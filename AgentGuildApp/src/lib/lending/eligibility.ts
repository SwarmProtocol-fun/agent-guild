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

/**
 * Number of successfully repaid trust (escrowed) loans required before
 * unsecured lending unlocks, by tier. Everyone needs at least one — a high
 * task-completion credit score doesn't tell you anything about whether an
 * agent repays a *loan*, so even Prime/Trusted agents build that track
 * record through an escrowed loan first instead of skipping straight to
 * unsecured borrowing on their very first request.
 */
const TRUST_LOANS_REQUIRED_BY_TIER: Record<PolicyTierName, number> = {
    prime: 1,
    trusted: 1,
    standard: 1,
    restricted: 2,
    high_risk: 3,
};

/** Loan ceilings as a fraction of the tier's existing task spending cap. */
const TRUST_MAX_RATIO = 0.15;
const UNSECURED_MAX_RATIO = 0.5;

/**
 * Borrowing power ramps up with each loan of that kind successfully repaid —
 * loan #1 of a kind is capped at a small fraction of the tier ceiling, not
 * the full amount, however good the agent's tier already is. Each repayment
 * raises the cap until it reaches the tier ceiling. This is what makes the
 * system permissionless: nobody reviews a loan request by hand, the size
 * limit is just a function of the borrower's own on-chain repayment history.
 */
const GRADUATION_LADDER = [0.10, 0.20, 0.35, 0.55, 0.80, 1.0];

export function graduatedMaxUsd(tierMaxUsd: number, repaidLoansOfKind: number): number {
    const step = GRADUATION_LADDER[Math.min(Math.max(0, repaidLoansOfKind), GRADUATION_LADDER.length - 1)];
    return Math.max(MIN_LOAN_USD, Math.round(tierMaxUsd * step));
}

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
    completedUnsecuredLoans: number;
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

    const trustMaxUsd = graduatedMaxUsd(terms.trustMaxUsd, input.completedTrustLoans);
    const trust: KindEligibility = blockedReason
        ? { eligible: false, maxAmountUsd: 0, rateBps: terms.trustRateBps, reason: blockedReason }
        : { eligible: true, maxAmountUsd: trustMaxUsd, rateBps: terms.trustRateBps };

    const unsecuredLocked = input.completedTrustLoans < terms.trustLoansRequiredForUnsecured;
    const unsecuredMaxUsd = graduatedMaxUsd(terms.unsecuredMaxUsd, input.completedUnsecuredLoans);
    const unsecured: KindEligibility = blockedReason
        ? { eligible: false, maxAmountUsd: 0, rateBps: terms.unsecuredRateBps, reason: blockedReason }
        : unsecuredLocked
            ? {
                eligible: false,
                maxAmountUsd: 0,
                rateBps: terms.unsecuredRateBps,
                reason: `Repay ${terms.trustLoansRequiredForUnsecured - input.completedTrustLoans} more escrowed trust loan(s) to unlock unsecured lending`,
            }
            : { eligible: true, maxAmountUsd: unsecuredMaxUsd, rateBps: terms.unsecuredRateBps };

    return {
        policyTier: input.policy.name,
        creditScore: input.creditScore,
        completedTrustLoans: input.completedTrustLoans,
        completedUnsecuredLoans: input.completedUnsecuredLoans,
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

/**
 * Solo loans are negotiated between two people, not priced by the platform —
 * unlike pool loans, where the rate is always the tier-algorithmic rate,
 * fixed, non-negotiable. The guardrail: a solo rate still has to sit within a
 * band around that same algorithmic rate, so a lender can't charge a
 * desperate borrower a usurious rate, and a borrower can't lowball a rate no
 * real lender would ever take (which would just mean the request never gets
 * funded, but there's no reason to allow it).
 */
export const SOLO_RATE_BAND_MULTIPLIER = { min: 0.5, max: 2.0 };

export interface SoloRateBand {
    minBps: number;
    maxBps: number;
}

export function soloRateBand(tierRateBps: number): SoloRateBand {
    return {
        minBps: Math.round(tierRateBps * SOLO_RATE_BAND_MULTIPLIER.min),
        maxBps: Math.round(tierRateBps * SOLO_RATE_BAND_MULTIPLIER.max),
    };
}

export function validateSoloRateBps(requestedRateBps: number, tierRateBps: number): { ok: boolean; band: SoloRateBand; error?: string } {
    const band = soloRateBand(tierRateBps);
    if (!Number.isFinite(requestedRateBps) || requestedRateBps < band.minBps || requestedRateBps > band.maxBps) {
        return {
            ok: false,
            band,
            error: `Rate must be between ${(band.minBps / 100).toFixed(1)}% and ${(band.maxBps / 100).toFixed(1)}% APR for this tier`,
        };
    }
    return { ok: true, band };
}

export function clampTermDays(termDays: number): number {
    if (!Number.isFinite(termDays)) return 30;
    return Math.min(90, Math.max(7, Math.round(termDays)));
}
