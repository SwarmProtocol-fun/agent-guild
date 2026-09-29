/**
 * GET /api/v1/credit/agents/:id/explanations
 *
 * Get a human-readable explanation of an agent's credit score factors.
 * Analyzes HCS event history to build factor breakdown.
 *
 * Auth: platform admin or authenticated agent (agents can read own explanation).
 */

import { NextRequest } from "next/server";
import { requirePlatformAdminOrAgent, unauthorized } from "@/lib/auth-guard";
import { getCreditExplanation } from "@/lib/credit-service";
import { rateLimit } from "@/app/api/v1/rate-limit";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;

    // Rate limit (more conservative — this is an expensive computation)
    const limited = await rateLimit(`explanation:${id}`);
    if (limited) return limited;

    // Auth
    const auth = await requirePlatformAdminOrAgent(request, `GET:/v1/credit/agents/${id}/explanations`);
    if (!auth.ok) return unauthorized(auth.error);

    if (auth.agent && auth.agent.agentId !== id) {
        return Response.json(
            { error: "Agents can only read their own credit explanation" },
            { status: 403 },
        );
    }

    try {
        const explanation = await getCreditExplanation(id);
        if (!explanation) {
            return Response.json({ error: "Agent not found" }, { status: 404 });
        }

        return Response.json(explanation);
    } catch (error) {
        console.error("[credit/agents/:id/explanations] Error:", error);
        return Response.json(
            { error: "Failed to generate credit explanation", details: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}
