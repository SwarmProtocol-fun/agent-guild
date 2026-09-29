/**
 * GET /api/v1/credit/agents/:id/policy-tier
 *
 * Get the current policy tier, constraints, and enforcement summary for an agent.
 * Includes what actions the agent is allowed/denied and why.
 *
 * Auth: platform admin or authenticated agent (agents can read own policy tier).
 */

import { NextRequest } from "next/server";
import { requirePlatformAdminOrAgent, unauthorized } from "@/lib/auth-guard";
import { getPolicyTier } from "@/lib/credit-service";
import { getEnforcementSummary } from "@/lib/credit-enforcement";
import { rateLimit } from "@/app/api/v1/rate-limit";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;

    // Rate limit
    const limited = await rateLimit(id);
    if (limited) return limited;

    // Auth
    const auth = await requirePlatformAdminOrAgent(request, `GET:/v1/credit/agents/${id}/policy-tier`);
    if (!auth.ok) return unauthorized(auth.error);

    if (auth.agent && auth.agent.agentId !== id) {
        return Response.json(
            { error: "Agents can only read their own policy tier" },
            { status: 403 },
        );
    }

    try {
        const [policyTier, enforcement] = await Promise.all([
            getPolicyTier(id),
            getEnforcementSummary(id),
        ]);

        if (!policyTier) {
            return Response.json({ error: "Agent not found" }, { status: 404 });
        }

        return Response.json({
            ...policyTier,
            enforcement,
        });
    } catch (error) {
        console.error("[credit/agents/:id/policy-tier] Error:", error);
        return Response.json(
            { error: "Failed to fetch policy tier", details: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}
