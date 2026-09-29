/**
 * GET /api/v1/credit/policy?agentId=xxx
 *
 * Resolve and return the effective credit policy for an agent.
 * Accessible by the agent itself, its org members, or platform admins.
 */

import { NextRequest } from "next/server";
import { resolveAgentPolicy, requireAgentAuth, requirePlatformAdminOrOrgMember } from "@/lib/auth-guard";
import { logAgentCall } from "@/lib/agent-call-log";

export async function GET(req: NextRequest) {
    const agentId = req.nextUrl.searchParams.get("agentId");
    if (!agentId) {
        return Response.json({ error: "agentId query parameter is required" }, { status: 400 });
    }

    const result = await resolveAgentPolicy(agentId);
    if (!result.ok || !result.policy) {
        return Response.json(
            { error: result.error || "Unable to resolve policy" },
            { status: 404 },
        );
    }

    // Accessible by the agent itself (signed request), its org members, or platform admins.
    // Previously this had no auth check at all — any caller could read any
    // agent's spending caps and fraud-review flags just by knowing/guessing
    // its Firestore doc ID.
    const agentAuth = await requireAgentAuth(req, "GET:/v1/credit/policy");
    const isSelf = agentAuth.ok && agentAuth.agent?.agentId === agentId;
    if (isSelf && agentAuth.agent) {
        logAgentCall({
            agentId: agentAuth.agent.agentId,
            orgId: agentAuth.agent.orgId,
            authMethod: "unknown",
            method: "GET",
            endpoint: "/v1/credit/policy",
        });
    }
    if (!isSelf) {
        const orgAuth = await requirePlatformAdminOrOrgMember(req, result.orgId || "");
        if (!orgAuth.ok) {
            return Response.json(
                { error: orgAuth.error || "Not authorized to view this agent's policy" },
                { status: orgAuth.status || 403 },
            );
        }
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
