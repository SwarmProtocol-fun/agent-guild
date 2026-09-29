/**
 * GET /api/admin/overview
 *
 * Platform-wide stats for the admin dashboard.
 * Returns counts for orgs, agents, marketplace items, subscriptions, reports, publishers.
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requirePlatformAdmin } from "@/lib/auth-guard";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    const db = adminDb();
    const [
      orgsSnap,
      agentsSnap,
      communitySnap,
      agentMarketSnap,
      subsSnap,
      reportsSnap,
      publishersSnap,
      modServicesSnap,
      pendingCommunitySnap,
      pendingAgentsSnap,
    ] = await Promise.all([
      db.collection("organizations").count().get(),
      db.collection("agents").count().get(),
      db.collection("communityMarketItems").count().get(),
      db.collection("marketplaceAgents").count().get(),
      db.collection("subscriptions").count().get(),
      db.collection("marketplaceReports").count().get(),
      db.collection("publisherProfiles").count().get(),
      db.collection("modServiceRegistry").count().get(),
      db.collection("communityMarketItems").where("status", "==", "pending").count().get(),
      db.collection("marketplaceAgents").where("status", "==", "review").count().get(),
    ]);

    return Response.json({
      ok: true,
      stats: {
        organizations: orgsSnap.data().count,
        agents: agentsSnap.data().count,
        communityItems: communitySnap.data().count,
        marketplaceAgents: agentMarketSnap.data().count,
        subscriptions: subsSnap.data().count,
        reports: reportsSnap.data().count,
        publishers: publishersSnap.data().count,
        modServices: modServicesSnap.data().count,
        pendingReviews: pendingCommunitySnap.data().count + pendingAgentsSnap.data().count,
      },
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch overview",
    }, { status: 500 });
  }
}
