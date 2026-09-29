/**
 * Credit Operations — Appeals Workflow
 *
 * Agents and org owners can appeal penalties, slashing events,
 * score anomalies, and tier demotions. Admins review and resolve.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, type Query } from "firebase-admin/firestore";
import { recordCreditOpsAudit } from "./audit";
import type {
  CreditOpsAppeal,
  AppealType,
  AppealStatus,
  AppealResolution,
  ReviewPriority,
  ReviewHistoryEntry,
} from "./types";

const APPEAL_COLLECTION = "creditOpsAppeals";

// ═══════════════════════════════════════════════════════════════
// Submit Appeal
// ═══════════════════════════════════════════════════════════════

/** Submit a new appeal. */
export async function submitAppeal(params: {
  appellantType: "agent" | "org_owner";
  appellantId: string;
  agentId: string;
  asn: string;
  orgId: string;
  appealType: AppealType;
  subject: string;
  description: string;
  evidence?: string[];
  relatedEventId?: string;
  relatedOverrideId?: string;
  requestedOutcome?: string;
}): Promise<string> {
  // Get current scores for context
  const agentsSnap = await adminDb().collection("agents").where("id", "==", params.agentId).get();
  const agentData = agentsSnap.empty ? null : agentsSnap.docs[0].data();
  const currentCredit = agentData?.creditScore ?? 680;
  const currentTrust = agentData?.trustScore ?? 50;

  const appeal: Omit<CreditOpsAppeal, "id" | "submittedAt" | "lastUpdatedAt"> = {
    appellantType: params.appellantType,
    appellantId: params.appellantId,
    agentId: params.agentId,
    asn: params.asn,
    orgId: params.orgId,
    appealType: params.appealType,
    relatedEventId: params.relatedEventId,
    relatedOverrideId: params.relatedOverrideId,
    subject: params.subject,
    description: params.description,
    evidence: params.evidence || [],
    scoreAtTimeOfEvent: { credit: currentCredit, trust: currentTrust },
    currentScore: { credit: currentCredit, trust: currentTrust },
    requestedOutcome: params.requestedOutcome,
    status: "submitted",
    priority: "medium",
    reviewHistory: [],
  };

  const ref = await adminDb().collection(APPEAL_COLLECTION).add({
    ...appeal,
    submittedAt: FieldValue.serverTimestamp(),
    lastUpdatedAt: FieldValue.serverTimestamp(),
  });

  await recordCreditOpsAudit({
    action: "appeal.submitted",
    performedBy: params.appellantId,
    targetType: "appeal",
    targetId: ref.id,
    metadata: {
      appealType: params.appealType,
      agentId: params.agentId,
      asn: params.asn,
    },
  });

  return ref.id;
}

// ═══════════════════════════════════════════════════════════════
// Query
// ═══════════════════════════════════════════════════════════════

/** Get an appeal by ID. */
export async function getAppeal(appealId: string): Promise<CreditOpsAppeal | null> {
  const ref = adminDb().collection(APPEAL_COLLECTION).doc(appealId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as CreditOpsAppeal;
}

/** List appeals with filters. */
export async function listAppeals(opts: {
  status?: AppealStatus;
  priority?: ReviewPriority;
  agentId?: string;
  appellantId?: string;
  limit?: number;
}): Promise<CreditOpsAppeal[]> {
  let q: Query = adminDb().collection(APPEAL_COLLECTION);

  if (opts.status) q = q.where("status", "==", opts.status);
  if (opts.priority) q = q.where("priority", "==", opts.priority);
  if (opts.agentId) q = q.where("agentId", "==", opts.agentId);
  if (opts.appellantId) q = q.where("appellantId", "==", opts.appellantId);

  q = q.orderBy("submittedAt", "desc").limit(opts.limit || 50);

  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })) as CreditOpsAppeal[];
}

// ═══════════════════════════════════════════════════════════════
// Update
// ═══════════════════════════════════════════════════════════════

/** Update an appeal (assign, review, resolve, reject, escalate). */
export async function updateAppeal(
  appealId: string,
  update: {
    action: "assign" | "start_review" | "request_info" | "resolve" | "reject" | "escalate";
    performedBy: string;
    comment?: string;
    assignedTo?: string;
    resolution?: AppealResolution;
  },
): Promise<void> {
  const ref = adminDb().collection(APPEAL_COLLECTION).doc(appealId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Appeal not found");

  const current = snap.data()!;
  const reviewHistory: ReviewHistoryEntry[] = Array.isArray(current.reviewHistory)
    ? current.reviewHistory
    : [];

  reviewHistory.push({
    action: update.action,
    performedBy: update.performedBy,
    performedAt: new Date().toISOString(),
    comment: update.comment,
  });

  const updates: Record<string, unknown> = {
    reviewHistory,
    lastUpdatedAt: FieldValue.serverTimestamp(),
  };

  switch (update.action) {
    case "assign":
      updates.assignedTo = update.assignedTo || update.performedBy;
      break;
    case "start_review":
      updates.status = "under_review";
      updates.assignedTo = update.performedBy;
      break;
    case "request_info":
      updates.status = "additional_info_requested";
      break;
    case "resolve":
      updates.status = "resolved";
      updates.resolution = update.resolution;
      updates.resolvedAt = FieldValue.serverTimestamp();
      break;
    case "reject":
      updates.status = "rejected";
      updates.resolvedAt = FieldValue.serverTimestamp();
      break;
    case "escalate":
      updates.status = "escalated";
      updates.priority = "critical";
      break;
  }

  await ref.update(updates);

  await recordCreditOpsAudit({
    action: `appeal.${update.action}`,
    performedBy: update.performedBy,
    targetType: "appeal",
    targetId: appealId,
    metadata: {
      resolution: update.resolution?.outcome,
      comment: update.comment,
    },
  });
}

// ═══════════════════════════════════════════════════════════════
// Stats
// ═══════════════════════════════════════════════════════════════

/** Get appeal stats for the dashboard. */
export async function getAppealStats(): Promise<{
  total: number;
  submitted: number;
  underReview: number;
  resolved: number;
  rejected: number;
}> {
  const col = adminDb().collection(APPEAL_COLLECTION);
  const [submittedSnap, underReviewSnap, resolvedSnap, rejectedSnap] = await Promise.all([
    col.where("status", "==", "submitted").count().get(),
    col.where("status", "==", "under_review").count().get(),
    col.where("status", "==", "resolved").count().get(),
    col.where("status", "==", "rejected").count().get(),
  ]);

  const submitted = submittedSnap.data().count;
  const underReview = underReviewSnap.data().count;
  const resolved = resolvedSnap.data().count;
  const rejected = rejectedSnap.data().count;

  return {
    total: submitted + underReview + resolved + rejected,
    submitted,
    underReview,
    resolved,
    rejected,
  };
}
