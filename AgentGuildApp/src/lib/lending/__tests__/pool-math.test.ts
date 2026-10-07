import { describe, it, expect } from "vitest";
import {
    poolSharePrice,
    freeShares,
    planWithdrawal,
    sharesForDeposit,
    poolSettlementDeltas,
    poolValue,
    poolInterestReceivable,
    accruePoolInterest,
    depositCapacity,
    computeDefaultRecovery,
} from "../math";
import type { LendingPool } from "../types";

function makePool(overrides: Partial<LendingPool> = {}): LendingPool {
    return {
        id: "p1",
        name: "Pool",
        totalShares: 1000,
        availableLiquidity: 600,
        totalLent: 400,
        totalDeposited: 1000,
        totalInterestEarned: 0,
        totalDefaulted: 0,
        pendingWithdrawal: 0,
        pendingWithdrawalShares: 0,
        createdAt: null,
        ...overrides,
    };
}

describe("poolSharePrice", () => {
    it("is 1 for an empty pool", () => {
        expect(poolSharePrice(makePool({ totalShares: 0, availableLiquidity: 0, totalLent: 0 }))).toBe(1);
    });

    it("works on legacy pool docs without pending fields", () => {
        const pool = makePool();
        delete pool.pendingWithdrawalShares;
        delete pool.pendingWithdrawal;
        expect(poolSharePrice(pool)).toBe(1);
    });

    it("is unchanged by reserving a withdrawal", () => {
        const before = makePool();
        const { sharesToBurn } = planWithdrawal(before, { shares: 500 }, 200);
        const after = makePool({
            availableLiquidity: 400,
            pendingWithdrawal: 200,
            pendingWithdrawalShares: sharesToBurn,
        });
        expect(poolSharePrice(after)).toBeCloseTo(poolSharePrice(before), 12);
    });
});

describe("planWithdrawal", () => {
    it("burns amount / price shares", () => {
        const pool = makePool({ availableLiquidity: 700 }); // value 1100 / 1000 shares => 1.1
        const { sharesToBurn, price } = planWithdrawal(pool, { shares: 100 }, 55);
        expect(price).toBeCloseTo(1.1, 12);
        expect(sharesToBurn).toBeCloseTo(50, 9);
    });

    it("rejects stacking requests beyond the unlocked position", () => {
        const pool = makePool();
        // 100 shares owned, 100 already locked in a pending request.
        expect(() => planWithdrawal(pool, { shares: 100, pendingWithdrawalShares: 100 }, 50)).toThrow(/exceeds your withdrawable/);
    });

    it("allows withdrawing exactly the remaining unlocked shares", () => {
        const pool = makePool();
        const { sharesToBurn } = planWithdrawal(pool, { shares: 100, pendingWithdrawalShares: 40 }, 60);
        expect(sharesToBurn).toBeCloseTo(60, 9);
    });

    it("clamps float dust on a full-position withdrawal", () => {
        const pool = makePool({ totalShares: 3, availableLiquidity: 10, totalLent: 0 }); // price 3.333...
        const { sharesToBurn } = planWithdrawal(pool, { shares: 3 }, 10);
        expect(sharesToBurn).toBe(3);
    });

    it("rejects more than the pool's free liquidity", () => {
        const pool = makePool({ availableLiquidity: 50, totalLent: 950 });
        expect(() => planWithdrawal(pool, { shares: 500 }, 100)).toThrow(/free liquidity/);
    });

    it("rejects non-positive amounts", () => {
        expect(() => planWithdrawal(makePool(), { shares: 100 }, 0)).toThrow(/positive/);
    });
});

describe("freeShares", () => {
    it("never goes negative", () => {
        expect(freeShares({ shares: 10, pendingWithdrawalShares: 12 })).toBe(0);
    });
});

describe("sharesForDeposit", () => {
    it("mints 1:1 into an empty pool", () => {
        expect(sharesForDeposit(makePool({ totalShares: 0, availableLiquidity: 0, totalLent: 0 }), 250)).toBe(250);
    });

    it("mints at the current price otherwise", () => {
        const pool = makePool({ availableLiquidity: 1000, totalLent: 1000 }); // price 2
        expect(sharesForDeposit(pool, 100)).toBeCloseTo(50, 12);
    });
});

describe("poolSettlementDeltas", () => {
    it("returns principal and interest to liquidity", () => {
        expect(poolSettlementDeltas(100, 5, 0)).toEqual({
            availableLiquidity: 105,
            totalLent: -100,
            totalInterestEarned: 5,
            totalDefaulted: 0,
        });
    });

    it("writes a loss off totalLent without adding liquidity", () => {
        expect(poolSettlementDeltas(0, 0, 300)).toEqual({
            availableLiquidity: 0,
            totalLent: -300,
            totalInterestEarned: 0,
            totalDefaulted: 300,
        });
    });

    it("handles a partial return plus loss in one settlement", () => {
        const d = poolSettlementDeltas(40, 2, 60);
        expect(d.totalLent).toBe(-100);
        expect(d.availableLiquidity).toBe(42);
    });

    it("conserves pool value across a repayment: value rises by exactly the interest", () => {
        const pool = makePool();
        const d = poolSettlementDeltas(100, 5, 0);
        const valueBefore = pool.availableLiquidity + pool.totalLent;
        const valueAfter = pool.availableLiquidity + d.availableLiquidity + pool.totalLent + d.totalLent;
        expect(valueAfter - valueBefore).toBeCloseTo(5, 12);
    });
});

describe("pool interest accrual", () => {
    const YEAR = 365 * 86400;

    it("adds accrued-but-unpaid interest to pool value linearly over time", () => {
        // $1,000 out at 10% APR => $100/yr accruing
        const pool = makePool({ accruingPerYear: 100, interestReceivable: 0, interestAccrualAt: 1_000 });
        expect(poolInterestReceivable(pool, 1_000)).toBe(0);
        expect(poolInterestReceivable(pool, 1_000 + YEAR / 2)).toBeCloseTo(50, 9);
        expect(poolValue(pool, 1_000 + YEAR)).toBeCloseTo(1000 + 100, 9);
    });

    it("matches per-loan accrual exactly (pool receivable == Σ loan.accrue)", () => {
        const start = 1_700_000_000;
        const loanA = { principalRemaining: 400, interestRateBps: 1200 }; // 48/yr
        const loanB = { principalRemaining: 250, interestRateBps: 800 };  // 20/yr
        const pool = makePool({ accruingPerYear: 48 + 20, interestReceivable: 0, interestAccrualAt: start });
        const t = start + 37 * 86400;
        const perLoan = (l: typeof loanA) => l.principalRemaining * (l.interestRateBps / 10_000 / 365) * 37;
        expect(poolInterestReceivable(pool, t)).toBeCloseTo(perLoan(loanA) + perLoan(loanB), 9);
    });

    it("accruePoolInterest folds elapsed interest into the stored receivable", () => {
        const pool = makePool({ accruingPerYear: 365, interestReceivable: 2, interestAccrualAt: 0 });
        expect(accruePoolInterest(pool, 86400)).toEqual({ interestReceivable: 3, interestAccrualAt: 86400 });
    });

    it("prices shares off accrued value, so a depositor arriving before a repayment doesn't capture past interest", () => {
        // 1000 shares, $1000 cash+principal, $50 of interest accrued so far
        const pool = makePool({ accruingPerYear: 100, interestReceivable: 50, interestAccrualAt: 5_000 });
        expect(poolSharePrice(pool, 5_000)).toBeCloseTo(1.05, 12);
        expect(sharesForDeposit(pool, 105, 5_000)).toBeCloseTo(100, 9);
    });

    it("treats legacy pools without accrual fields as zero receivable", () => {
        expect(poolInterestReceivable(makePool(), 123)).toBe(0);
    });
});

describe("depositCapacity", () => {
    it("is unlimited with no caps", () => {
        expect(depositCapacity(makePool(), null, { maxPoolTvlUsd: null, maxDepositPerWalletUsd: null })).toBe(Infinity);
    });

    it("respects the pool TVL cap", () => {
        expect(depositCapacity(makePool(), null, { maxPoolTvlUsd: 1500, maxDepositPerWalletUsd: null }, 0)).toBe(500);
    });

    it("respects the per-wallet cap on net deposits", () => {
        const position = { principalDeposited: 800, principalWithdrawn: 300 };
        expect(depositCapacity(makePool(), position, { maxPoolTvlUsd: null, maxDepositPerWalletUsd: 1000 })).toBe(500);
    });

    it("takes the tighter of the two caps and never goes negative", () => {
        const position = { principalDeposited: 100, principalWithdrawn: 0 };
        expect(depositCapacity(makePool(), position, { maxPoolTvlUsd: 1050, maxDepositPerWalletUsd: 500 }, 0)).toBe(50);
        expect(depositCapacity(makePool(), position, { maxPoolTvlUsd: 900, maxDepositPerWalletUsd: 500 }, 0)).toBe(0);
    });
});

describe("computeDefaultRecovery", () => {
    it("recovers nothing without collateral", () => {
        expect(computeDefaultRecovery(500, 20, 0)).toEqual({
            recoveredPrincipal: 0,
            recoveredInterest: 0,
            principalLoss: 500,
            unrecoveredInterest: 20,
            collateralExcess: 0,
        });
    });

    it("applies collateral to principal first", () => {
        const r = computeDefaultRecovery(500, 20, 300);
        expect(r.recoveredPrincipal).toBe(300);
        expect(r.recoveredInterest).toBe(0);
        expect(r.principalLoss).toBe(200);
        expect(r.collateralExcess).toBe(0);
    });

    it("then to interest, returning any excess", () => {
        const r = computeDefaultRecovery(500, 20, 600);
        expect(r.recoveredPrincipal).toBe(500);
        expect(r.recoveredInterest).toBe(20);
        expect(r.principalLoss).toBe(0);
        expect(r.unrecoveredInterest).toBe(0);
        expect(r.collateralExcess).toBe(80);
    });

    it("conserves the collateral exactly", () => {
        const r = computeDefaultRecovery(123.45, 6.78, 200);
        expect(r.recoveredPrincipal + r.recoveredInterest + r.collateralExcess).toBeCloseTo(200, 12);
    });
});
