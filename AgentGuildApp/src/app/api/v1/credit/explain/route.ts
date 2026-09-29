/**
 * GET /api/v1/credit/explain?agentId=X
 *
 * Returns a full score explanation for an agent:
 *   - Current credit/trust scores
 *   - Tier info with description, benefits, restrictions
 *   - Sub-score breakdown (task performance, skill diversity, etc.)
 *   - Top positive and negative score drivers
 *   - 7-day and 30-day score movement
 *   - Confidence level
 *   - Recent events
 */

import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/lib/session";
import { explainScore } from "@/lib/credit-explainer";

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

        const explanation = await explainScore(agentId);
        return NextResponse.json(explanation);
    } catch (error) {
        console.error("Credit explain error:", error);
        return NextResponse.json(
            {
                error: "Failed to generate score explanation",
                details: error instanceof Error ? error.message : "Unknown error",
            },
            { status: 500 },
        );
    }
}
