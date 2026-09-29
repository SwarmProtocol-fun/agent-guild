/**
 * GET /api/v1/scoring/history?agentId=XXX&limit=50
 *
 * Returns score snapshot history for an agent.
 * Auth: Session required.
 */
import { NextRequest } from "next/server";
import { validateSession } from "@/lib/session";
import { getScoreHistory } from "@/lib/scoring-engine";

export async function GET(request: NextRequest) {
    const session = await validateSession();
    if (!session?.sub) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get("agentId");
    const limitParam = searchParams.get("limit");

    if (!agentId) {
        return Response.json({ error: "agentId query param is required" }, { status: 400 });
    }

    const max = Math.min(200, Math.max(1, parseInt(limitParam || "50", 10) || 50));

    try {
        const history = await getScoreHistory(agentId, max);
        return Response.json({ ok: true, count: history.length, history });
    } catch (err) {
        console.error("Score history fetch failed:", err);
        return Response.json({ error: (err as Error).message }, { status: 500 });
    }
}
