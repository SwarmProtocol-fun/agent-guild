import { describe, it, expect } from "vitest";
import { getLoanTerms, evaluateEligibility, clampTermDays, MIN_LOAN_USD, MAX_CONCURRENT_LOANS } from "../eligibility";
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

    it("requires more proven trust loans to unlock unsecured lending for worse tiers", () => {
        expect(getLoanTerms(prime).trustLoansRequiredForUnsecured).toBe(0);
        expect(getLoanTerms(highRisk).trustLoansRequiredForUnsecured).toBeGreaterThan(0);
    });
});

describe("evaluateEligibility", () => {
    it("allows a prime-tier agent with no history straight into unsecured lending", () => {
        const summary = evaluateEligibility({
            policy: prime, creditScore: 880, completedTrustLoans: 0, activeLoanCount: 0, hasUnresolvedDefault: false,
        });
        expect(summary.trust.eligible).toBe(true);
        expect(summary.unsecured.eligible).toBe(true);
    });

    it("locks unsecured lending for a standard-tier agent until trust loans are repaid", () => {
        const summary = evaluateEligibility({
            policy: standard, creditScore: 700, completedTrustLoans: 0, activeLoanCount: 0, hasUnresolvedDefault: false,
        });
        expect(summary.trust.eligible).toBe(true);
        expect(summary.unsecured.eligible).toBe(false);
        expect(summary.unsecured.reason).toMatch(/trust loan/i);
    });

    it("unlocks unsecured lending once enough trust loans are repaid", () => {
        const required = getLoanTerms(standard).trustLoansRequiredForUnsecured;
        const summary = evaluateEligibility({
            policy: standard, creditScore: 700, completedTrustLoans: required, activeLoanCount: 0, hasUnresolvedDefault: false,
        });
        expect(summary.unsecured.eligible).toBe(true);
    });

    it("blocks all new loans while a default is unresolved", () => {
        const summary = evaluateEligibility({
            policy: prime, creditScore: 880, completedTrustLoans: 5, activeLoanCount: 0, hasUnresolvedDefault: true,
        });
        expect(summary.trust.eligible).toBe(false);
        expect(summary.unsecured.eligible).toBe(false);
        expect(summary.trust.reason).toMatch(/default/i);
    });

    it("blocks new loans once the concurrent loan cap is reached", () => {
        const summary = evaluateEligibility({
            policy: prime, creditScore: 880, completedTrustLoans: 5, activeLoanCount: MAX_CONCURRENT_LOANS, hasUnresolvedDefault: false,
        });
        expect(summary.trust.eligible).toBe(false);
        expect(summary.trust.reason).toMatch(/concurrent/i);
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
