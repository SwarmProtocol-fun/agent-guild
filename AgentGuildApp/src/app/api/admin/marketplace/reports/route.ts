/**
 * GET /api/admin/marketplace/reports
 * POST /api/admin/marketplace/reports
 *
 * Report management: list reports with status filters,
 * dismiss/resolve/suspend-item actions.
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, type Query } from "firebase-admin/firestore";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";

/** GET — List reports */
export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const url = req.nextUrl;
  const statusFilter = url.searchParams.get("status") || "open";
  const sort = url.searchParams.get("sort") || "newest";
  const limitParam = Number(url.searchParams.get("limit")) || 50;

  try {
    let q: Query = adminDb().collection("marketplaceReports");
    if (statusFilter === "dismissed") {
      q = q.where("resolution", "==", "dismissed");
    } else if (statusFilter === "resolved") {
      q = q.where("resolution", "==", "resolved");
    }
    // For "open", no where clause — fetch all and filter client-side below

    q = q.orderBy("createdAt", sort === "oldest" ? "asc" : "desc").limit(limitParam);
    const snap = await q.get();

    let reports = snap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    })) as Record<string, unknown>[];

    // For "open" filter, remove reports that have a resolution
    if (statusFilter === "open") {
      reports = reports.filter((r) => !r.resolution);
    }

    return Response.json({ ok: true, count: reports.length, reports });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch reports",
    }, { status: 500 });
  }
}

/** POST — Report resolution actions */
export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const { action, reportId, resolution, reason } = body as {
    action: "dismiss" | "resolve" | "suspend_item";
    reportId: string;
    resolution?: string;
    reason?: string;
  };

  if (!action || !reportId) {
    return Response.json({ error: "action and reportId required" }, { status: 400 });
  }

  try {
    const reportRef = adminDb().collection("marketplaceReports").doc(reportId);
    const reportSnap = await reportRef.get();
    if (!reportSnap.exists) {
      return Response.json({ error: "Report not found" }, { status: 404 });
    }

    const reportData = reportSnap.data()!;

    switch (action) {
      case "dismiss":
        await reportRef.update({
          resolution: "dismissed",
          resolvedAt: FieldValue.serverTimestamp(),
          resolvedBy: "platform-admin",
          resolutionNote: reason || "",
        });
        break;

      case "resolve":
        await reportRef.update({
          resolution: resolution || "resolved",
          resolvedAt: FieldValue.serverTimestamp(),
          resolvedBy: "platform-admin",
          resolutionNote: reason || "",
        });
        break;

      case "suspend_item": {
        // Suspend the reported item
        const itemId = reportData.itemId as string;
        const itemCollection = reportData.collection === "agents" ? "marketplaceAgents" : "communityMarketItems";
        const itemRef = adminDb().collection(itemCollection).doc(itemId);
        const itemSnap = await itemRef.get();

        if (itemSnap.exists) {
          await itemRef.update({
            status: "suspended",
            suspendedAt: FieldValue.serverTimestamp(),
            suspendReason: reason || `Suspended due to report: ${reportData.reason}`,
          });

          await recordAuditEntry({
            action: "listing.suspended",
            performedBy: "platform-admin",
            targetType: "listing",
            targetId: itemId,
            metadata: { reportId, reason: reason || reportData.reason },
          });
        }

        // Resolve the report
        await reportRef.update({
          resolution: "item_suspended",
          resolvedAt: FieldValue.serverTimestamp(),
          resolvedBy: "platform-admin",
          resolutionNote: reason || "",
        });
        break;
      }

      default:
        return Response.json({ error: "Invalid action" }, { status: 400 });
    }

    await recordAuditEntry({
      action: `report.${action}`,
      performedBy: "platform-admin",
      targetType: "report",
      targetId: reportId,
      metadata: { resolution: resolution || action, reason },
    });

    return Response.json({ ok: true, action, reportId });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Action failed",
    }, { status: 500 });
  }
}
