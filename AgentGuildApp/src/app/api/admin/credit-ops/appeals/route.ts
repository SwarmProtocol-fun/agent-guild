/**
 * GET /api/admin/credit-ops/appeals
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { listAppeals, getAppealStats } from "@/lib/credit-ops/appeals";
import type { AppealStatus, ReviewPriority } from "@/lib/credit-ops/types";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const url = req.nextUrl;
  const status = url.searchParams.get("status") as AppealStatus | null;
  const priority = url.searchParams.get("priority") as ReviewPriority | null;
  const includeStats = url.searchParams.get("stats") === "true";

  try {
    const [items, stats] = await Promise.all([
      listAppeals({ status: status || undefined, priority: priority || undefined }),
      includeStats ? getAppealStats() : null,
    ]);
    return Response.json({ ok: true, count: items.length, items, stats });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
