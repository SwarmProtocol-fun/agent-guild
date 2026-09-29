/**
 * GET /api/admin/analytics/performance — Agent/swarm performance overview
 *
 * Returns agent health, job/workflow/task-assignment/delegation success
 * rates, a 30-day throughput trend, and top agents by tasks completed.
 */
import { NextRequest } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { getAgentPerformanceOverview } from "@/lib/agent-performance-analytics";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return forbidden(auth.error);

  try {
    const overview = await getAgentPerformanceOverview(30);
    return Response.json({ ok: true, overview });
  } catch (err) {
    console.error("[admin/analytics/performance]", err);
    return Response.json(
      { ok: false, error: "Failed to fetch performance analytics" },
      { status: 500 },
    );
  }
}
