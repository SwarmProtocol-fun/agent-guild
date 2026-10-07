/**
 * Lending Service — Firestore-backed loan and pool ledger, backed by real
 * on-chain transfers. Each pool lends one asset (USDC or SOL on Solana, ETH
 * on Ethereum) and is accounted in that asset's units — see assets.ts.
 * Solo loans and offers are USDC.
 *
 * Every balance-changing action requires a verified on-chain transfer before
 * Firestore is updated, and the signature's replay-guard claim is written in
 * the same Firestore transaction as the credit — so a credit that fails can't
 * burn a signature the user really paid with: a human sends USDC from their own wallet (deposit,
 * solo loan funding, repayment) or a platform admin manually pays out from
 * the treasury and confirms (pool withdrawal, pool-funded loan disbursement).
 * This module never holds a signing key — see verify.ts for the read-only
 * verification it calls before crediting anything.
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
import { verifyLendingTransfer, claimLendingTransferInTxn, treasuryFor, normalizeTxSig, type VerifyTransferInput } from "./verify";
import { assetOf, collateralAssetOf, poolLabel, roundAmount, floorAmount, ceilAmount, formatAssetAmount, LENDING_ASSETS, type LendingAsset } from "./assets";
import { getUsdPrice } from "./prices";
import { normalizeLegacy, healLegacyInTxn } from "./legacy-fields";
import { isAddress } from "viem";
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
    depositCapacity,
    loanToValue,
} from "./math";
import { SOLANA_WALLET_LINKS_COLLECTION, isSolanaAddress } from "@/lib/identity-nft-service";
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
const ACTIVE_LOAN_STATUSES: string[] = ["pending_collateral", "pending", "pending_disbursement", "active", "liquidating"];

/**
 * The pools lending offers. Single-asset pools lend and take back one asset.
 * Collateral markets ("usdc/eth", "usdc/sol") lend USDC against locked
 * ETH/SOL. The original USDC pool keeps its auto-id document; the rest get
 * fixed ids so seeding is idempotent.
 */
type PoolKey = "usdc" | "sol" | "eth" | "usdc/eth" | "usdc/sol";
interface PoolDefinition {
    id: string | null;
    asset: LendingAsset;
    collateralAsset?: LendingAsset;
    maxLtvBps?: number;
    liquidationLtvBps?: number;
    name: string;
    description: string;
}
const DEFAULT_POOLS: Record<PoolKey, PoolDefinition> = {
    usdc: { id: null, asset: "usdc", name: "Community Lending Pool", description: "Diversified community pool — lower risk, funds agents automatically as they qualify." },
    sol: { id: "community-sol", asset: "sol", name: "SOL Lending Pool", description: "Lend SOL, earn SOL. Loans from this pool are paid out and repaid in SOL." },
    eth: { id: "community-eth", asset: "eth", name: "ETH Lending Pool", description: "Lend ETH on Ethereum, earn ETH. Loans from this pool are paid out and repaid in ETH." },
    "usdc/eth": {
        id: "market-usdc-eth", asset: "usdc", collateralAsset: "eth", maxLtvBps: 6500, liquidationLtvBps: 8000,
        name: "USDC/ETH Market", description: "Lend USDC, earn USDC. Borrowers lock ETH worth at least 1.5× the loan; liquidated if the loan reaches 80% of the ETH's value.",
    },
    "usdc/sol": {
        id: "market-usdc-sol", asset: "usdc", collateralAsset: "sol", maxLtvBps: 5500, liquidationLtvBps: 7500,
        name: "USDC/SOL Market", description: "Lend USDC, earn USDC. Borrowers lock SOL worth at least 1.8× the loan; liquidated if the loan reaches 75% of the SOL's value.",
    },
};

function poolKey(pool: Pick<LendingPool, "asset" | "collateralAsset">): string {
    return pool.collateralAsset ? `${assetOf(pool)}/${pool.collateralAsset}` : assetOf(pool);
}

/** ETH and USDC/ETH need the Ethereum treasury configured; the rest use the Solana treasury. */
function enabledPools(): PoolKey[] {
    return process.env.ETH_LENDING_TREASURY_ADDRESS ? ["usdc", "sol", "eth", "usdc/eth", "usdc/sol"] : ["usdc", "sol", "usdc/sol"];
}

// ═══════════════════════════════════════════════════════════════
// Time helpers
// ═══════════════════════════════════════════════════════════════

const nowSec = () => Math.floor(Date.now() / 1000);

/** Firestore here isn't configured with ignoreUndefinedProperties — optional fields must be dropped, not written as undefined. */
function withoutUndefined<T extends object>(obj: T): T {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function toLoan(id: string, data: FirebaseFirestore.DocumentData): Loan {
    return { id, ...normalizeLegacy("loans", data) } as Loan;
}

function toPool(id: string, data: FirebaseFirestore.DocumentData): LendingPool {
    return { id, ...normalizeLegacy("lendingPools", data) } as LendingPool;
}

function toPosition(id: string, data: FirebaseFirestore.DocumentData): PoolPosition {
    return { id, ...normalizeLegacy("lendingPoolPositions", data) } as PoolPosition;
}

function toWithdrawal(id: string, data: FirebaseFirestore.DocumentData): PoolWithdrawalRequest {
    return { id, ...normalizeLegacy("lendingPoolWithdrawals", data) } as PoolWithdrawalRequest;
}

// ═══════════════════════════════════════════════════════════════
// Pools — vault-style share accounting
// ═══════════════════════════════════════════════════════════════

export interface PoolLoanChange {
    principalReturned?: number;
    interestReturned?: number;
    loss?: number;
    /** Change in Σ principal × APR of accruing loans (positive on disbursement, negative on repayment/default). */
    accruingDeltaPerYear?: number;
    /** Change in accrued-but-unpaid interest (negative when interest is paid or written off). */
    receivableDelta?: number;
}

/**
 * Apply a loan event to its pool inside a transaction. The caller must have
 * read `pool` in the same transaction: interest accrual is brought up to `at`
 * before accruingPerYear changes, so the pool's receivable always equals
 * the sum of its tracked loans' accrued interest.
 */
function applyPoolLoanChangeInTxn(
    txn: FirebaseFirestore.Transaction,
    pool: LendingPool,
    at: number,
    change: PoolLoanChange,
): void {
    const d = poolSettlementDeltas(change.principalReturned ?? 0, change.interestReturned ?? 0, change.loss ?? 0);
    const accrued = accruePoolInterest(pool, at);
    txn.update(adminDb().collection(POOLS).doc(pool.id), {
        availableLiquidity: FieldValue.increment(d.availableLiquidity),
        totalLent: FieldValue.increment(d.totalLent),
        totalInterestEarned: FieldValue.increment(d.totalInterestEarned),
        totalDefaulted: FieldValue.increment(d.totalDefaulted),
        accruingPerYear: Math.max(0, (pool.accruingPerYear ?? 0) + (change.accruingDeltaPerYear ?? 0)),
        interestReceivable: Math.max(0, accrued.interestReceivable + (change.receivableDelta ?? 0)),
        interestAccrualAt: accrued.interestAccrualAt,
    });
}

/** Annual interest a loan contributes to its pool's accrual at its current remaining principal. */
function loanAccruingPerYear(loan: Pick<Loan, "principalRemaining" | "interestRateBps">, principal = loan.principalRemaining): number {
    return principal * (loan.interestRateBps / 10_000);
}

/** Idempotently ensures every enabled pool exists, and returns all pools (oldest first). */
export async function listPools(): Promise<LendingPool[]> {
    const snap = await adminDb().collection(POOLS).orderBy("createdAt", "asc").get();
    const pools = snap.docs.map((d) => toPool(d.id, d.data()));
    const have = new Set(pools.map(poolKey));
    for (const key of enabledPools()) {
        if (have.has(key)) continue;
        const { id, ...def } = DEFAULT_POOLS[key];
        pools.push(await createPool({ ...def, id: id ?? undefined }));
    }
    return pools;
}

/** The oldest single-asset pool for `asset` — where a pool loan goes when no poolId is given. */
async function defaultPoolFor(asset: LendingAsset): Promise<LendingPool> {
    const pool = (await listPools()).find((p) => assetOf(p) === asset && !p.collateralAsset);
    if (!pool) throw new Error(`No ${LENDING_ASSETS[asset].symbol} pool is available`);
    return pool;
}

export async function getPool(poolId: string): Promise<LendingPool | null> {
    const snap = await adminDb().collection(POOLS).doc(poolId).get();
    return snap.exists ? toPool(snap.id, snap.data()!) : null;
}

export async function createPool(input: {
    name: string;
    description?: string;
    createdBy?: string;
    asset?: LendingAsset;
    collateralAsset?: LendingAsset;
    maxLtvBps?: number;
    liquidationLtvBps?: number;
    id?: string;
}): Promise<LendingPool> {
    const asset = input.asset ?? "usdc";
    if (input.collateralAsset && !(input.maxLtvBps && input.liquidationLtvBps && input.maxLtvBps < input.liquidationLtvBps && input.liquidationLtvBps < 10_000)) {
        throw new Error("A collateral market needs 0 < maxLtvBps < liquidationLtvBps < 10000");
    }
    const doc = {
        name: input.name,
        description: input.description || "",
        ...(asset === "usdc" ? {} : { asset }),
        ...(input.collateralAsset ? { collateralAsset: input.collateralAsset, maxLtvBps: input.maxLtvBps, liquidationLtvBps: input.liquidationLtvBps } : {}),
        totalShares: 0,
        availableLiquidity: 0,
        totalLent: 0,
        totalDeposited: 0,
        totalInterestEarned: 0,
        totalDefaulted: 0,
        pendingWithdrawal: 0,
        pendingWithdrawalShares: 0,
        accruingPerYear: 0,
        interestReceivable: 0,
        interestAccrualAt: nowSec(),
        createdAt: FieldValue.serverTimestamp(),
        createdBy: input.createdBy || null,
    };
    let id: string;
    if (input.id) {
        // Fixed id: a concurrent seeder may have created it first — then use theirs.
        const ref = adminDb().collection(POOLS).doc(input.id);
        try {
            await ref.create(doc);
        } catch (err) {
            const existing = await ref.get();
            if (!existing.exists) throw err;
            return toPool(existing.id, existing.data()!);
        }
        id = input.id;
    } else {
        id = (await adminDb().collection(POOLS).add(doc)).id;
    }
    return { id, ...doc, createdAt: Timestamp.now() } as unknown as LendingPool;
}

export async function getPoolPosition(poolId: string, wallet: string): Promise<PoolPosition | null> {
    const id = `${poolId}_${wallet}`;
    const snap = await adminDb().collection(POSITIONS).doc(id).get();
    return snap.exists ? toPosition(snap.id, snap.data()!) : null;
}

export async function listPositionsForWallet(wallet: string): Promise<PoolPosition[]> {
    const snap = await adminDb().collection(POSITIONS).where("walletAddress", "==", wallet).get();
    return snap.docs.map((d) => toPosition(d.id, d.data()));
}

export interface DepositCapacity {
    /** null = uncapped. */
    capacity: number | null;
    paused: boolean;
    allowed: boolean;
}

/** What a wallet may deposit right now — check this BEFORE sending USDC. */
export async function getDepositCapacity(poolId: string, wallet: string): Promise<DepositCapacity> {
    const limits = lendingLimits();
    const [pool, position] = await Promise.all([getPool(poolId), getPoolPosition(poolId, wallet)]);
    if (!pool) throw new Error("Pool not found");
    const allowed = isWalletAllowed(limits, wallet);
    if (limits.paused || !allowed) return { capacity: 0, paused: limits.paused, allowed };
    const asset = assetOf(pool);
    const cap = depositCapacity(pool, position, await capsInAssetUnits(limits, asset));
    return { capacity: Number.isFinite(cap) ? floorAmount(asset, cap) : null, paused: false, allowed };
}

/** The beta's USD caps expressed in `asset` units at the current price (no price needed for USDC or when uncapped). */
async function capsInAssetUnits(
    limits: { maxPoolTvlUsd: number | null; maxDepositPerWalletUsd: number | null },
    asset: LendingAsset,
): Promise<{ maxPoolTvlUsd: number | null; maxDepositPerWalletUsd: number | null }> {
    if (asset === "usdc" || (limits.maxPoolTvlUsd === null && limits.maxDepositPerWalletUsd === null)) return limits;
    const price = await getUsdPrice(asset);
    return {
        maxPoolTvlUsd: limits.maxPoolTvlUsd === null ? null : limits.maxPoolTvlUsd / price,
        maxDepositPerWalletUsd: limits.maxDepositPerWalletUsd === null ? null : limits.maxDepositPerWalletUsd / price,
    };
}

/**
 * The wallet that sends or receives `asset` on-chain for `account`, the
 * signed-in identity. Solana assets: a Solana login is its own wallet; an
 * EVM login must have linked one by signature (POST /api/v1/solana/link).
 * ETH: the account must be an Ethereum address. Ledger records stay keyed by
 * `account`; only transfers and payouts use the result.
 */
export async function resolvePayerWallet(account: string, asset: LendingAsset = "usdc"): Promise<string> {
    if (LENDING_ASSETS[asset].chain === "ethereum") {
        if (isAddress(account, { strict: false })) return account.toLowerCase();
        throw new Error("The ETH pool needs an Ethereum wallet — sign in with one to use it");
    }
    if (!account.startsWith("0x")) return account;
    const link = await adminDb().collection(SOLANA_WALLET_LINKS_COLLECTION).doc(account).get();
    const linked = link.data()?.solanaAddress;
    if (typeof linked === "string" && isSolanaAddress(linked)) return linked;
    throw new Error("Link a Solana wallet to this account first — lending moves USDC on Solana");
}

/**
 * Where a borrower's loan is paid out. On Solana: the agent's wallet, or its
 * EVM owner's linked Solana wallet. On Ethereum: the agent's wallet if it's
 * an Ethereum address, otherwise the requesting member's.
 */
async function resolveBorrowerWallet(agentWallet: string | undefined, requestedByWallet: string | undefined, asset: LendingAsset): Promise<string | undefined> {
    if (LENDING_ASSETS[asset].chain === "ethereum") {
        const evm = [agentWallet, requestedByWallet].find((w) => !!w && isAddress(w, { strict: false }));
        return evm?.toLowerCase();
    }
    return agentWallet ? resolvePayerWallet(agentWallet).catch(() => undefined) : undefined;
}

/**
 * Verify a lender actually sent `amount` (in the pool's asset) to that
 * asset's treasury on-chain, then mint pool shares for it. The signature claim, share mint and deposit
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
    amount: number,
    txSig: string,
): Promise<{ pool: LendingPool; position: PoolPosition | null; credited: number; refunded: number }> {
    const target = await getPool(poolId);
    if (!target) throw new Error("Pool not found");
    const asset = assetOf(target);
    amount = roundAmount(asset, amount);
    if (!(amount > 0)) throw new Error("Deposit amount must be positive");

    const treasury = treasuryFor(asset);
    const payer = await resolvePayerWallet(wallet, asset);
    const transfer: VerifyTransferInput = {
        txSig: normalizeTxSig(asset, txSig),
        expectedFromWallet: payer,
        expectedToWallet: treasury,
        expectedAmount: amount,
        purpose: "pool_deposit",
        refId: poolId,
    };
    await verifyLendingTransfer(asset, transfer);

    const limits = lendingLimits();
    // Priced before the transaction: if no trustworthy price is available the
    // deposit fails here, unclaimed, and the same signature can be retried.
    const caps = await capsInAssetUnits(limits, asset);
    const poolRef = adminDb().collection(POOLS).doc(poolId);
    const positionRef = adminDb().collection(POSITIONS).doc(`${poolId}_${wallet}`);
    const depositRef = adminDb().collection(DEPOSITS).doc();

    return adminDb().runTransaction(async (txn) => {
        const [poolSnap, posSnap] = await Promise.all([txn.get(poolRef), txn.get(positionRef)]);
        if (!poolSnap.exists) throw new Error("Pool not found");
        const pool = toPool(poolSnap.id, poolSnap.data()!);
        const existing = posSnap.exists ? toPosition(posSnap.id, posSnap.data()!) : null;
        healLegacyInTxn(txn, poolRef, "lendingPools", poolSnap.data());
        healLegacyInTxn(txn, positionRef, "lendingPoolPositions", posSnap.data());

        const at = nowSec();
        const capacity = limits.paused || !isWalletAllowed(limits, wallet) ? 0 : depositCapacity(pool, existing, caps, at);
        const credited = floorAmount(asset, Math.min(amount, capacity));
        const refunded = roundAmount(asset, amount - credited);

        claimLendingTransferInTxn(asset, txn, transfer);

        if (refunded > 0) {
            createPayoutInTxn(txn, {
                kind: "deposit_refund",
                fromWallet: treasury,
                toWallet: payer,
                amount: refunded,
                asset,
                poolId,
                reason: (limits.paused
                    ? "Deposit arrived while lending was paused"
                    : !isWalletAllowed(limits, wallet)
                        ? "Wallet is not on the lending beta allowlist"
                        : "Deposit exceeded the pool or per-wallet beta cap"),
            });
        }

        txn.set(depositRef, withoutUndefined({
            poolId,
            walletAddress: wallet,
            amount: credited,
            refunded: refunded > 0 ? refunded : undefined,
            asset: asset === "usdc" ? undefined : asset,
            txSig: transfer.txSig,
            depositedAt: at,
        }));

        if (credited <= 0) {
            return { pool, position: existing ? { ...existing, id: positionRef.id } : null, credited: 0, refunded };
        }

        const sharesToMint = sharesForDeposit(pool, credited, at);

        txn.update(poolRef, {
            totalShares: FieldValue.increment(sharesToMint),
            availableLiquidity: FieldValue.increment(credited),
            totalDeposited: FieldValue.increment(credited),
        });

        if (existing) {
            txn.update(positionRef, {
                shares: FieldValue.increment(sharesToMint),
                principalDeposited: FieldValue.increment(credited),
                updatedAt: FieldValue.serverTimestamp(),
            });
        } else {
            txn.set(positionRef, {
                poolId,
                walletAddress: wallet,
                shares: sharesToMint,
                principalDeposited: credited,
                principalWithdrawn: 0,
                pendingWithdrawalShares: 0,
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            });
        }

        return {
            pool: {
                ...pool,
                totalShares: pool.totalShares + sharesToMint,
                availableLiquidity: pool.availableLiquidity + credited,
                totalDeposited: pool.totalDeposited + credited,
            },
            position: {
                id: positionRef.id,
                poolId,
                walletAddress: wallet,
                shares: (existing?.shares || 0) + sharesToMint,
                principalDeposited: (existing?.principalDeposited || 0) + credited,
                principalWithdrawn: existing?.principalWithdrawn || 0,
                pendingWithdrawalShares: existing?.pendingWithdrawalShares || 0,
                createdAt: existing?.createdAt ?? Timestamp.now(),
                updatedAt: Timestamp.now(),
            },
            credited,
            refunded,
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
export async function requestPoolWithdrawal(poolId: string, wallet: string, amount: number): Promise<PoolWithdrawalRequest> {
    if (!(amount > 0)) throw new Error("Withdrawal amount must be positive");

    const poolRef = adminDb().collection(POOLS).doc(poolId);
    const positionRef = adminDb().collection(POSITIONS).doc(`${poolId}_${wallet}`);
    const requestRef = adminDb().collection(WITHDRAWALS).doc();
    const target = await getPool(poolId);
    if (!target) throw new Error("Pool not found");
    const asset = assetOf(target);
    amount = roundAmount(asset, amount);
    const payoutWalletAddress = await resolvePayerWallet(wallet, asset);

    return adminDb().runTransaction(async (txn) => {
        const [poolSnap, posSnap] = await Promise.all([txn.get(poolRef), txn.get(positionRef)]);
        if (!poolSnap.exists) throw new Error("Pool not found");
        if (!posSnap.exists) throw new Error("No position in this pool");
        const pool = toPool(poolSnap.id, poolSnap.data()!);
        const position = toPosition(posSnap.id, posSnap.data()!);
        healLegacyInTxn(txn, poolRef, "lendingPools", poolSnap.data());
        healLegacyInTxn(txn, positionRef, "lendingPoolPositions", posSnap.data());

        const { sharesToBurn } = planWithdrawal(pool, position, amount);

        const request: Omit<PoolWithdrawalRequest, "id"> = {
            poolId,
            walletAddress: wallet,
            payoutWalletAddress,
            ...(asset === "usdc" ? {} : { asset }),
            amount,
            sharesToBurn,
            status: "pending_payout",
            requestedAt: nowSec(),
            reserved: true,
        };
        txn.set(requestRef, request);
        txn.update(poolRef, {
            availableLiquidity: FieldValue.increment(-amount),
            pendingWithdrawal: FieldValue.increment(amount),
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
        const request = toWithdrawal(snap.id, snap.data()!);
        if (request.status !== "pending_payout") throw new Error(`Withdrawal is not pending (status: ${request.status})`);

        if (request.reserved) {
            const poolRef = adminDb().collection(POOLS).doc(request.poolId);
            const positionRef = adminDb().collection(POSITIONS).doc(`${request.poolId}_${request.walletAddress}`);
            const [poolSnap, posSnap] = await Promise.all([txn.get(poolRef), txn.get(positionRef)]);
            healLegacyInTxn(txn, poolRef, "lendingPools", poolSnap.data());
            healLegacyInTxn(txn, positionRef, "lendingPoolPositions", posSnap.data());
            txn.update(poolRef, {
                availableLiquidity: FieldValue.increment(request.amount),
                pendingWithdrawal: FieldValue.increment(-request.amount),
                pendingWithdrawalShares: FieldValue.increment(-request.sharesToBurn),
            });
            txn.update(positionRef, {
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
    return snap.exists ? toWithdrawal(snap.id, snap.data()!) : null;
}

export async function listPendingPoolWithdrawals(): Promise<PoolWithdrawalRequest[]> {
    const snap = await adminDb().collection(WITHDRAWALS).where("status", "==", "pending_payout").orderBy("requestedAt", "asc").get();
    return snap.docs.map((d) => toWithdrawal(d.id, d.data()));
}

export async function listPoolWithdrawalsForWallet(wallet: string): Promise<PoolWithdrawalRequest[]> {
    const snap = await adminDb().collection(WITHDRAWALS).where("walletAddress", "==", wallet).orderBy("requestedAt", "desc").get();
    return snap.docs.map((d) => toWithdrawal(d.id, d.data()));
}

/** Platform-admin action: verify the treasury really paid the lender, then burn the locked-in shares. */
export async function confirmPoolWithdrawal(requestId: string, txSig: string): Promise<{ pool: LendingPool; position: PoolPosition }> {
    const requestRef = adminDb().collection(WITHDRAWALS).doc(requestId);
    const requestSnap = await requestRef.get();
    if (!requestSnap.exists) throw new Error("Withdrawal request not found");
    const request = toWithdrawal(requestSnap.id, requestSnap.data()!);
    if (request.status !== "pending_payout") throw new Error(`Withdrawal is not pending (status: ${request.status})`);
    const asset = assetOf(await getPool(request.poolId));
    txSig = normalizeTxSig(asset, txSig);

    const transfer: VerifyTransferInput = {
        txSig,
        expectedFromWallet: treasuryFor(asset),
        expectedToWallet: request.payoutWalletAddress ?? request.walletAddress,
        expectedAmount: request.amount,
        purpose: "pool_withdrawal",
        refId: requestId,
    };
    await verifyLendingTransfer(asset, transfer);

    const poolRef = adminDb().collection(POOLS).doc(request.poolId);
    const positionRef = adminDb().collection(POSITIONS).doc(`${request.poolId}_${request.walletAddress}`);

    return adminDb().runTransaction(async (txn) => {
        const [reqSnap, poolSnap, posSnap] = await Promise.all([txn.get(requestRef), txn.get(poolRef), txn.get(positionRef)]);
        if (!reqSnap.exists) throw new Error("Withdrawal request not found");
        const current = toWithdrawal(reqSnap.id, reqSnap.data()!);
        if (current.status !== "pending_payout") throw new Error(`Withdrawal is not pending (status: ${current.status})`);
        if (!poolSnap.exists) throw new Error("Pool not found");
        if (!posSnap.exists) throw new Error("Position not found");
        const pool = toPool(poolSnap.id, poolSnap.data()!);
        const position = toPosition(posSnap.id, posSnap.data()!);

        claimLendingTransferInTxn(asset, txn, transfer);
        healLegacyInTxn(txn, poolRef, "lendingPools", poolSnap.data());
        healLegacyInTxn(txn, positionRef, "lendingPoolPositions", posSnap.data());

        const depositedDecrement = -Math.min(current.amount, pool.totalDeposited);
        if (current.reserved) {
            // Liquidity already left availableLiquidity at request time.
            txn.update(poolRef, {
                totalShares: FieldValue.increment(-current.sharesToBurn),
                pendingWithdrawal: FieldValue.increment(-current.amount),
                pendingWithdrawalShares: FieldValue.increment(-current.sharesToBurn),
                totalDeposited: FieldValue.increment(depositedDecrement),
            });
            txn.update(positionRef, {
                shares: FieldValue.increment(-current.sharesToBurn),
                pendingWithdrawalShares: FieldValue.increment(-current.sharesToBurn),
                principalWithdrawn: FieldValue.increment(current.amount),
                updatedAt: FieldValue.serverTimestamp(),
            });
        } else {
            // Legacy request from before reservations — re-check at payout time.
            if (current.sharesToBurn > position.shares - (position.pendingWithdrawalShares ?? 0) + 1e-9) {
                throw new Error("Position no longer holds enough shares for this legacy withdrawal — cancel it and reconcile manually");
            }
            txn.update(poolRef, {
                totalShares: FieldValue.increment(-current.sharesToBurn),
                availableLiquidity: FieldValue.increment(-current.amount),
                totalDeposited: FieldValue.increment(depositedDecrement),
            });
            txn.update(positionRef, {
                shares: FieldValue.increment(-current.sharesToBurn),
                principalWithdrawn: FieldValue.increment(current.amount),
                updatedAt: FieldValue.serverTimestamp(),
            });
        }
        txn.update(requestRef, { status: "paid", txSig, paidAt: nowSec() });

        return {
            pool: {
                ...pool,
                totalShares: pool.totalShares - current.sharesToBurn,
                availableLiquidity: current.reserved ? pool.availableLiquidity : pool.availableLiquidity - current.amount,
                pendingWithdrawal: (pool.pendingWithdrawal ?? 0) - (current.reserved ? current.amount : 0),
                pendingWithdrawalShares: (pool.pendingWithdrawalShares ?? 0) - (current.reserved ? current.sharesToBurn : 0),
            },
            position: {
                ...position,
                shares: position.shares - current.sharesToBurn,
                pendingWithdrawalShares: (position.pendingWithdrawalShares ?? 0) - (current.reserved ? current.sharesToBurn : 0),
                principalWithdrawn: position.principalWithdrawn + current.amount,
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
    amount: number;
    termDays?: number;
    poolId?: string;
    /** Pool loans without a poolId: borrow from this asset's default pool (default USDC). The amount is in this asset. */
    asset?: LendingAsset;
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
    const termDays = clampTermDays(input.termDays ?? 30);

    // Solo loans (and offers) are USDC; a pool loan is in its pool's asset.
    let pool: LendingPool | null = null;
    if (source === "pool") {
        pool = input.poolId ? await getPool(input.poolId) : await defaultPoolFor(input.asset ?? "usdc");
        if (!pool) throw new Error("Pool not found");
    }
    const asset = assetOf(pool);
    const market = pool?.collateralAsset ? pool : null;
    if (market && kind !== "trust") {
        throw new Error(`${poolLabel(market)} loans are collateralized — request kind "trust"`);
    }
    const amount = roundAmount(asset, input.amount);

    const limits = lendingLimits();
    assertCanOpenPosition(limits, requestedByWallet);

    // Every dollar rule (minimum, beta cap, tier limit) applies to the loan's USD value.
    const usdValue = amount * (await getUsdPrice(asset));
    const asAsset = (usd: number) => (asset === "usdc" ? "" : ` (≈ ${formatAssetAmount(asset, usd / (usdValue / amount))})`);
    if (!(amount > 0) || !(usdValue >= MIN_LOAN_USD)) {
        throw new Error(`Loan amount must be worth at least $${MIN_LOAN_USD}${amount > 0 ? asAsset(MIN_LOAN_USD) : ""}`);
    }
    if (limits.maxLoanUsd !== null && usdValue > limits.maxLoanUsd) {
        throw new Error(`Loans are capped at $${limits.maxLoanUsd.toLocaleString()}${asAsset(limits.maxLoanUsd)} during the lending beta`);
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
    if (usdValue > gate.maxAmountUsd) {
        throw new Error(`Amount exceeds the maximum for this loan type ($${gate.maxAmountUsd.toLocaleString()}${asAsset(gate.maxAmountUsd)})`);
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

    // Trust loans post collateral in the loan's own asset, sized by the credit
    // tier's escrow ratio. Collateral-market loans post the market's
    // collateral asset, sized so the loan starts at the market's max LTV.
    let collateral = 0;
    if (market) {
        const collateralAsset = market.collateralAsset!;
        const collateralUsd = usdValue / (market.maxLtvBps! / 10_000);
        collateral = ceilAmount(collateralAsset, collateralUsd / (await getUsdPrice(collateralAsset)));
    } else if (kind === "trust") {
        collateral = roundAmount(asset, calculateRequiredEscrow(policy, amount).escrowAmount);
    }

    const borrowerWalletAddress = await resolveBorrowerWallet((agentData.walletAddress as string) || undefined, requestedByWallet, asset);

    const base: Omit<Loan, "id"> = withoutUndefined({
        borrowerAgentId: agentId,
        borrowerOrgId: orgId,
        borrowerWalletAddress,
        requestedByWallet,
        kind,
        source,
        asset: asset === "usdc" ? undefined : asset,
        collateralAsset: market?.collateralAsset,
        liquidationLtvBps: market?.liquidationLtvBps,
        principalUsdValue: asset === "usdc" ? undefined : Math.round(usdValue * 100) / 100,
        principal: amount,
        principalRemaining: amount,
        principalPaid: 0,
        interestRateBps,
        interestAccrued: 0,
        interestPaid: 0,
        collateral,
        // Trust loans can't be funded until their collateral is verified on-chain (see postLoanCollateral).
        collateralStatus: collateral > 0 ? "awaiting" : "none",
        termDays,
        requestedAt: nowSec(),
        policyTierAtOrigination: policy.name,
        creditScoreAtOrigination: creditScore,
        purpose,
        status: collateral > 0 ? "pending_collateral" : "pending",
    } satisfies Omit<Loan, "id">);

    if (input.offerId) base.offerId = input.offerId;
    if (input.reservedLenderWallet) base.reservedLenderWallet = input.reservedLenderWallet;

    if (!base.borrowerWalletAddress) {
        throw new Error(asset === "eth"
            ? "The ETH pool pays out on Ethereum — the agent's wallet or yours must be an Ethereum address"
            : "Agent has no Solana wallet on file (link one to its EVM owner wallet) — cannot receive a real loan disbursement");
    }

    const poolId = pool?.id;
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
        if (poolSnap?.exists) healLegacyInTxn(txn, poolSnap.ref, "lendingPools", poolSnap.data());

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
        if (pool.availableLiquidity < amount) {
            throw new Error("The pool does not have enough available liquidity for this loan right now");
        }

        const loan: Omit<Loan, "id"> = {
            ...base,
            status: collateral > 0 ? "pending_collateral" : "pending_disbursement",
            poolId,
        };
        txn.set(loanRef, loan);
        txn.update(poolRef, {
            availableLiquidity: FieldValue.increment(-amount),
            totalLent: FieldValue.increment(amount),
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
export async function fundLoanSolo(loanId: string, lenderAccount: string, txSig: string): Promise<Loan> {
    const loanRef = adminDb().collection(LOANS).doc(loanId);
    const loan = await getLoan(loanId);
    if (!loan) throw new Error("Loan not found");
    if (loan.source !== "solo") throw new Error("Only solo loan requests can be funded directly");
    if (!loan.borrowerWalletAddress) throw new Error("Borrower has no wallet address on file");
    const lenderWallet = await resolvePayerWallet(lenderAccount);

    const transfer: VerifyTransferInput = {
        txSig: normalizeTxSig("usdc", txSig),
        expectedFromWallet: lenderWallet,
        expectedToWallet: loan.borrowerWalletAddress,
        expectedAmount: loan.principal,
        purpose: "solo_loan_fund",
        refId: loanId,
    };
    await verifyLendingTransfer("usdc", transfer);

    const result = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        const current = toLoan(snap.id, snap.data()!);
        healLegacyInTxn(txn, loanRef, "loans", snap.data());

        claimLendingTransferInTxn("usdc", txn, transfer);

        // Offers record the lender's signed-in account; match either it or its Solana wallet.
        const reservedForOther = !!current.reservedLenderWallet
            && current.reservedLenderWallet !== lenderAccount
            && current.reservedLenderWallet !== lenderWallet;
        if (current.status !== "pending" || reservedForOther) {
            createPayoutInTxn(txn, {
                kind: "funding_refund",
                fromWallet: current.borrowerWalletAddress!,
                toWallet: lenderWallet,
                amount: current.principal,
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
export async function postLoanCollateral(loanId: string, account: string, txSig: string): Promise<Loan> {
    const loanRef = adminDb().collection(LOANS).doc(loanId);
    const loan = await getLoan(loanId);
    if (!loan) throw new Error("Loan not found");
    if (!(loan.collateral > 0)) throw new Error("This loan doesn't require collateral");
    if (loan.collateralStatus && loan.collateralStatus !== "awaiting") throw new Error(`Collateral already ${loan.collateralStatus.replace("_", " ")}`);
    // A collateral-market loan's collateral is a different asset (and maybe chain) from its principal.
    const asset = collateralAssetOf(loan);
    const wallet = await resolvePayerWallet(account, asset);

    const treasury = treasuryFor(asset);
    const transfer: VerifyTransferInput = {
        txSig: normalizeTxSig(asset, txSig),
        expectedFromWallet: wallet,
        expectedToWallet: treasury,
        expectedAmount: loan.collateral,
        purpose: "loan_collateral",
        refId: loanId,
    };
    await verifyLendingTransfer(asset, transfer);

    const result = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        const current = toLoan(snap.id, snap.data()!);
        healLegacyInTxn(txn, loanRef, "loans", snap.data());

        claimLendingTransferInTxn(asset, txn, transfer);

        if (current.status !== "pending_collateral" || (current.collateralStatus && current.collateralStatus !== "awaiting")) {
            createPayoutInTxn(txn, {
                kind: "collateral_return",
                fromWallet: treasury,
                toWallet: wallet,
                amount: current.collateral,
                asset,
                loanId,
                reason: `Collateral arrived after the loan was no longer awaiting it (status: ${current.status})`,
            });
            return { returned: true as const, status: current.status };
        }

        const update = {
            status: current.source === "pool" ? ("pending_disbursement" as const) : ("pending" as const),
            collateralStatus: "held" as const,
            collateralTxSig: transfer.txSig,
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
        const poolRef = current.source === "pool" && current.poolId ? adminDb().collection(POOLS).doc(current.poolId) : null;
        const poolSnap = poolRef ? await txn.get(poolRef) : null;
        healLegacyInTxn(txn, loanRef, "loans", snap.data());
        if (poolSnap?.exists) healLegacyInTxn(txn, poolSnap.ref, "lendingPools", poolSnap.data());

        const update: Partial<Loan> = { status: "cancelled", cancelledAt: nowSec(), cancelReason: opts.reason };

        if (current.collateralStatus === "held" && current.collateralPostedByWallet) {
            createPayoutInTxn(txn, {
                kind: "collateral_return",
                fromWallet: treasuryFor(collateralAssetOf(current)),
                toWallet: current.collateralPostedByWallet,
                amount: current.collateral,
                asset: collateralAssetOf(current),
                loanId,
                reason: `Loan cancelled: ${opts.reason}`,
            });
            update.collateralStatus = "return_pending";
        }

        // Pool loans reserved their principal at request time.
        if (poolRef) {
            txn.update(poolRef, {
                availableLiquidity: FieldValue.increment(current.principal),
                totalLent: FieldValue.increment(-current.principal),
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
    return { id, ...normalizeLegacy("loanOffers", data) } as LoanOffer;
}

export interface CreateLoanOfferInput {
    lenderWalletAddress: string;
    kind: LoanKind;
    amount: number;
    rateBps: number;
    termDays?: number;
    note?: string;
}

export async function createLoanOffer(input: CreateLoanOfferInput): Promise<LoanOffer> {
    const limits = lendingLimits();
    assertCanOpenPosition(limits, input.lenderWalletAddress);
    // The offer stays owned by the signed-in account, but it must be fundable on Solana.
    await resolvePayerWallet(input.lenderWalletAddress);
    const amount = Math.round(input.amount * 100) / 100;
    if (limits.maxLoanUsd !== null && amount > limits.maxLoanUsd) {
        throw new Error(`Offers are capped at $${limits.maxLoanUsd.toLocaleString()} during the lending beta`);
    }
    if (!(amount >= MIN_LOAN_USD)) {
        throw new Error(`Offer amount must be at least $${MIN_LOAN_USD}`);
    }
    const rateBps = Math.round(input.rateBps);
    if (!Number.isFinite(rateBps) || rateBps < OFFER_MIN_RATE_BPS || rateBps > OFFER_MAX_RATE_BPS) {
        throw new Error(`Rate must be between ${(OFFER_MIN_RATE_BPS / 100).toFixed(1)}% and ${(OFFER_MAX_RATE_BPS / 100).toFixed(1)}% APR`);
    }

    const offer: Omit<LoanOffer, "id"> = withoutUndefined({
        lenderWalletAddress: input.lenderWalletAddress,
        kind: input.kind,
        amount,
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
    amount?: number;
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

    const amount = input.amount !== undefined ? Math.round(input.amount * 100) / 100 : offer.amount;
    if (amount > offer.amount) {
        await offerRef.update({ status: "open" });
        throw new Error(`Amount exceeds the offer's maximum of $${offer.amount.toLocaleString()}`);
    }

    try {
        const loan = await requestLoan({
            agentId: input.agentId,
            orgId: input.orgId,
            kind: offer.kind,
            source: "solo",
            amount,
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
    const asset = assetOf(loan);
    txSig = normalizeTxSig(asset, txSig);

    const transfer: VerifyTransferInput = {
        txSig,
        expectedFromWallet: treasuryFor(asset),
        expectedToWallet: loan.borrowerWalletAddress,
        expectedAmount: loan.principal,
        purpose: "loan_disbursement",
        refId: loanId,
    };
    await verifyLendingTransfer(asset, transfer);

    return adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        const current = toLoan(snap.id, snap.data()!);
        if (current.status !== "pending_disbursement") throw new Error(`Loan is not awaiting disbursement (status: ${current.status})`);
        const poolSnap = current.poolId ? await txn.get(adminDb().collection(POOLS).doc(current.poolId)) : null;
        healLegacyInTxn(txn, loanRef, "loans", snap.data());
        if (poolSnap?.exists) healLegacyInTxn(txn, poolSnap.ref, "lendingPools", poolSnap.data());

        claimLendingTransferInTxn(asset, txn, transfer);

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
                accruingDeltaPerYear: loanAccruingPerYear(current, current.principal),
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
    // A liquidation means the borrower let their collateral run short, even when it covered the debt.
    const canonicalType: CreditEventType = eventType === "loan_defaulted" || eventType === "loan_liquidated" ? "payment.failed" : "payment.settled";
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
export async function repayLoan(loanId: string, amount: number, paidByAccount: string, txSig: string): Promise<{ loan: Loan; repayment: LoanRepayment }> {
    if (!(amount > 0)) throw new Error("Repayment amount must be positive");
    const loanRef = adminDb().collection(LOANS).doc(loanId);

    const existing = await getLoan(loanId);
    if (!existing) throw new Error("Loan not found");
    if (!["active", "repaid", "defaulted"].includes(existing.status)) {
        throw new Error(`Loan hasn't been funded yet (status: ${existing.status})`);
    }

    const asset = assetOf(existing);
    amount = roundAmount(asset, amount);
    if (!(amount > 0)) throw new Error("Repayment amount must be positive");
    const paidByWallet = await resolvePayerWallet(paidByAccount, asset);
    const recipientWallet = existing.source === "pool" ? treasuryFor(asset) : existing.lenderWalletAddress;
    if (!recipientWallet) throw new Error("No lender wallet on file to verify repayment against");

    const transfer: VerifyTransferInput = {
        txSig: normalizeTxSig(asset, txSig),
        expectedFromWallet: paidByWallet,
        expectedToWallet: recipientWallet,
        expectedAmount: amount,
        purpose: "loan_repayment",
        refId: loanId,
    };
    await verifyLendingTransfer(asset, transfer);

    const result = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        let loan = toLoan(snap.id, snap.data()!);
        const poolSnap = loan.status === "active" && loan.poolId
            ? await txn.get(adminDb().collection(POOLS).doc(loan.poolId))
            : null;
        healLegacyInTxn(txn, loanRef, "loans", snap.data());
        if (poolSnap?.exists) healLegacyInTxn(txn, poolSnap.ref, "lendingPools", poolSnap.data());

        claimLendingTransferInTxn(asset, txn, transfer);

        if (loan.status !== "active") {
            createPayoutInTxn(txn, {
                kind: "repayment_refund",
                fromWallet: recipientWallet,
                toWallet: paidByWallet,
                amount,
                asset,
                loanId,
                reason: `Repayment arrived after the loan was closed (status: ${loan.status})`,
            });
            return { refunded: true as const, status: loan.status };
        }

        const at = nowSec();
        loan = accrue(loan, at);

        const {
            loan: paidLoan, applied, principalPortion, interestPortion, remainingBalance, excess, finalStatus,
        } = applyPayment(loan, amount, at);

        const update: Partial<Loan> = {
            principalRemaining: paidLoan.principalRemaining,
            principalPaid: paidLoan.principalPaid,
            interestAccrued: paidLoan.interestAccrued,
            interestPaid: paidLoan.interestPaid,
            lastAccrualAt: loan.lastAccrualAt,
            status: finalStatus,
        };
        if (finalStatus === "repaid") update.repaidAt = at;
        if (excess > 0) update.overpaymentOwed = (loan.overpaymentOwed ?? 0) + excess;

        const repaymentRef = adminDb().collection(REPAYMENTS).doc();
        const repayment: LoanRepayment = {
            id: repaymentRef.id,
            loanId,
            amount: applied,
            principalPortion,
            interestPortion,
            remainingBalance,
            paidAt: at,
            paidByWallet,
            txSig: transfer.txSig,
            ...(excess > 0 ? { excess, refundStatus: "pending" as const } : {}),
        };
        txn.set(repaymentRef, repayment);

        if (excess > 0) {
            createPayoutInTxn(txn, {
                kind: "overpayment_refund",
                fromWallet: recipientWallet,
                toWallet: paidByWallet,
                amount: excess,
                asset,
                loanId,
                repaymentId: repaymentRef.id,
                reason: "Repayment exceeded the remaining balance",
            });
        }

        if (finalStatus === "repaid" && loan.collateralStatus === "held" && loan.collateralPostedByWallet) {
            createPayoutInTxn(txn, {
                kind: "collateral_return",
                fromWallet: treasuryFor(collateralAssetOf(loan)),
                toWallet: loan.collateralPostedByWallet,
                amount: loan.collateral,
                asset: collateralAssetOf(loan),
                loanId,
                reason: "Loan repaid in full",
            });
            update.collateralStatus = "return_pending";
        }

        txn.update(loanRef, update as FirebaseFirestore.UpdateData<Loan>);

        if (poolSnap?.exists) {
            const tracked = !!loan.poolAccrualTracked;
            applyPoolLoanChangeInTxn(txn, toPool(poolSnap.id, poolSnap.data()!), at, {
                principalReturned: principalPortion,
                interestReturned: interestPortion,
                accruingDeltaPerYear: tracked ? -loanAccruingPerYear(loan, principalPortion) : 0,
                receivableDelta: tracked ? -interestPortion : 0,
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
            `Repaid ${result.loan.kind} loan in full (${formatAssetAmount(asset, result.loan.principal)})`,
            "loan_repaid",
            { loanId, kind: result.loan.kind, principal: result.loan.principal },
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

    // A collateral-market loan's collateral is another asset: it can't be
    // applied to the balance directly, so an overdue one is liquidated instead.
    const pre = await getLoan(loanId);
    if (pre?.collateralAsset && pre.status === "active") {
        if (!pre.dueAt || nowSec() <= pre.dueAt + graceSec) {
            throw new Error(graceSec > 0 ? "Loan is not past its due date plus grace period yet" : "Loan is not past its due date yet");
        }
        return startLiquidation(loanId, "overdue");
    }

    const { loan, recovery } = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        let current = toLoan(snap.id, snap.data()!);
        if (current.status !== "active") throw new Error(`Loan is not active (status: ${current.status})`);
        if (!current.dueAt || nowSec() <= current.dueAt + graceSec) {
            throw new Error(graceSec > 0 ? "Loan is not past its due date plus grace period yet" : "Loan is not past its due date yet");
        }
        const poolSnap = current.poolId ? await txn.get(adminDb().collection(POOLS).doc(current.poolId)) : null;
        healLegacyInTxn(txn, loanRef, "loans", snap.data());
        if (poolSnap?.exists) healLegacyInTxn(txn, poolSnap.ref, "lendingPools", poolSnap.data());

        const at = nowSec();
        current = accrue(current, at);
        const asset = assetOf(current);

        const collateralHeld = current.collateralStatus === "held" ? current.collateral : 0;
        const rec = computeDefaultRecovery(current.principalRemaining, current.interestAccrued, collateralHeld);
        const recovered = rec.recoveredPrincipal + rec.recoveredInterest;

        const update: Partial<Loan> = {
            interestAccrued: current.interestAccrued,
            lastAccrualAt: current.lastAccrualAt,
            status: "defaulted",
            defaultedAt: at,
        };
        if (collateralHeld > 0) update.collateralStatus = "seized";
        txn.update(loanRef, update as FirebaseFirestore.UpdateData<Loan>);

        if (poolSnap?.exists) {
            const tracked = !!current.poolAccrualTracked;
            applyPoolLoanChangeInTxn(txn, toPool(poolSnap.id, poolSnap.data()!), at, {
                principalReturned: rec.recoveredPrincipal,
                interestReturned: rec.recoveredInterest,
                loss: rec.principalLoss,
                accruingDeltaPerYear: tracked ? -loanAccruingPerYear(current) : 0,
                receivableDelta: tracked ? -current.interestAccrued : 0,
            });
        } else if (recovered > 0 && current.lenderWalletAddress) {
            createPayoutInTxn(txn, {
                kind: "collateral_to_lender",
                fromWallet: treasuryFor(asset),
                toWallet: current.lenderWalletAddress,
                amount: recovered,
                asset,
                loanId,
                reason: "Seized collateral from a defaulted solo loan",
            });
        }

        if (rec.collateralExcess > 0 && current.collateralPostedByWallet) {
            createPayoutInTxn(txn, {
                kind: "collateral_return",
                fromWallet: treasuryFor(asset),
                toWallet: current.collateralPostedByWallet,
                amount: rec.collateralExcess,
                asset,
                loanId,
                reason: "Collateral left over after covering the defaulted balance",
            });
        }

        return { loan: { ...current, ...update } as Loan, recovery: rec };
    });

    const recoveryRatio = loan.principalRemaining > 0 ? clamp(recovery.recoveredPrincipal / loan.principalRemaining, 0, 1) : 1;
    const baseCredit = loan.kind === "unsecured" ? -55 : -25;
    const baseTrust = loan.kind === "unsecured" ? -20 : -8;
    await applyLoanCreditEvent(
        loan.borrowerAgentId,
        Math.round(baseCredit * (1 - recoveryRatio * 0.5)),
        Math.round(baseTrust * (1 - recoveryRatio * 0.5)),
        `Defaulted on ${loan.kind} loan (${formatAssetAmount(assetOf(loan), loan.principalRemaining)} outstanding)`,
        "loan_defaulted",
        {
            loanId: loan.id,
            kind: loan.kind,
            outstanding: loan.principalRemaining,
            recovered: recovery.recoveredPrincipal + recovery.recoveredInterest,
        },
    );
    return loan;
}

// ═══════════════════════════════════════════════════════════════
// Collateral markets — liquidation
// ═══════════════════════════════════════════════════════════════

/** Current loan-to-value of an active collateral-market loan, at live prices. */
export async function currentLoanToValue(loan: Loan, at: number = nowSec()): Promise<number> {
    if (!loan.collateralAsset) throw new Error("Not a collateral-market loan");
    const accrued = accrue(loan, at);
    const [debtPrice, collateralPrice] = await Promise.all([getUsdPrice(assetOf(loan)), getUsdPrice(loan.collateralAsset)]);
    return loanToValue(accrued.principalRemaining + accrued.interestAccrued, debtPrice, loan.collateral, collateralPrice);
}

/**
 * Seize an active collateral-market loan's collateral for sale: the loan
 * stops accruing and moves to "liquidating", and the pool stops counting its
 * interest as receivable (whatever the sale recovers is credited at
 * settlement). The collateral is already in its treasury; a platform admin
 * sells it and records the proceeds with settleLiquidation().
 */
export async function startLiquidation(loanId: string, reason: "ltv" | "overdue" | "admin"): Promise<Loan> {
    const loanRef = adminDb().collection(LOANS).doc(loanId);
    const existing = await getLoan(loanId);
    if (!existing) throw new Error("Loan not found");
    if (!existing.collateralAsset) throw new Error("Only collateral-market loans are liquidated — other loans default instead");
    const [debtPrice, collateralPrice] = await Promise.all([getUsdPrice(assetOf(existing)), getUsdPrice(existing.collateralAsset)]);

    const loan = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        let current = toLoan(snap.id, snap.data()!);
        if (current.status !== "active") throw new Error(`Loan is not active (status: ${current.status})`);
        const poolSnap = current.poolId ? await txn.get(adminDb().collection(POOLS).doc(current.poolId)) : null;
        healLegacyInTxn(txn, loanRef, "loans", snap.data());
        if (poolSnap?.exists) healLegacyInTxn(txn, poolSnap.ref, "lendingPools", poolSnap.data());

        const at = nowSec();
        current = accrue(current, at);
        const ltv = loanToValue(current.principalRemaining + current.interestAccrued, debtPrice, current.collateral, collateralPrice);
        const update: Partial<Loan> = {
            status: "liquidating",
            collateralStatus: "seized",
            interestAccrued: current.interestAccrued,
            lastAccrualAt: current.lastAccrualAt,
            liquidationStartedAt: at,
            liquidationPriceUsd: collateralPrice,
            liquidationLtvAtStart: Math.round(ltv * 10_000) / 10_000,
            liquidationReason: reason,
            // Its accrual leaves the pool now; settlement must not remove it again.
            poolAccrualTracked: false,
        };
        txn.update(loanRef, update as FirebaseFirestore.UpdateData<Loan>);
        if (poolSnap?.exists && current.poolAccrualTracked) {
            applyPoolLoanChangeInTxn(txn, toPool(poolSnap.id, poolSnap.data()!), at, {
                accruingDeltaPerYear: -loanAccruingPerYear(current),
                receivableDelta: -current.interestAccrued,
            });
        }
        return { ...current, ...update } as Loan;
    });
    invalidateCache(`credit:${loan.borrowerAgentId}`);
    return loan;
}

/**
 * Record the sale of a liquidated loan's collateral: verify `proceeds` of the
 * loan's asset reached its treasury (from any sender — an exchange withdrawal
 * or a swap inside the treasury both count), then apply them to principal,
 * then interest. A shortfall is written off and the loan becomes "defaulted";
 * otherwise it's "liquidated" and any surplus is queued back to the borrower.
 */
export async function settleLiquidation(loanId: string, proceeds: number, txSig: string): Promise<Loan> {
    const loanRef = adminDb().collection(LOANS).doc(loanId);
    const existing = await getLoan(loanId);
    if (!existing) throw new Error("Loan not found");
    if (existing.status !== "liquidating") throw new Error(`Loan is not being liquidated (status: ${existing.status})`);
    const asset = assetOf(existing);
    proceeds = roundAmount(asset, proceeds);
    if (!(proceeds > 0)) throw new Error("Proceeds must be positive");

    const transfer: VerifyTransferInput = {
        txSig: normalizeTxSig(asset, txSig),
        expectedFromWallet: null,
        expectedToWallet: treasuryFor(asset),
        expectedAmount: proceeds,
        purpose: "liquidation_proceeds",
        refId: loanId,
    };
    await verifyLendingTransfer(asset, transfer);

    const { loan, recovery } = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new Error("Loan not found");
        const current = toLoan(snap.id, snap.data()!);
        if (current.status !== "liquidating") throw new Error(`Loan is not being liquidated (status: ${current.status})`);
        const poolSnap = current.poolId ? await txn.get(adminDb().collection(POOLS).doc(current.poolId)) : null;
        healLegacyInTxn(txn, loanRef, "loans", snap.data());
        if (poolSnap?.exists) healLegacyInTxn(txn, poolSnap.ref, "lendingPools", poolSnap.data());

        claimLendingTransferInTxn(asset, txn, transfer);

        const at = nowSec();
        const rec = computeDefaultRecovery(current.principalRemaining, current.interestAccrued, proceeds);
        const shortfall = rec.principalLoss > 0;
        const update: Partial<Loan> = {
            status: shortfall ? "defaulted" : "liquidated",
            principalRemaining: rec.principalLoss,
            principalPaid: current.principalPaid + rec.recoveredPrincipal,
            interestAccrued: rec.unrecoveredInterest,
            interestPaid: current.interestPaid + rec.recoveredInterest,
            liquidationProceeds: proceeds,
            liquidationTxSig: transfer.txSig,
            liquidatedAt: at,
            ...(shortfall ? { defaultedAt: at } : {}),
        };
        txn.update(loanRef, update as FirebaseFirestore.UpdateData<Loan>);

        if (poolSnap?.exists) {
            applyPoolLoanChangeInTxn(txn, toPool(poolSnap.id, poolSnap.data()!), at, {
                principalReturned: rec.recoveredPrincipal,
                interestReturned: rec.recoveredInterest,
                loss: rec.principalLoss,
            });
        }
        if (rec.collateralExcess > 0 && current.borrowerWalletAddress) {
            createPayoutInTxn(txn, {
                kind: "liquidation_surplus",
                fromWallet: treasuryFor(asset),
                toWallet: current.borrowerWalletAddress,
                amount: rec.collateralExcess,
                asset,
                loanId,
                reason: "Liquidation proceeds beyond what the loan owed",
            });
        }
        return { loan: { ...current, ...update } as Loan, recovery: rec };
    });

    const outstanding = recovery.principalLoss;
    await applyLoanCreditEvent(
        loan.borrowerAgentId,
        outstanding > 0 ? -40 : -10,
        outstanding > 0 ? -15 : -3,
        outstanding > 0
            ? `Collateral liquidated with ${formatAssetAmount(asset, outstanding)} of principal unrecovered`
            : `Collateral liquidated (${poolLabel(loan)} loan, debt fully covered)`,
        "loan_liquidated",
        { loanId: loan.id, proceeds, principalLoss: outstanding, collateralAsset: loan.collateralAsset },
    );
    return loan;
}

export async function listLiquidatingLoans(): Promise<Loan[]> {
    const snap = await adminDb().collection(LOANS).where("status", "==", "liquidating").get();
    return snap.docs.map((d) => toLoan(d.id, d.data()));
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
    return snap.docs.map((d) => ({ id: d.id, ...normalizeLegacy("loanRepayments", d.data()) }) as LoanRepayment);
}
