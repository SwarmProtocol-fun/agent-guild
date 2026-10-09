/**
 * Pure loan math — interest accrual and payment application.
 * No Firestore I/O, so it's directly unit-testable; lending-service.ts's
 * transactions call these and persist the results.
 */

import type { Loan, LendingPool, PoolPosition } from "./types";

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Accrue simple daily interest on the remaining principal up to `asOf` (unix seconds). */
export function accrue(loan: Loan, asOf: number): Loan {
    const last = loan.lastAccrualAt ?? loan.originatedAt ?? asOf;
    const daysElapsed = Math.max(0, (asOf - last) / 86400);
    if (daysElapsed <= 0) return loan;
    const dailyRate = loan.interestRateBps / 10_000 / 365;
    const newInterest = loan.principalRemaining * dailyRate * daysElapsed;
    return {
        ...loan,
        interestAccrued: loan.interestAccrued + newInterest,
        lastAccrualAt: asOf,
    };
}

export interface PaymentResult {
    loan: Loan;
    applied: number;
    principalPortion: number;
    interestPortion: number;
    remainingBalance: number;
    /** Part of the payment beyond the total owed — already sent on-chain, so it must be refunded, not dropped. */
    excess: number;
    isOverdue: boolean;
    finalStatus: Loan["status"];
}

/**
 * Apply a payment to an (already-accrued) active loan: interest first, then principal.
 * Resulting status is "repaid" if the balance clears, otherwise "active" — even past
 * `dueAt`. A late partial payment must not close the loan out from under a borrower
 * who is trying to pay; only an explicit default (markLoanDefaulted) does that.
 */
export function applyPayment(loan: Loan, amount: number, asOf: number): PaymentResult {
    const totalOwed = loan.principalRemaining + loan.interestAccrued;
    const applied = Math.min(amount, totalOwed);
    const excess = Math.max(0, amount - applied);
    const interestPortion = Math.min(applied, loan.interestAccrued);
    const principalPortion = applied - interestPortion;

    const updated: Loan = {
        ...loan,
        interestAccrued: Math.max(0, loan.interestAccrued - interestPortion),
        interestPaid: loan.interestPaid + interestPortion,
        principalRemaining: Math.max(0, loan.principalRemaining - principalPortion),
        principalPaid: loan.principalPaid + principalPortion,
    };

    const remainingBalance = Math.max(0, updated.principalRemaining + updated.interestAccrued);
    const isOverdue = !!loan.dueAt && asOf > loan.dueAt;

    const finalStatus: Loan["status"] = remainingBalance <= 0.01 ? "repaid" : "active";

    return { loan: updated, applied, principalPortion, interestPortion, remainingBalance, excess, isOverdue, finalStatus };
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
 * receivable + Σ(principal × APR) × elapsed — as long as accruingPerYear
 * is updated at every principal change (disbursement, repayment, default).
 */
export function poolInterestReceivable(pool: LendingPool, asOf: number = nowSec()): number {
    const base = pool.interestReceivable ?? 0;
    const rate = pool.accruingPerYear ?? 0;
    const since = pool.interestAccrualAt ?? asOf;
    return base + rate * (Math.max(0, asOf - since) / SECONDS_PER_YEAR);
}

/**
 * Pool fields to write when bringing interest accrual up to `asOf`, before
 * changing accruingPerYear. Always write both together.
 */
export function accruePoolInterest(pool: LendingPool, asOf: number): { interestReceivable: number; interestAccrualAt: number } {
    return { interestReceivable: poolInterestReceivable(pool, asOf), interestAccrualAt: asOf };
}

/**
 * Pool value = free cash + outstanding principal (at par) + accrued interest.
 * A pending withdrawal is a fixed liability: its USD has already been moved
 * out of availableLiquidity (into pendingWithdrawal) and its shares are
 * still in totalShares until the payout is confirmed. Both are excluded, so
 * the remaining lenders' share price is unaffected by the reservation.
 */
export function poolValue(pool: LendingPool, asOf: number = nowSec()): number {
    return pool.availableLiquidity + pool.totalLent + poolInterestReceivable(pool, asOf);
}

export function effectiveShares(pool: LendingPool): number {
    return pool.totalShares - (pool.pendingWithdrawalShares ?? 0);
}

export function poolSharePrice(pool: LendingPool, asOf: number = nowSec()): number {
    const shares = effectiveShares(pool);
    if (shares <= 0) return 1;
    return poolValue(pool, asOf) / shares;
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
    amount: number,
    asOf: number = nowSec(),
): { sharesToBurn: number; price: number } {
    if (!(amount > 0)) throw new Error("Withdrawal amount must be positive");
    const price = poolSharePrice(pool, asOf);
    const available = freeShares(position);
    let sharesToBurn = amount / price;
    if (sharesToBurn > available) {
        // Tolerate float dust when withdrawing an entire position.
        if (sharesToBurn - available > SHARE_EPSILON * Math.max(1, available) && (sharesToBurn - available) * price > 0.01) {
            const positionValue = available * price;
            throw new Error(`Requested amount exceeds your withdrawable position value ($${positionValue.toFixed(2)}, excluding pending withdrawals)`);
        }
        sharesToBurn = available;
    }
    if (amount > pool.availableLiquidity + 0.01) {
        throw new Error("Pool does not have enough free liquidity right now — some capital is out on loan or reserved for other withdrawals. Try a smaller amount or wait for repayments.");
    }
    return { sharesToBurn, price };
}

/** Shares minted for a deposit at the current price (1:1 into an empty pool). */
export function sharesForDeposit(pool: LendingPool, amount: number, asOf: number = nowSec()): number {
    return effectiveShares(pool) <= 0 ? amount : amount / poolSharePrice(pool, asOf);
}

/**
 * How much more a wallet may deposit into a pool under the beta caps
 * (Infinity when uncapped). Net deposits = deposited − withdrawn principal.
 */
export function depositCapacity(
    pool: LendingPool,
    position: Pick<PoolPosition, "principalDeposited" | "principalWithdrawn"> | null,
    caps: { maxPoolTvlUsd: number | null; maxDepositPerWalletUsd: number | null },
    asOf: number = nowSec(),
): number {
    let capacity = Infinity;
    if (caps.maxPoolTvlUsd !== null) {
        capacity = Math.min(capacity, caps.maxPoolTvlUsd - poolValue(pool, asOf));
    }
    if (caps.maxDepositPerWalletUsd !== null) {
        const net = (position?.principalDeposited ?? 0) - (position?.principalWithdrawn ?? 0);
        capacity = Math.min(capacity, caps.maxDepositPerWalletUsd - net);
    }
    return Math.max(0, capacity);
}

export interface DefaultRecovery {
    recoveredPrincipal: number;
    recoveredInterest: number;
    principalLoss: number;
    unrecoveredInterest: number;
    /** Collateral left over after covering principal and interest — returned to the borrower. */
    collateralExcess: number;
}

/** Apply held collateral to a defaulted balance: principal first, then accrued interest; any excess goes back to the borrower. */
export function computeDefaultRecovery(principalRemaining: number, interestAccrued: number, collateralHeld: number): DefaultRecovery {
    const collateral = Math.max(0, collateralHeld);
    const recoveredPrincipal = Math.min(collateral, principalRemaining);
    const recoveredInterest = Math.min(collateral - recoveredPrincipal, interestAccrued);
    return {
        recoveredPrincipal,
        recoveredInterest,
        principalLoss: principalRemaining - recoveredPrincipal,
        unrecoveredInterest: interestAccrued - recoveredInterest,
        collateralExcess: collateral - recoveredPrincipal - recoveredInterest,
    };
}

/**
 * Pool field deltas for money coming back from (or written off on) a loan.
 * Returned principal and interest become liquid again; principal leaves
 * totalLent whether it came back or was lost.
 */
export function poolSettlementDeltas(principalReturned: number, interestReturned: number, loss: number): {
    availableLiquidity: number;
    totalLent: number;
    totalInterestEarned: number;
    totalDefaulted: number;
} {
    return {
        availableLiquidity: principalReturned + interestReturned,
        totalLent: -(principalReturned + loss),
        totalInterestEarned: interestReturned,
        totalDefaulted: loss,
    };
}

/**
 * Loan-to-value of a collateral-market loan: what's owed (principal + accrued
 * interest) over what the collateral is worth, both in USD. Infinity with no
 * collateral value.
 */
export function loanToValue(debt: number, debtPriceUsd: number, collateral: number, collateralPriceUsd: number): number {
    const collateralUsd = collateral * collateralPriceUsd;
    return collateralUsd > 0 ? (debt * debtPriceUsd) / collateralUsd : Infinity;
}

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * What lenders earn right now, annualized: interest accruing on active loans
 * per year over the pool's value. Idle liquidity earns nothing, so this
 * already reflects utilization. Simple (not compounded) and before losses.
 */
export function poolSupplyApy(pool: LendingPool, asOf: number = nowSec()): number {
    const value = poolValue(pool, asOf);
    return value > 0 ? Math.max(0, pool.accruingPerYear ?? 0) / value : 0;
}

/** Share of the pool's capital out on loan (or reserved for approved loans). */
export function poolUtilization(pool: LendingPool): number {
    const total = pool.availableLiquidity + pool.totalLent;
    return total > 0 ? clamp(pool.totalLent / total, 0, 1) : 0;
}

/**
 * A lender's lifetime result in a pool: what the position is worth now plus
 * everything taken out (paid or awaiting payout), minus everything put in.
 * principalWithdrawn counts confirmed withdrawals at their full amount.
 */
export function positionEarnings(
    pool: LendingPool,
    position: Pick<PoolPosition, "shares" | "pendingWithdrawalShares" | "principalDeposited" | "principalWithdrawn">,
    pendingPayoutAmount = 0,
    asOf: number = nowSec(),
): { value: number; earned: number } {
    const value = freeShares(position) * poolSharePrice(pool, asOf);
    return { value, earned: value + pendingPayoutAmount + position.principalWithdrawn - position.principalDeposited };
}

export type LoanHealth = "healthy" | "watch" | "at_risk";

/** How close a collateral-market loan is to liquidation: "at_risk" within 5 points of the threshold, "watch" within 10. */
export function loanHealth(ltv: number, liquidationLtvBps: number): LoanHealth {
    const bps = Math.round(ltv * 1_000_000) / 100; // basis points, without float drift
    if (bps >= liquidationLtvBps - 500) return "at_risk";
    if (bps >= liquidationLtvBps - 1000) return "watch";
    return "healthy";
}

/** Extra collateral needed to bring a loan down to `targetLtv` (0 if already there). */
export function collateralToReachLtv(debtUsd: number, collateral: number, collateralPriceUsd: number, targetLtv: number): number {
    if (!(collateralPriceUsd > 0) || !(targetLtv > 0)) return 0;
    return Math.max(0, debtUsd / (targetLtv * collateralPriceUsd) - collateral);
}
