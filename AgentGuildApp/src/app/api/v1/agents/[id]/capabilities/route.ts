/**
 * GET /api/v1/agents/:id/capabilities
 *
 * Get resolved capabilities for a specific agent.
 * Merges org mod installations + agent skill assignments + derived
 * capabilities (agent-wallet, matching reported skills).
 *
 * Query params:
 *   org — (required) organization ID
 *
 * Auth: org membership, and the agent must belong to that org.
 */
import { NextRequest } from "next/server";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { getAgent, getAgentCapabilities } from "@/lib/firestore-admin";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id: agentId } = await params;
    const orgId = req.nextUrl.searchParams.get("org");

    if (!orgId) {
        return unauthorized("org parameter and an org member session are required");
    }

    const auth = await requireOrgMember(req, orgId);
    if (!auth.ok) return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);

    try {
        const agent = await getAgent(agentId);
        if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
        if (agent.orgId !== orgId) return forbidden("Agent does not belong to this organization");

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
