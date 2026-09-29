/**
 * Credit Operations — Policy Configuration
 *
 * CRUD for scoring policies: tier boundaries, event weights,
 * slashing rules, anomaly thresholds. Only one policy can be active.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { recordCreditOpsAudit } from "./audit";
import type { CreditOpsPolicy, PolicyStatus } from "./types";

const POLICY_COLLECTION = "creditOpsPolicies";

// In-memory cache for active policy (avoid repeated Firestore reads)
let activePolicyCache: CreditOpsPolicy | null = null;
let policyCacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute

/** Default policy values (matches current hardcoded values) */
export const DEFAULT_POLICY: Omit<CreditOpsPolicy, "id" | "createdAt" | "activatedAt"> = {
  version: 1,
  status: "active" as PolicyStatus,
  tierBoundaries: { platinum: 850, gold: 700, silver: 550 },
  scoreRange: { min: 300, max: 900 },
  trustRange: { min: 0, max: 100 },
  defaultCreditScore: 680,
  defaultTrustScore: 50,
  eventWeights: {
    task_complete_simple: { credit: 5, trust: 1 },
    task_complete_medium: { credit: 10, trust: 2 },
    task_complete_complex: { credit: 20, trust: 5 },
    task_fail: { credit: -10, trust: -2 },
    skill_report: { credit: 2, trust: 1 },
  },
  slashingRules: {
    missedDeadline: { credit: 5, trust: 1, hoursThreshold: 0 },
    severelyLate: { credit: 15, trust: 3, hoursThreshold: 24 },
    abandoned: { credit: 30, trust: 5, hoursThreshold: 168 },
    governanceThreshold: 50,
  },
  anomalyThresholds: {
    maxScoreChangePerHour: 100,
    minEventsForAnomaly: 5,
    rapidEventWindowMinutes: 10,
    rapidEventMax: 20,
  },
  createdBy: "system",
  description: "Default scoring policy",
};

// ═══════════════════════════════════════════════════════════════
// Read
// ═══════════════════════════════════════════════════════════════

/** Get the currently active policy. Falls back to defaults if none exists. */
export async function getActivePolicy(): Promise<CreditOpsPolicy> {
  if (activePolicyCache && Date.now() - policyCacheTime < CACHE_TTL) {
    return activePolicyCache;
  }

  const snap = await adminDb().collection(POLICY_COLLECTION).where("status", "==", "active").limit(1).get();

  if (snap.empty) {
    // Seed default policy
    const id = await seedDefaultPolicy();
    const policy = { ...DEFAULT_POLICY, id } as CreditOpsPolicy;
    activePolicyCache = policy;
    policyCacheTime = Date.now();
    return policy;
  }

  const policy = { id: snap.docs[0].id, ...snap.docs[0].data() } as CreditOpsPolicy;
  activePolicyCache = policy;
  policyCacheTime = Date.now();
  return policy;
}

/** Get a policy by ID. */
export async function getPolicy(policyId: string): Promise<CreditOpsPolicy | null> {
  const snap = await adminDb().collection(POLICY_COLLECTION).doc(policyId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as CreditOpsPolicy;
}

/** List all policy versions. */
export async function listPolicies(): Promise<CreditOpsPolicy[]> {
  const snap = await adminDb().collection(POLICY_COLLECTION).orderBy("version", "desc").limit(50).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })) as CreditOpsPolicy[];
}

// ═══════════════════════════════════════════════════════════════
// Write
// ═══════════════════════════════════════════════════════════════

/** Create a draft policy. */
export async function createDraftPolicy(
  partial: Partial<CreditOpsPolicy>,
  createdBy: string,
): Promise<string> {
  // Get current max version
  const policies = await listPolicies();
  const maxVersion = policies.length > 0 ? Math.max(...policies.map((p) => p.version || 0)) : 0;

  const policy = {
    ...DEFAULT_POLICY,
    ...partial,
    version: maxVersion + 1,
    status: "draft",
    createdBy,
    createdAt: FieldValue.serverTimestamp(),
  };

  const ref = await adminDb().collection(POLICY_COLLECTION).add(policy);

  await recordCreditOpsAudit({
    action: "policy.created",
    performedBy: createdBy,
    targetType: "policy",
    targetId: ref.id,
    metadata: { version: policy.version },
  });

  return ref.id;
}

/** Update a draft policy. Only drafts can be edited. */
export async function updateDraftPolicy(
  policyId: string,
  updates: Partial<CreditOpsPolicy>,
): Promise<void> {
  const ref = adminDb().collection(POLICY_COLLECTION).doc(policyId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Policy not found");
  if (snap.data()!.status !== "draft") throw new Error("Only draft policies can be edited");

  // Prevent changing status or version through this function
  const { status: _s, version: _v, id: _id, ...safeUpdates } = updates;
  await ref.update(safeUpdates);
}

/** Activate a policy. Archives the current active one. */
export async function activatePolicy(
  policyId: string,
  activatedBy: string,
): Promise<void> {
  // Archive current active policy
  const currentActive = await getActivePolicy();
  if (currentActive.id && currentActive.id !== policyId) {
    await adminDb().collection(POLICY_COLLECTION).doc(currentActive.id).update({ status: "archived" });
  }

  // Activate new policy
  await adminDb().collection(POLICY_COLLECTION).doc(policyId).update({
    status: "active",
    activatedAt: FieldValue.serverTimestamp(),
  });

  // Invalidate cache
  activePolicyCache = null;
  policyCacheTime = 0;

  await recordCreditOpsAudit({
    action: "policy.activated",
    performedBy: activatedBy,
    targetType: "policy",
    targetId: policyId,
  });
}

/** Seed default policy if none exists. */
export async function seedDefaultPolicy(): Promise<string> {
  const ref = await adminDb().collection(POLICY_COLLECTION).add({
    ...DEFAULT_POLICY,
    createdAt: FieldValue.serverTimestamp(),
    activatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/** Get tier name for a credit score using active policy boundaries. */
export async function getTierForScore(creditScore: number): Promise<string> {
  const policy = await getActivePolicy();
  if (creditScore >= policy.tierBoundaries.platinum) return "Platinum";
  if (creditScore >= policy.tierBoundaries.gold) return "Gold";
  if (creditScore >= policy.tierBoundaries.silver) return "Silver";
  return "Bronze";
}
