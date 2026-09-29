/**
 * GET /api/admin/credit-ops/queue
 * POST /api/admin/credit-ops/queue
 *
 * Review queue: list flagged agents with filters, batch review actions.
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getReviewQueue, updateReviewItem } from "@/lib/credit-ops/review";
import type { ReviewStatus, ReviewPriority, ReviewFlagType, ReviewResolution } from "@/lib/credit-ops/types";

/** GET — List review queue items */
export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const url = req.nextUrl;
  const status = url.searchParams.get("status") as ReviewStatus | null;
  const priority = url.searchParams.get("priority") as ReviewPriority | null;
  const flagType = url.searchParams.get("flagType") as ReviewFlagType | null;
  const sort = (url.searchParams.get("sort") || "newest") as "newest" | "oldest" | "priority";
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);

  try {
    const items = await getReviewQueue({
      status: status || undefined,
      priority: priority || undefined,
      flagType: flagType || undefined,
      sort,
      limit,
    });

    return Response.json({ ok: true, count: items.length, items });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fetch queue" },
      { status: 500 },
    );
  }
}

/** POST — Batch review actions */
export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const { action, itemIds, comment, assignedTo, resolution } = body as {
    action: "assign" | "start_review" | "resolve" | "dismiss";
    itemIds: string[];
    comment?: string;
    assignedTo?: string;
    resolution?: ReviewResolution;
  };

  if (!action || !itemIds?.length) {
    return Response.json({ error: "action and itemIds[] required" }, { status: 400 });
  }

  const validActions = ["assign", "start_review", "resolve", "dismiss"];
  if (!validActions.includes(action)) {
    return Response.json(
      { error: `action must be one of: ${validActions.join(", ")}` },
      { status: 400 },
    );
  }

  const results: { id: string; status: string; error?: string }[] = [];

  for (const itemId of itemIds) {
    try {
      await updateReviewItem(itemId, {
        action,
        performedBy: "platform-admin",
        comment,
        assignedTo,
        resolution,
      });
      results.push({ id: itemId, status: "ok" });
    } catch (err) {
      results.push({
        id: itemId,
        status: "error",
        error: err instanceof Error ? err.message : "Failed",
      });
    }
  }

  return Response.json({ ok: true, results });
}
