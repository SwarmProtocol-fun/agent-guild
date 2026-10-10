/**
 * Load the snapshot buildHarnessBenefits reads.
 * One failed query drops that slice. It does not take the harness tab down.
 * Server-only. Never returns key material.
 */
import { adminDb } from "@/lib/firebase-admin";
import { listAgentWallets } from "@/lib/agent-wallets";
import { getAgentCapabilities } from "@/lib/firestore-admin";
import { listOrgJobsByStatus } from "@/lib/jobs-admin";
import type { PolicyTierName } from "@/lib/credit-policy";
import { listBindings } from "@/lib/vault/store";
import { agentMayUse } from "@/lib/vault/policy";
import {
  buildHarnessBenefits,
  resolveBenefitPolicy,
  type HarnessBenefits,
  type HarnessJobInput,
} from "@/lib/harness-benefits";

const TIER_NAMES = new Set<PolicyTierName>(["high_risk", "restricted", "standard", "trusted", "prime"]);

export interface HarnessBenefitAgent {
  id: string;
  orgId?: string;
  creditScore?: number;
  solanaAddress?: string;
}

async function safe<T>(label: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error(`harness benefits: ${label}`, err);
    return fallback;
  }
}

async function activeTaskCount(agentId: string): Promise<number> {
  const snap = await adminDb()
    .collection("tasks")
    .where("assigneeAgentId", "==", agentId)
    .where("status", "==", "in_progress")
    .get();
  return snap.size;
}

export async function loadHarnessBenefits(
  agent: HarnessBenefitAgent,
  harness: { playbookGeneration: number | null; pendingGeneration: number | null },
): Promise<HarnessBenefits> {
  const orgId = agent.orgId || "";
  const [jobs, wallets, capabilities, bindings, activeTasks] = await Promise.all([
    orgId
      ? safe("open jobs", [], () => listOrgJobsByStatus(orgId, "open", { limit: 8 }).then((p) => p.jobs))
      : Promise.resolve([]),
    safe("wallets", [], () => listAgentWallets(agent.id)),
    orgId ? safe("capabilities", [], () => getAgentCapabilities(agent.id, orgId)) : Promise.resolve([]),
    orgId ? safe("bindings", [], () => listBindings(orgId)) : Promise.resolve([]),
    safe("active tasks", 0, () => activeTaskCount(agent.id)),
  ]);

  const openJobs: HarnessJobInput[] = jobs.map((job) => {
    const tier = job.minPolicyTier;
    return {
      id: job.id,
      title: job.title || "",
      reward: job.reward,
      priority: job.priority || "medium",
      hiringMode: job.hiringMode,
      minPolicyTier: tier && TIER_NAMES.has(tier) ? tier : undefined,
    };
  });

  const { creditScore, policy, adjustments } = resolveBenefitPolicy(agent.creditScore);

  return buildHarnessBenefits({
    creditScore,
    policy,
    adjustments,
    openJobs,
    activeTasks,
    wallets: wallets.map((w) => ({
      chain: w.chain,
      publicKey: w.publicKey,
      payout: w.payout,
      label: w.label,
    })),
    identitySolana: agent.solanaAddress,
    capabilities: capabilities.map((c) => c.key),
    bindings: bindings.filter((b) => agentMayUse(b, agent.id)).map((b) => b.name),
    playbookGeneration: harness.playbookGeneration,
    pendingGeneration: harness.pendingGeneration,
  });
}
