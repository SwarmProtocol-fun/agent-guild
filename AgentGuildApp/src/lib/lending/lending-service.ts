/**
 * Lending Service — Firestore-backed loan and pool ledger, backed by real
 * on-chain devnet USDC transfers.
 *
 * Every balance-changing action requires a verified on-chain transfer before
 * Firestore is updated, and the signature's replay-guard claim is written in
 * the same Firestore transaction as the credit — so a credit that fails can't
 * burn a signature the user really paid with: a human sends USDC from their own wallet (deposit,
 * solo loan funding, repayment) or a platform admin manually pays out from
 * the treasury and confirms (pool withdrawal, pool-funded loan disbursement).
 * This module never holds a signing key — see lib/solana/lending-verify.ts
 * for the read-only verification it calls before crediting anything.
 *
 * Trust loans require collateral, posted to the treasury and verified
 * on-chain before funding; it is returned on repayment and seized on
 * default. Obligations the ledger can't execute itself (collateral returns,
 * refunds) are queued in payouts.ts inside the same transaction that creates
 * them. Launch guards (pause, allowlist, caps) live in config.ts.
 *
 * Collections: lendingPools, lendingPoolPositions, lendingPoolDeposits,
 * lendingPoolWithdrawals, loans, loanRepayments, loanOffers, lendingPayouts.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { resolveAgentPolicy } from "@/lib/agent-policy";
import { adminPolicyLoaders } from "@/lib/credit-policy-settings-admin";
import { calculateRequiredEscrow } from "@/lib/credit-policy";
import { CREDIT_SCORE_MIN, CREDIT_SCORE_MAX, TRUST_SCORE_MIN, TRUST_SCORE_MAX } from "@/lib/credit-tiers";
import { recordCreditAudit } from "@/lib/credit-audit-log";
import { invalidateCache } from "@/lib/credit-cache";
import { ingestCreditEvent } from "@/lib/credit-events/ingest";
import type { CreditEventType } from "@/lib/credit-events/types";
import { recomputeAndSync } from "@/lib/scoring-engine";
import { verifyUsdcTransfer, claimUsdcTransferInTxn, treasuryAddress, type VerifyTransferInput } from "@/lib/solana/lending-verify";
import {
    MIN_LOAN_USD,
    MAX_CONCURRENT_LOANS,
    evaluateEligibility,
    kindEligibility,
    clampTermDays,
    validateSoloRateBps,
} from "./eligibility";
import {
    accrue,
    applyPayment,
    clamp,
    planWithdrawal,
    sharesForDeposit,
    poolSettlementDeltas,
    accruePoolInterest,
    computeDefaultRecovery,
    depositCapacityUsd,
} from "./math";
import { lendingLimits, assertCanOpenPosition, isWalletAllowed } from "./config";
import { createPayoutInTxn } from "./payouts";
import type {
    Loan,
    LoanKind,
    LoanSource,
    LoanRepayment,
    LendingPool,
    PoolPosition,
    PoolWithdrawalRequest,
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
const ACTIVE_LOAN_STATUSES: string[] = ["pending_collateral", "pending", "pending_disbursement", "active"];

const DEFAULT_POOL_NAME = "Community Lending Pool";

// ═══════════════════════════════════════════════════════════════
// Time helpers
// ═══════════════════════════════════════════════════════════════

const nowSec = () => Math.floor(Date.now() / 1000);

/** Firestore here isn't configured with ignoreUndefinedProperties — optional fields must be dropped, not written as undefined. */
function withoutUndefined<T extends object>(obj: T): T {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function toLoan(id: string, data: FirebaseFirestore.DocumentData): Loan {
    return { id, ...data } as Loan;
}

function toPool(id: string, data: FirebaseFirestore.DocumentData): LendingPool {
    return { id, ...data } as LendingPool;
}

// ═══════════════════════════════════════════════════════════════
// Pools — vault-style share accounting
// ═══════════════════════════════════════════════════════════════

export interface PoolLoanChange {
    principalReturnedUsd?: number;
    interestReturnedUsd?: number;
    lossUsd?: number;
    /** Change in Σ principal × APR of accruing loans (positive on disbursement, negative on repayment/default). */
    accruingDeltaUsdPerYear?: number;
    /** Change in accrued-but-unpaid interest (negative when interest is paid or written off). */
    receivableDeltaUsd?: number;
}

/**
 * Apply a loan event to its pool inside a transaction. The caller must have
 * read `pool` in the same transaction: interest accrual is brought up to `at`
 * before accruingUsdPerYear changes, so the pool's receivable always equals
 * the sum of its tracked loans' accrued interest.
 */
function applyPoolLoanChangeInTxn(
    txn: FirebaseFirestore.Transaction,
    pool: LendingPool,
    at: number,
    change: PoolLoanChange,
): void {
    const d = poolSettlementDeltas(change.principalReturnedUsd ?? 0, change.interestReturnedUsd ?? 0, change.lossUsd ?? 0);
    const accrued = accruePoolInterest(pool, at);
    txn.update(adminDb().collection(POOLS).doc(pool.id), {
        availableLiquidityUsd: FieldValue.increment(d.availableLiquidityUsd),
        totalLentUsd: FieldValue.increment(d.totalLentUsd),
        totalInterestEarnedUsd: FieldValue.increment(d.totalInterestEarnedUsd),
        totalDefaultedUsd: FieldValue.increment(d.totalDefaultedUsd),
        accruingUsdPerYear: Math.max(0, (pool.accruingUsdPerYear ?? 0) + (change.accruingDeltaUsdPerYear ?? 0)),
        interestReceivableUsd: Math.max(0, accrued.interestReceivableUsd + (change.receivableDeltaUsd ?? 0)),
        interestAccrualAt: accrued.interestAccrualAt,
    });
}

/** Annual interest a loan contributes to its pool's accrual at its current remaining principal. */
function loanAccruingUsdPerYear(loan: Pick<Loan, "principalRemainingUsd" | "interestRateBps">, principalUsd = loan.principalRemainingUsd): number {
    return principalUsd * (loan.interestRateBps / 10_000);
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
        pendingWithdrawalUsd: 0,
        pendingWithdrawalShares: 0,
        accruingUsdPerYear: 0,
        interestReceivableUsd: 0,
        interestAccrualAt: nowSec(),
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

export interface DepositCapacity {
    /** null = uncapped. */
    capacityUsd: number | null;
    paused: boolean;
    allowed: boolean;
}

/** What a wallet may deposit right now — check this BEFORE sending USDC. */
export async function getDepositCapacity(poolId: string, wallet: string): Promise<DepositCapacity> {
    const limits = lendingLimits();
    const [pool, position] = await Promise.all([getPool(poolId), getPoolPosition(poolId, wallet)]);
    if (!pool) throw new Error("Pool not found");
    const allowed = isWalletAllowed(limits, wallet);
    if (limits.paused || !allowed) return { capacityUsd: 0, paused: limits.paused, allowed };
    const cap = depositCapacityUsd(pool, position, limits);
    return { capacityUsd: Number.isFinite(cap) ? Math.floor(cap * 100) / 100 : null, paused: false, allowed };
}

/**
 * Verify a lender actually sent `amountUsd` USDC to the treasury on-chain,
 * then mint pool shares for it. The signature claim, share mint and deposit
 * record commit in one transaction. Throws if the signature doesn't check out
 * or has already been used.
 *
 * The money has already arrived by the time this runs, so the launch guards
 * never reject it: any part beyond the wallet's capacity (paused, not
 * allowlisted, over a cap) is credited as nothing and queued as a
 * deposit_refund payout instead.
 */
export async function confirmPoolDeposit(
    poolId: string,
    wallet: string,
    amountUsd: number,
    txSig: string,
): Promise<{ pool: LendingPool; position: PoolPosition | null; creditedUsd: number; refundedUsd: number }> {
    if (!(amountUsd > 0)) throw new Error("Deposit amount must be positive");

    const treasury = treasuryAddress();
    const transfer: VerifyTransferInput = {
        txSig,
        expectedFromWallet: wallet,
        expectedToWallet: treasury,
        expectedAmountUsd: amountUsd,
        purpose: "pool_deposit",
        refId: poolId,
    };
    await verifyUsdcTransfer(transfer);

    const limits = lendingLimits();
    const poolRef = adminDb().collection(POOLS).doc(poolId);
    const positionRef = adminDb().collection(POSITIONS).doc(`${poolId}_${wallet}`);
    const depositRef = adminDb().collection(DEPOSITS).doc();

    return adminDb().runTransaction(async (txn) => {
        const [poolSnap, posSnap] = await Promise.all([txn.get(poolRef), txn.get(positionRef)]);
        if (!poolSnap.exists) throw new Error("Pool not found");
        const pool = toPool(poolSnap.id, poolSnap.data()!);
        const existing = posSnap.exists ? (posSnap.data() as PoolPosition) : null;

        const at = nowSec();
        const capacity = limits.paused || !isWalletAllowed(limits, wallet) ? 0 : depositCapacityUsd(pool, existing, limits, at);
        const creditedUsd = Math.floor(Math.min(amountUsd, capacity) * 1_000_000) / 1_000_000;
        const refundedUsd = Math.round((amountUsd - creditedUsd) * 1_000_000) / 1_000_000;

        claimUsdcTransferInTxn(txn, transfer);

        if (refundedUsd > 0) {
            createPayoutInTxn(txn, {
                kind: "deposit_refund",
                fromWallet: treasury,
                toWallet: wallet,
                amountUsd: refundedUsd,
                poolId,
                reason: limits.paused
                    ? "Deposit arrived while lending was paused"
                    : !isWalletAllowed(limits, wallet)
                        ? "Wallet is not on the lending beta allowlist"
                        : "Deposit exceeded the pool or per-wallet beta cap",
            });
        }

        txn.set(depositRef, withoutUndefined({
            poolId,
            walletAddress: wallet,
            amountUsd: creditedUsd,
            refundedUsd: refundedUsd > 0 ? refundedUsd : undefined,
            txSig,
            depositedAt: at,
        }));

        if (creditedUsd <= 0) {
            return { pool, position: existing ? { ...existing, id: positionRef.id } : null, creditedUsd: 0, refundedUsd };
        }

        const sharesToMint = sharesForDeposit(pool, creditedUsd, at);

        txn.update(poolRef, {
            totalShares: FieldValue.increment(sharesToMint),
            availableLiquidityUsd: FieldValue.increment(creditedUsd),
            totalDepositedUsd: FieldValue.increment(creditedUsd),
        });

        if (existing) {
            txn.update(positionRef, {
                shares: FieldValue.increment(sharesToMint),
                principalDepositedUsd: FieldValue.increment(creditedUsd),
                updatedAt: FieldValue.serverTimestamp(),
            });
        } else {
            txn.set(positionRef, {
                poolId,
                walletAddress: wallet,
                shares: sharesToMint,
                principalDepositedUsd: creditedUsd,
                principalWithdrawnUsd: 0,
                pendingWithdrawalShares: 0,
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            });
        }

        return {
            pool: {
                ...pool,
                totalShares: pool.totalShares + sharesToMint,
                availableLiquidityUsd: pool.availableLiquidityUsd + creditedUsd,
                totalDepositedUsd: pool.totalDepositedUsd + creditedUsd,
            },
            position: {
                id: positionRef.id,
                poolId,
                walletAddress: wallet,
                shares: (existing?.shares || 0) + sharesToMint,
                principalDepositedUsd: (existing?.principalDepositedUsd || 0) + creditedUsd,
                principalWithdrawnUsd: existing?.principalWithdrawnUsd || 0,
                pendingWithdrawalShares: existing?.pendingWithdrawalShares || 0,
                createdAt: existing?.createdAt ?? Timestamp.now(),
                updatedAt: Timestamp.now(),
            },
            creditedUsd,
            refundedUsd,
        };
    });
}

/**
 * Lock in a withdrawal at today's share price and amount — the pool can't pay
 * it out itself (no signing key held here), so this opens a request that an
 * admin pays from the treasury by hand and confirms (see
 * confirmPoolWithdrawal). The request reserves its shares on the position and
 * its USD out of the pool's free liquidity in the same transaction, so a
 * lender can't stack requests beyond their position and a new loan can't take
 * liquidity that's already promised to a withdrawal.
 */
export async function requestPoolWithdrawal(poolId: string, wallet: string, amountUsd: number): Promise<PoolWithdrawalRequest> {
    if (!(amountUsd > 0)) throw new Error("Withdrawal amount must be positive");

    const poolRef = adminDb().collection(POOLS).doc(poolId);
    const positionRef = adminDb().collection(POSITIONS).doc(`${poolId}_${wallet}`);
    const requestRef = adminDb().collection(WITHDRAWALS).doc();

    return adminDb().runTransaction(async (txn) => {
        const [poolSnap, posSnap] = await Promise.all([txn.get(poolRef), txn.get(positionRef)]);
        if (!poolSnap.exists) throw new Error("Pool not found");
        if (!posSnap.exists) throw new Error("No position in this pool");
        const pool = toPool(poolSnap.id, poolSnap.data()!);
        const position = posSnap.data() as PoolPosition;

        const { sharesToBurn } = planWithdrawal(pool, position, amountUsd);

        const request: Omit<PoolWithdrawalRequest, "id"> = {
            poolId,
            walletAddress: wallet,
            amountUsd,
            sharesToBurn,
            status: "pending_payout",
            requestedAt: nowSec(),
            reserved: true,
        };
        txn.set(requestRef, request);
        txn.update(poolRef, {
            availableLiquidityUsd: FieldValue.increment(-amountUsd),
            pendingWithdrawalUsd: FieldValue.increment(amountUsd),
            pendingWithdrawalShares: FieldValue.increment(sharesToBurn),
        });
        txn.update(positionRef, {
            pendingWithdrawalShares: FieldValue.increment(sharesToBurn),
            updatedAt: FieldValue.serverTimestamp(),
        });
        return { id: requestRef.id, ...request };
    });
}

/**
 * Cancel a pending withdrawal and release its reservation. Allowed for the
 * requesting wallet or a platform admin (the route decides which). Only
 * requests that haven't been paid can be cancelled.
 */
export async function cancelPoolWithdrawal(requestId: string): Promise<PoolWithdrawalRequest> {
    const requestRef = adminDb().collection(WITHDRAWALS).doc(requestId);
    return adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(requestRef);
        if (!snap.exists) throw new Error("Withdrawal request not found");
        const request = { id: snap.id, ...snap.data() } as PoolWithdrawalRequest;
        if (request.status !== "pending_payout") throw new Error(`Withdrawal is not pending (status: ${request.status})`);

        if (request.reserved) {
            txn.update(adminDb().collection(POOLS).doc(request.poolId), {
                availableLiquidityUsd: FieldValue.increment(request.amountUsd),
                pendingWithdrawalUsd: FieldValue.increment(-request.amountUsd),
                pendingWithdrawalShares: FieldValue.increment(-request.sharesToBurn),
            });
            txn.update(adminDb().collection(POSITIONS).doc(`${request.poolId}_${request.walletAddress}`), {
                pendingWithdrawalShares: FieldValue.increment(-request.sharesToBurn),
                updatedAt: FieldValue.serverTimestamp(),
            });
        }
        const update = { status: "cancelled" as const, cancelledAt: nowSec() };
        txn.update(requestRef, update);
        return { ...request, ...update };
    });
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

    const transfer: VerifyTransferInput = {
        txSig,
        expectedFromWallet: treasuryAddress(),
        expectedToWallet: request.walletAddress,
        expectedAmountUsd: request.amountUsd,
        purpose: "pool_withdrawal",
        refId: requestId,
    };
    await verifyUsdcTransfer(transfer);

    const poolRef = adminDb().collection(POOLS).doc(request.poolId);
    const positionRef = adminDb().collection(POSITIONS).doc(`${request.poolId}_${request.walletAddress}`);

    return adminDb().runTransaction(async (txn) => {
        const [reqSnap, poolSnap, posSnap] = await Promise.all([txn.get(requestRef), txn.get(poolRef), txn.get(positionRef)]);
        if (!reqSnap.exists) throw new Error("Withdrawal request not found");
        const current = reqSnap.data() as PoolWithdrawalRequest;
        if (current.status !== "pending_payout") throw new Error(`Withdrawal is not pending (status: ${current.status})`);
        if (!poolSnap.exists) throw new Error("Pool not found");
        if (!posSnap.exists) throw new Error("Position not found");
        const pool = toPool(poolSnap.id, poolSnap.data()!);
        const position = posSnap.data() as PoolPosition;

        claimUsdcTransferInTxn(txn, transfer);

        const depositedDecrement = -Math.min(current.amountUsd, pool.totalDepositedUsd);
        if (current.reserved) {
            // Liquidity already left availableLiquidityUsd at request time.
            txn.update(poolRef, {
                totalShares: FieldValue.increment(-current.sharesToBurn),
                pendingWithdrawalUsd: FieldValue.increment(-current.amountUsd),
                pendingWithdrawalShares: FieldValue.increment(-current.sharesToBurn),
                totalDepositedUsd: FieldValue.increment(depositedDecrement),
            });
            txn.update(positionRef, {
                shares: FieldValue.increment(-current.sharesToBurn),
                pendingWithdrawalShares: FieldValue.increment(-current.sharesToBurn),
                principalWithdrawnUsd: FieldValue.increment(current.amountUsd),
                updatedAt: FieldValue.serverTimestamp(),
            });
        } else {
            // Legacy request from before reservations — re-check at payout time.
            if (current.sharesToBurn > position.shares - (position.pendingWithdrawalShares ?? 0) + 1e-9) {
                throw new Error("Position no longer holds enough shares for this legacy withdrawal — cancel it and reconcile manually");
            }
            txn.update(poolRef, {
                totalShares: FieldValue.increment(-current.sharesToBurn),
                availableLiquidityUsd: FieldValue.increment(-current.amountUsd),
                totalDepositedUsd: FieldValue.increment(depositedDecrement),
            });
            txn.update(positionRef, {
                shares: FieldValue.increment(-current.sharesToBurn),
                principalWithdrawnUsd: FieldValue.increment(current.amountUsd),
                updatedAt: FieldValue.serverTimestamp(),
            });
        }
        txn.update(requestRef, { status: "paid", txSig, paidAt: nowSec() });

        return {
            pool: {
                ...pool,
                totalShares: pool.totalShares - current.sharesToBurn,
                availableLiquidityUsd: current.reserved ? pool.availableLiquidityUsd : pool.availableLiquidityUsd - current.amountUsd,
                pendingWithdrawalUsd: (pool.pendingWithdrawalUsd ?? 0) - (current.reserved ? current.amountUsd : 0),
                pendingWithdrawalShares: (pool.pendingWithdrawalShares ?? 0) - (current.reserved ? current.sharesToBurn : 0),
            },
            position: {
                ...position,
                shares: position.shares - current.sharesToBurn,
                pendingWithdrawalShares: (position.pendingWithdrawalShares ?? 0) - (current.reserved ? current.sharesToBurn : 0),
                principalWithdrawnUsd: position.principalWithdrawnUsd + current.amountUsd,
            },
        };
    });
}

// ═══════════════════════════════════════════════════════════════
// Eligibility
// ═══════════════════════════════════════════════════════════════

export async function getEligibility(agentId: string): Promise<EligibilitySummary> {
    const policyResult = await resolveAgentPolicy(agentId, adminPolicyLoaders);
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
    /** Set by acceptLoanOffer so the reservation is written with the loan, never after it. */
    offerId?: string;
    reservedLenderWallet?: string;
}

export async function requestLoan(input: RequestLoanInput): Promise<Loan> {
    const { agentId, orgId, kind, source, purpose, requestedByWallet } = input;
    const amountUsd = Math.round(input.amountUsd * 100) / 100;
    const termDays = clampTermDays(input.termDays ?? 30);

    if (!(amountUsd >= MIN_LOAN_USD)) {
        throw new Error(`Loan amount must be at least $${MIN_LOAN_USD}`);
    }

    const limits = lendingLimits();
    assertCanOpenPosition(limits, requestedByWallet);
    if (limits.maxLoanUsd !== null && amountUsd > limits.maxLoanUsd) {
        throw new Error(`Loans are capped at $${limits.maxLoanUsd.toLocaleString()} during the lending beta`);
    }

    const policyResult = await resolveAgentPolicy(agentId, adminPolicyLoaders);
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

    const base: Omit<Loan, "id"> = withoutUndefined({
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
        // Trust loans can't be funded until their collateral is verified on-chain (see postLoanCollateral).
        collateralStatus: collateralUsd > 0 ? "awaiting" : "none",
        termDays,
        requestedAt: nowSec(),
        policyTierAtOrigination: policy.name,
        creditScoreAtOrigination: creditScore,
        purpose,
        status: collateralUsd > 0 ? "pending_collateral" : "pending",
    } satisfies Omit<Loan, "id">);

    if (input.offerId) base.offerId = input.offerId;
    if (input.reservedLenderWallet) base.reservedLenderWallet = input.reservedLenderWallet;

    if (!base.borrowerWalletAddress) {
        throw new Error("Agent has no wallet address on file — cannot receive a real loan disbursement");
    }

    const poolId = source === "pool" ? (input.poolId || (await listPools())[0].id) : undefined;
    const poolRef = poolId ? adminDb().collection(POOLS).doc(poolId) : null;
    const loanRef = adminDb().collection(LOANS).doc();
    // Re-count active loans inside the transaction so parallel requests can't
    // both slip under MAX_CONCURRENT_LOANS.
    const activeQuery = adminDb().collection(LOANS)
        .where("borrowerAgentId", "==", agentId)
        .where("status", "in", ACTIVE_LOAN_STATUSES);

    const created = await adminDb().runTransaction(async (txn) => {
        const activeSnap = await txn.get(activeQuery);
        const poolSnap = poolRef ? await txn.get(poolRef) : null;

        if (activeSnap.size >= MAX_CONCURRENT_LOANS) {
            throw new Error(`Maximum of ${MAX_CONCURRENT_LOANS} concurrent loans reached`);
        }

        if (!poolRef || !poolSnap) {
            txn.set(loanRef, base);
            return { id: loanRef.id, ...base };
        }

        // Pool-funded: reserve the liquidity now; real disbursement still needs an
        // admin to send it from the treasury and confirm (see confirmLoanDisbursement).
        // A trust loan holds the reservation while it waits for collateral; the
        // sweep releases it if collateral never arrives (see cancelLoan).
        if (!poolSnap.exists) throw new Error("Pool not found");
        const pool = toPool(poolSnap.id, poolSnap.data()!);
        if (pool.availableLiquidityUsd < amountUsd) {
            throw new Error("The pool does not have enough available liquidity for this loan right now");
        }

        const loan: Omit<Loan, "id"> = {
            ...base,
            status: collateralUsd > 0 ? "pending_collateral" : "pending_disbursement",
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
    return created;
}

/**
 * Activate a pending solo loan once its lender's USDC has verifiably reached
 * the borrower. The transfer has already happened by the time this runs, so
 * if the loan is no longer fundable by this wallet (already funded by someone
 * else, cancelled, reserved for a different lender), the signature is still
 * claimed and a funding_refund payout is queued from the borrower back to
 * the lender, instead of leaving the money unaccounted for.
 */
export async function fundLoanSolo(loanId: string, lenderWallet: string, txSig: string): Promise<Loan> {
    const loanRef = adminDb().collection(LOANS).doc(loanId);
    const loan = await getLoan(loanId);
    if (!loan) throw new Error("Loan not found");
    if (loan.source !== "solo") throw new Error("Only solo loan requests can be funded directly");
    if (!loan.borrowerWalletAddress) throw new Error("Borrower has no wallet address on file");

    const transfer: VerifyTransferInput = {
        txSig,
        expectedFromWallet: lenderWallet,
        expectedToWallet: loan.borrowerWalletAddress,
        expectedAmountUsd: loan.principalUsd,
        purpose: "solo_loan_fund",
        refId: loanId,
    };
    await verifyUsdcTransfer(transfer);

    const result = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        const current = toLoan(snap.id, snap.data()!);

        claimUsdcTransferInTxn(txn, transfer);

        const reservedForOther = !!current.reservedLenderWallet && current.reservedLenderWallet !== lenderWallet;
        if (current.status !== "pending" || reservedForOther) {
            createPayoutInTxn(txn, {
                kind: "funding_refund",
                fromWallet: current.borrowerWalletAddress!,
                toWallet: lenderWallet,
                amountUsd: current.principalUsd,
                loanId,
                reason: reservedForOther
                    ? "Funding sent for a loan reserved for a different lender's offer"
                    : `Funding arrived after the loan was no longer open (status: ${current.status})`,
            });
            return { refunded: true as const, status: current.status, reservedForOther };
        }

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
        return { refunded: false as const, loan: { ...current, ...update } };
    });

    if (result.refunded) {
        throw new Error(
            result.reservedForOther
                ? "This loan is reserved for a different lender. Your transfer was recorded and a refund from the borrower has been queued."
                : `This loan was no longer open for funding (status: ${result.status}). Your transfer was recorded and a refund from the borrower has been queued.`,
        );
    }
    return result.loan;
}

/**
 * Borrower posts a trust loan's collateral: verify the USDC reached the
 * treasury from `wallet`, mark it held, and move the loan on to funding
 * ("pending" for solo — now visible to lenders — or "pending_disbursement"
 * for pool). If the loan was cancelled or expired in the meantime, the
 * collateral is still recorded and queued straight back to the poster.
 */
export async function postLoanCollateral(loanId: string, wallet: string, txSig: string): Promise<Loan> {
    const loanRef = adminDb().collection(LOANS).doc(loanId);
    const loan = await getLoan(loanId);
    if (!loan) throw new Error("Loan not found");
    if (!(loan.collateralUsd > 0)) throw new Error("This loan doesn't require collateral");
    if (loan.collateralStatus && loan.collateralStatus !== "awaiting") throw new Error(`Collateral already ${loan.collateralStatus.replace("_", " ")}`);

    const treasury = treasuryAddress();
    const transfer: VerifyTransferInput = {
        txSig,
        expectedFromWallet: wallet,
        expectedToWallet: treasury,
        expectedAmountUsd: loan.collateralUsd,
        purpose: "loan_collateral",
        refId: loanId,
    };
    await verifyUsdcTransfer(transfer);

    const result = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        const current = toLoan(snap.id, snap.data()!);

        claimUsdcTransferInTxn(txn, transfer);

        if (current.status !== "pending_collateral" || (current.collateralStatus && current.collateralStatus !== "awaiting")) {
            createPayoutInTxn(txn, {
                kind: "collateral_return",
                fromWallet: treasury,
                toWallet: wallet,
                amountUsd: current.collateralUsd,
                loanId,
                reason: `Collateral arrived after the loan was no longer awaiting it (status: ${current.status})`,
            });
            return { returned: true as const, status: current.status };
        }

        const update = {
            status: current.source === "pool" ? ("pending_disbursement" as const) : ("pending" as const),
            collateralStatus: "held" as const,
            collateralTxSig: txSig,
            collateralPostedByWallet: wallet,
        };
        txn.update(loanRef, update);
        return { returned: false as const, loan: { ...current, ...update } };
    });

    if (result.returned) {
        throw new Error(`This loan is no longer awaiting collateral (status: ${result.status}). Your transfer was recorded and its return has been queued.`);
    }
    invalidateCache(`credit:${loan.borrowerAgentId}`);
    return result.loan;
}

/** Statuses a borrower may cancel themselves — nobody else can have money in flight for these. */
const BORROWER_CANCELLABLE: Loan["status"][] = ["pending_collateral"];
/** Statuses an admin (or the expiry sweep, for pending_collateral) may cancel. */
const ADMIN_CANCELLABLE: Loan["status"][] = ["pending_collateral", "pending", "pending_disbursement"];

/**
 * Cancel a loan that was never funded: release any pool liquidity it
 * reserved and queue its collateral back if it was posted. Borrowers can
 * only cancel while it's still awaiting collateral; once it's open to a
 * lender or waiting on a treasury payout, someone else may already be
 * sending money, so only an admin can cancel it.
 */
export async function cancelLoan(loanId: string, opts: { byAdmin: boolean; reason: string }): Promise<Loan> {
    const loanRef = adminDb().collection(LOANS).doc(loanId);
    const loan = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        const current = toLoan(snap.id, snap.data()!);
        const allowed = opts.byAdmin ? ADMIN_CANCELLABLE : BORROWER_CANCELLABLE;
        if (!allowed.includes(current.status)) {
            throw new Error(
                opts.byAdmin || !ADMIN_CANCELLABLE.includes(current.status)
                    ? `Loan can't be cancelled (status: ${current.status})`
                    : "Once a loan is open to lenders or awaiting disbursement only a platform admin can cancel it",
            );
        }

        const update: Partial<Loan> = { status: "cancelled", cancelledAt: nowSec(), cancelReason: opts.reason };

        if (current.collateralStatus === "held" && current.collateralPostedByWallet) {
            createPayoutInTxn(txn, {
                kind: "collateral_return",
                fromWallet: treasuryAddress(),
                toWallet: current.collateralPostedByWallet,
                amountUsd: current.collateralUsd,
                loanId,
                reason: `Loan cancelled: ${opts.reason}`,
            });
            update.collateralStatus = "return_pending";
        }

        // Pool loans reserved their principal at request time.
        if (current.source === "pool" && current.poolId) {
            txn.update(adminDb().collection(POOLS).doc(current.poolId), {
                availableLiquidityUsd: FieldValue.increment(current.principalUsd),
                totalLentUsd: FieldValue.increment(-current.principalUsd),
            });
        }

        txn.update(loanRef, update as FirebaseFirestore.UpdateData<Loan>);
        return { ...current, ...update } as Loan;
    });
    invalidateCache(`credit:${loan.borrowerAgentId}`);
    return loan;
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
    const limits = lendingLimits();
    assertCanOpenPosition(limits, input.lenderWalletAddress);
    const amountUsd = Math.round(input.amountUsd * 100) / 100;
    if (limits.maxLoanUsd !== null && amountUsd > limits.maxLoanUsd) {
        throw new Error(`Offers are capped at $${limits.maxLoanUsd.toLocaleString()} during the lending beta`);
    }
    if (!(amountUsd >= MIN_LOAN_USD)) {
        throw new Error(`Offer amount must be at least $${MIN_LOAN_USD}`);
    }
    const rateBps = Math.round(input.rateBps);
    if (!Number.isFinite(rateBps) || rateBps < OFFER_MIN_RATE_BPS || rateBps > OFFER_MAX_RATE_BPS) {
        throw new Error(`Rate must be between ${(OFFER_MIN_RATE_BPS / 100).toFixed(1)}% and ${(OFFER_MAX_RATE_BPS / 100).toFixed(1)}% APR`);
    }

    const offer: Omit<LoanOffer, "id"> = withoutUndefined({
        lenderWalletAddress: input.lenderWalletAddress,
        kind: input.kind,
        amountUsd,
        rateBps,
        termDays: clampTermDays(input.termDays ?? 30),
        note: input.note,
        status: "open",
        createdAt: nowSec(),
    } satisfies Omit<LoanOffer, "id">);
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
            offerId: offer.id,
            reservedLenderWallet: offer.lenderWalletAddress,
        });

        await offerRef.update({ acceptedLoanId: loan.id, acceptedAt: nowSec() });

        return loan;
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

    const transfer: VerifyTransferInput = {
        txSig,
        expectedFromWallet: treasuryAddress(),
        expectedToWallet: loan.borrowerWalletAddress,
        expectedAmountUsd: loan.principalUsd,
        purpose: "loan_disbursement",
        refId: loanId,
    };
    await verifyUsdcTransfer(transfer);

    return adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        const current = toLoan(snap.id, snap.data()!);
        if (current.status !== "pending_disbursement") throw new Error(`Loan is not awaiting disbursement (status: ${current.status})`);
        const poolSnap = current.poolId ? await txn.get(adminDb().collection(POOLS).doc(current.poolId)) : null;

        claimUsdcTransferInTxn(txn, transfer);

        const originatedAt = nowSec();
        const update = {
            status: "active" as const,
            originatedAt,
            dueAt: originatedAt + current.termDays * 86400,
            lastAccrualAt: originatedAt,
            disbursementTxSig: txSig,
            poolAccrualTracked: !!poolSnap?.exists,
        };
        txn.update(loanRef, update);
        // Interest starts accruing now — fold this loan into the pool's accrual.
        if (poolSnap?.exists) {
            applyPoolLoanChangeInTxn(txn, toPool(poolSnap.id, poolSnap.data()!), originatedAt, {
                accruingDeltaUsdPerYear: loanAccruingUsdPerYear(current, current.principalUsd),
            });
        }
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

/**
 * Apply a verified repayment. Signature claim, loan update, repayment record,
 * pool settlement and any payouts it triggers (overpayment refund, collateral
 * return) all commit in one transaction.
 *
 * If the loan is no longer active when the money lands (repaid or defaulted
 * in the meantime), the transfer is still claimed and refunded in full via a
 * repayment_refund payout rather than dropped.
 */
export async function repayLoan(loanId: string, amountUsd: number, paidByWallet: string, txSig: string): Promise<{ loan: Loan; repayment: LoanRepayment }> {
    if (!(amountUsd > 0)) throw new Error("Repayment amount must be positive");
    const loanRef = adminDb().collection(LOANS).doc(loanId);

    const existing = await getLoan(loanId);
    if (!existing) throw new Error("Loan not found");
    if (!["active", "repaid", "defaulted"].includes(existing.status)) {
        throw new Error(`Loan hasn't been funded yet (status: ${existing.status})`);
    }

    const recipientWallet = existing.source === "pool" ? treasuryAddress() : existing.lenderWalletAddress;
    if (!recipientWallet) throw new Error("No lender wallet on file to verify repayment against");

    const transfer: VerifyTransferInput = {
        txSig,
        expectedFromWallet: paidByWallet,
        expectedToWallet: recipientWallet,
        expectedAmountUsd: amountUsd,
        purpose: "loan_repayment",
        refId: loanId,
    };
    await verifyUsdcTransfer(transfer);

    const result = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        let loan = toLoan(snap.id, snap.data()!);
        const poolSnap = loan.status === "active" && loan.poolId
            ? await txn.get(adminDb().collection(POOLS).doc(loan.poolId))
            : null;

        claimUsdcTransferInTxn(txn, transfer);

        if (loan.status !== "active") {
            createPayoutInTxn(txn, {
                kind: "repayment_refund",
                fromWallet: recipientWallet,
                toWallet: paidByWallet,
                amountUsd,
                loanId,
                reason: `Repayment arrived after the loan was closed (status: ${loan.status})`,
            });
            return { refunded: true as const, status: loan.status };
        }

        const at = nowSec();
        loan = accrue(loan, at);

        const {
            loan: paidLoan, appliedUsd, principalPortionUsd, interestPortionUsd, remainingBalanceUsd, excessUsd, finalStatus,
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
        if (excessUsd > 0) update.overpaymentOwedUsd = (loan.overpaymentOwedUsd ?? 0) + excessUsd;

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
            ...(excessUsd > 0 ? { excessUsd, refundStatus: "pending" as const } : {}),
        };
        txn.set(repaymentRef, repayment);

        if (excessUsd > 0) {
            createPayoutInTxn(txn, {
                kind: "overpayment_refund",
                fromWallet: recipientWallet,
                toWallet: paidByWallet,
                amountUsd: excessUsd,
                loanId,
                repaymentId: repaymentRef.id,
                reason: "Repayment exceeded the remaining balance",
            });
        }

        if (finalStatus === "repaid" && loan.collateralStatus === "held" && loan.collateralPostedByWallet) {
            createPayoutInTxn(txn, {
                kind: "collateral_return",
                fromWallet: treasuryAddress(),
                toWallet: loan.collateralPostedByWallet,
                amountUsd: loan.collateralUsd,
                loanId,
                reason: "Loan repaid in full",
            });
            update.collateralStatus = "return_pending";
        }

        txn.update(loanRef, update as FirebaseFirestore.UpdateData<Loan>);

        if (poolSnap?.exists) {
            const tracked = !!loan.poolAccrualTracked;
            applyPoolLoanChangeInTxn(txn, toPool(poolSnap.id, poolSnap.data()!), at, {
                principalReturnedUsd: principalPortionUsd,
                interestReturnedUsd: interestPortionUsd,
                accruingDeltaUsdPerYear: tracked ? -loanAccruingUsdPerYear(loan, principalPortionUsd) : 0,
                receivableDeltaUsd: tracked ? -interestPortionUsd : 0,
            });
        }

        return { refunded: false as const, loan: { ...loan, ...update } as Loan, repayment };
    });

    if (result.refunded) {
        throw new Error(`This loan was already closed (status: ${result.status}). Your transfer was recorded and a full refund has been queued.`);
    }

    if (result.loan.status === "repaid") {
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
    }

    return { loan: result.loan, repayment: result.repayment };
}

/**
 * Close an overdue active loan as "defaulted". Called by a platform admin
 * (graceDays 0 — any time after dueAt) or by the lending sweep (with the
 * configured grace period). Late payments never default a loan by themselves.
 *
 * Held collateral is seized and applied to principal, then accrued interest;
 * anything left over is queued back to the borrower. For pool loans the
 * recovery goes straight back into the pool (the collateral is already in the
 * treasury); for solo loans it's queued as a payout to the lender. Whatever
 * principal isn't covered is written off against the pool.
 */
export async function markLoanDefaulted(loanId: string, opts: { graceDays?: number } = {}): Promise<Loan> {
    const graceSec = Math.max(0, opts.graceDays ?? 0) * 86400;
    const loanRef = adminDb().collection(LOANS).doc(loanId);

    const { loan, recovery } = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        let current = toLoan(snap.id, snap.data()!);
        if (current.status !== "active") throw new Error(`Loan is not active (status: ${current.status})`);
        if (!current.dueAt || nowSec() <= current.dueAt + graceSec) {
            throw new Error(graceSec > 0 ? "Loan is not past its due date plus grace period yet" : "Loan is not past its due date yet");
        }
        const poolSnap = current.poolId ? await txn.get(adminDb().collection(POOLS).doc(current.poolId)) : null;

        const at = nowSec();
        current = accrue(current, at);

        const collateralHeld = current.collateralStatus === "held" ? current.collateralUsd : 0;
        const rec = computeDefaultRecovery(current.principalRemainingUsd, current.interestAccruedUsd, collateralHeld);
        const recoveredUsd = rec.recoveredPrincipalUsd + rec.recoveredInterestUsd;

        const update: Partial<Loan> = {
            interestAccruedUsd: current.interestAccruedUsd,
            lastAccrualAt: current.lastAccrualAt,
            status: "defaulted",
            defaultedAt: at,
        };
        if (collateralHeld > 0) update.collateralStatus = "seized";
        txn.update(loanRef, update as FirebaseFirestore.UpdateData<Loan>);

        if (poolSnap?.exists) {
            const tracked = !!current.poolAccrualTracked;
            applyPoolLoanChangeInTxn(txn, toPool(poolSnap.id, poolSnap.data()!), at, {
                principalReturnedUsd: rec.recoveredPrincipalUsd,
                interestReturnedUsd: rec.recoveredInterestUsd,
                lossUsd: rec.principalLossUsd,
                accruingDeltaUsdPerYear: tracked ? -loanAccruingUsdPerYear(current) : 0,
                receivableDeltaUsd: tracked ? -current.interestAccruedUsd : 0,
            });
        } else if (recoveredUsd > 0 && current.lenderWalletAddress) {
            createPayoutInTxn(txn, {
                kind: "collateral_to_lender",
                fromWallet: treasuryAddress(),
                toWallet: current.lenderWalletAddress,
                amountUsd: recoveredUsd,
                loanId,
                reason: "Seized collateral from a defaulted solo loan",
            });
        }

        if (rec.collateralExcessUsd > 0 && current.collateralPostedByWallet) {
            createPayoutInTxn(txn, {
                kind: "collateral_return",
                fromWallet: treasuryAddress(),
                toWallet: current.collateralPostedByWallet,
                amountUsd: rec.collateralExcessUsd,
                loanId,
                reason: "Collateral left over after covering the defaulted balance",
            });
        }

        return { loan: { ...current, ...update } as Loan, recovery: rec };
    });

    const recoveryRatio = loan.principalRemainingUsd > 0 ? clamp(recovery.recoveredPrincipalUsd / loan.principalRemainingUsd, 0, 1) : 1;
    const baseCredit = loan.kind === "unsecured" ? -55 : -25;
    const baseTrust = loan.kind === "unsecured" ? -20 : -8;
    await applyLoanCreditEvent(
        loan.borrowerAgentId,
        Math.round(baseCredit * (1 - recoveryRatio * 0.5)),
        Math.round(baseTrust * (1 - recoveryRatio * 0.5)),
        `Defaulted on ${loan.kind} loan ($${loan.principalRemainingUsd.toLocaleString()} outstanding)`,
        "loan_defaulted",
        {
            loanId: loan.id,
            kind: loan.kind,
            outstandingUsd: loan.principalRemainingUsd,
            recoveredUsd: recovery.recoveredPrincipalUsd + recovery.recoveredInterestUsd,
        },
    );
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
