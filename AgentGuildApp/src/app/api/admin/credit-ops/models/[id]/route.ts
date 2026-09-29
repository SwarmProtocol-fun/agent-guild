/**
 * GET /api/admin/credit-ops/models/[id]
 * POST /api/admin/credit-ops/models/[id]
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getModel, startShadowMode, computeShadowComparison, promoteModel, rollbackModel } from "@/lib/credit-ops/model";

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, ctx: RouteContext) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { id } = await ctx.params;
  try {
    const item = await getModel(id);
    if (!item) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ ok: true, item });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { id } = await ctx.params;
  const body = await req.json();
  const { action, reason } = body as { action: string; reason?: string };

  try {
    switch (action) {
      case "start_shadow":
        await startShadowMode(id);
        return Response.json({ ok: true, shadowStarted: true });
      case "compute_shadow":
        const results = await computeShadowComparison(id);
        return Response.json({ ok: true, results });
      case "promote":
        await promoteModel(id, "platform-admin");
        return Response.json({ ok: true, promoted: true });
      case "rollback":
        await rollbackModel(id, "platform-admin", reason || "Admin rollback");
        return Response.json({ ok: true, rolledBack: true });
      default:
        return Response.json({ error: "action must be start_shadow, compute_shadow, promote, or rollback" }, { status: 400 });
    }
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
