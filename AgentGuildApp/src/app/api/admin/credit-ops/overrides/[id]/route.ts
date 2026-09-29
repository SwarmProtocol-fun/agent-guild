/**
 * GET /api/admin/credit-ops/overrides/[id]
 * POST /api/admin/credit-ops/overrides/[id]
 *
 * Override detail and actions (approve, rollback).
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import {
  getOverride,
  approveOverride,
  rollbackOverride,
} from "@/lib/credit-ops/override";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** GET — Override detail */
export async function GET(req: NextRequest, ctx: RouteContext) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { id } = await ctx.params;

  try {
    const item = await getOverride(id);
    if (!item) {
      return Response.json({ error: "Override not found" }, { status: 404 });
    }
    return Response.json({ ok: true, item });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fetch override" },
      { status: 500 },
    );
  }
}

/** POST — Override actions (approve, rollback) */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { id } = await ctx.params;
  const body = await req.json();
  const { action, reason } = body as {
    action: "approve" | "rollback";
    reason?: string;
  };

  if (!action) {
    return Response.json({ error: "action required" }, { status: 400 });
  }

  try {
    switch (action) {
      case "approve": {
        const result = await approveOverride(id, "platform-admin");
        return Response.json({ ok: true, applied: result.applied });
      }
      case "rollback": {
        if (!reason) {
          return Response.json({ error: "reason required for rollback" }, { status: 400 });
        }
        await rollbackOverride(id, "platform-admin", reason);
        return Response.json({ ok: true, rolledBack: true });
      }
      default:
        return Response.json({ error: "action must be approve or rollback" }, { status: 400 });
    }
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to process action" },
      { status: 500 },
    );
  }
}
