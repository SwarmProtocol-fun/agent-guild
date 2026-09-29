/**
 * GET /api/admin/marketplace/audit
 *
 * Read-only access to the marketplace audit log with filtering.
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getAuditLog } from "@/lib/audit-log";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const url = req.nextUrl;
  const actionFilter = url.searchParams.get("action") || undefined;
  const targetId = url.searchParams.get("targetId") || undefined;
  const targetType = url.searchParams.get("targetType") as "submission" | "listing" | "publisher" | "report" | "mod_service" | undefined;
  const limitParam = Number(url.searchParams.get("limit")) || 50;

  try {
    const entries = await getAuditLog({
      limit: limitParam,
      action: actionFilter,
      targetId,
      targetType,
    });

    return Response.json({ ok: true, count: entries.length, entries });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch audit log",
    }, { status: 500 });
  }
}
