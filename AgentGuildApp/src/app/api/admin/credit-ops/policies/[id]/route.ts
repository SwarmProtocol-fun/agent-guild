/**
 * GET /api/admin/credit-ops/policies/[id]
 * POST /api/admin/credit-ops/policies/[id]
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getPolicy, updateDraftPolicy, activatePolicy } from "@/lib/credit-ops/policy";

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, ctx: RouteContext) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { id } = await ctx.params;
  try {
    const item = await getPolicy(id);
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
  const { action, ...updates } = body as { action?: "activate" } & Record<string, unknown>;

  try {
    if (action === "activate") {
      await activatePolicy(id, "platform-admin");
      return Response.json({ ok: true, activated: true });
    }
    await updateDraftPolicy(id, updates);
    return Response.json({ ok: true, updated: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
