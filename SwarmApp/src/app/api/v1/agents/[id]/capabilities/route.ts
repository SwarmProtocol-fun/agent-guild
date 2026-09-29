/**
 * GET /api/v1/agents/:id/capabilities
 *
 * Get resolved capabilities for a specific agent.
 * Merges org mod installations + agent skill assignments.
 *
 * Query params:
 *   org — (required) organization ID
 */
import { NextRequest } from "next/server";
import { getAgentCapabilities } from "@/lib/firestore-admin";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id: agentId } = await params;
    const orgId = req.nextUrl.searchParams.get("org");

    if (!orgId) {
        return Response.json({ error: "org parameter is required" }, { status: 400 });
    }

    try {
        const capabilities = await getAgentCapabilities(agentId, orgId);

        return Response.json({
            agentId,
            org: orgId,
            count: capabilities.length,
            capabilities,
        });
    } catch (err) {
        console.error("agents/capabilities error:", err);
        return Response.json({ error: "Internal server error" }, { status: 500 });
    }
}
