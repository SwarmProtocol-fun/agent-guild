/**
 * GET /api/v1/credit/history?agentId=X&days=30
 *
 * Returns daily credit/trust score time-series for charting.
 * Aggregated from HCS event stream, carry-forward on days with no events.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/lib/session";
import { getScoreHistory } from "@/lib/credit-explainer";

export async function GET(req: NextRequest) {
    try {
        const session = await validateSession();
        if (!session?.address) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const agentId = req.nextUrl.searchParams.get("agentId");
        if (!agentId) {
            return NextResponse.json({ error: "Missing agentId parameter" }, { status: 400 });
        }

        const days = parseInt(req.nextUrl.searchParams.get("days") || "30", 10);
        const clampedDays = Math.max(1, Math.min(365, days));

        const history = await getScoreHistory(agentId, clampedDays);
        return NextResponse.json({ agentId, days: clampedDays, history });
    } catch (error) {
        console.error("Credit history error:", error);
        return NextResponse.json(
            {
                error: "Failed to fetch score history",
                details: error instanceof Error ? error.message : "Unknown error",
            },
            { status: 500 },
        );
    }
}
