/**
 * GET /api/admin/credit-ops/appeals/[id]
 * POST /api/admin/credit-ops/appeals/[id]
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getAppeal, updateAppeal } from "@/lib/credit-ops/appeals";
import type { AppealResolution } from "@/lib/credit-ops/types";

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, ctx: RouteContext) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { id } = await ctx.params;
  try {
    const item = await getAppeal(id);
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
  const { action, comment, assignedTo, resolution } = body as {
    action: string; comment?: string; assignedTo?: string; resolution?: AppealResolution;
  };

  const validActions = ["assign", "start_review", "request_info", "resolve", "reject", "escalate"];
  if (!validActions.includes(action)) {
    return Response.json({ error: `action must be one of: ${validActions.join(", ")}` }, { status: 400 });
  }

  try {
    await updateAppeal(id, {
      action: action as "assign" | "start_review" | "request_info" | "resolve" | "reject" | "escalate",
      performedBy: "platform-admin",
      comment, assignedTo, resolution,
    });
    const updated = await getAppeal(id);
    return Response.json({ ok: true, item: updated });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
