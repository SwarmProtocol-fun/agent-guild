import { describe, it, expect } from "vitest";
import { accrue, applyPayment, clamp } from "../math";
import type { Loan } from "../types";

const DAY = 86400;

function makeLoan(overrides: Partial<Loan> = {}): Loan {
    const originatedAt = 1_000_000;
    return {
        id: "loan-1",
        borrowerAgentId: "agent-1",
        borrowerOrgId: "org-1",
        kind: "unsecured",
        source: "pool",
        status: "active",
        principalUsd: 1000,
        principalRemainingUsd: 1000,
        principalPaidUsd: 0,
        interestRateBps: 1000, // 10% APR
        interestAccruedUsd: 0,
        interestPaidUsd: 0,
        collateralUsd: 0,
        termDays: 30,
        requestedAt: originatedAt,
        originatedAt,
        dueAt: originatedAt + 30 * DAY,
        lastAccrualAt: originatedAt,
        policyTierAtOrigination: "standard",
        creditScoreAtOrigination: 700,
        ...overrides,
    };
}

describe("accrue", () => {
    it("accrues nothing when no time has elapsed", () => {
        const loan = makeLoan();
        const accrued = accrue(loan, loan.lastAccrualAt!);
        expect(accrued.interestAccruedUsd).toBe(0);
    });

    it("accrues simple daily interest proportional to elapsed days", () => {
        const loan = makeLoan();
        const asOf = loan.lastAccrualAt! + 36.5 * DAY; // 1/10 of a year
        const accrued = accrue(loan, asOf);
        // 1000 * 10% * (36.5/365) = 10
        expect(accrued.interestAccruedUsd).toBeCloseTo(10, 6);
        expect(accrued.lastAccrualAt).toBe(asOf);
    });

    it("accrues on the remaining principal, not the original principal", () => {
        const loan = makeLoan({ principalRemainingUsd: 500 });
        const asOf = loan.lastAccrualAt! + 36.5 * DAY;
        const accrued = accrue(loan, asOf);
        expect(accrued.interestAccruedUsd).toBeCloseTo(5, 6);
    });

    it("never accrues negative interest for a stale asOf", () => {
        const loan = makeLoan();
        const accrued = accrue(loan, loan.lastAccrualAt! - DAY);
        expect(accrued.interestAccruedUsd).toBe(0);
    });
});

describe("applyPayment", () => {
    it("applies payment to accrued interest before principal", () => {
        const loan = makeLoan({ interestAccruedUsd: 20, principalRemainingUsd: 1000 });
        const result = applyPayment(loan, 15, loan.originatedAt!);
        expect(result.interestPortionUsd).toBe(15);
        expect(result.principalPortionUsd).toBe(0);
        expect(result.loan.interestAccruedUsd).toBeCloseTo(5, 6);
        expect(result.loan.principalRemainingUsd).toBe(1000);
        expect(result.finalStatus).toBe("active");
    });

    it("pays off interest fully then rolls the remainder into principal", () => {
        const loan = makeLoan({ interestAccruedUsd: 20, principalRemainingUsd: 1000 });
        const result = applyPayment(loan, 120, loan.originatedAt!);
        expect(result.interestPortionUsd).toBe(20);
        expect(result.principalPortionUsd).toBe(100);
        expect(result.loan.interestAccruedUsd).toBe(0);
        expect(result.loan.principalRemainingUsd).toBe(900);
        expect(result.finalStatus).toBe("active");
    });

    it("caps the applied amount at what's owed and reports the excess for refund", () => {
        const loan = makeLoan({ interestAccruedUsd: 10, principalRemainingUsd: 100 });
        const result = applyPayment(loan, 1_000_000, loan.originatedAt!);
        expect(result.appliedUsd).toBe(110);
        expect(result.excessUsd).toBe(999_890);
        expect(result.remainingBalanceUsd).toBe(0);
    });

    it("reports zero excess for an exact or partial payment", () => {
        const loan = makeLoan({ interestAccruedUsd: 10, principalRemainingUsd: 100 });
        expect(applyPayment(loan, 110, loan.originatedAt!).excessUsd).toBe(0);
        expect(applyPayment(loan, 50, loan.originatedAt!).excessUsd).toBe(0);
    });

    it("marks the loan repaid once the full balance clears", () => {
        const loan = makeLoan({ interestAccruedUsd: 10, principalRemainingUsd: 100 });
        const result = applyPayment(loan, 110, loan.originatedAt!);
        expect(result.finalStatus).toBe("repaid");
        expect(result.remainingBalanceUsd).toBe(0);
    });

    it("keeps a late partial payment active (overdue) rather than auto-defaulting", () => {
        const loan = makeLoan({ interestAccruedUsd: 10, principalRemainingUsd: 1000, dueAt: 1_000_000 });
        const result = applyPayment(loan, 50, 2_000_000); // well past dueAt, partial payment
        expect(result.isOverdue).toBe(true);
        expect(result.finalStatus).toBe("active");
        expect(result.loan.principalRemainingUsd).toBe(960);
    });

    it("stays active for a partial payment before the due date", () => {
        const loan = makeLoan({ interestAccruedUsd: 10, principalRemainingUsd: 1000, dueAt: 5_000_000 });
        const result = applyPayment(loan, 50, 2_000_000);
        expect(result.isOverdue).toBe(false);
        expect(result.finalStatus).toBe("active");
    });

    it("a full clearing payment on the due date itself is repaid, not defaulted", () => {
        const loan = makeLoan({ interestAccruedUsd: 10, principalRemainingUsd: 100, dueAt: 2_000_000 });
        const result = applyPayment(loan, 110, 3_000_000); // overdue, but fully clears
        expect(result.finalStatus).toBe("repaid");
    });
});

describe("clamp", () => {
    it("clamps within range", () => {
        expect(clamp(50, 0, 100)).toBe(50);
        expect(clamp(-10, 0, 100)).toBe(0);
        expect(clamp(150, 0, 100)).toBe(100);
    });
});
