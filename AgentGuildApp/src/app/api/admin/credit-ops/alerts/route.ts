/**
 * GET /api/admin/credit-ops/alerts
 * POST /api/admin/credit-ops/alerts
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getAlerts, batchAcknowledgeAlerts } from "@/lib/credit-ops/monitoring";
import type { AlertSeverity, AlertType } from "@/lib/credit-ops/types";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const url = req.nextUrl;
  const severity = url.searchParams.get("severity") as AlertSeverity | null;
  const alertType = url.searchParams.get("alertType") as AlertType | null;
  const acknowledged = url.searchParams.get("acknowledged");

  try {
    const items = await getAlerts({
      severity: severity || undefined,
      alertType: alertType || undefined,
      acknowledged: acknowledged !== null ? acknowledged === "true" : undefined,
    });
    return Response.json({ ok: true, count: items.length, items });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const { alertIds } = body as { alertIds: string[] };

  if (!alertIds?.length) {
    return Response.json({ error: "alertIds[] required" }, { status: 400 });
  }

  try {
    await batchAcknowledgeAlerts(alertIds, "platform-admin");
    return Response.json({ ok: true, acknowledged: alertIds.length });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
