/**
 * GET /api/admin/credit-ops/monitoring
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getMonitoringStats } from "@/lib/credit-ops/monitoring";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    const stats = await getMonitoringStats();
    return Response.json({ ok: true, stats });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
