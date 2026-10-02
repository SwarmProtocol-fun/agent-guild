/**
 * Pure loan math — interest accrual and payment application.
 * No Firestore I/O, so it's directly unit-testable; lending-service.ts's
 * transactions call these and persist the results.
 */

import type { Loan, LendingPool, PoolPosition } from "./types";

/** Accrue simple daily interest on the remaining principal up to `asOf` (unix seconds). */
export function accrue(loan: Loan, asOf: number): Loan {
    const last = loan.lastAccrualAt ?? loan.originatedAt ?? asOf;
    const daysElapsed = Math.max(0, (asOf - last) / 86400);
    if (daysElapsed <= 0) return loan;
    const dailyRate = loan.interestRateBps / 10_000 / 365;
    const newInterest = loan.principalRemainingUsd * dailyRate * daysElapsed;
    return {
        ...loan,
        interestAccruedUsd: loan.interestAccruedUsd + newInterest,
        lastAccrualAt: asOf,
    };
}

export interface PaymentResult {
    loan: Loan;
    appliedUsd: number;
    principalPortionUsd: number;
    interestPortionUsd: number;
    remainingBalanceUsd: number;
    /** Part of the payment beyond the total owed — already sent on-chain, so it must be refunded, not dropped. */
    excessUsd: number;
    isOverdue: boolean;
    finalStatus: Loan["status"];
}

/**
 * Apply a payment to an (already-accrued) active loan: interest first, then principal.
 * Resulting status is "repaid" if the balance clears, otherwise "active" — even past
 * `dueAt`. A late partial payment must not close the loan out from under a borrower
 * who is trying to pay; only an explicit default (markLoanDefaulted) does that.
 */
export function applyPayment(loan: Loan, amountUsd: number, asOf: number): PaymentResult {
    const totalOwed = loan.principalRemainingUsd + loan.interestAccruedUsd;
    const appliedUsd = Math.min(amountUsd, totalOwed);
    const excessUsd = Math.max(0, amountUsd - appliedUsd);
    const interestPortionUsd = Math.min(appliedUsd, loan.interestAccruedUsd);
    const principalPortionUsd = appliedUsd - interestPortionUsd;

    const updated: Loan = {
        ...loan,
        interestAccruedUsd: Math.max(0, loan.interestAccruedUsd - interestPortionUsd),
        interestPaidUsd: loan.interestPaidUsd + interestPortionUsd,
        principalRemainingUsd: Math.max(0, loan.principalRemainingUsd - principalPortionUsd),
        principalPaidUsd: loan.principalPaidUsd + principalPortionUsd,
    };

    const remainingBalanceUsd = Math.max(0, updated.principalRemainingUsd + updated.interestAccruedUsd);
    const isOverdue = !!loan.dueAt && asOf > loan.dueAt;

    const finalStatus: Loan["status"] = remainingBalanceUsd <= 0.01 ? "repaid" : "active";

    return { loan: updated, appliedUsd, principalPortionUsd, interestPortionUsd, remainingBalanceUsd, excessUsd, isOverdue, finalStatus };
}

// ═══════════════════════════════════════════════════════════════
// Pool share accounting
// ═══════════════════════════════════════════════════════════════

const SECONDS_PER_YEAR = 365 * 86400;

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Accrued-but-unpaid interest on the pool's active loans as of `asOf`.
 * Loans accrue simple interest on remaining principal (see accrue()), which
 * is linear in time, so the pool-wide total is exactly
 * receivable + Σ(principal × APR) × elapsed — as long as accruingUsdPerYear
 * is updated at every principal change (disbursement, repayment, default).
 */
export function poolInterestReceivableUsd(pool: LendingPool, asOf: number = nowSec()): number {
    const base = pool.interestReceivableUsd ?? 0;
    const rate = pool.accruingUsdPerYear ?? 0;
    const since = pool.interestAccrualAt ?? asOf;
    return base + rate * (Math.max(0, asOf - since) / SECONDS_PER_YEAR);
}

/**
 * Pool fields to write when bringing interest accrual up to `asOf`, before
 * changing accruingUsdPerYear. Always write both together.
 */
export function accruePoolInterest(pool: LendingPool, asOf: number): { interestReceivableUsd: number; interestAccrualAt: number } {
    return { interestReceivableUsd: poolInterestReceivableUsd(pool, asOf), interestAccrualAt: asOf };
}

/**
 * Pool value = free cash + outstanding principal (at par) + accrued interest.
 * A pending withdrawal is a fixed liability: its USD has already been moved
 * out of availableLiquidityUsd (into pendingWithdrawalUsd) and its shares are
 * still in totalShares until the payout is confirmed. Both are excluded, so
 * the remaining lenders' share price is unaffected by the reservation.
 */
export function poolValueUsd(pool: LendingPool, asOf: number = nowSec()): number {
    return pool.availableLiquidityUsd + pool.totalLentUsd + poolInterestReceivableUsd(pool, asOf);
}

export function effectiveShares(pool: LendingPool): number {
    return pool.totalShares - (pool.pendingWithdrawalShares ?? 0);
}

export function poolSharePrice(pool: LendingPool, asOf: number = nowSec()): number {
    const shares = effectiveShares(pool);
    if (shares <= 0) return 1;
    return poolValueUsd(pool, asOf) / shares;
}

/** Shares a lender can still withdraw — owned shares minus those already locked in pending requests. */
export function freeShares(position: Pick<PoolPosition, "shares" | "pendingWithdrawalShares">): number {
    return Math.max(0, position.shares - (position.pendingWithdrawalShares ?? 0));
}

const SHARE_EPSILON = 1e-9;

/**
 * Validate a withdrawal against the lender's unlocked shares and the pool's
 * free liquidity, and work out how many shares it burns. Throws a
 * user-facing error if it can't be honoured.
 */
export function planWithdrawal(
    pool: LendingPool,
    position: Pick<PoolPosition, "shares" | "pendingWithdrawalShares">,
    amountUsd: number,
    asOf: number = nowSec(),
): { sharesToBurn: number; price: number } {
    if (!(amountUsd > 0)) throw new Error("Withdrawal amount must be positive");
    const price = poolSharePrice(pool, asOf);
    const available = freeShares(position);
    let sharesToBurn = amountUsd / price;
    if (sharesToBurn > available) {
        // Tolerate float dust when withdrawing an entire position.
        if (sharesToBurn - available > SHARE_EPSILON * Math.max(1, available) && (sharesToBurn - available) * price > 0.01) {
            const valueUsd = available * price;
            throw new Error(`Requested amount exceeds your withdrawable position value ($${valueUsd.toFixed(2)}, excluding pending withdrawals)`);
        }
        sharesToBurn = available;
    }
    if (amountUsd > pool.availableLiquidityUsd + 0.01) {
        throw new Error("Pool does not have enough free liquidity right now — some capital is out on loan or reserved for other withdrawals. Try a smaller amount or wait for repayments.");
    }
    return { sharesToBurn, price };
}

/** Shares minted for a deposit at the current price (1:1 into an empty pool). */
export function sharesForDeposit(pool: LendingPool, amountUsd: number, asOf: number = nowSec()): number {
    return effectiveShares(pool) <= 0 ? amountUsd : amountUsd / poolSharePrice(pool, asOf);
}

/**
 * How much more a wallet may deposit into a pool under the beta caps
 * (Infinity when uncapped). Net deposits = deposited − withdrawn principal.
 */
export function depositCapacityUsd(
    pool: LendingPool,
    position: Pick<PoolPosition, "principalDepositedUsd" | "principalWithdrawnUsd"> | null,
    caps: { maxPoolTvlUsd: number | null; maxDepositPerWalletUsd: number | null },
    asOf: number = nowSec(),
): number {
    let capacity = Infinity;
    if (caps.maxPoolTvlUsd !== null) {
        capacity = Math.min(capacity, caps.maxPoolTvlUsd - poolValueUsd(pool, asOf));
    }
    if (caps.maxDepositPerWalletUsd !== null) {
        const net = (position?.principalDepositedUsd ?? 0) - (position?.principalWithdrawnUsd ?? 0);
        capacity = Math.min(capacity, caps.maxDepositPerWalletUsd - net);
    }
    return Math.max(0, capacity);
}

export interface DefaultRecovery {
    recoveredPrincipalUsd: number;
    recoveredInterestUsd: number;
    principalLossUsd: number;
    unrecoveredInterestUsd: number;
    /** Collateral left over after covering principal and interest — returned to the borrower. */
    collateralExcessUsd: number;
}

/** Apply held collateral to a defaulted balance: principal first, then accrued interest; any excess goes back to the borrower. */
export function computeDefaultRecovery(principalRemainingUsd: number, interestAccruedUsd: number, collateralHeldUsd: number): DefaultRecovery {
    const collateral = Math.max(0, collateralHeldUsd);
    const recoveredPrincipalUsd = Math.min(collateral, principalRemainingUsd);
    const recoveredInterestUsd = Math.min(collateral - recoveredPrincipalUsd, interestAccruedUsd);
    return {
        recoveredPrincipalUsd,
        recoveredInterestUsd,
        principalLossUsd: principalRemainingUsd - recoveredPrincipalUsd,
        unrecoveredInterestUsd: interestAccruedUsd - recoveredInterestUsd,
        collateralExcessUsd: collateral - recoveredPrincipalUsd - recoveredInterestUsd,
    };
}

/**
 * Pool field deltas for money coming back from (or written off on) a loan.
 * Returned principal and interest become liquid again; principal leaves
 * totalLentUsd whether it came back or was lost.
 */
export function poolSettlementDeltas(principalReturnedUsd: number, interestReturnedUsd: number, lossUsd: number): {
    availableLiquidityUsd: number;
    totalLentUsd: number;
    totalInterestEarnedUsd: number;
    totalDefaultedUsd: number;
} {
    return {
        availableLiquidityUsd: principalReturnedUsd + interestReturnedUsd,
        totalLentUsd: -(principalReturnedUsd + lossUsd),
        totalInterestEarnedUsd: interestReturnedUsd,
        totalDefaultedUsd: lossUsd,
    };
}

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}
