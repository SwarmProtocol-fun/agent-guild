/**
 * GET /api/summaries
 *
 * Get daily summaries for an org or specific agent.
 * Query params:
 *  - orgId (required)
 *  - agentId (optional) - filter by agent
 *  - date (optional) - specific date (YYYY-MM-DD)
 *  - limit (optional) - max results (default 30)
 */

import { NextRequest } from "next/server";
import { getDailySummary, getAllSummaries, formatSummary } from "@/lib/daily-summary";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const orgId = searchParams.get("orgId");
  const agentId = searchParams.get("agentId");
  const date = searchParams.get("date");
  const limit = parseInt(searchParams.get("limit") || "30");

  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  try {
    // If agentId and date specified, get specific summary
    if (agentId && date) {
      const summary = await getDailySummary(orgId, agentId, date);
      if (!summary) {
        return Response.json(
          { error: "Summary not found" },
          { status: 404 }
        );
      }

      const formatted = formatSummary(summary, {
        format: "markdown",
        includeStats: true,
        includeErrors: true,
        includeHighlights: true,
      });

      return Response.json({
        ok: true,
        summary,
        formatted,
      });
    }

    // Otherwise get all summaries for org
    const summaries = await getAllSummaries(orgId, limit);

    // Filter by agentId if specified
    const filtered = agentId
      ? summaries.filter((s) => s.agentId === agentId)
      : summaries;

    return Response.json({
      ok: true,
      summaries: filtered,
      count: filtered.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Get summaries error:", message);
    return Response.json(
      { error: "Failed to retrieve summaries", detail: message },
      { status: 500 }
    );
  }
}
