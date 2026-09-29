/**
 * GET /api/cron/[id]/history
 *
 * Get execution history for a specific cron job.
 * Query params: limit (optional, default 50)
 */

import { NextRequest } from "next/server";
import { getCronExecutionHistory, calculateCronStats } from "@/lib/cron-history";
import { getWalletAddress } from "@/lib/auth-guard";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const wallet = getWalletAddress(request);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const rawLimit = parseInt(searchParams.get("limit") || "50", 10);
  const limit = isNaN(rawLimit) ? 50 : Math.max(1, Math.min(rawLimit, 500));

  try {
    const history = await getCronExecutionHistory(id, limit);
    const stats = calculateCronStats(history);

    return Response.json({
      ok: true,
      jobId: id,
      history,
      stats,
      count: history.length,
    });
  } catch (err) {
    console.error("Get cron history error:", err);
    return Response.json(
      { error: "Failed to retrieve cron execution history" },
      { status: 500 }
    );
  }
}
