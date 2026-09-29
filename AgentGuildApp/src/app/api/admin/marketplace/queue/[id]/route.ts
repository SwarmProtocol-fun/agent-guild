/**
 * GET /api/admin/marketplace/queue/[id]
 * POST /api/admin/marketplace/queue/[id]
 *
 * Single submission detail: fetch full item with enriched publisher data
 * and security scan, and perform review actions.
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";
import {
  getNextStage, getStartingStage, updatePublisherStats, runSecurityScan,
  type ReviewEntry, type SubmissionStage,
} from "@/lib/submission-protocol";
import type { PermissionScope } from "@/lib/skills";

const COLLECTIONS = {
  community: "communityMarketItems",
  agents: "marketplaceAgents",
} as const;

type CollectionKey = keyof typeof COLLECTIONS;

function resolveCollection(value: string | null): CollectionKey {
  return value === "agents" ? "agents" : "community";
}

function pendingStatus(col: CollectionKey): string {
  return col === "agents" ? "review" : "pending";
}

/** GET — Fetch single submission with enriched data */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { id } = await params;
  const col = resolveCollection(req.nextUrl.searchParams.get("source"));
  const colName = COLLECTIONS[col];

  try {
    const ref = adminDb().collection(colName).doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return Response.json({ error: "Submission not found" }, { status: 404 });
    }

    const data = snap.data()!;

    // Enrich with publisher profile
    const publisherWallet = data.submittedBy || data.authorWallet;
    let publisher = null;
    if (publisherWallet) {
      const pubRef = adminDb().collection("publisherProfiles").doc(publisherWallet);
      const pubSnap = await pubRef.get();
      if (pubSnap.exists) {
        const p = pubSnap.data()!;
        publisher = {
          wallet: publisherWallet,
          displayName: p.displayName || publisherWallet.slice(0, 10) + "...",
          tier: p.tier ?? 0,
          totalSubmissions: p.totalSubmissions ?? 0,
          approvedCount: p.approvedCount ?? 0,
          banned: p.banned ?? false,
        };
      }
    }

    // Run live security scan
    let securityScan = null;
    try {
      const result = runSecurityScan(
        data.description || "",
        data.modManifest,
        data.permissionsRequired as PermissionScope[] | undefined,
      );
      securityScan = result;
    } catch {
      // non-blocking
    }

    return Response.json({
      ok: true,
      item: {
        id: snap.id,
        source: col,
        ...data,
        publisher,
        securityScan,
      },
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch submission",
    }, { status: 500 });
  }
}

/** POST — Review action on single submission */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = body.action as string;
  const reviewComment = (body.reviewComment as string) || "";
  const col = resolveCollection((body.source as string) || null);
  const skipTo = body.skipTo as string | undefined;

  const validActions = ["advance", "approve", "reject", "request_changes", "re_evaluate"];
  if (!action || !validActions.includes(action)) {
    return Response.json({
      error: `action must be one of: ${validActions.join(", ")}`,
    }, { status: 400 });
  }

  const ref = adminDb().collection(COLLECTIONS[col]).doc(id);
  const snap = await ref.get();

  if (!snap.exists) {
    return Response.json({ error: "Submission not found" }, { status: 404 });
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
      const validStages: SubmissionStage[] = ["intake", "security_scan", "sandbox", "product_review", "decision"];
      if (skipTo && validStages.includes(skipTo as SubmissionStage)) {
        newStage = skipTo as SubmissionStage;
      } else {
        const next = getNextStage(currentStage);
        if (!next) {
          return Response.json({ error: `Cannot advance past ${currentStage}` }, { status: 400 });
        }
        newStage = next;
      }
      newStatus = current.status;
      newEntry.result = "passed";
      break;
    }

    case "approve": {
      newStatus = "approved";
      newStage = "decision";
      newEntry.stage = currentStage;
      newEntry.result = "passed";
      const publisherWallet = current.submittedBy || current.authorWallet;
      if (publisherWallet && publisherWallet !== "platform-admin") {
        try { await updatePublisherStats(publisherWallet); } catch { /* best-effort */ }
      }
      break;
    }

    case "reject":
      newStatus = "rejected";
      newEntry.result = "failed";
      break;

    case "request_changes":
      newStatus = "changes_requested";
      newEntry.result = "failed";
      break;

    case "re_evaluate": {
      // Accept appeal — reset to appropriate pipeline stage
      const publisherWallet = current.submittedBy || current.authorWallet;
      let tier = 0;
      if (publisherWallet) {
        const pubRef = adminDb().collection("publisherProfiles").doc(publisherWallet);
        const pubSnap = await pubRef.get();
        if (pubSnap.exists) tier = pubSnap.data()!.tier ?? 0;
      }
      newStage = getStartingStage(tier);
      newStatus = pendingStatus(col);
      newEntry.result = "passed";
      newEntry.comment = reviewComment || "Appeal accepted, re-evaluating";
      break;
    }

    default:
      newStatus = current.status;
  }

  reviewHistory.push(newEntry);

  await ref.update({
    status: newStatus,
    stage: newStage,
    reviewHistory,
    reviewedAt: FieldValue.serverTimestamp(),
    reviewComment,
  });

  await recordAuditEntry({
    action: `submission.${action}`,
    performedBy: "platform-admin",
    targetType: "submission",
    targetId: id,
    metadata: { collection: col, stage: newStage, comment: reviewComment },
  }).catch(() => {});

  return Response.json({
    ok: true,
    action,
    itemId: id,
    status: newStatus,
    stage: newStage,
    reviewComment: reviewComment || undefined,
  });
}
