/**
 * GET /api/compute/admin/profitability — Get platform profitability summary
 *
 * Platform admin only. Returns cost vs revenue breakdown.
 */
import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getProfitabilitySummary } from "@/lib/compute/billing";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const summary = await getProfitabilitySummary();
  return Response.json({ ok: true, summary });
}
