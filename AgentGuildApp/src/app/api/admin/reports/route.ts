/**
 * GET /api/admin/reports
 *
 * Lists marketplace reports for admin review.
 *
 * POST /api/admin/reports
 *
 * Admin actions: dismiss, action-taken (resolve report + optionally suspend item).
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const limitParam = Number(req.nextUrl.searchParams.get("limit")) || 50;

  try {
    const snap = await adminDb().collection("marketplaceReports")
      .orderBy("createdAt", "desc")
      .limit(limitParam)
      .get();
    const reports = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    return Response.json({ ok: true, reports });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch reports",
    }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const { action, reportId, suspendItem } = body as {
    action: "dismiss" | "action-taken";
    reportId: string;
    suspendItem?: boolean;
  };

  if (!action || !reportId) {
    return Response.json({ error: "Missing action or reportId" }, { status: 400 });
  }

  const reportRef = adminDb().collection("marketplaceReports").doc(reportId);
  const reportSnap = await reportRef.get();

  if (!reportSnap.exists) {
    return Response.json({ error: "Report not found" }, { status: 404 });
  }

  const report = reportSnap.data()!;

  try {
    await reportRef.update({
      resolution: action,
      resolvedAt: FieldValue.serverTimestamp(),
      resolvedBy: req.headers.get("x-wallet-address") || "admin",
    });

    // Optionally suspend the reported item
    if (action === "action-taken" && suspendItem && report.itemId && report.collection) {
      const itemRef = adminDb().collection(report.collection).doc(report.itemId);
      await itemRef.update({
        status: "suspended",
        suspendedAt: FieldValue.serverTimestamp(),
        suspendReason: `Report ${reportId}: ${report.reason}`,
      });
    }

    await recordAuditEntry({
      action: `report.${action}`,
      performedBy: req.headers.get("x-wallet-address") || "admin",
      targetType: "report",
      targetId: reportId,
      metadata: { suspendItem, itemId: report.itemId, reason: report.reason },
    }).catch(() => {}); // non-blocking

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Action failed",
    }, { status: 500 });
  }
}
