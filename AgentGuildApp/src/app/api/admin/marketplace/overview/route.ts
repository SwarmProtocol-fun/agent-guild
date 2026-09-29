/**
 * GET /api/admin/marketplace/overview
 *
 * Marketplace-specific stats: queue depth, stage breakdown, listings,
 * publishers, reports, and recent audit entries.
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getAuditLog } from "@/lib/audit-log";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    const db = adminDb();
    // Parallel count queries
    const [
      communityPendingSnap,
      agentPendingSnap,
      communityApprovedSnap,
      agentApprovedSnap,
      publisherActiveSnap,
      reportsSnap,
    ] = await Promise.all([
      db.collection("communityMarketItems").where("status", "==", "pending").count().get(),
      db.collection("marketplaceAgents").where("status", "==", "review").count().get(),
      db.collection("communityMarketItems").where("status", "==", "approved").count().get(),
      db.collection("marketplaceAgents").where("status", "==", "approved").count().get(),
      db.collection("publisherProfiles").where("banned", "==", false).count().get(),
      db.collection("marketplaceReports").count().get(),
    ]);

    const queueDepth = communityPendingSnap.data().count + agentPendingSnap.data().count;
    const activeListings = communityApprovedSnap.data().count + agentApprovedSnap.data().count;

    // Stage breakdown — query pending items and group by stage
    const [communityPendingDocs, agentPendingDocs] = await Promise.all([
      db.collection("communityMarketItems").where("status", "==", "pending").get(),
      db.collection("marketplaceAgents").where("status", "==", "review").get(),
    ]);

    const stageBreakdown: Record<string, number> = {
      intake: 0, security_scan: 0, sandbox: 0, product_review: 0, decision: 0,
    };
    for (const d of [...communityPendingDocs.docs, ...agentPendingDocs.docs]) {
      const stage = (d.data().stage as string) || "intake";
      stageBreakdown[stage] = (stageBreakdown[stage] || 0) + 1;
    }

    // Recent audit entries
    const recentAudit = await getAuditLog({ limit: 10 });

    return Response.json({
      ok: true,
      stats: {
        queueDepth,
        activeListings,
        activePublishers: publisherActiveSnap.data().count,
        openReports: reportsSnap.data().count,
        stageBreakdown,
      },
      recentAudit,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch overview",
    }, { status: 500 });
  }
}
