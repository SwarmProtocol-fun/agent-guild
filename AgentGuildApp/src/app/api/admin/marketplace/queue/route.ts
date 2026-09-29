/**
 * GET /api/admin/marketplace/queue
 * POST /api/admin/marketplace/queue
 *
 * Queue management: list pending submissions with stage filters,
 * and batch review actions (advance, approve, reject).
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";
import {
  getNextStage, updatePublisherStats,
  type ReviewEntry, type SubmissionStage,
} from "@/lib/submission-protocol";

const COLLECTIONS = {
  community: "communityMarketItems",
  agents: "marketplaceAgents",
} as const;

type CollectionKey = keyof typeof COLLECTIONS;

function pendingStatus(col: CollectionKey): string {
  return col === "agents" ? "review" : "pending";
}

const VALID_STAGES: SubmissionStage[] = ["intake", "security_scan", "sandbox", "product_review", "decision"];

/** GET — List pending queue items */
export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const url = req.nextUrl;
  const stageFilter = url.searchParams.get("stage") || "all";
  const colFilter = url.searchParams.get("collection") as CollectionKey | "all" | null;
  const sort = url.searchParams.get("sort") || "oldest";

  try {
    const results: Record<string, unknown>[] = [];
    const collectionsToQuery: CollectionKey[] =
      colFilter && colFilter !== "all" ? [colFilter as CollectionKey] : ["community", "agents"];

    for (const col of collectionsToQuery) {
      const snap = await adminDb().collection(COLLECTIONS[col])
        .where("status", "==", pendingStatus(col))
        .get();
      for (const d of snap.docs) {
        const data = d.data();
        const stage = (data.stage as string) || "intake";

        if (stageFilter !== "all" && stage !== stageFilter) continue;

        results.push({
          id: d.id,
          source: col,
          name: data.name || data.title || "Untitled",
          submittedBy: data.submittedBy || data.authorWallet || "unknown",
          stage,
          publisherTier: data.publisherTier ?? 0,
          submittedAt: data.submittedAt,
          type: data.type || data.itemType || "unknown",
        });
      }
    }

    // Sort
    results.sort((a, b) => {
      const aTime = (a.submittedAt as { seconds: number })?.seconds || 0;
      const bTime = (b.submittedAt as { seconds: number })?.seconds || 0;
      return sort === "newest" ? bTime - aTime : aTime - bTime;
    });

    return Response.json({ ok: true, count: results.length, items: results });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch queue",
    }, { status: 500 });
  }
}

/** POST — Batch review actions */
export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const { action, itemIds, collection: colParam, reviewComment } = body as {
    action: "advance" | "approve" | "reject" | "request_changes";
    itemIds: string[];
    collection?: string;
    reviewComment?: string;
  };

  if (!action || !itemIds?.length) {
    return Response.json({ error: "action and itemIds[] required" }, { status: 400 });
  }

  const validActions = ["advance", "approve", "reject", "request_changes"];
  if (!validActions.includes(action)) {
    return Response.json({ error: `action must be one of: ${validActions.join(", ")}` }, { status: 400 });
  }

  const col: CollectionKey = colParam === "agents" ? "agents" : "community";
  const results: { id: string; status: string; stage: string; error?: string }[] = [];

  for (const itemId of itemIds) {
    try {
      const ref = adminDb().collection(COLLECTIONS[col]).doc(itemId);
      const snap = await ref.get();

      if (!snap.exists) {
        results.push({ id: itemId, status: "error", stage: "", error: "Not found" });
        continue;
      }

      const current = snap.data()!;
      const currentStage = (current.stage as SubmissionStage) || "intake";
      const reviewHistory: ReviewEntry[] = Array.isArray(current.reviewHistory) ? current.reviewHistory : [];

      const newEntry: ReviewEntry = {
        stage: currentStage,
        result: action === "reject" || action === "request_changes" ? "failed" : "passed",
        reviewedBy: "platform-admin",
        reviewedAt: new Date().toISOString(),
        comment: reviewComment || undefined,
      };

      let newStatus: string;
      let newStage: SubmissionStage | string = currentStage;

      switch (action) {
        case "advance": {
          const next = getNextStage(currentStage);
          if (!next) {
            results.push({ id: itemId, status: "error", stage: currentStage, error: `Cannot advance past ${currentStage}` });
            continue;
          }
          newStage = next;
          newStatus = current.status;
          newEntry.result = "passed";
          break;
        }
        case "approve":
          newStatus = "approved";
          newStage = "decision";
          newEntry.result = "passed";
          // Auto-upgrade publisher tier
          const publisherWallet = current.submittedBy || current.authorWallet;
          if (publisherWallet && publisherWallet !== "platform-admin") {
            try { await updatePublisherStats(publisherWallet); } catch { /* best-effort */ }
          }
          break;
        case "reject":
          newStatus = "rejected";
          newEntry.result = "failed";
          break;
        case "request_changes":
          newStatus = "changes_requested";
          newEntry.result = "failed";
          break;
        default:
          newStatus = current.status;
      }

      reviewHistory.push(newEntry);
      await ref.update({
        status: newStatus,
        stage: newStage,
        reviewHistory,
        reviewedAt: FieldValue.serverTimestamp(),
        reviewComment: reviewComment || "",
      });

      await recordAuditEntry({
        action: `submission.${action}`,
        performedBy: "platform-admin",
        targetType: "submission",
        targetId: itemId,
        metadata: { collection: col, stage: newStage, comment: reviewComment },
      });

      results.push({ id: itemId, status: newStatus, stage: newStage as string });
    } catch (err) {
      results.push({ id: itemId, status: "error", stage: "", error: err instanceof Error ? err.message : "Failed" });
    }
  }

  return Response.json({ ok: true, results });
}
