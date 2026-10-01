/**
 * Lending Eligibility & Underwriting
 *
 * Pure functions — no Firestore I/O. Loan limits and rates scale off the agent's
 * resolved credit policy tier (credit-policy.ts), the same tier that already
 * governs escrow ratios and spending caps for task work. Collateral for "trust"
 * loans reuses calculateRequiredEscrow() so a Bronze/high-risk agent posts more
 * security than a Platinum/prime one, exactly like task escrow does today.
 */

import type { PolicyTierDefinition, PolicyTierName } from "@/lib/credit-policy";
import type { EligibilitySummary, KindEligibility, LoanKind } from "./types";

export const MIN_LOAN_USD = 50;
export const MAX_CONCURRENT_LOANS = 2;

/** Annualized base rate (bps) by resolved policy tier. */
const RATE_BPS_BY_TIER: Record<PolicyTierName, number> = {
    prime: 600,
    trusted: 900,
    standard: 1400,
    restricted: 2000,
    high_risk: 2800,
};

/** Trust (collateralized) loans carry a lower rate than unsecured — the collateral cushions lender risk. */
const TRUST_RATE_DISCOUNT = 0.7;

/** Number of successfully repaid trust loans required before unsecured lending unlocks, by tier. */
const TRUST_LOANS_REQUIRED_BY_TIER: Record<PolicyTierName, number> = {
    prime: 0,
    trusted: 0,
    standard: 1,
    restricted: 2,
    high_risk: 3,
};

/** Loan ceilings as a fraction of the tier's existing task spending cap. */
const TRUST_MAX_RATIO = 0.15;
const UNSECURED_MAX_RATIO = 0.5;

export interface LoanTerms {
    trustMaxUsd: number;
    trustRateBps: number;
    unsecuredMaxUsd: number;
    unsecuredRateBps: number;
    trustLoansRequiredForUnsecured: number;
}

export function getLoanTerms(policy: PolicyTierDefinition): LoanTerms {
    const rateBps = RATE_BPS_BY_TIER[policy.name];
    return {
        trustMaxUsd: Math.max(MIN_LOAN_USD, Math.round(policy.spendingCapUsd * TRUST_MAX_RATIO)),
        trustRateBps: Math.round(rateBps * TRUST_RATE_DISCOUNT),
        unsecuredMaxUsd: Math.round(policy.spendingCapUsd * UNSECURED_MAX_RATIO),
        unsecuredRateBps: rateBps,
        trustLoansRequiredForUnsecured: TRUST_LOANS_REQUIRED_BY_TIER[policy.name],
    };
}

export interface EvaluateEligibilityInput {
    policy: PolicyTierDefinition;
    creditScore: number;
    completedTrustLoans: number;
    activeLoanCount: number;
    hasUnresolvedDefault: boolean;
}

export function evaluateEligibility(input: EvaluateEligibilityInput): EligibilitySummary {
    const terms = getLoanTerms(input.policy);
    const atCapacity = input.activeLoanCount >= MAX_CONCURRENT_LOANS;

    const blockedReason = input.hasUnresolvedDefault
        ? "An unresolved default must be cleared before taking on a new loan"
        : atCapacity
            ? `Maximum of ${MAX_CONCURRENT_LOANS} concurrent loans reached`
            : undefined;

    const trust: KindEligibility = blockedReason
        ? { eligible: false, maxAmountUsd: 0, rateBps: terms.trustRateBps, reason: blockedReason }
        : { eligible: true, maxAmountUsd: terms.trustMaxUsd, rateBps: terms.trustRateBps };

    const unsecuredLocked = input.completedTrustLoans < terms.trustLoansRequiredForUnsecured;
    const unsecured: KindEligibility = blockedReason
        ? { eligible: false, maxAmountUsd: 0, rateBps: terms.unsecuredRateBps, reason: blockedReason }
        : unsecuredLocked
            ? {
                eligible: false,
                maxAmountUsd: 0,
                rateBps: terms.unsecuredRateBps,
                reason: `Repay ${terms.trustLoansRequiredForUnsecured - input.completedTrustLoans} more escrowed trust loan(s) to unlock unsecured lending`,
            }
            : { eligible: true, maxAmountUsd: terms.unsecuredMaxUsd, rateBps: terms.unsecuredRateBps };

    return {
        policyTier: input.policy.name,
        creditScore: input.creditScore,
        completedTrustLoans: input.completedTrustLoans,
        trustLoansRequiredForUnsecured: terms.trustLoansRequiredForUnsecured,
        activeLoanCount: input.activeLoanCount,
        hasUnresolvedDefault: input.hasUnresolvedDefault,
        trust,
        unsecured,
    };
}

export function kindEligibility(summary: EligibilitySummary, kind: LoanKind): KindEligibility {
    return kind === "trust" ? summary.trust : summary.unsecured;
}

export function clampTermDays(termDays: number): number {
    if (!Number.isFinite(termDays)) return 30;
    return Math.min(90, Math.max(7, Math.round(termDays)));
}
