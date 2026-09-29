/**
 * GET /api/v1/credit/agents/:id
 *
 * Get current credit/trust scores, band, and policy tier for an agent.
 *
 * Auth: platform admin or authenticated agent (agents can read own profile).
 */

import { NextRequest } from "next/server";
import { requirePlatformAdminOrAgent, unauthorized } from "@/lib/auth-guard";
import { getCreditProfileCached } from "@/lib/credit-service";
import { rateLimit } from "@/app/api/v1/rate-limit";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;

    // Rate limit
    const limited = await rateLimit(id);
    if (limited) return limited;

    // Auth: platform admin or authenticated agent
    const auth = await requirePlatformAdminOrAgent(request, `GET:/v1/credit/agents/${id}`);
    if (!auth.ok) return unauthorized(auth.error);

    // If agent-authed, verify agent can only read own profile
    if (auth.agent && auth.agent.agentId !== id) {
        return Response.json(
            { error: "Agents can only read their own credit profile" },
            { status: 403 },
        );
    }

    try {
        const profile = await getCreditProfileCached(id);
        if (!profile) {
            return Response.json({ error: "Agent not found" }, { status: 404 });
        }

        return Response.json(profile);
    } catch (error) {
        console.error("[credit/agents/:id] Error:", error);
        return Response.json(
            { error: "Failed to fetch credit profile", details: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}
