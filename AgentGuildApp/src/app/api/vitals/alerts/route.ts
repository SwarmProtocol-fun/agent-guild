/**
 * GET /api/vitals/alerts
 *
 * Get vital alerts for an organization.
 * Query params:
 *  - orgId (required)
 *  - active (optional, default true) - show only active alerts
 *  - limit (optional, default 100) - max results for history
 *
 * POST /api/vitals/alerts/resolve
 *
 * Resolve a vital alert.
 * Body: { alertId }
 */

import { NextRequest } from "next/server";
import { getActiveAlerts, getAlertHistory, resolveAlert } from "@/lib/vitals-collector";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";

export async function GET(request: NextRequest) {
  const wallet = getWalletAddress(request);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const orgId = searchParams.get("orgId");
  const active = searchParams.get("active") !== "false";
  const rawLimit = parseInt(searchParams.get("limit") || "100", 10);
  const limit = isNaN(rawLimit) ? 100 : Math.max(1, Math.min(rawLimit, 500));

  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  const orgAuth = await requireOrgMember(request, orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  try {
    const alerts = active
      ? await getActiveAlerts(orgId)
      : await getAlertHistory(orgId, limit);

    return Response.json({
      ok: true,
      alerts,
      count: alerts.length,
      active,
    });
  } catch (err) {
    console.error("Get vitals alerts error:", err);
    return Response.json(
      { error: "Failed to retrieve vitals alerts" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const wallet = getWalletAddress(request);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { alertId } = body;

  if (!alertId) {
    return Response.json({ error: "alertId is required" }, { status: 400 });
  }

  try {
    await resolveAlert(alertId as string);

    return Response.json({
      ok: true,
      message: "Alert resolved",
    });
  } catch (err) {
    console.error("Resolve alert error:", err);
    return Response.json(
      { error: "Failed to resolve alert" },
      { status: 500 }
    );
  }
}
