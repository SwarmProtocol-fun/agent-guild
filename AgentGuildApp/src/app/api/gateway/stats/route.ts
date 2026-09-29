/**
 * GET /api/gateway/stats?orgId=... — Queue statistics for an org
 *
 * Auth: org member (wallet session)
 */

import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { getQueueStats, getOrgWorkers } from "@/lib/gateway/store";

export async function GET(req: NextRequest) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const orgId = req.nextUrl.searchParams.get("orgId");
  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  const orgAuth = await requireOrgMember(req, orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  try {
    const [queueStats, workers] = await Promise.all([
      getQueueStats(orgId),
      getOrgWorkers(orgId),
    ]);

    const workerSummary = {
      total: workers.length,
      idle: workers.filter((w) => w.status === "idle").length,
      busy: workers.filter((w) => w.status === "busy").length,
      draining: workers.filter((w) => w.status === "draining").length,
      offline: workers.filter((w) => w.status === "offline").length,
    };

    return Response.json({
      ok: true,
      queue: queueStats,
      workers: workerSummary,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to get stats" },
      { status: 500 },
    );
  }
}
