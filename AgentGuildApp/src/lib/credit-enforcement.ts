/**
 * Credit Enforcement Middleware
 *
 * Pre-action hooks that check credit policy before allowing actions.
 * Fail-open design — if Firestore/cache unavailable, log warning and allow.
 *
 * Depends on:
 *   - credit-service.ts: getCreditProfileCached()
 *   - credit-scoring.ts: getDefaultPolicy(), PolicyState
 *   - firebase.ts: Firestore queries for task counts
 */

import { adminDb } from "@/lib/firebase-admin";
import { getDefaultPolicy, type PolicyState } from "@/lib/credit-scoring";
import { getCreditProfileCached, type CreditProfile } from "@/lib/credit-service";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type EnforcedAction =
    | "accept_task"
    | "publish_marketplace"
    | "create_compute"
    | "accept_bounty";

export interface EnforcementResult {
    allowed: boolean;
    reason: string;
    requiredScore?: number;
    currentScore: number;
    currentBand: string;
    policyTier: PolicyState;
    constraints?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// Action Requirements
// ═══════════════════════════════════════════════════════════════

const ACTION_REQUIREMENTS: Record<EnforcedAction, { minCreditScore: number; description: string }> = {
    accept_task: { minCreditScore: 300, description: "Accept a task assignment" },
    publish_marketplace: { minCreditScore: 550, description: "Publish to marketplace" },
    create_compute: { minCreditScore: 550, description: "Provision compute resources" },
    accept_bounty: { minCreditScore: 550, description: "Accept a bounty" },
};

// ═══════════════════════════════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════════════════════════════

/** Count active (in-progress) tasks for an agent. */
async function getActiveTaskCount(agentId: string): Promise<number> {
    try {
        const snap = await adminDb()
            .collection("tasks")
            .where("assigneeAgentId", "==", agentId)
            .where("status", "==", "in_progress")
            .get();
        return snap.size;
    } catch (error) {
        console.error("[credit-enforcement] Failed to count active tasks:", error);
        return 0; // Fail-open
    }
}

/** Build a fail-open result (allow the action with a warning). */
function failOpen(action: EnforcedAction, reason: string): EnforcementResult {
    console.warn(`[credit-enforcement] Fail-open for ${action}: ${reason}`);
    return {
        allowed: true,
        reason: `Allowed (fail-open): ${reason}`,
        currentScore: 0,
        currentBand: "unknown",
        policyTier: getDefaultPolicy(680), // Default policy
    };
}

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

/**
 * Check if an agent is allowed to perform the given action based on credit policy.
 *
 * @param agentId  The agent to check
 * @param action   The action being attempted
 * @param context  Optional context (e.g. estimatedCostUsd, bountyHbar)
 */
export async function enforceCreditPolicy(
    agentId: string,
    action: EnforcedAction,
    context?: Record<string, unknown>,
): Promise<EnforcementResult> {
    let profile: CreditProfile | null;

    try {
        profile = await getCreditProfileCached(agentId);
    } catch (error) {
        return failOpen(action, `Credit profile fetch failed: ${error instanceof Error ? error.message : "Unknown"}`);
    }

    if (!profile) {
        return failOpen(action, "Agent not found — allowing action");
    }

    const requirement = ACTION_REQUIREMENTS[action];
    const policy = getDefaultPolicy(profile.creditScore);
    const band = profile.scoreBand;

    const baseResult: Omit<EnforcementResult, "allowed" | "reason"> = {
        currentScore: profile.creditScore,
        currentBand: band.band,
        policyTier: policy,
    };

    // Check minimum credit score
    if (profile.creditScore < requirement.minCreditScore) {
        return {
            ...baseResult,
            allowed: false,
            reason: `Credit score ${profile.creditScore} is below minimum ${requirement.minCreditScore} required to ${requirement.description}`,
            requiredScore: requirement.minCreditScore,
        };
    }

    // Check agent status
    if (profile.status === "suspended" || profile.status === "revoked") {
        return {
            ...baseResult,
            allowed: false,
            reason: `Agent status is "${profile.status}" — action not permitted`,
        };
    }

    // Action-specific checks
    switch (action) {
        case "accept_task": {
            const activeCount = await getActiveTaskCount(agentId);
            if (activeCount >= policy.maxConcurrentTasks) {
                return {
                    ...baseResult,
                    allowed: false,
                    reason: `Agent has ${activeCount} active tasks — limit is ${policy.maxConcurrentTasks} for ${band.band} tier`,
                    constraints: { activeTaskCount: activeCount, maxConcurrentTasks: policy.maxConcurrentTasks },
                };
            }
            break;
        }

        case "publish_marketplace": {
            if (band.band === "restricted") {
                return {
                    ...baseResult,
                    allowed: false,
                    reason: `Restricted credit band (${profile.creditScore}) — publishing to marketplace requires Risky tier or above (550+)`,
                    requiredScore: 550,
                };
            }
            break;
        }

        case "create_compute": {
            const estimatedCost = (context?.estimatedCostUsd as number) || 0;
            if (estimatedCost > policy.spendingCapUsd) {
                return {
                    ...baseResult,
                    allowed: false,
                    reason: `Estimated cost $${estimatedCost} exceeds spending cap $${policy.spendingCapUsd} for ${band.band} tier`,
                    constraints: { estimatedCostUsd: estimatedCost, spendingCapUsd: policy.spendingCapUsd },
                };
            }
            break;
        }

        case "accept_bounty": {
            if (band.band === "restricted") {
                return {
                    ...baseResult,
                    allowed: false,
                    reason: `Restricted credit band (${profile.creditScore}) — accepting bounties requires Risky tier or above (550+)`,
                    requiredScore: 550,
                };
            }
            break;
        }
    }

    return {
        ...baseResult,
        allowed: true,
        reason: `Action permitted — ${band.band} tier (score ${profile.creditScore})`,
    };
}

/**
 * Get enforcement summary for all actions for an agent.
 * Useful for dashboard display.
 */
export async function getEnforcementSummary(
    agentId: string,
): Promise<Record<EnforcedAction, EnforcementResult>> {
    const actions: EnforcedAction[] = ["accept_task", "publish_marketplace", "create_compute", "accept_bounty"];

    const results = await Promise.all(
        actions.map(async (action) => [action, await enforceCreditPolicy(agentId, action)] as const),
    );

    return Object.fromEntries(results) as Record<EnforcedAction, EnforcementResult>;
}
