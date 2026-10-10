/**
 * Credit policy resolution for an agent.
 *
 * Split out of auth-guard.ts because that module statically imports
 * verify.ts -> firebase-admin (Node-only, needs `fs`/`child_process`).
 * resolveAgentPolicy itself only touches the client Firestore SDK, and is
 * called via `await import(...)` from code reachable in the browser bundle
 * (firestore.ts:claimJob, assignments.ts) — importing auth-guard.ts there
 * dragged firebase-admin into the client bundle and broke the build.
 */

import { evaluateStanding, PROVISIONAL_TIER_CAP, type StandingInput } from "./agent-standing";

export interface PolicyGuardResult {
  ok: boolean;
  policy?: import("./credit-policy").PolicyTierDefinition;
  tier?: import("./credit-policy").PolicyTierName;
  agentId?: string;
  orgId?: string;
  adjustments?: string[];
  overridden?: boolean;
  error?: string;
}

/**
 * Where resolveAgentPolicy reads its inputs from. Defaults to the client SDK
 * (this module must stay importable from the browser bundle); server code
 * passes Admin SDK loaders instead — see `adminPolicyLoaders` in
 * credit-policy-settings-admin.ts — because the client SDK has no signed-in
 * user on the server and Firestore rules deny its reads.
 */
export interface PolicyLoaders {
  getAgent(agentId: string): Promise<import("./firestore").Agent | null>;
  getCreditPolicyConfig(): Promise<import("./credit-policy-settings").CreditPolicyConfig>;
  getOrgPolicyOverride(orgId: string): Promise<import("./credit-policy").OrgPolicyOverride | null>;
}

async function clientPolicyLoaders(): Promise<PolicyLoaders> {
  const { getAgent } = await import("@/lib/firestore");
  const { getCreditPolicyConfig, getOrgPolicyOverride } = await import("@/lib/credit-policy-settings");
  return { getAgent, getCreditPolicyConfig, getOrgPolicyOverride };
}

/**
 * Resolve effective credit policy for an agent.
 * Loads agent from Firestore → resolves tier from scores/flags →
 * applies org overrides → checks enforcement toggle.
 *
 * Returns a passthrough Standard-tier policy if enforcement is disabled.
 */
export async function resolveAgentPolicy(agentId: string, loaders?: PolicyLoaders): Promise<PolicyGuardResult> {
  const { getAgent, getCreditPolicyConfig, getOrgPolicyOverride } = loaders ?? await clientPolicyLoaders();
  const { resolvePolicyTier, resolveEffectivePolicy, getTier, tierRank } = await import("@/lib/credit-policy");

  // 1. Load agent
  const agent = await getAgent(agentId);
  if (!agent) {
    return { ok: false, error: `Agent ${agentId} not found` };
  }

  // 2. Check enforcement toggle
  const config = await getCreditPolicyConfig();
  if (!config.enforcementEnabled) {
    // Return Standard tier as passthrough (all actions allowed, no blocking)
    const passthrough = getTier("standard");
    return {
      ok: true,
      policy: { ...passthrough, requiresManualReview: false, maxConcurrentTasks: 999 },
      tier: "standard",
      agentId,
      orgId: agent.orgId,
      adjustments: ["Enforcement disabled — passthrough policy"],
      overridden: false,
    };
  }

  // 3. Resolve base tier from scoring inputs
  const resolution = resolvePolicyTier({
    creditScore: agent.creditScore ?? 680,
    trustScore: agent.trustScore ?? 50,
    fraudRiskScore: (agent as unknown as Record<string, unknown>).fraudRiskScore as number ?? 0,
    riskFlags: ((agent as unknown as Record<string, unknown>).riskFlags as string[]) ?? [],
    verificationLevel: ((agent as unknown as Record<string, unknown>).verificationLevel as "unverified" | "basic" | "verified" | "certified") ?? "unverified",
    confidenceLevel: (agent as unknown as Record<string, unknown>).confidenceLevel as number | undefined,
  });

  // 4. Apply org-level overrides
  const orgOverride = await getOrgPolicyOverride(agent.orgId);
  const { policy, overridden, adjustments: orgAdjustments } = resolveEffectivePolicy(
    resolution.tier,
    orgOverride,
  );

  const allAdjustments = [...resolution.adjustments, ...orgAdjustments];

  // 5. Provisional cap — applied after org overrides so an org's minTier
  // can't lift a fresh identity out of it.
  let effective = policy;
  const standing = evaluateStanding(agent as unknown as StandingInput);
  if (standing.provisional && tierRank(policy.name) > tierRank(PROVISIONAL_TIER_CAP)) {
    const cap = getTier(PROVISIONAL_TIER_CAP);
    allAdjustments.push(`Capped at ${cap.label} (provisional agent: ${standing.requirements.filter((r) => !r.met).map((r) => r.label).join("; ")})`);
    effective = { ...cap };
  }

  return {
    ok: true,
    policy: effective,
    tier: effective.name,
    agentId,
    orgId: agent.orgId,
    adjustments: allAdjustments,
    overridden,
  };
}
