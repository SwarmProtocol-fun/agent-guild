/**
 * POST /api/v1/credit/task-complete
 *
 * Records a task completion for an agent:
 *   - Increments credit score by +5 (capped at 900)
 *   - Increments trust score by +1 (capped at 100)
 *   - Updates Firestore
 *   - Calls updateCredit on the Solana AgentGuild program
 *
 * Body: { agentId, volumeUsd? }
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { updateCreditOnChain as updateCreditOnSolana } from "@/lib/solana/platform";
import { requirePlatformAdminOrAgent, unauthorized } from "@/lib/auth-guard";
import { recordCreditAudit } from "@/lib/credit-audit-log";
import { fireWebhooks } from "@/lib/credit-webhooks";
import { invalidateCache } from "@/lib/credit-cache";

/** Update credit scores on-chain via the platform authority (Solana AgentGuild program) */
async function updateCreditOnChain(
    agentAddr: string,
    creditScore: number,
    trustScore: number,
): Promise<{ txHash?: string }> {
    const result = await updateCreditOnSolana(agentAddr, creditScore, trustScore);
    return { txHash: result.txSignature };
}

export async function POST(request: NextRequest) {
    // Auth: platform admin or authenticated agent
    const auth = await requirePlatformAdminOrAgent(request, "POST:/v1/credit/task-complete");
    if (!auth.ok) return unauthorized(auth.error);

    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const agentId = body.agentId as string | undefined;
    if (!agentId) {
        return Response.json({ error: "agentId is required" }, { status: 400 });
    }

    // If agent-authed, verify the agent can only record completions for itself
    if (auth.agent && auth.agent.agentId !== agentId) {
        return Response.json({ error: "Agents can only record their own task completions" }, { status: 403 });
    }

    // Load agent from Firestore
    const agentRef = adminDb().collection("agents").doc(agentId);
    const agentSnap = await agentRef.get();
    if (!agentSnap.exists) {
        return Response.json({ error: "Agent not found" }, { status: 404 });
    }

    const agentData = agentSnap.data()!;
    const asn = (agentData.asn as string) || "";

    // Bump credit score: +5 per task, capped at 900
    const currentCredit = (agentData.creditScore as number) || 680;
    const currentTrust = (agentData.trustScore as number) || 50;
    const newCredit = Math.min(currentCredit + 5, 900);
    // Bump trust: +1 per task, capped at 100
    const newTrust = Math.min(currentTrust + 1, 100);

    // Update Firestore
    await agentRef.update({
        creditScore: newCredit,
        trustScore: newTrust,
        lastCreditUpdate: FieldValue.serverTimestamp(),
    });

    // Record credit audit entry (non-blocking)
    recordCreditAudit({
        agentId,
        asn,
        source: "auto",
        creditBefore: currentCredit,
        creditAfter: newCredit,
        trustBefore: currentTrust,
        trustAfter: newTrust,
        reason: "Task completion",
        eventType: "task_complete",
    }).catch((err) => console.error("Failed to record credit audit:", err));

    // Invalidate credit cache
    invalidateCache(`credit:${agentId}`);

    // Fire webhooks (non-blocking)
    fireWebhooks(agentId, "score_change", {
        previousCreditScore: currentCredit,
        newCreditScore: newCredit,
        previousTrustScore: currentTrust,
        newTrustScore: newTrust,
        delta: { credit: newCredit - currentCredit, trust: newTrust - currentTrust },
        trigger: "task_complete",
    }).catch(err => console.error("[credit/task-complete] Webhook dispatch error:", err));

    // ── Credit Policy: Fee multiplier + tier re-resolution ──
    let feeMultiplier = 1.0;
    let resolvedTier: string | undefined;
    try {
        const { resolveAgentPolicy } = await import("@/lib/agent-policy");
        const { calculateFeeWithMultiplier } = await import("@/lib/credit-policy");
        const { getCreditPolicyConfig, recordPolicyEvent } = await import("@/lib/credit-policy-settings");

        const config = await getCreditPolicyConfig();
        const policyResult = await resolveAgentPolicy(agentId);

        if (config.enforcementEnabled && config.enforceFeeMultipliers && policyResult.ok && policyResult.policy) {
            const fee = calculateFeeWithMultiplier(policyResult.policy, 15); // 15% base platform fee
            feeMultiplier = fee.multiplier;
            resolvedTier = policyResult.tier;

            // Update cached policy tier on agent if score crossed a tier boundary
            await agentRef.update({
                policyTier: policyResult.tier,
                policyTierResolvedAt: FieldValue.serverTimestamp(),
            });

            await recordPolicyEvent({
                agentId,
                orgId: policyResult.orgId || "",
                action: "fee_multiplier_applied",
                tier: policyResult.tier!,
                details: {
                    baseFee: 15,
                    effectiveFee: fee.effectiveFeePercent,
                    multiplier: fee.multiplier,
                    creditScore: newCredit,
                },
            });
        }
    } catch (err) {
        console.warn("[credit/task-complete] Fee multiplier calc failed (non-blocking):", err);
    }

    // Update on-chain credit (Solana)
    const creditResult = await updateCreditOnChain(
        agentData.walletAddress || "",
        newCredit,
        newTrust,
    );

    return Response.json({
        agentId,
        asn,
        creditScore: newCredit,
        trustScore: newTrust,
        delta: { credit: newCredit - currentCredit, trust: newTrust - currentTrust },
        ...(resolvedTier ? { policyTier: resolvedTier, feeMultiplier } : {}),
        onChain: {
            chain: "solana-devnet",
            txHash: creditResult.txHash || null,
        },
    });
}
