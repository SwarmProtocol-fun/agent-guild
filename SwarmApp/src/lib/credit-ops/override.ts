/**
 * Credit Operations — Override Workflows
 *
 * Create, approve, apply, and rollback score overrides.
 * Small overrides (delta <= 50) auto-approve; large overrides require a second admin.
 */

import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit as firestoreLimit,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { emitAdminOverride } from "@/lib/mod-stubs";
// [swarm-core] Hedera integration removed — install swarm-hedera mod
import { recordCreditOpsAudit } from "./audit";
import type { CreditOpsOverride, OverrideType } from "./types";

const OVERRIDE_COLLECTION = "creditOpsOverrides";
const APPROVAL_THRESHOLD = 50; // delta > 50 requires second admin

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/** Fetch current agent scores from Firestore */
async function getAgentScores(agentId: string): Promise<{
  creditScore: number;
  trustScore: number;
  docId: string;
}> {
  const agentsRef = collection(db, "agents");
  const q = query(agentsRef, where("id", "==", agentId));
  const snap = await getDocs(q);

  if (snap.empty) {
    return { creditScore: 680, trustScore: 50, docId: "" };
  }

  const d = snap.docs[0];
  return {
    creditScore: d.data().creditScore ?? 680,
    trustScore: d.data().trustScore ?? 50,
    docId: d.id,
  };
}

/** Update agent scores in Firestore */
async function updateAgentScores(
  agentId: string,
  creditScore: number,
  trustScore: number,
  reason: string,
): Promise<void> {
  const agentsRef = collection(db, "agents");
  const q = query(agentsRef, where("id", "==", agentId));
  const snap = await getDocs(q);

  if (snap.empty) return;

  const agentDocRef = doc(db, "agents", snap.docs[0].id);
  await updateDoc(agentDocRef, {
    creditScore: Math.max(300, Math.min(900, creditScore)),
    trustScore: Math.max(0, Math.min(100, trustScore)),
    lastCreditUpdate: serverTimestamp(),
    lastCreditReason: reason,
  });
}

// ═══════════════════════════════════════════════════════════════
// Request Override
// ═══════════════════════════════════════════════════════════════

/** Request a score override. Auto-approves if delta is small enough. */
export async function requestOverride(params: {
  agentId: string;
  asn: string;
  newCreditScore: number;
  newTrustScore: number;
  reason: string;
  overrideType: OverrideType;
  requestedBy: string;
  reviewQueueItemId?: string;
  appealId?: string;
  expiresAt?: Date;
}): Promise<{ overrideId: string; requiresApproval: boolean }> {
  const current = await getAgentScores(params.agentId);
  const creditDelta = params.newCreditScore - current.creditScore;
  const trustDelta = params.newTrustScore - current.trustScore;
  const absDelta = Math.abs(creditDelta);
  const requiresApproval = absDelta > APPROVAL_THRESHOLD;

  const override: Omit<CreditOpsOverride, "id" | "createdAt" | "appliedAt"> = {
    agentId: params.agentId,
    asn: params.asn,
    overrideType: params.overrideType,
    previousCreditScore: current.creditScore,
    previousTrustScore: current.trustScore,
    newCreditScore: params.newCreditScore,
    newTrustScore: params.newTrustScore,
    creditDelta,
    trustDelta,
    reason: params.reason,
    reviewQueueItemId: params.reviewQueueItemId,
    appealId: params.appealId,
    requestedBy: params.requestedBy,
    approvedBy: requiresApproval ? [] : [params.requestedBy],
    approvalStatus: requiresApproval ? "pending" : "approved",
    expired: false,
    rolledBack: false,
  };

  const ref = await addDoc(collection(db, OVERRIDE_COLLECTION), {
    ...override,
    expiresAt: params.expiresAt || null,
    createdAt: serverTimestamp(),
  });

  await recordCreditOpsAudit({
    action: "override.requested",
    performedBy: params.requestedBy,
    targetType: "override",
    targetId: ref.id,
    metadata: {
      agentId: params.agentId,
      asn: params.asn,
      creditDelta,
      trustDelta,
      requiresApproval,
    },
  });

  // Auto-apply if no approval needed
  if (!requiresApproval) {
    await applyOverride(ref.id);
  }

  return { overrideId: ref.id, requiresApproval };
}

// ═══════════════════════════════════════════════════════════════
// Approve Override
// ═══════════════════════════════════════════════════════════════

/** Approve a pending override. Applies automatically when approval threshold met. */
export async function approveOverride(
  overrideId: string,
  approvedBy: string,
): Promise<{ applied: boolean }> {
  const ref = doc(db, OVERRIDE_COLLECTION, overrideId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Override not found");

  const data = snap.data();
  if (data.approvalStatus !== "pending") {
    throw new Error(`Override is not pending (status: ${data.approvalStatus})`);
  }

  const approvedByList: string[] = Array.isArray(data.approvedBy) ? [...data.approvedBy] : [];

  if (approvedByList.includes(approvedBy)) {
    throw new Error("Already approved by this admin");
  }

  approvedByList.push(approvedBy);

  // Need at least 2 approvers for large overrides
  const fullyApproved = approvedByList.length >= 2;

  await updateDoc(ref, {
    approvedBy: approvedByList,
    approvalStatus: fullyApproved ? "approved" : "pending",
  });

  await recordCreditOpsAudit({
    action: "override.approved",
    performedBy: approvedBy,
    targetType: "override",
    targetId: overrideId,
    metadata: { approvalCount: approvedByList.length, fullyApproved },
  });

  if (fullyApproved) {
    await applyOverride(overrideId);
    return { applied: true };
  }

  return { applied: false };
}

// ═══════════════════════════════════════════════════════════════
// Apply Override
// ═══════════════════════════════════════════════════════════════

/** Apply an approved override to the agent's scores. */
export async function applyOverride(overrideId: string): Promise<void> {
  const ref = doc(db, OVERRIDE_COLLECTION, overrideId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Override not found");

  const data = snap.data();

  // Update agent scores in Firestore
  await updateAgentScores(
    data.agentId,
    data.newCreditScore,
    data.newTrustScore,
    `Admin override: ${data.reason}`,
  );

  // Emit HCS event
  try {
    await emitAdminOverride(
      data.asn,
      data.agentAddress || "",
      data.creditDelta,
      data.trustDelta,
      data.reason,
      overrideId,
    );
  } catch (err) {
    console.error("Failed to emit admin override HCS event:", err);
  }

  await updateDoc(ref, {
    approvalStatus: "approved",
    appliedAt: serverTimestamp(),
  });

  await recordCreditOpsAudit({
    action: "override.applied",
    performedBy: "system",
    targetType: "agent",
    targetId: data.asn || data.agentId,
    metadata: {
      overrideId,
      previousCredit: data.previousCreditScore,
      newCredit: data.newCreditScore,
      previousTrust: data.previousTrustScore,
      newTrust: data.newTrustScore,
    },
  });
}

// ═══════════════════════════════════════════════════════════════
// Rollback Override
// ═══════════════════════════════════════════════════════════════

/** Rollback an applied override, restoring previous scores. */
export async function rollbackOverride(
  overrideId: string,
  rolledBackBy: string,
  reason: string,
): Promise<void> {
  const ref = doc(db, OVERRIDE_COLLECTION, overrideId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Override not found");

  const data = snap.data();
  if (data.rolledBack) throw new Error("Override already rolled back");

  // Restore previous scores
  await updateAgentScores(
    data.agentId,
    data.previousCreditScore,
    data.previousTrustScore,
    `Rollback override: ${reason}`,
  );

  // Emit reverse HCS event
  try {
    await emitAdminOverride(
      data.asn,
      data.agentAddress || "",
      -data.creditDelta,
      -data.trustDelta,
      `Rollback: ${reason}`,
      overrideId,
    );
  } catch (err) {
    console.error("Failed to emit rollback HCS event:", err);
  }

  await updateDoc(ref, {
    rolledBack: true,
    rollbackAt: serverTimestamp(),
    rollbackBy: rolledBackBy,
    rollbackReason: reason,
  });

  await recordCreditOpsAudit({
    action: "override.rolled_back",
    performedBy: rolledBackBy,
    targetType: "override",
    targetId: overrideId,
    metadata: {
      agentId: data.agentId,
      asn: data.asn,
      reason,
      restoredCredit: data.previousCreditScore,
      restoredTrust: data.previousTrustScore,
    },
  });
}

// ═══════════════════════════════════════════════════════════════
// Queries
// ═══════════════════════════════════════════════════════════════

/** Get overrides for an agent. */
export async function getOverridesForAgent(
  asn: string,
): Promise<CreditOpsOverride[]> {
  const q = query(
    collection(db, OVERRIDE_COLLECTION),
    where("asn", "==", asn),
    orderBy("createdAt", "desc"),
    firestoreLimit(50),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })) as CreditOpsOverride[];
}

/** List all overrides with optional filters. */
export async function listOverrides(opts: {
  approvalStatus?: string;
  overrideType?: string;
  limit?: number;
}): Promise<CreditOpsOverride[]> {
  const constraints: Parameters<typeof query>[1][] = [];

  if (opts.approvalStatus) {
    constraints.push(where("approvalStatus", "==", opts.approvalStatus));
  }
  if (opts.overrideType) {
    constraints.push(where("overrideType", "==", opts.overrideType));
  }

  constraints.push(orderBy("createdAt", "desc"));
  constraints.push(firestoreLimit(opts.limit || 50));

  const q = query(collection(db, OVERRIDE_COLLECTION), ...constraints);
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })) as CreditOpsOverride[];
}

/** Get a single override by ID. */
export async function getOverride(
  overrideId: string,
): Promise<CreditOpsOverride | null> {
  const ref = doc(db, OVERRIDE_COLLECTION, overrideId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as CreditOpsOverride;
}

/** Expire temporary overrides that have passed their expiry date. */
export async function expireTemporaryOverrides(): Promise<number> {
  const now = new Date();
  const q = query(
    collection(db, OVERRIDE_COLLECTION),
    where("overrideType", "==", "temporary"),
    where("expired", "==", false),
    where("rolledBack", "==", false),
  );
  const snap = await getDocs(q);
  let count = 0;

  for (const d of snap.docs) {
    const data = d.data();
    if (!data.expiresAt) continue;

    const expiresAt = data.expiresAt.seconds
      ? new Date(data.expiresAt.seconds * 1000)
      : new Date(data.expiresAt);

    if (expiresAt <= now) {
      await rollbackOverride(d.id, "system", "Temporary override expired");
      await updateDoc(doc(db, OVERRIDE_COLLECTION, d.id), { expired: true });
      count++;
    }
  }

  return count;
}
