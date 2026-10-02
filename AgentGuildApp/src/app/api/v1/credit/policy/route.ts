/**
 * GET /api/v1/credit/policy?agentId=xxx
 *
 * Resolve and return the effective credit policy for an agent.
 * Accessible by the agent itself, its org members, or platform admins.
 */

import { NextRequest } from "next/server";
import { resolveAgentPolicy } from "@/lib/agent-policy";
import { adminPolicyLoaders } from "@/lib/credit-policy-settings-admin";
import { requireAgentViewer } from "@/lib/auth-guard";

export async function GET(req: NextRequest) {
    const agentId = req.nextUrl.searchParams.get("agentId");
    if (!agentId) {
        return Response.json({ error: "agentId query parameter is required" }, { status: 400 });
    }

    const viewer = await requireAgentViewer(req, agentId, "GET:/v1/credit/policy");
    if (!viewer.ok) return Response.json({ error: viewer.error }, { status: viewer.status ?? 403 });

    const result = await resolveAgentPolicy(agentId, adminPolicyLoaders);
    if (!result.ok || !result.policy) {
        return Response.json(
            { error: result.error || "Unable to resolve policy" },
            { status: 404 },
        );
    }

    return Response.json({
        agentId,
        tier: result.tier,
        tierLabel: result.policy.label,
        policy: {
            spendingCapUsd: result.policy.spendingCapUsd,
            escrowRatio: result.policy.escrowRatio,
            maxConcurrentTasks: result.policy.maxConcurrentTasks,
            feeMultiplier: result.policy.feeMultiplier,
            sensitiveWorkflowAccess: result.policy.sensitiveWorkflowAccess,
            requiresManualReview: result.policy.requiresManualReview,
            canClaimHighValueJobs: result.policy.canClaimHighValueJobs,
            canClaimUrgentJobs: result.policy.canClaimUrgentJobs,
            canPublishToMarketplace: result.policy.canPublishToMarketplace,
            marketplaceVisibility: result.policy.marketplaceVisibility,
            payoutSpeed: result.policy.payoutSpeed,
            payoutHoldPercent: result.policy.payoutHoldPercent,
            maxDeployedAgents: result.policy.maxDeployedAgents,
            maxOrgMemberships: result.policy.maxOrgMemberships,
        },
        adjustments: result.adjustments,
        overridden: result.overridden,
        resolvedAt: new Date().toISOString(),
    });
}
