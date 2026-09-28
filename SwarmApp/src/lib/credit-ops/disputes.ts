/**
 * Credit Operations — Dispute Adjudication
 *
 * Multi-party disputes between agents/orgs regarding credit decisions.
 * Admins investigate, mediate, and adjudicate with binding actions.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, type Query } from "firebase-admin/firestore";
import { recordCreditOpsAudit } from "./audit";
import type {
  CreditOpsDispute,
  DisputeType,
  DisputeStatus,
  DisputeAdjudication,
  ReviewPriority,
  ReviewHistoryEntry,
} from "./types";

const DISPUTE_COLLECTION = "creditOpsDisputes";

// ═══════════════════════════════════════════════════════════════
// File Dispute
// ═══════════════════════════════════════════════════════════════

/** File a new dispute. */
export async function fileDispute(params: {
  initiatorType: "agent" | "org";
  initiatorId: string;
  respondentType: "agent" | "org" | "platform";
  respondentId: string;
  disputeType: DisputeType;
  subject: string;
  description: string;
  evidence?: string[];
  relatedAgentIds: string[];
  relatedEventIds: string[];
}): Promise<string> {
  const dispute: Omit<CreditOpsDispute, "id" | "filedAt" | "lastUpdatedAt"> = {
    initiatorType: params.initiatorType,
    initiatorId: params.initiatorId,
    respondentType: params.respondentType,
    respondentId: params.respondentId,
    disputeType: params.disputeType,
    subject: params.subject,
    description: params.description,
    evidence: params.evidence || [],
    relatedAgentIds: params.relatedAgentIds,
    relatedEventIds: params.relatedEventIds,
    status: "filed",
    priority: "medium",
    reviewHistory: [],
  };

  const ref = await adminDb().collection(DISPUTE_COLLECTION).add({
    ...dispute,
    filedAt: FieldValue.serverTimestamp(),
    lastUpdatedAt: FieldValue.serverTimestamp(),
  });

  await recordCreditOpsAudit({
    action: "dispute.filed",
    performedBy: params.initiatorId,
    targetType: "dispute",
    targetId: ref.id,
    metadata: {
      disputeType: params.disputeType,
      respondentId: params.respondentId,
    },
  });

  return ref.id;
}

// ═══════════════════════════════════════════════════════════════
// Query
// ═══════════════════════════════════════════════════════════════

/** Get a dispute by ID. */
export async function getDispute(disputeId: string): Promise<CreditOpsDispute | null> {
  const ref = adminDb().collection(DISPUTE_COLLECTION).doc(disputeId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as CreditOpsDispute;
}

/** List disputes with filters. */
export async function listDisputes(opts: {
  status?: DisputeStatus;
  priority?: ReviewPriority;
  initiatorId?: string;
  limit?: number;
}): Promise<CreditOpsDispute[]> {
  let q: Query = adminDb().collection(DISPUTE_COLLECTION);

  if (opts.status) q = q.where("status", "==", opts.status);
  if (opts.priority) q = q.where("priority", "==", opts.priority);
  if (opts.initiatorId) q = q.where("initiatorId", "==", opts.initiatorId);

  q = q.orderBy("filedAt", "desc").limit(opts.limit || 50);

  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })) as CreditOpsDispute[];
}

// ═══════════════════════════════════════════════════════════════
// Update
// ═══════════════════════════════════════════════════════════════

/** Update a dispute (assign, investigate, mediate, adjudicate, close). */
export async function updateDispute(
  disputeId: string,
  update: {
    action: "assign" | "investigate" | "mediate" | "adjudicate" | "close";
    performedBy: string;
    comment?: string;
    adjudication?: DisputeAdjudication;
  },
): Promise<void> {
  const ref = adminDb().collection(DISPUTE_COLLECTION).doc(disputeId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Dispute not found");

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
      updates.assignedTo = update.performedBy;
      break;
    case "investigate":
      updates.status = "investigating";
      break;
    case "mediate":
      updates.status = "mediation";
      break;
    case "adjudicate":
      updates.status = "adjudicated";
      updates.adjudication = update.adjudication;
      break;
    case "close":
      updates.status = "closed";
      updates.closedAt = FieldValue.serverTimestamp();
      break;
  }

  await ref.update(updates);

  await recordCreditOpsAudit({
    action: `dispute.${update.action}`,
    performedBy: update.performedBy,
    targetType: "dispute",
    targetId: disputeId,
    metadata: {
      newStatus: updates.status,
      comment: update.comment,
    },
  });
}
