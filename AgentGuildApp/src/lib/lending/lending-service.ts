/**
 * Lending Service — Firestore-backed loan and pool ledger, backed by real
 * on-chain devnet USDC transfers.
 *
 * Every balance-changing action requires a verified on-chain transfer before
 * Firestore is updated: a human sends USDC from their own wallet (deposit,
 * solo loan funding, repayment) or a platform admin manually pays out from
 * the treasury and confirms (pool withdrawal, pool-funded loan disbursement).
 * This module never holds a signing key — see lib/solana/lending-verify.ts
 * for the read-only verification it calls before crediting anything.
 *
 * Collections: lendingPools, lendingPoolPositions, lendingPoolDeposits,
 * lendingPoolWithdrawals, loans, loanRepayments.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { resolveAgentPolicy } from "@/lib/agent-policy";
import { calculateRequiredEscrow } from "@/lib/credit-policy";
import { CREDIT_SCORE_MIN, CREDIT_SCORE_MAX, TRUST_SCORE_MIN, TRUST_SCORE_MAX } from "@/lib/credit-tiers";
import { recordCreditAudit } from "@/lib/credit-audit-log";
import { invalidateCache } from "@/lib/credit-cache";
import { ingestCreditEvent } from "@/lib/credit-events/ingest";
import type { CreditEventType } from "@/lib/credit-events/types";
import { recomputeAndSync } from "@/lib/scoring-engine";
import { verifyAndClaimUsdcTransfer, treasuryAddress } from "@/lib/solana/lending-verify";
import {
    MIN_LOAN_USD,
    MAX_CONCURRENT_LOANS,
    evaluateEligibility,
    kindEligibility,
    clampTermDays,
    validateSoloRateBps,
} from "./eligibility";
import { accrue, applyPayment, clamp } from "./math";
import type {
    Loan,
    LoanKind,
    LoanSource,
    LoanRepayment,
    LendingPool,
    PoolPosition,
    PoolWithdrawalRequest,
    PoolDepositRecord,
    EligibilitySummary,
    LoanOffer,
} from "./types";

const POOLS = "lendingPools";
const POSITIONS = "lendingPoolPositions";
const DEPOSITS = "lendingPoolDeposits";
const WITHDRAWALS = "lendingPoolWithdrawals";
const LOANS = "loans";
const REPAYMENTS = "loanRepayments";
const OFFERS = "loanOffers";

/** Loose sanity bounds on a lender-proposed rate — actual eligibility banding happens per-borrower at acceptance time. */
const OFFER_MIN_RATE_BPS = 100;
const OFFER_MAX_RATE_BPS = 10_000;
const ACTIVE_LOAN_STATUSES: string[] = ["pending", "pending_disbursement", "active"];

const DEFAULT_POOL_NAME = "Community Lending Pool";

// ═══════════════════════════════════════════════════════════════
// Time helpers
// ═══════════════════════════════════════════════════════════════

const nowSec = () => Math.floor(Date.now() / 1000);

function toLoan(id: string, data: FirebaseFirestore.DocumentData): Loan {
    return { id, ...data } as Loan;
}

function toPool(id: string, data: FirebaseFirestore.DocumentData): LendingPool {
    return { id, ...data } as LendingPool;
}

// ═══════════════════════════════════════════════════════════════
// Pools — vault-style share accounting
// ═══════════════════════════════════════════════════════════════

/** poolValue = liquid cash + outstanding principal, valued at par. */
function poolValueUsd(pool: LendingPool): number {
    return pool.availableLiquidityUsd + pool.totalLentUsd;
}

function sharePrice(pool: LendingPool): number {
    if (pool.totalShares <= 0) return 1;
    return poolValueUsd(pool) / pool.totalShares;
}

/** Idempotently ensures at least one community pool exists, and returns all pools. */
export async function listPools(): Promise<LendingPool[]> {
    const snap = await adminDb().collection(POOLS).orderBy("createdAt", "asc").get();
    if (!snap.empty) {
        return snap.docs.map((d) => toPool(d.id, d.data()));
    }
    const created = await createPool({ name: DEFAULT_POOL_NAME, description: "Diversified community pool — lower risk, funds agents automatically as they qualify." });
    return [created];
}

export async function getPool(poolId: string): Promise<LendingPool | null> {
    const snap = await adminDb().collection(POOLS).doc(poolId).get();
    return snap.exists ? toPool(snap.id, snap.data()!) : null;
}

export async function createPool(input: { name: string; description?: string; createdBy?: string }): Promise<LendingPool> {
    const doc = {
        name: input.name,
        description: input.description || "",
        totalShares: 0,
        availableLiquidityUsd: 0,
        totalLentUsd: 0,
        totalDepositedUsd: 0,
        totalInterestEarnedUsd: 0,
        totalDefaultedUsd: 0,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: input.createdBy || null,
    };
    const ref = await adminDb().collection(POOLS).add(doc);
    return { id: ref.id, ...doc, createdAt: Timestamp.now() } as unknown as LendingPool;
}

export async function getPoolPosition(poolId: string, wallet: string): Promise<PoolPosition | null> {
    const id = `${poolId}_${wallet}`;
    const snap = await adminDb().collection(POSITIONS).doc(id).get();
    return snap.exists ? ({ id: snap.id, ...snap.data() } as PoolPosition) : null;
}

export async function listPositionsForWallet(wallet: string): Promise<PoolPosition[]> {
    const snap = await adminDb().collection(POSITIONS).where("walletAddress", "==", wallet).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as PoolPosition);
}

/**
 * Verify a lender actually sent `amountUsd` USDC to the treasury on-chain,
 * then mint pool shares for it. Throws if the signature doesn't check out or
 * has already been used.
 */
export async function confirmPoolDeposit(
    poolId: string,
    wallet: string,
    amountUsd: number,
    txSig: string,
): Promise<{ pool: LendingPool; position: PoolPosition }> {
    await verifyAndClaimUsdcTransfer({
        txSig,
        expectedFromWallet: wallet,
        expectedToWallet: treasuryAddress(),
        expectedAmountUsd: amountUsd,
        purpose: "pool_deposit",
        refId: poolId,
    });

    const result = await creditPoolDeposit(poolId, wallet, amountUsd);

    await adminDb().collection(DEPOSITS).add({
        poolId,
        walletAddress: wallet,
        amountUsd,
        txSig,
        depositedAt: nowSec(),
    } satisfies Omit<PoolDepositRecord, "id">);

    return result;
}

async function creditPoolDeposit(poolId: string, wallet: string, amountUsd: number): Promise<{ pool: LendingPool; position: PoolPosition }> {
    if (!(amountUsd > 0)) throw new Error("Deposit amount must be positive");

    const poolRef = adminDb().collection(POOLS).doc(poolId);
    const positionRef = adminDb().collection(POSITIONS).doc(`${poolId}_${wallet}`);

    return adminDb().runTransaction(async (txn) => {
        const poolSnap = await txn.get(poolRef);
        if (!poolSnap.exists) throw new Error("Pool not found");
        const pool = toPool(poolSnap.id, poolSnap.data()!);

        const price = sharePrice(pool);
        const sharesToMint = pool.totalShares <= 0 ? amountUsd : amountUsd / price;

        const posSnap = await txn.get(positionRef);
        const existing = posSnap.exists ? (posSnap.data() as PoolPosition) : null;

        txn.update(poolRef, {
            totalShares: FieldValue.increment(sharesToMint),
            availableLiquidityUsd: FieldValue.increment(amountUsd),
            totalDepositedUsd: FieldValue.increment(amountUsd),
        });

        if (existing) {
            txn.update(positionRef, {
                shares: FieldValue.increment(sharesToMint),
                principalDepositedUsd: FieldValue.increment(amountUsd),
                updatedAt: FieldValue.serverTimestamp(),
            });
        } else {
            txn.set(positionRef, {
                poolId,
                walletAddress: wallet,
                shares: sharesToMint,
                principalDepositedUsd: amountUsd,
                principalWithdrawnUsd: 0,
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            });
        }

        return {
            pool: {
                ...pool,
                totalShares: pool.totalShares + sharesToMint,
                availableLiquidityUsd: pool.availableLiquidityUsd + amountUsd,
                totalDepositedUsd: pool.totalDepositedUsd + amountUsd,
            },
            position: {
                id: positionRef.id,
                poolId,
                walletAddress: wallet,
                shares: (existing?.shares || 0) + sharesToMint,
                principalDepositedUsd: (existing?.principalDepositedUsd || 0) + amountUsd,
                principalWithdrawnUsd: existing?.principalWithdrawnUsd || 0,
                createdAt: existing?.createdAt ?? Timestamp.now(),
                updatedAt: Timestamp.now(),
            },
        };
    });
}

/**
 * Lock in a withdrawal at today's share price and amount — the pool can't pay
 * it out itself (no signing key held here), so this just opens a request. An
 * admin sends the USDC from the treasury by hand and confirms it (see
 * confirmPoolWithdrawal), which is what actually burns the shares.
 */
export async function requestPoolWithdrawal(poolId: string, wallet: string, amountUsd: number): Promise<PoolWithdrawalRequest> {
    if (!(amountUsd > 0)) throw new Error("Withdrawal amount must be positive");

    const pool = await getPool(poolId);
    if (!pool) throw new Error("Pool not found");
    const position = await getPoolPosition(poolId, wallet);
    if (!position) throw new Error("No position in this pool");

    const price = sharePrice(pool);
    const positionValueUsd = position.shares * price;
    if (amountUsd > positionValueUsd + 0.01) {
        throw new Error(`Requested amount exceeds your position value ($${positionValueUsd.toFixed(2)})`);
    }
    if (amountUsd > pool.availableLiquidityUsd + 0.01) {
        throw new Error("Pool does not have enough free liquidity right now — some capital is out on loan. Try a smaller amount or wait for repayments.");
    }

    const request: Omit<PoolWithdrawalRequest, "id"> = {
        poolId,
        walletAddress: wallet,
        amountUsd,
        sharesToBurn: amountUsd / price,
        status: "pending_payout",
        requestedAt: nowSec(),
    };
    const ref = await adminDb().collection(WITHDRAWALS).add(request);
    return { id: ref.id, ...request };
}

export async function getPoolWithdrawalRequest(requestId: string): Promise<PoolWithdrawalRequest | null> {
    const snap = await adminDb().collection(WITHDRAWALS).doc(requestId).get();
    return snap.exists ? ({ id: snap.id, ...snap.data() } as PoolWithdrawalRequest) : null;
}

export async function listPendingPoolWithdrawals(): Promise<PoolWithdrawalRequest[]> {
    const snap = await adminDb().collection(WITHDRAWALS).where("status", "==", "pending_payout").orderBy("requestedAt", "asc").get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as PoolWithdrawalRequest);
}

export async function listPoolWithdrawalsForWallet(wallet: string): Promise<PoolWithdrawalRequest[]> {
    const snap = await adminDb().collection(WITHDRAWALS).where("walletAddress", "==", wallet).orderBy("requestedAt", "desc").get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as PoolWithdrawalRequest);
}

/** Platform-admin action: verify the treasury really paid the lender, then burn the locked-in shares. */
export async function confirmPoolWithdrawal(requestId: string, txSig: string): Promise<{ pool: LendingPool; position: PoolPosition }> {
    const requestRef = adminDb().collection(WITHDRAWALS).doc(requestId);
    const requestSnap = await requestRef.get();
    if (!requestSnap.exists) throw new Error("Withdrawal request not found");
    const request = requestSnap.data() as PoolWithdrawalRequest;
    if (request.status !== "pending_payout") throw new Error(`Withdrawal is not pending (status: ${request.status})`);

    await verifyAndClaimUsdcTransfer({
        txSig,
        expectedFromWallet: treasuryAddress(),
        expectedToWallet: request.walletAddress,
        expectedAmountUsd: request.amountUsd,
        purpose: "pool_withdrawal",
        refId: requestId,
    });

    const poolRef = adminDb().collection(POOLS).doc(request.poolId);
    const positionRef = adminDb().collection(POSITIONS).doc(`${request.poolId}_${request.walletAddress}`);

    const result = await adminDb().runTransaction(async (txn) => {
        const [poolSnap, posSnap] = await Promise.all([txn.get(poolRef), txn.get(positionRef)]);
        if (!poolSnap.exists) throw new Error("Pool not found");
        if (!posSnap.exists) throw new Error("Position not found");
        const pool = toPool(poolSnap.id, poolSnap.data()!);
        const position = posSnap.data() as PoolPosition;

        txn.update(poolRef, {
            totalShares: FieldValue.increment(-request.sharesToBurn),
            availableLiquidityUsd: FieldValue.increment(-request.amountUsd),
            totalDepositedUsd: FieldValue.increment(-Math.min(request.amountUsd, pool.totalDepositedUsd)),
        });
        txn.update(positionRef, {
            shares: FieldValue.increment(-request.sharesToBurn),
            principalWithdrawnUsd: FieldValue.increment(request.amountUsd),
            updatedAt: FieldValue.serverTimestamp(),
        });
        txn.update(requestRef, { status: "paid", txSig, paidAt: nowSec() });

        return {
            pool: {
                ...pool,
                totalShares: pool.totalShares - request.sharesToBurn,
                availableLiquidityUsd: pool.availableLiquidityUsd - request.amountUsd,
            },
            position: {
                ...position,
                shares: position.shares - request.sharesToBurn,
                principalWithdrawnUsd: position.principalWithdrawnUsd + request.amountUsd,
            },
        };
    });

    return result;
}

// ═══════════════════════════════════════════════════════════════
// Eligibility
// ═══════════════════════════════════════════════════════════════

export async function getEligibility(agentId: string): Promise<EligibilitySummary> {
    const policyResult = await resolveAgentPolicy(agentId);
    if (!policyResult.ok || !policyResult.policy) {
        throw new Error(policyResult.error || "Could not resolve agent credit policy");
    }

    const agentSnap = await adminDb().collection("agents").doc(agentId).get();
    const creditScore = (agentSnap.data()?.creditScore as number) ?? 680;

    const [trustRepaidSnap, unsecuredRepaidSnap, activeSnap, defaultedSnap] = await Promise.all([
        adminDb().collection(LOANS).where("borrowerAgentId", "==", agentId).where("kind", "==", "trust").where("status", "==", "repaid").get(),
        adminDb().collection(LOANS).where("borrowerAgentId", "==", agentId).where("kind", "==", "unsecured").where("status", "==", "repaid").get(),
        adminDb().collection(LOANS).where("borrowerAgentId", "==", agentId).where("status", "in", ACTIVE_LOAN_STATUSES).get(),
        adminDb().collection(LOANS).where("borrowerAgentId", "==", agentId).where("status", "==", "defaulted").get(),
    ]);

    return evaluateEligibility({
        policy: policyResult.policy,
        creditScore,
        completedTrustLoans: trustRepaidSnap.size,
        completedUnsecuredLoans: unsecuredRepaidSnap.size,
        activeLoanCount: activeSnap.size,
        hasUnresolvedDefault: defaultedSnap.size > 0,
    });
}

// ═══════════════════════════════════════════════════════════════
// Loan lifecycle
// ═══════════════════════════════════════════════════════════════

export interface RequestLoanInput {
    agentId: string;
    orgId: string;
    kind: LoanKind;
    source: LoanSource;
    amountUsd: number;
    termDays?: number;
    poolId?: string;
    purpose?: string;
    requestedByWallet?: string;
    /** Solo loans only — the rate the borrower is offering, negotiated between the two parties within a band around the tier's algorithmic rate. Ignored for pool loans, which always use the fixed tier rate. */
    requestedRateBps?: number;
}

export async function requestLoan(input: RequestLoanInput): Promise<Loan> {
    const { agentId, orgId, kind, source, purpose, requestedByWallet } = input;
    const amountUsd = Math.round(input.amountUsd * 100) / 100;
    const termDays = clampTermDays(input.termDays ?? 30);

    if (!(amountUsd >= MIN_LOAN_USD)) {
        throw new Error(`Loan amount must be at least $${MIN_LOAN_USD}`);
    }

    const policyResult = await resolveAgentPolicy(agentId);
    if (!policyResult.ok || !policyResult.policy) {
        throw new Error(policyResult.error || "Could not resolve agent credit policy");
    }
    const policy = policyResult.policy;

    const agentSnap = await adminDb().collection("agents").doc(agentId).get();
    if (!agentSnap.exists) throw new Error("Agent not found");
    const agentData = agentSnap.data()!;
    const creditScore = (agentData.creditScore as number) ?? 680;

    const summary = await getEligibility(agentId);
    const gate = kindEligibility(summary, kind);
    if (!gate.eligible) {
        throw new Error(gate.reason || "Not eligible for this loan type");
    }
    if (amountUsd > gate.maxAmountUsd) {
        throw new Error(`Amount exceeds the maximum for this loan type ($${gate.maxAmountUsd.toLocaleString()})`);
    }
    if (summary.activeLoanCount >= MAX_CONCURRENT_LOANS) {
        throw new Error(`Maximum of ${MAX_CONCURRENT_LOANS} concurrent loans reached`);
    }

    // Pool loans are always priced at the fixed, algorithmic tier rate — no
    // negotiation. Solo loans can be priced differently (the two parties are
    // negotiating directly), but still only within a band around that same
    // tier rate, so it can't be used for a usurious or throwaway rate.
    let interestRateBps = gate.rateBps;
    if (source === "solo" && input.requestedRateBps !== undefined) {
        const rateCheck = validateSoloRateBps(input.requestedRateBps, gate.rateBps);
        if (!rateCheck.ok) throw new Error(rateCheck.error);
        interestRateBps = Math.round(input.requestedRateBps);
    }

    const collateralUsd = kind === "trust"
        ? Math.round(calculateRequiredEscrow(policy, amountUsd).escrowAmount * 100) / 100
        : 0;

    const base: Omit<Loan, "id"> = {
        borrowerAgentId: agentId,
        borrowerOrgId: orgId,
        borrowerWalletAddress: (agentData.walletAddress as string) || undefined,
        requestedByWallet,
        kind,
        source,
        principalUsd: amountUsd,
        principalRemainingUsd: amountUsd,
        principalPaidUsd: 0,
        interestRateBps,
        interestAccruedUsd: 0,
        interestPaidUsd: 0,
        collateralUsd,
        termDays,
        requestedAt: nowSec(),
        policyTierAtOrigination: policy.name,
        creditScoreAtOrigination: creditScore,
        purpose,
        status: "pending",
    };

    if (!base.borrowerWalletAddress) {
        throw new Error("Agent has no wallet address on file — cannot receive a real loan disbursement");
    }

    if (source === "solo") {
        const ref = await adminDb().collection(LOANS).add(base);
        return { id: ref.id, ...base };
    }

    // Pool-funded: reserve the liquidity now; real disbursement still needs an
    // admin to send it from the treasury and confirm (see confirmLoanDisbursement).
    const pools = await listPools();
    const poolId = input.poolId || pools[0].id;
    const poolRef = adminDb().collection(POOLS).doc(poolId);
    const loanRef = adminDb().collection(LOANS).doc();

    const reserved = await adminDb().runTransaction(async (txn) => {
        const poolSnap = await txn.get(poolRef);
        if (!poolSnap.exists) throw new Error("Pool not found");
        const pool = toPool(poolSnap.id, poolSnap.data()!);
        if (pool.availableLiquidityUsd < amountUsd) {
            throw new Error("The pool does not have enough available liquidity for this loan right now");
        }

        const loan: Omit<Loan, "id"> = {
            ...base,
            status: "pending_disbursement",
            poolId,
        };

        txn.set(loanRef, loan);
        txn.update(poolRef, {
            availableLiquidityUsd: FieldValue.increment(-amountUsd),
            totalLentUsd: FieldValue.increment(amountUsd),
        });

        return { id: loanRef.id, ...loan };
    });

    invalidateCache(`credit:${agentId}`);
    return reserved;
}

export async function fundLoanSolo(loanId: string, lenderWallet: string, txSig: string): Promise<Loan> {
    const loanRef = adminDb().collection(LOANS).doc(loanId);
    const loanSnap = await loanRef.get();
    if (!loanSnap.exists) throw new Error("Loan not found");
    const loan = toLoan(loanSnap.id, loanSnap.data()!);

    if (loan.source !== "solo") throw new Error("Only solo loan requests can be funded directly");
    if (loan.status !== "pending") throw new Error("This loan is no longer open for funding");
    if (!loan.borrowerWalletAddress) throw new Error("Borrower has no wallet address on file");
    if (loan.reservedLenderWallet && loan.reservedLenderWallet !== lenderWallet) {
        throw new Error("This loan was accepted from a specific lender's offer and can only be funded by that wallet");
    }

    await verifyAndClaimUsdcTransfer({
        txSig,
        expectedFromWallet: lenderWallet,
        expectedToWallet: loan.borrowerWalletAddress,
        expectedAmountUsd: loan.principalUsd,
        purpose: "solo_loan_fund",
        refId: loanId,
    });

    return adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        const current = toLoan(snap.id, snap.data()!);
        if (current.status !== "pending") throw new Error("This loan is no longer open for funding");

        const originatedAt = nowSec();
        const update = {
            status: "active" as const,
            lenderWalletAddress: lenderWallet,
            originatedAt,
            dueAt: originatedAt + current.termDays * 86400,
            lastAccrualAt: originatedAt,
            disbursementTxSig: txSig,
        };
        txn.update(loanRef, update);
        return { ...current, ...update };
    });
}

// ═══════════════════════════════════════════════════════════════
// Loan offers — lender posts terms first, a borrower accepts
// ═══════════════════════════════════════════════════════════════

function toOffer(id: string, data: FirebaseFirestore.DocumentData): LoanOffer {
    return { id, ...data } as LoanOffer;
}

export interface CreateLoanOfferInput {
    lenderWalletAddress: string;
    kind: LoanKind;
    amountUsd: number;
    rateBps: number;
    termDays?: number;
    note?: string;
}

export async function createLoanOffer(input: CreateLoanOfferInput): Promise<LoanOffer> {
    const amountUsd = Math.round(input.amountUsd * 100) / 100;
    if (!(amountUsd >= MIN_LOAN_USD)) {
        throw new Error(`Offer amount must be at least $${MIN_LOAN_USD}`);
    }
    const rateBps = Math.round(input.rateBps);
    if (!Number.isFinite(rateBps) || rateBps < OFFER_MIN_RATE_BPS || rateBps > OFFER_MAX_RATE_BPS) {
        throw new Error(`Rate must be between ${(OFFER_MIN_RATE_BPS / 100).toFixed(1)}% and ${(OFFER_MAX_RATE_BPS / 100).toFixed(1)}% APR`);
    }

    const offer: Omit<LoanOffer, "id"> = {
        lenderWalletAddress: input.lenderWalletAddress,
        kind: input.kind,
        amountUsd,
        rateBps,
        termDays: clampTermDays(input.termDays ?? 30),
        note: input.note,
        status: "open",
        createdAt: nowSec(),
    };
    const ref = await adminDb().collection(OFFERS).add(offer);
    return { id: ref.id, ...offer };
}

export async function getLoanOffer(offerId: string): Promise<LoanOffer | null> {
    const snap = await adminDb().collection(OFFERS).doc(offerId).get();
    return snap.exists ? toOffer(snap.id, snap.data()!) : null;
}

export async function listOpenLoanOffers(): Promise<LoanOffer[]> {
    const snap = await adminDb().collection(OFFERS).where("status", "==", "open").orderBy("createdAt", "desc").limit(50).get();
    return snap.docs.map((d) => toOffer(d.id, d.data()));
}

export async function listLoanOffersForWallet(wallet: string): Promise<LoanOffer[]> {
    const snap = await adminDb().collection(OFFERS).where("lenderWalletAddress", "==", wallet).orderBy("createdAt", "desc").get();
    return snap.docs.map((d) => toOffer(d.id, d.data()));
}

export async function withdrawLoanOffer(offerId: string, walletAddress: string): Promise<LoanOffer> {
    const ref = adminDb().collection(OFFERS).doc(offerId);
    return adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(ref);
        if (!snap.exists) throw new Error("Offer not found");
        const offer = toOffer(snap.id, snap.data()!);
        if (offer.lenderWalletAddress !== walletAddress) throw new Error("Only the lender who posted this offer can withdraw it");
        if (offer.status !== "open") throw new Error(`Offer is not open (status: ${offer.status})`);
        const update = { status: "withdrawn" as const, withdrawnAt: nowSec() };
        txn.update(ref, update);
        return { ...offer, ...update };
    });
}

export interface AcceptLoanOfferInput {
    offerId: string;
    agentId: string;
    orgId: string;
    /** Defaults to the offer's full amount; must not exceed it. */
    amountUsd?: number;
    requestedByWallet?: string;
}

/**
 * Borrower accepts a lender's standing offer: creates a "pending" solo loan
 * on the offer's terms, reserved so only the offering lender can fund it (see
 * reservedLenderWallet / fundLoanSolo). Still runs through the normal
 * eligibility gate — an offer's rate/amount must land within the accepting
 * agent's own tier band, same as a self-posted solo request.
 */
export async function acceptLoanOffer(input: AcceptLoanOfferInput): Promise<Loan> {
    const offerRef = adminDb().collection(OFFERS).doc(input.offerId);

    const offer = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(offerRef);
        if (!snap.exists) throw new Error("Offer not found");
        const current = toOffer(snap.id, snap.data()!);
        if (current.status !== "open") throw new Error(`Offer is not open (status: ${current.status})`);
        txn.update(offerRef, { status: "fulfilled" as const });
        return current;
    });

    const amountUsd = input.amountUsd !== undefined ? Math.round(input.amountUsd * 100) / 100 : offer.amountUsd;
    if (amountUsd > offer.amountUsd) {
        await offerRef.update({ status: "open" });
        throw new Error(`Amount exceeds the offer's maximum of $${offer.amountUsd.toLocaleString()}`);
    }

    try {
        const loan = await requestLoan({
            agentId: input.agentId,
            orgId: input.orgId,
            kind: offer.kind,
            source: "solo",
            amountUsd,
            termDays: offer.termDays,
            requestedByWallet: input.requestedByWallet,
            requestedRateBps: offer.rateBps,
        });

        const loanRef = adminDb().collection(LOANS).doc(loan.id);
        const update = { offerId: offer.id, reservedLenderWallet: offer.lenderWalletAddress };
        await loanRef.update(update);

        await offerRef.update({ acceptedLoanId: loan.id, acceptedAt: nowSec() });

        return { ...loan, ...update };
    } catch (error) {
        await offerRef.update({ status: "open" });
        throw error;
    }
}

/**
 * Platform-admin action: verify the treasury really paid the borrower, then
 * flip a pool-funded loan from "pending_disbursement" to "active" and start
 * its interest clock.
 */
export async function confirmLoanDisbursement(loanId: string, txSig: string): Promise<Loan> {
    const loanRef = adminDb().collection(LOANS).doc(loanId);
    const loanSnap = await loanRef.get();
    if (!loanSnap.exists) throw new Error("Loan not found");
    const loan = toLoan(loanSnap.id, loanSnap.data()!);

    if (loan.status !== "pending_disbursement") throw new Error(`Loan is not awaiting disbursement (status: ${loan.status})`);
    if (!loan.borrowerWalletAddress) throw new Error("Borrower has no wallet address on file");

    await verifyAndClaimUsdcTransfer({
        txSig,
        expectedFromWallet: treasuryAddress(),
        expectedToWallet: loan.borrowerWalletAddress,
        expectedAmountUsd: loan.principalUsd,
        purpose: "loan_disbursement",
        refId: loanId,
    });

    return adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        const current = toLoan(snap.id, snap.data()!);
        if (current.status !== "pending_disbursement") throw new Error(`Loan is not awaiting disbursement (status: ${current.status})`);

        const originatedAt = nowSec();
        const update = {
            status: "active" as const,
            originatedAt,
            dueAt: originatedAt + current.termDays * 86400,
            lastAccrualAt: originatedAt,
            disbursementTxSig: txSig,
        };
        txn.update(loanRef, update);
        return { ...current, ...update };
    });
}

export async function listPendingDisbursements(): Promise<Loan[]> {
    const snap = await adminDb().collection(LOANS).where("status", "==", "pending_disbursement").orderBy("requestedAt", "asc").get();
    return snap.docs.map((d) => toLoan(d.id, d.data()));
}

async function applyLoanCreditEvent(
    agentId: string,
    creditDelta: number,
    trustDelta: number,
    reason: string,
    eventType: string,
    metadata: Record<string, unknown>,
): Promise<void> {
    const agentRef = adminDb().collection("agents").doc(agentId);
    const agentSnap = await agentRef.get();
    if (!agentSnap.exists) return;
    const data = agentSnap.data()!;
    const creditBefore = (data.creditScore as number) ?? 680;
    const trustBefore = (data.trustScore as number) ?? 50;
    const creditAfter = clamp(creditBefore + creditDelta, CREDIT_SCORE_MIN, CREDIT_SCORE_MAX);
    const trustAfter = clamp(trustBefore + trustDelta, TRUST_SCORE_MIN, TRUST_SCORE_MAX);

    await agentRef.update({
        creditScore: creditAfter,
        trustScore: trustAfter,
        lastCreditUpdate: FieldValue.serverTimestamp(),
        lastCreditReason: reason,
    });

    await recordCreditAudit({
        agentId,
        asn: (data.asn as string) || "",
        source: "auto",
        creditBefore,
        creditAfter,
        trustBefore,
        trustAfter,
        reason,
        eventType,
        metadata,
    }).catch((err) => console.error("[lending-service] Failed to record credit audit:", err));

    invalidateCache(`credit:${agentId}`);

    // Feed the canonical credit-events pipeline (non-blocking) — the Dynamic
    // Scoring Engine's settlement sub-score reads loan outcomes from here.
    const asn = (data.asn as string) || "";
    const canonicalType: CreditEventType = eventType === "loan_defaulted" ? "payment.failed" : "payment.settled";
    ingestCreditEvent({
        eventType: canonicalType,
        agentId,
        asn,
        agentAddress: (data.walletAddress as string) || undefined,
        orgId: (data.orgId as string) || "platform",
        creditDelta,
        trustDelta,
        provenance: "system",
        severity: creditDelta < 0 ? (Math.abs(creditDelta) > 30 ? "high" : "medium") : "info",
        source: {
            system: "lending-service",
            sourceEventId: `${eventType}-${agentId}-${Date.now()}`,
            sourceEventType: eventType,
        },
        timestamp: Math.floor(Date.now() / 1000),
        description: reason,
        metadata,
    }).then(() => {
        if (asn) return recomputeAndSync(agentId, asn);
    }).catch((err) => console.error("[lending-service] Failed to ingest credit event:", err));
}

async function settleLoanWithPool(poolId: string | undefined, principalReturned: number, interestReturned: number, lossUsd: number): Promise<void> {
    if (!poolId) return;
    const poolRef = adminDb().collection(POOLS).doc(poolId);
    const updates: Record<string, FirebaseFirestore.FieldValue> = {};
    if (principalReturned > 0 || interestReturned > 0) {
        updates.availableLiquidityUsd = FieldValue.increment(principalReturned + interestReturned);
        updates.totalLentUsd = FieldValue.increment(-principalReturned);
        if (interestReturned > 0) updates.totalInterestEarnedUsd = FieldValue.increment(interestReturned);
    }
    if (lossUsd > 0) {
        updates.totalLentUsd = FieldValue.increment(-lossUsd);
        updates.totalDefaultedUsd = FieldValue.increment(lossUsd);
    }
    if (Object.keys(updates).length > 0) {
        await poolRef.update(updates);
    }
}

export async function repayLoan(loanId: string, amountUsd: number, paidByWallet: string, txSig: string): Promise<{ loan: Loan; repayment: LoanRepayment }> {
    if (!(amountUsd > 0)) throw new Error("Repayment amount must be positive");
    const loanRef = adminDb().collection(LOANS).doc(loanId);

    const existing = await getLoan(loanId);
    if (!existing) throw new Error("Loan not found");
    if (existing.status !== "active") throw new Error(`Loan is not active (status: ${existing.status})`);

    const recipientWallet = existing.source === "pool" ? treasuryAddress() : existing.lenderWalletAddress;
    if (!recipientWallet) throw new Error("No lender wallet on file to verify repayment against");

    await verifyAndClaimUsdcTransfer({
        txSig,
        expectedFromWallet: paidByWallet,
        expectedToWallet: recipientWallet,
        expectedAmountUsd: amountUsd,
        purpose: "loan_repayment",
        refId: loanId,
    });

    const result = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        let loan = toLoan(snap.id, snap.data()!);
        if (loan.status !== "active") throw new Error(`Loan is not active (status: ${loan.status})`);

        const at = nowSec();
        loan = accrue(loan, at);

        const {
            loan: paidLoan, appliedUsd, principalPortionUsd, interestPortionUsd, remainingBalanceUsd, finalStatus,
        } = applyPayment(loan, amountUsd, at);

        const update: Partial<Loan> = {
            principalRemainingUsd: paidLoan.principalRemainingUsd,
            principalPaidUsd: paidLoan.principalPaidUsd,
            interestAccruedUsd: paidLoan.interestAccruedUsd,
            interestPaidUsd: paidLoan.interestPaidUsd,
            lastAccrualAt: loan.lastAccrualAt,
            status: finalStatus,
        };
        if (finalStatus === "repaid") update.repaidAt = at;
        if (finalStatus === "defaulted") update.defaultedAt = at;

        txn.update(loanRef, update as FirebaseFirestore.UpdateData<Loan>);

        const repaymentRef = adminDb().collection(REPAYMENTS).doc();
        const repayment: LoanRepayment = {
            id: repaymentRef.id,
            loanId,
            amountUsd: appliedUsd,
            principalPortionUsd,
            interestPortionUsd,
            remainingBalanceUsd,
            paidAt: at,
            paidByWallet,
            txSig,
        };
        txn.set(repaymentRef, repayment);

        return { loan: { ...loan, ...update } as Loan, repayment, principalPortion: principalPortionUsd, interestPortion: interestPortionUsd };
    });

    if (result.loan.status === "repaid") {
        await settleLoanWithPool(result.loan.poolId, result.principalPortion, result.interestPortion, 0);
        const credit = result.loan.kind === "unsecured" ? 14 : 8;
        const trust = result.loan.kind === "unsecured" ? 4 : 2;
        await applyLoanCreditEvent(
            result.loan.borrowerAgentId,
            credit,
            trust,
            `Repaid ${result.loan.kind} loan in full ($${result.loan.principalUsd.toLocaleString()})`,
            "loan_repaid",
            { loanId, kind: result.loan.kind, principalUsd: result.loan.principalUsd },
        );
    } else if (result.loan.status === "defaulted") {
        await processDefaultLoss(result.loan);
    } else {
        await settleLoanWithPool(result.loan.poolId, result.principalPortion, result.interestPortion, 0);
    }

    return { loan: result.loan, repayment: result.repayment };
}

async function processDefaultLoss(loan: Loan): Promise<void> {
    const recovered = Math.min(loan.collateralUsd, loan.principalRemainingUsd);
    const lossUsd = Math.max(0, loan.principalRemainingUsd - recovered);
    await settleLoanWithPool(loan.poolId, recovered, 0, lossUsd);

    const recoveryRatio = loan.principalRemainingUsd > 0 ? clamp(recovered / loan.principalRemainingUsd, 0, 1) : 1;
    const baseCredit = loan.kind === "unsecured" ? -55 : -25;
    const baseTrust = loan.kind === "unsecured" ? -20 : -8;
    const credit = Math.round(baseCredit * (1 - recoveryRatio * 0.5));
    const trust = Math.round(baseTrust * (1 - recoveryRatio * 0.5));

    await applyLoanCreditEvent(
        loan.borrowerAgentId,
        credit,
        trust,
        `Defaulted on ${loan.kind} loan ($${loan.principalRemainingUsd.toLocaleString()} outstanding)`,
        "loan_defaulted",
        { loanId: loan.id, kind: loan.kind, outstandingUsd: loan.principalRemainingUsd, recoveredUsd: recovered },
    );
}

/**
 * Admin action: force-process an overdue active loan into "defaulted".
 * There is no cron in this codebase to sweep overdue loans automatically —
 * this is the explicit closing mechanism, and repayLoan() also settles the
 * transition inline if a borrower pays after their due date.
 */
export async function markLoanDefaulted(loanId: string): Promise<Loan> {
    const loanRef = adminDb().collection(LOANS).doc(loanId);
    const loan = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        let current = toLoan(snap.id, snap.data()!);
        if (current.status !== "active") throw new Error(`Loan is not active (status: ${current.status})`);
        if (!current.dueAt || nowSec() <= current.dueAt) throw new Error("Loan is not past its due date yet");

        const at = nowSec();
        current = accrue(current, at);
        const update = {
            interestAccruedUsd: current.interestAccruedUsd,
            lastAccrualAt: current.lastAccrualAt,
            status: "defaulted" as const,
            defaultedAt: at,
        };
        txn.update(loanRef, update);
        return { ...current, ...update };
    });

    await processDefaultLoss(loan);
    return loan;
}

// ═══════════════════════════════════════════════════════════════
// Queries
// ═══════════════════════════════════════════════════════════════

export async function getLoan(loanId: string): Promise<Loan | null> {
    const snap = await adminDb().collection(LOANS).doc(loanId).get();
    return snap.exists ? toLoan(snap.id, snap.data()!) : null;
}

export async function listLoansForAgent(agentId: string): Promise<Loan[]> {
    const snap = await adminDb().collection(LOANS).where("borrowerAgentId", "==", agentId).orderBy("requestedAt", "desc").limit(50).get();
    return snap.docs.map((d) => toLoan(d.id, d.data()));
}

export async function listOpenSoloRequests(): Promise<Loan[]> {
    const snap = await adminDb().collection(LOANS).where("source", "==", "solo").where("status", "==", "pending").orderBy("requestedAt", "desc").limit(50).get();
    return snap.docs.map((d) => toLoan(d.id, d.data()));
}

export async function listLoansFundedByWallet(wallet: string): Promise<Loan[]> {
    const snap = await adminDb().collection(LOANS).where("lenderWalletAddress", "==", wallet).orderBy("requestedAt", "desc").limit(50).get();
    return snap.docs.map((d) => toLoan(d.id, d.data()));
}

export async function listRepaymentsForLoan(loanId: string): Promise<LoanRepayment[]> {
    const snap = await adminDb().collection(REPAYMENTS).where("loanId", "==", loanId).orderBy("paidAt", "desc").get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as LoanRepayment);
}
