/**
 * Credit Operations — Review Queue
 *
 * Manage flagged agents awaiting admin review. Agents are flagged
 * automatically (slashing, anomaly detection) or manually by admins.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, type Query } from "firebase-admin/firestore";
import { recordCreditOpsAudit } from "./audit";
import type {
  CreditOpsReviewItem,
  ReviewFlagType,
  ReviewStatus,
  ReviewPriority,
  ReviewResolution,
  ReviewHistoryEntry,
} from "./types";

const REVIEW_COLLECTION = "creditOpsReviewQueue";

/** Compute tier from credit score */
function getTier(creditScore: number): string {
  if (creditScore >= 850) return "Platinum";
  if (creditScore >= 700) return "Gold";
  if (creditScore >= 550) return "Silver";
  return "Bronze";
}

/** Fetch current agent scores from Firestore */
async function getAgentScores(agentId: string): Promise<{
  creditScore: number;
  trustScore: number;
}> {
  // Try to look up the agent document
  const snap = await adminDb().collection("agents").where("id", "==", agentId).get();

  if (snap.empty) {
    return { creditScore: 680, trustScore: 50 }; // defaults
  }

  const data = snap.docs[0].data();
  return {
    creditScore: data.creditScore ?? 680,
    trustScore: data.trustScore ?? 50,
  };
}

// ═══════════════════════════════════════════════════════════════
// Flag Agent
// ═══════════════════════════════════════════════════════════════

/** Flag an agent for review. Called by slashing system, anomaly detector, or manually. */
export async function flagAgentForReview(params: {
  agentId: string;
  asn: string;
  agentAddress: string;
  orgId: string;
  flagType: ReviewFlagType;
  flagReason: string;
  flaggedBy: "system" | "admin" | "governance";
  sourceEventId?: string;
  priority?: ReviewPriority;
}): Promise<string> {
  const scores = await getAgentScores(params.agentId);

  const item: Omit<CreditOpsReviewItem, "id" | "flaggedAt"> = {
    agentId: params.agentId,
    asn: params.asn,
    agentAddress: params.agentAddress,
    orgId: params.orgId,
    flagType: params.flagType,
    flagReason: params.flagReason,
    flaggedBy: params.flaggedBy,
    sourceEventId: params.sourceEventId,
    currentCreditScore: scores.creditScore,
    currentTrustScore: scores.trustScore,
    currentTier: getTier(scores.creditScore),
    status: "pending",
    priority: params.priority || "medium",
    reviewHistory: [],
  };

  const ref = await adminDb().collection(REVIEW_COLLECTION).add({
    ...item,
    flaggedAt: FieldValue.serverTimestamp(),
  });

  await recordCreditOpsAudit({
    action: "review.flagged",
    performedBy: params.flaggedBy,
    targetType: "agent",
    targetId: params.asn || params.agentId,
    metadata: {
      flagType: params.flagType,
      flagReason: params.flagReason,
      reviewItemId: ref.id,
    },
  });

  return ref.id;
}

// ═══════════════════════════════════════════════════════════════
// Query Queue
// ═══════════════════════════════════════════════════════════════

/** Get review queue items with filters. */
export async function getReviewQueue(opts: {
  status?: ReviewStatus;
  priority?: ReviewPriority;
  flagType?: ReviewFlagType;
  limit?: number;
  sort?: "newest" | "oldest" | "priority";
}): Promise<CreditOpsReviewItem[]> {
  let q: Query = adminDb().collection(REVIEW_COLLECTION);

  if (opts.status) {
    q = q.where("status", "==", opts.status);
  }
  if (opts.priority) {
    q = q.where("priority", "==", opts.priority);
  }
  if (opts.flagType) {
    q = q.where("flagType", "==", opts.flagType);
  }

  q = q.orderBy("flaggedAt", opts.sort === "oldest" ? "asc" : "desc").limit(opts.limit || 50);

  const snap = await q.get();

  return snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  })) as CreditOpsReviewItem[];
}

/** Get a single review item by ID. */
export async function getReviewItem(
  itemId: string,
): Promise<CreditOpsReviewItem | null> {
  const snap = await adminDb().collection(REVIEW_COLLECTION).doc(itemId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as CreditOpsReviewItem;
}

// ═══════════════════════════════════════════════════════════════
// Update Review
// ═══════════════════════════════════════════════════════════════

/** Update a review item (assign, start review, resolve, dismiss). */
export async function updateReviewItem(
  itemId: string,
  update: {
    action: "assign" | "start_review" | "resolve" | "dismiss";
    performedBy: string;
    comment?: string;
    assignedTo?: string;
    resolution?: ReviewResolution;
  },
): Promise<void> {
  const ref = adminDb().collection(REVIEW_COLLECTION).doc(itemId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Review item not found");

  const current = snap.data()!;
  const reviewHistory: ReviewHistoryEntry[] = Array.isArray(
    current.reviewHistory,
  )
    ? current.reviewHistory
    : [];

  const entry: ReviewHistoryEntry = {
    action: update.action,
    performedBy: update.performedBy,
    performedAt: new Date().toISOString(),
    comment: update.comment,
  };
  reviewHistory.push(entry);

  const updates: Record<string, unknown> = { reviewHistory };

  switch (update.action) {
    case "assign":
      updates.assignedTo = update.assignedTo || update.performedBy;
      updates.status = "pending";
      break;
    case "start_review":
      updates.status = "in_review";
      updates.assignedTo = update.performedBy;
      updates.reviewedAt = FieldValue.serverTimestamp();
      break;
    case "resolve":
      updates.status = "resolved";
      updates.resolution = update.resolution || "no_action";
      updates.resolutionComment = update.comment || "";
      updates.resolvedAt = FieldValue.serverTimestamp();
      break;
    case "dismiss":
      updates.status = "dismissed";
      updates.resolutionComment = update.comment || "";
      updates.resolvedAt = FieldValue.serverTimestamp();
      break;
  }

  await ref.update(updates);

  await recordCreditOpsAudit({
    action: `review.${update.action}`,
    performedBy: update.performedBy,
    targetType: "agent",
    targetId: current.asn || current.agentId,
    metadata: {
      reviewItemId: itemId,
      resolution: update.resolution,
      comment: update.comment,
    },
  });
}

// ═══════════════════════════════════════════════════════════════
// Stats
// ═══════════════════════════════════════════════════════════════

/** Get review queue stats for the overview dashboard. */
export async function getReviewQueueStats(): Promise<{
  total: number;
  pending: number;
  inReview: number;
  resolved: number;
  byPriority: Record<ReviewPriority, number>;
  byFlagType: Record<ReviewFlagType, number>;
}> {
  const col = adminDb().collection(REVIEW_COLLECTION);
  const [pendingSnap, inReviewSnap, resolvedSnap] = await Promise.all([
    col.where("status", "==", "pending").count().get(),
    col.where("status", "==", "in_review").count().get(),
    col.where("status", "==", "resolved").count().get(),
  ]);

  const pending = pendingSnap.data().count;
  const inReview = inReviewSnap.data().count;
  const resolved = resolvedSnap.data().count;

  // Priority breakdown (for active items only)
  const activeCol = col.where("status", "in", ["pending", "in_review"]);
  const [lowSnap, medSnap, highSnap, critSnap] = await Promise.all([
    activeCol.where("priority", "==", "low").count().get(),
    activeCol.where("priority", "==", "medium").count().get(),
    activeCol.where("priority", "==", "high").count().get(),
    activeCol.where("priority", "==", "critical").count().get(),
  ]);

  // Flag type breakdown (for active items)
  const [slashSnap, anomalySnap, fraudSnap, manualSnap, appealSnap] = await Promise.all([
    activeCol.where("flagType", "==", "slashing").count().get(),
    activeCol.where("flagType", "==", "anomaly").count().get(),
    activeCol.where("flagType", "==", "fraud").count().get(),
    activeCol.where("flagType", "==", "manual").count().get(),
    activeCol.where("flagType", "==", "appeal_trigger").count().get(),
  ]);

  return {
    total: pending + inReview + resolved,
    pending,
    inReview,
    resolved,
    byPriority: {
      low: lowSnap.data().count,
      medium: medSnap.data().count,
      high: highSnap.data().count,
      critical: critSnap.data().count,
    },
    byFlagType: {
      slashing: slashSnap.data().count,
      anomaly: anomalySnap.data().count,
      fraud: fraudSnap.data().count,
      manual: manualSnap.data().count,
      appeal_trigger: appealSnap.data().count,
    },
  };
}
