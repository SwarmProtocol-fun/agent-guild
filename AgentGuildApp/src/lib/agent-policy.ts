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
 * Resolve effective credit policy for an agent.
 * Loads agent from Firestore → resolves tier from scores/flags →
 * applies org overrides → checks enforcement toggle.
 *
 * Returns a passthrough Standard-tier policy if enforcement is disabled.
 */
export async function resolveAgentPolicy(agentId: string): Promise<PolicyGuardResult> {
  const { getAgent } = await import("@/lib/firestore");
  const { resolvePolicyTier, resolveEffectivePolicy, getTier } = await import("@/lib/credit-policy");
  const { getCreditPolicyConfig, getOrgPolicyOverride } = await import("@/lib/credit-policy-settings");

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

  return {
    ok: true,
    policy,
    tier: policy.name,
    agentId,
    orgId: agent.orgId,
    adjustments: allAdjustments,
    overridden,
  };
}
