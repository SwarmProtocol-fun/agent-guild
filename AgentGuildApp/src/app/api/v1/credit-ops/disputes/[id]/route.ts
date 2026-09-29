/**
 * GET /api/v1/credit-ops/disputes/[id] — Get own dispute detail
 */

import { NextRequest } from "next/server";
import { requirePlatformAdminOrAgent } from "@/lib/auth-guard";
import { getDispute } from "@/lib/credit-ops/disputes";

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, ctx: RouteContext) {
  const auth = await requirePlatformAdminOrAgent(req);
  if (!auth.ok) return Response.json({ error: "Auth required" }, { status: 403 });

  const { id } = await ctx.params;
  try {
    const item = await getDispute(id);
    if (!item) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ ok: true, item });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
