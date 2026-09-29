/**
 * GET /api/admin/credit-ops/overview
 *
 * Dashboard stats for the credit operations admin panel.
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getReviewQueueStats } from "@/lib/credit-ops/review";
import { getCreditOpsAuditLog } from "@/lib/credit-ops/audit";
import { getAlerts } from "@/lib/credit-ops/monitoring";
import { listAppeals } from "@/lib/credit-ops/appeals";
import { listDisputes } from "@/lib/credit-ops/disputes";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    const [queueStats, recentAudit, activeAlerts, openAppeals, openDisputes] = await Promise.all([
      getReviewQueueStats(),
      getCreditOpsAuditLog({ limit: 10 }),
      getAlerts({ acknowledged: false, limit: 1000 }).then(a => a.length).catch(() => 0),
      listAppeals({ status: "submitted", limit: 1000 }).then(a => a.length)
        .then(submitted => listAppeals({ status: "under_review", limit: 1000 }).then(r => submitted + r.length))
        .catch(() => 0),
      listDisputes({ status: "filed", limit: 1000 }).then(d => d.length)
        .then(filed => listDisputes({ status: "investigating", limit: 1000 }).then(r => filed + r.length))
        .catch(() => 0),
    ]);

    return Response.json({
      ok: true,
      stats: {
        queueDepth: queueStats.pending + queueStats.inReview,
        pending: queueStats.pending,
        inReview: queueStats.inReview,
        resolved: queueStats.resolved,
        byPriority: queueStats.byPriority,
        byFlagType: queueStats.byFlagType,
        activeAlerts,
        openAppeals,
        openDisputes,
      },
      recentAudit,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fetch overview" },
      { status: 500 },
    );
  }
}
