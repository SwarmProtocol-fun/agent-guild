/**
 * GET /api/admin/credit-ops/queue/[id]
 * POST /api/admin/credit-ops/queue/[id]
 *
 * Single review item: detail view and review actions.
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getReviewItem, updateReviewItem } from "@/lib/credit-ops/review";
import { getAgentSlashingHistory } from "@/lib/mod-stubs";
// [swarm-core] Hedera integration removed — install swarm-hedera mod
import type { ReviewResolution } from "@/lib/credit-ops/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** GET — Single review item detail */
export async function GET(req: NextRequest, ctx: RouteContext) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { id } = await ctx.params;

  try {
    const item = await getReviewItem(id);
    if (!item) {
      return Response.json({ error: "Review item not found" }, { status: 404 });
    }

    // Fetch slashing history for context
    let slashingHistory: unknown[] = [];
    if (item.asn) {
      try {
        slashingHistory = await getAgentSlashingHistory(item.asn);
      } catch {
        // non-critical
      }
    }

    return Response.json({ ok: true, item, slashingHistory });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fetch review item" },
      { status: 500 },
    );
  }
}

/** POST — Review action on single item */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { id } = await ctx.params;
  const body = await req.json();
  const { action, comment, assignedTo, resolution } = body as {
    action: "assign" | "start_review" | "resolve" | "dismiss";
    comment?: string;
    assignedTo?: string;
    resolution?: ReviewResolution;
  };

  if (!action) {
    return Response.json({ error: "action required" }, { status: 400 });
  }

  const validActions = ["assign", "start_review", "resolve", "dismiss"];
  if (!validActions.includes(action)) {
    return Response.json(
      { error: `action must be one of: ${validActions.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    await updateReviewItem(id, {
      action,
      performedBy: "platform-admin",
      comment,
      assignedTo,
      resolution,
    });

    const updated = await getReviewItem(id);
    return Response.json({ ok: true, item: updated });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to update review item" },
      { status: 500 },
    );
  }
}
