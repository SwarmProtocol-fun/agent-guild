/**
 * GET /api/admin/risk/overview
 *
 * Platform risk overview: pending reviews, signal breakdown,
 * risk tier distribution, and recent scan runs.
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { listFraudReviewCases, listScanRuns, getRiskProfiles } from "@/lib/fraud-detection";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    // Parallel count queries
    const [
      pendingCasesSnap,
      activeSignalsSnap,
      recentCases,
      recentScans,
      allProfiles,
    ] = await Promise.all([
      adminDb().collection("fraudReviewQueue").where("status", "==", "pending").count().get(),
      adminDb().collection("riskSignals").where("status", "==", "active").count().get(),
      listFraudReviewCases({ max: 5 }),
      listScanRuns(5),
      getRiskProfiles({ max: 500 }),
    ]);

    // Risk tier distribution
    const tierDistribution: Record<string, number> = {
      clean: 0, watch: 0, suspicious: 0, flagged: 0, banned: 0,
    };
    for (const profile of allProfiles) {
      tierDistribution[profile.riskTier] = (tierDistribution[profile.riskTier] || 0) + 1;
    }

    // Signal type breakdown from recent scan
    const latestScan = recentScans[0];
    const signalBreakdown = latestScan?.signalBreakdown || {};

    return Response.json({
      ok: true,
      stats: {
        pendingReviews: pendingCasesSnap.data().count,
        activeSignals: activeSignalsSnap.data().count,
        tierDistribution,
        signalBreakdown,
      },
      recentCases,
      recentScans,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch risk overview",
    }, { status: 500 });
  }
}
