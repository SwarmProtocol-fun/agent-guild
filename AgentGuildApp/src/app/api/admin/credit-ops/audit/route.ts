/**
 * GET /api/admin/credit-ops/audit
 *
 * Credit operations audit log with filters.
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getCreditOpsAuditLog } from "@/lib/credit-ops/audit";
import type { CreditOpsAuditTargetType } from "@/lib/credit-ops/types";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const url = req.nextUrl;
  const action = url.searchParams.get("action") || undefined;
  const targetId = url.searchParams.get("targetId") || undefined;
  const targetType = url.searchParams.get("targetType") as CreditOpsAuditTargetType | null;
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);

  try {
    const entries = await getCreditOpsAuditLog({
      limit,
      action,
      targetId,
      targetType: targetType || undefined,
    });

    return Response.json({ ok: true, count: entries.length, entries });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fetch audit log" },
      { status: 500 },
    );
  }
}
