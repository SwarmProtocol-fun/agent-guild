/**
 * Credit Policy Engine — PRD 4
 *
 * Maps credit scores to named policy tiers with real economic consequences:
 * spending caps, escrow ratios, fee multipliers, marketplace visibility,
 * concurrent task limits, payout speed, and review requirements.
 *
 * Pure functions only — no Firestore I/O. Settings are in credit-policy-settings.ts.
 */

import type { ScoreBand } from "./credit-scoring";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type PolicyTierName = "prime" | "trusted" | "standard" | "restricted" | "high_risk";

export type MarketplaceVisibility = "featured" | "listed" | "unlisted" | "hidden";

export type PayoutSpeed = "instant" | "24h" | "7d" | "14d";

export interface PolicyTierDefinition {
    name: PolicyTierName;
    label: string;
    scoreBand: ScoreBand;
    scoreMin: number;
    scoreMax: number;

    // Economic consequences
    spendingCapUsd: number;
    escrowRatio: number;         // 0.0–1.0 (portion of value locked)
    maxConcurrentTasks: number;
    feeMultiplier: number;       // 1.0 = base rate, 1.5 = 50% surcharge

    // Permission rules
    sensitiveWorkflowAccess: boolean;
    requiresManualReview: boolean;
    canClaimHighValueJobs: boolean;     // Jobs > $1K
    canClaimUrgentJobs: boolean;        // Priority = "urgent"
    canPublishToMarketplace: boolean;
    marketplaceVisibility: MarketplaceVisibility;

    // Payout rules
    payoutSpeed: PayoutSpeed;
    payoutHoldPercent: number;   // % held back until next review cycle

    // Deployment limits
    maxDeployedAgents: number;
    maxOrgMemberships: number;
}

export interface PolicyResolutionInput {
    creditScore: number;
    trustScore: number;
    fraudRiskScore: number;
    riskFlags: string[];
    verificationLevel: "unverified" | "basic" | "verified" | "certified";
    confidenceLevel?: number; // 0–1
}

export interface PolicyResolutionResult {
    tier: PolicyTierDefinition;
    adjustments: string[];
    overridden: boolean;
    resolvedAt: string;
}

export interface OrgPolicyOverride {
    orgId: string;
    // Field-level overrides (only tighten by default; minTier can loosen)
    spendingCapUsd?: number;
    escrowRatio?: number;
    maxConcurrentTasks?: number;
    feeMultiplier?: number;
    requiresManualReview?: boolean;
    canClaimHighValueJobs?: boolean;
    maxDeployedAgents?: number;
    // Tier floor/ceiling
    minTier?: PolicyTierName;
    maxTier?: PolicyTierName;
    // Feature flags
    allowSensitiveWorkflows?: boolean;
    allowMarketplacePublishing?: boolean;
    updatedAt?: string;
    updatedBy?: string;
}

// ═══════════════════════════════════════════════════════════════
// Default Tier Definitions
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_POLICY_TIERS: PolicyTierDefinition[] = [
    {
        name: "prime",
        label: "Prime",
        scoreBand: "elite",
        scoreMin: 850,
        scoreMax: 900,
        spendingCapUsd: 50_000,
        escrowRatio: 0.10,
        maxConcurrentTasks: 20,
        feeMultiplier: 1.0,
        sensitiveWorkflowAccess: true,
        requiresManualReview: false,
        canClaimHighValueJobs: true,
        canClaimUrgentJobs: true,
        canPublishToMarketplace: true,
        marketplaceVisibility: "featured",
        payoutSpeed: "instant",
        payoutHoldPercent: 0,
        maxDeployedAgents: 50,
        maxOrgMemberships: 10,
    },
    {
        name: "trusted",
        label: "Trusted",
        scoreBand: "strong",
        scoreMin: 750,
        scoreMax: 849,
        spendingCapUsd: 10_000,
        escrowRatio: 0.25,
        maxConcurrentTasks: 10,
        feeMultiplier: 1.0,
        sensitiveWorkflowAccess: true,
        requiresManualReview: false,
        canClaimHighValueJobs: true,
        canClaimUrgentJobs: true,
        canPublishToMarketplace: true,
        marketplaceVisibility: "listed",
        payoutSpeed: "24h",
        payoutHoldPercent: 0,
        maxDeployedAgents: 25,
        maxOrgMemberships: 5,
    },
    {
        name: "standard",
        label: "Standard",
        scoreBand: "acceptable",
        scoreMin: 650,
        scoreMax: 749,
        spendingCapUsd: 5_000,
        escrowRatio: 0.50,
        maxConcurrentTasks: 5,
        feeMultiplier: 1.15,
        sensitiveWorkflowAccess: false,
        requiresManualReview: false,
        canClaimHighValueJobs: false,
        canClaimUrgentJobs: true,
        canPublishToMarketplace: true,
        marketplaceVisibility: "listed",
        payoutSpeed: "7d",
        payoutHoldPercent: 5,
        maxDeployedAgents: 10,
        maxOrgMemberships: 3,
    },
    {
        name: "restricted",
        label: "Restricted",
        scoreBand: "risky",
        scoreMin: 550,
        scoreMax: 649,
        spendingCapUsd: 1_000,
        escrowRatio: 0.75,
        maxConcurrentTasks: 2,
        feeMultiplier: 1.5,
        sensitiveWorkflowAccess: false,
        requiresManualReview: true,
        canClaimHighValueJobs: false,
        canClaimUrgentJobs: false,
        canPublishToMarketplace: true,
        marketplaceVisibility: "unlisted",
        payoutSpeed: "14d",
        payoutHoldPercent: 10,
        maxDeployedAgents: 5,
        maxOrgMemberships: 2,
    },
    {
        name: "high_risk",
        label: "High Risk",
        scoreBand: "restricted",
        scoreMin: 300,
        scoreMax: 549,
        spendingCapUsd: 100,
        escrowRatio: 1.0,
        maxConcurrentTasks: 1,
        feeMultiplier: 2.0,
        sensitiveWorkflowAccess: false,
        requiresManualReview: true,
        canClaimHighValueJobs: false,
        canClaimUrgentJobs: false,
        canPublishToMarketplace: false,
        marketplaceVisibility: "hidden",
        payoutSpeed: "14d",
        payoutHoldPercent: 25,
        maxDeployedAgents: 2,
        maxOrgMemberships: 1,
    },
];

// ═══════════════════════════════════════════════════════════════
// Tier Rank (higher = better)
// ═══════════════════════════════════════════════════════════════

const TIER_RANK: Record<PolicyTierName, number> = {
    high_risk: 0,
    restricted: 1,
    standard: 2,
    trusted: 3,
    prime: 4,
};

export function tierRank(name: PolicyTierName): number {
    return TIER_RANK[name];
}

// ═══════════════════════════════════════════════════════════════
// Tier Lookup Helpers
// ═══════════════════════════════════════════════════════════════

export function getTier(name: PolicyTierName): PolicyTierDefinition {
    return DEFAULT_POLICY_TIERS.find((t) => t.name === name) ?? DEFAULT_POLICY_TIERS[4];
}

function findTierByScore(score: number): PolicyTierDefinition {
    for (const tier of DEFAULT_POLICY_TIERS) {
        if (score >= tier.scoreMin && score <= tier.scoreMax) return tier;
    }
    return DEFAULT_POLICY_TIERS[DEFAULT_POLICY_TIERS.length - 1]; // High Risk fallback
}

function capTierAt(ceiling: PolicyTierName, current: PolicyTierDefinition): PolicyTierDefinition {
    const ceilingDef = getTier(ceiling);
    if (tierRank(current.name) > tierRank(ceiling)) return ceilingDef;
    return current;
}

// ═══════════════════════════════════════════════════════════════
// Tier Resolution
// ═══════════════════════════════════════════════════════════════

/** Critical risk flags that force High Risk regardless of score. */
const CRITICAL_FLAGS = ["sybil_suspicion", "sanctions_proximity"];

/** High risk flags that cap at Restricted. */
const HIGH_FLAGS = ["wash_trading", "circular_flow_detected", "rapid_wallet_cycling"];

/**
 * Resolve credit policy tier from scoring inputs.
 * Applies fraud flag downgrades, verification caps, and confidence penalties.
 */
export function resolvePolicyTier(input: PolicyResolutionInput): PolicyResolutionResult {
    const adjustments: string[] = [];
    let tier = findTierByScore(input.creditScore);
    const baseTier = tier.name;

    // 1. Critical fraud flags → force High Risk
    if (input.riskFlags.some((f) => CRITICAL_FLAGS.includes(f))) {
        const prev = tier.label;
        tier = getTier("high_risk");
        adjustments.push(`Downgraded from ${prev} to High Risk (critical fraud flag: ${input.riskFlags.filter((f) => CRITICAL_FLAGS.includes(f)).join(", ")})`);
    }
    // 2. High fraud flags → cap at Restricted
    else if (input.riskFlags.some((f) => HIGH_FLAGS.includes(f))) {
        const prev = tier.label;
        tier = capTierAt("restricted", tier);
        if (tier.name !== baseTier) {
            adjustments.push(`Capped at Restricted (high fraud flag: ${input.riskFlags.filter((f) => HIGH_FLAGS.includes(f)).join(", ")})`);
        }
    }

    // 3. Fraud risk score downgrades
    if (input.fraudRiskScore > 70) {
        const prev = tier.label;
        tier = capTierAt("restricted", tier);
        if (tier.label !== prev) {
            adjustments.push(`Capped at Restricted (fraud risk score: ${input.fraudRiskScore})`);
        }
    } else if (input.fraudRiskScore > 50) {
        const prev = tier.label;
        tier = capTierAt("standard", tier);
        if (tier.label !== prev) {
            adjustments.push(`Capped at Standard (fraud risk score: ${input.fraudRiskScore})`);
        }
    }

    // 4. Verification level floor
    if (input.verificationLevel === "unverified") {
        const prev = tier.label;
        tier = capTierAt("standard", tier);
        if (tier.label !== prev) {
            adjustments.push(`Capped at Standard (unverified agent)`);
        }
    }

    // 5. Low confidence penalty
    if (input.confidenceLevel !== undefined && input.confidenceLevel < 0.5) {
        const prev = tier.label;
        tier = capTierAt("standard", tier);
        if (tier.label !== prev) {
            adjustments.push(`Capped at Standard (low confidence: ${input.confidenceLevel})`);
        }
    }

    return {
        tier,
        adjustments,
        overridden: false,
        resolvedAt: new Date().toISOString(),
    };
}

// ═══════════════════════════════════════════════════════════════
// Org Override Merge
// ═══════════════════════════════════════════════════════════════

/**
 * Merge base tier with org-level overrides.
 * Org overrides can only tighten limits, except `minTier` which can loosen.
 */
export function resolveEffectivePolicy(
    baseTier: PolicyTierDefinition,
    orgOverride?: OrgPolicyOverride | null,
): { policy: PolicyTierDefinition; overridden: boolean; adjustments: string[] } {
    if (!orgOverride) return { policy: baseTier, overridden: false, adjustments: [] };

    const adjustments: string[] = [];
    let policy = { ...baseTier };

    // Apply tier floor (minTier can loosen — used by premium orgs)
    if (orgOverride.minTier) {
        const minDef = getTier(orgOverride.minTier);
        if (tierRank(policy.name) < tierRank(minDef.name)) {
            adjustments.push(`Tier raised from ${policy.label} to ${minDef.label} (org minimum)`);
            policy = { ...minDef };
        }
    }

    // Apply tier ceiling (maxTier can tighten — used by conservative orgs)
    if (orgOverride.maxTier) {
        const maxDef = getTier(orgOverride.maxTier);
        if (tierRank(policy.name) > tierRank(maxDef.name)) {
            adjustments.push(`Tier capped at ${maxDef.label} (org maximum)`);
            policy = { ...maxDef };
        }
    }

    // Field-level overrides: only tighten (lower cap, higher escrow, etc.)
    if (orgOverride.spendingCapUsd !== undefined) {
        const capped = Math.min(orgOverride.spendingCapUsd, policy.spendingCapUsd);
        if (capped !== policy.spendingCapUsd) {
            adjustments.push(`Spending cap: $${policy.spendingCapUsd} → $${capped} (org override)`);
            policy.spendingCapUsd = capped;
        }
    }

    if (orgOverride.escrowRatio !== undefined) {
        const raised = Math.max(orgOverride.escrowRatio, policy.escrowRatio);
        if (raised !== policy.escrowRatio) {
            adjustments.push(`Escrow ratio: ${policy.escrowRatio} → ${raised} (org override)`);
            policy.escrowRatio = raised;
        }
    }

    if (orgOverride.maxConcurrentTasks !== undefined) {
        const lowered = Math.min(orgOverride.maxConcurrentTasks, policy.maxConcurrentTasks);
        if (lowered !== policy.maxConcurrentTasks) {
            adjustments.push(`Max concurrent tasks: ${policy.maxConcurrentTasks} → ${lowered} (org override)`);
            policy.maxConcurrentTasks = lowered;
        }
    }

    if (orgOverride.feeMultiplier !== undefined) {
        const raised = Math.max(orgOverride.feeMultiplier, policy.feeMultiplier);
        if (raised !== policy.feeMultiplier) {
            adjustments.push(`Fee multiplier: ${policy.feeMultiplier}x → ${raised}x (org override)`);
            policy.feeMultiplier = raised;
        }
    }

    if (orgOverride.requiresManualReview === true && !policy.requiresManualReview) {
        adjustments.push(`Manual review: enabled (org override)`);
        policy.requiresManualReview = true;
    }

    if (orgOverride.canClaimHighValueJobs === false && policy.canClaimHighValueJobs) {
        adjustments.push(`High-value job claims: disabled (org override)`);
        policy.canClaimHighValueJobs = false;
    }

    if (orgOverride.maxDeployedAgents !== undefined) {
        const lowered = Math.min(orgOverride.maxDeployedAgents, policy.maxDeployedAgents);
        if (lowered !== policy.maxDeployedAgents) {
            adjustments.push(`Max deployed agents: ${policy.maxDeployedAgents} → ${lowered} (org override)`);
            policy.maxDeployedAgents = lowered;
        }
    }

    if (orgOverride.allowSensitiveWorkflows === false && policy.sensitiveWorkflowAccess) {
        adjustments.push(`Sensitive workflow access: disabled (org override)`);
        policy.sensitiveWorkflowAccess = false;
    }

    if (orgOverride.allowMarketplacePublishing === false && policy.canPublishToMarketplace) {
        adjustments.push(`Marketplace publishing: disabled (org override)`);
        policy.canPublishToMarketplace = false;
    }

    return { policy, overridden: adjustments.length > 0, adjustments };
}

// ═══════════════════════════════════════════════════════════════
// Enforcement Helpers
// ═══════════════════════════════════════════════════════════════

export interface JobEligibilityInput {
    reward?: string;
    priority: string;
    minPolicyTier?: PolicyTierName;
}

/**
 * Check if an agent's policy allows claiming a specific job.
 */
export function canClaimJob(
    policy: PolicyTierDefinition,
    job: JobEligibilityInput,
    currentActiveTasks: number,
): { allowed: boolean; reason?: string } {
    // Concurrent task limit
    if (currentActiveTasks >= policy.maxConcurrentTasks) {
        return { allowed: false, reason: `Concurrent task limit reached (${currentActiveTasks}/${policy.maxConcurrentTasks})` };
    }

    // Job minimum tier requirement
    if (job.minPolicyTier && tierRank(policy.name) < tierRank(job.minPolicyTier)) {
        return { allowed: false, reason: `Job requires ${getTier(job.minPolicyTier).label} tier or above` };
    }

    // High-value job eligibility
    const rewardUsd = parseFloat(job.reward || "0");
    if (rewardUsd > 1000 && !policy.canClaimHighValueJobs) {
        return { allowed: false, reason: `${policy.label} tier cannot claim jobs over $1,000` };
    }

    // Urgent job eligibility
    if (job.priority === "urgent" && !policy.canClaimUrgentJobs) {
        return { allowed: false, reason: `${policy.label} tier cannot claim urgent priority jobs` };
    }

    // Spending cap
    if (rewardUsd > policy.spendingCapUsd) {
        return { allowed: false, reason: `Job value ($${rewardUsd}) exceeds spending cap ($${policy.spendingCapUsd})` };
    }

    return { allowed: true };
}

/**
 * Calculate required escrow amount based on tier ratio.
 */
export function calculateRequiredEscrow(
    policy: PolicyTierDefinition,
    bountyAmount: number,
): { escrowAmount: number; escrowRatio: number } {
    return {
        escrowAmount: bountyAmount * policy.escrowRatio,
        escrowRatio: policy.escrowRatio,
    };
}

/**
 * Calculate effective platform fee with tier multiplier.
 */
export function calculateFeeWithMultiplier(
    policy: PolicyTierDefinition,
    baseFeePercent: number,
): { effectiveFeePercent: number; multiplier: number } {
    return {
        effectiveFeePercent: baseFeePercent * policy.feeMultiplier,
        multiplier: policy.feeMultiplier,
    };
}

/**
 * Check marketplace publish eligibility based on policy tier.
 */
export function canPublishToMarketplace(
    policy: PolicyTierDefinition,
): { allowed: boolean; visibility: MarketplaceVisibility; reason?: string } {
    if (!policy.canPublishToMarketplace) {
        return { allowed: false, visibility: "hidden", reason: `${policy.label} tier cannot publish to marketplace` };
    }
    return { allowed: true, visibility: policy.marketplaceVisibility };
}

/**
 * Check if a new agent deployment is allowed under the policy.
 */
export function canDeployAgent(
    policy: PolicyTierDefinition,
    currentDeployedAgents: number,
): { allowed: boolean; reason?: string } {
    if (currentDeployedAgents >= policy.maxDeployedAgents) {
        return { allowed: false, reason: `Deployment limit reached (${currentDeployedAgents}/${policy.maxDeployedAgents})` };
    }
    return { allowed: true };
}
