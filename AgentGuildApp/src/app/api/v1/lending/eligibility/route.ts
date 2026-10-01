/**
 * GET /api/v1/lending/eligibility?agentId=X
 * Returns the agent's current loan eligibility: trust/unsecured max amounts,
 * rates, and what's blocking access (if anything).
 */
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/lib/session";
import { getEligibility } from "@/lib/lending/lending-service";

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

        const eligibility = await getEligibility(agentId);
        return NextResponse.json(eligibility);
    } catch (error) {
        console.error("[lending/eligibility] error:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Failed to resolve eligibility" },
            { status: 500 },
        );
    }
}
