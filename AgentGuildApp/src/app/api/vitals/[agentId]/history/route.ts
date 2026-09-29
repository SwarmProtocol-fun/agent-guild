/**
 * GET /api/vitals/[agentId]/history
 *
 * Get vitals history for a specific agent.
 * Query params: hoursBack (optional, default 24)
 */

import { NextRequest } from "next/server";
import { getVitalsHistory, calculateVitalsStats } from "@/lib/vitals-collector";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const { searchParams } = new URL(request.url);
  const rawHours = parseInt(searchParams.get("hoursBack") || "24", 10);
  const hoursBack = isNaN(rawHours) ? 24 : Math.max(1, Math.min(rawHours, 720));

  try {
    const history = await getVitalsHistory(agentId, hoursBack);
    const stats = calculateVitalsStats(history);

    return Response.json({
      ok: true,
      agentId,
      history,
      stats,
      count: history.length,
      hoursBack,
    });
  } catch (err) {
    console.error("Get vitals history error:", err);
    return Response.json(
      { error: "Failed to retrieve vitals history" },
      { status: 500 }
    );
  }
}
