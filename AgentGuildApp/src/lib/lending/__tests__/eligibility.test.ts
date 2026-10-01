import { describe, it, expect } from "vitest";
import {
    getLoanTerms, evaluateEligibility, graduatedMaxUsd, clampTermDays, soloRateBand, validateSoloRateBps,
    MIN_LOAN_USD, MAX_CONCURRENT_LOANS,
} from "../eligibility";
import { DEFAULT_POLICY_TIERS, getTier } from "@/lib/credit-policy";

const prime = getTier("prime");
const standard = getTier("standard");
const highRisk = getTier("high_risk");

describe("getLoanTerms", () => {
    it("derives loan ceilings as a fraction of the tier's spending cap", () => {
        const terms = getLoanTerms(prime);
        expect(terms.trustMaxUsd).toBeCloseTo(prime.spendingCapUsd * 0.15);
        expect(terms.unsecuredMaxUsd).toBeCloseTo(prime.spendingCapUsd * 0.5);
    });

    it("gives every tier a real minimum trust loan ceiling even at a tiny spending cap", () => {
        const terms = getLoanTerms(highRisk);
        expect(terms.trustMaxUsd).toBeGreaterThanOrEqual(MIN_LOAN_USD);
    });

    it("discounts the trust (collateralized) rate below the unsecured rate for every tier", () => {
        for (const tier of DEFAULT_POLICY_TIERS) {
            const terms = getLoanTerms(tier);
            expect(terms.trustRateBps).toBeLessThan(terms.unsecuredRateBps);
        }
    });

    it("charges worse tiers a higher rate than better tiers", () => {
        const primeTerms = getLoanTerms(prime);
        const highRiskTerms = getLoanTerms(highRisk);
        expect(highRiskTerms.unsecuredRateBps).toBeGreaterThan(primeTerms.unsecuredRateBps);
    });

    it("requires at least one escrowed trust loan for every tier, more for worse tiers", () => {
        for (const tier of DEFAULT_POLICY_TIERS) {
            expect(getLoanTerms(tier).trustLoansRequiredForUnsecured).toBeGreaterThanOrEqual(1);
        }
        expect(getLoanTerms(highRisk).trustLoansRequiredForUnsecured).toBeGreaterThan(getLoanTerms(prime).trustLoansRequiredForUnsecured);
    });
});

describe("graduatedMaxUsd", () => {
    it("caps a borrower with no history at a small fraction of the tier ceiling", () => {
        const max = graduatedMaxUsd(10_000, 0);
        expect(max).toBeCloseTo(1_000); // 10% step
        expect(max).toBeLessThan(10_000);
    });

    it("ramps up with each additional repaid loan of that kind", () => {
        const amounts = [0, 1, 2, 3, 4, 5, 6].map((n) => graduatedMaxUsd(10_000, n));
        for (let i = 1; i < amounts.length; i++) {
            expect(amounts[i]).toBeGreaterThanOrEqual(amounts[i - 1]);
        }
        expect(amounts[amounts.length - 1]).toBeCloseTo(10_000); // fully graduated
    });

    it("never drops below the platform minimum loan size even for a tiny tier ceiling", () => {
        expect(graduatedMaxUsd(100, 0)).toBeGreaterThanOrEqual(MIN_LOAN_USD);
    });
});

describe("evaluateEligibility", () => {
    it("still requires an escrowed trust loan before unsecured lending, even for a Prime-tier agent with no history", () => {
        const summary = evaluateEligibility({
            policy: prime, creditScore: 880, completedTrustLoans: 0, completedUnsecuredLoans: 0, activeLoanCount: 0, hasUnresolvedDefault: false,
        });
        expect(summary.trust.eligible).toBe(true);
        expect(summary.unsecured.eligible).toBe(false);
        expect(summary.unsecured.reason).toMatch(/trust loan/i);
    });

    it("caps a first-ever trust loan well below the tier's full trust ceiling", () => {
        const summary = evaluateEligibility({
            policy: prime, creditScore: 880, completedTrustLoans: 0, completedUnsecuredLoans: 0, activeLoanCount: 0, hasUnresolvedDefault: false,
        });
        const terms = getLoanTerms(prime);
        expect(summary.trust.maxAmountUsd).toBeLessThan(terms.trustMaxUsd);
    });

    it("locks unsecured lending for a standard-tier agent until trust loans are repaid", () => {
        const summary = evaluateEligibility({
            policy: standard, creditScore: 700, completedTrustLoans: 0, completedUnsecuredLoans: 0, activeLoanCount: 0, hasUnresolvedDefault: false,
        });
        expect(summary.trust.eligible).toBe(true);
        expect(summary.unsecured.eligible).toBe(false);
        expect(summary.unsecured.reason).toMatch(/trust loan/i);
    });

    it("unlocks unsecured lending once enough trust loans are repaid, but still at a graduated (not full) size", () => {
        const required = getLoanTerms(standard).trustLoansRequiredForUnsecured;
        const summary = evaluateEligibility({
            policy: standard, creditScore: 700, completedTrustLoans: required, completedUnsecuredLoans: 0, activeLoanCount: 0, hasUnresolvedDefault: false,
        });
        expect(summary.unsecured.eligible).toBe(true);
        expect(summary.unsecured.maxAmountUsd).toBeLessThan(getLoanTerms(standard).unsecuredMaxUsd);
    });

    it("grows the unsecured cap toward the tier ceiling as unsecured loans are repaid", () => {
        const required = getLoanTerms(standard).trustLoansRequiredForUnsecured;
        const early = evaluateEligibility({
            policy: standard, creditScore: 700, completedTrustLoans: required, completedUnsecuredLoans: 0, activeLoanCount: 0, hasUnresolvedDefault: false,
        });
        const seasoned = evaluateEligibility({
            policy: standard, creditScore: 700, completedTrustLoans: required, completedUnsecuredLoans: 10, activeLoanCount: 0, hasUnresolvedDefault: false,
        });
        expect(seasoned.unsecured.maxAmountUsd).toBeGreaterThan(early.unsecured.maxAmountUsd);
        expect(seasoned.unsecured.maxAmountUsd).toBeCloseTo(getLoanTerms(standard).unsecuredMaxUsd);
    });

    it("blocks all new loans while a default is unresolved", () => {
        const summary = evaluateEligibility({
            policy: prime, creditScore: 880, completedTrustLoans: 5, completedUnsecuredLoans: 5, activeLoanCount: 0, hasUnresolvedDefault: true,
        });
        expect(summary.trust.eligible).toBe(false);
        expect(summary.unsecured.eligible).toBe(false);
        expect(summary.trust.reason).toMatch(/default/i);
    });

    it("blocks new loans once the concurrent loan cap is reached", () => {
        const summary = evaluateEligibility({
            policy: prime, creditScore: 880, completedTrustLoans: 5, completedUnsecuredLoans: 5, activeLoanCount: MAX_CONCURRENT_LOANS, hasUnresolvedDefault: false,
        });
        expect(summary.trust.eligible).toBe(false);
        expect(summary.trust.reason).toMatch(/concurrent/i);
    });
});

describe("soloRateBand / validateSoloRateBps", () => {
    it("centers the band on the tier's algorithmic rate", () => {
        const band = soloRateBand(1000);
        expect(band.minBps).toBeCloseTo(500);
        expect(band.maxBps).toBeCloseTo(2000);
    });

    it("accepts a rate at the tier's own algorithmic rate", () => {
        expect(validateSoloRateBps(1000, 1000).ok).toBe(true);
    });

    it("rejects a rate below the band (undercutting no real lender would take, but still bounded)", () => {
        const result = validateSoloRateBps(100, 1000);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/between/i);
    });

    it("rejects a usurious rate above the band", () => {
        const result = validateSoloRateBps(10_000, 1000);
        expect(result.ok).toBe(false);
    });

    it("accepts a rate at the exact band edges", () => {
        const band = soloRateBand(1000);
        expect(validateSoloRateBps(band.minBps, 1000).ok).toBe(true);
        expect(validateSoloRateBps(band.maxBps, 1000).ok).toBe(true);
    });
});

describe("clampTermDays", () => {
    it("clamps below the 7-day floor", () => {
        expect(clampTermDays(1)).toBe(7);
    });
    it("clamps above the 90-day ceiling", () => {
        expect(clampTermDays(365)).toBe(90);
    });
    it("passes through a valid value", () => {
        expect(clampTermDays(30)).toBe(30);
    });
    it("falls back to 30 for non-finite input", () => {
        expect(clampTermDays(NaN)).toBe(30);
    });
});
