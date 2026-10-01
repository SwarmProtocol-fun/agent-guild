/**
 * Pure loan math — interest accrual and payment application.
 * No Firestore I/O, so it's directly unit-testable; lending-service.ts's
 * transactions call these and persist the results.
 */

import type { Loan } from "./types";

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
    isOverdue: boolean;
    finalStatus: Loan["status"];
}

/**
 * Apply a payment to an (already-accrued) active loan: interest first, then principal.
 * Determines the resulting status — "repaid" if the balance clears, "defaulted" if a
 * balance remains past `dueAt`, otherwise stays "active".
 */
export function applyPayment(loan: Loan, amountUsd: number, asOf: number): PaymentResult {
    const totalOwed = loan.principalRemainingUsd + loan.interestAccruedUsd;
    const appliedUsd = Math.min(amountUsd, totalOwed);
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

    let finalStatus: Loan["status"] = "active";
    if (remainingBalanceUsd <= 0.01) {
        finalStatus = "repaid";
    } else if (isOverdue) {
        finalStatus = "defaulted";
    }

    return { loan: updated, appliedUsd, principalPortionUsd, interestPortionUsd, remainingBalanceUsd, isOverdue, finalStatus };
}

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}
