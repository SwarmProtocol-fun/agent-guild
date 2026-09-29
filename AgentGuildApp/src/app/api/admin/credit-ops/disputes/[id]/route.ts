/**
 * GET /api/admin/credit-ops/disputes/[id]
 * POST /api/admin/credit-ops/disputes/[id]
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getDispute, updateDispute } from "@/lib/credit-ops/disputes";
import type { DisputeAdjudication } from "@/lib/credit-ops/types";

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, ctx: RouteContext) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { id } = await ctx.params;
  try {
    const item = await getDispute(id);
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
  const { action, comment, adjudication } = body as {
    action: string; comment?: string; adjudication?: DisputeAdjudication;
  };

  const validActions = ["assign", "investigate", "mediate", "adjudicate", "close"];
  if (!validActions.includes(action)) {
    return Response.json({ error: `action must be one of: ${validActions.join(", ")}` }, { status: 400 });
  }

  try {
    await updateDispute(id, {
      action: action as "assign" | "investigate" | "mediate" | "adjudicate" | "close",
      performedBy: "platform-admin",
      comment, adjudication,
    });
    const updated = await getDispute(id);
    return Response.json({ ok: true, item: updated });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
