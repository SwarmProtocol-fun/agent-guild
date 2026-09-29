/**
 * GET /api/admin/risk/agent/[agentId]
 *
 * Fetch risk profile, all signals, and review history for a specific agent.
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import {
  getRiskProfile,
  getSignals,
  listFraudReviewCases,
} from "@/lib/fraud-detection";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { agentId } = await params;

  try {
    // Fetch agent info
    const agentDoc = await adminDb().collection("agents").doc(agentId).get();
    if (!agentDoc.exists) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }

    const agentData = agentDoc.data()!;

    // Parallel fetch of risk data
    const [riskProfile, allSignals, reviewCases] = await Promise.all([
      getRiskProfile(agentId),
      getSignals({ agentId, max: 100 }),
      listFraudReviewCases({ agentId, max: 20 }),
    ]);

    return Response.json({
      ok: true,
      agent: {
        id: agentDoc.id,
        name: agentData.name,
        asn: agentData.asn,
        walletAddress: agentData.walletAddress,
        creditScore: agentData.creditScore,
        trustScore: agentData.trustScore,
        status: agentData.status,
        orgId: agentData.orgId,
        createdAt: agentData.createdAt,
      },
      riskProfile,
      signals: allSignals,
      reviewCases,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch agent risk data",
    }, { status: 500 });
  }
}
