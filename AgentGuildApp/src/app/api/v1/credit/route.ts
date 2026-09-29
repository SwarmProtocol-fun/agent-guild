/**
 * POST /api/v1/credit
 *
 * Update an agent's credit and trust scores — both in Firestore and on-chain
 * (AgentRegistry on Hedera Testnet).
 *
 * Body: { agentId, creditScore, trustScore, reason? }
 *   creditScore — 300–900
 *   trustScore  — 0–100
 *   reason      — optional audit log text
 */
import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import {
    HEDERA_CONTRACTS,
    HEDERA_GAS_LIMIT,
} from "@/lib/swarm-contracts";
import { AGENT_REGISTRY_ABI } from "@/lib/swarm-contracts";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { recordCreditAudit } from "@/lib/credit-audit-log";
import { fireWebhooks } from "@/lib/credit-webhooks";
import { invalidateCache } from "@/lib/credit-cache";

const HEDERA_RPC = "https://testnet.hashio.io/api";

/** Update credit scores on-chain via platform wallet (Hedera Testnet) */
async function updateCreditOnChain(
    agentAddr: string,
    creditScore: number,
    trustScore: number,
): Promise<{ txHash?: string }> {
    const privateKey = process.env.HEDERA_PLATFORM_KEY;
    if (!privateKey || !agentAddr) return {};

    try {
        const provider = new ethers.JsonRpcProvider(HEDERA_RPC);
        const wallet = new ethers.Wallet(privateKey, provider);
        const registry = new ethers.Contract(
            HEDERA_CONTRACTS.AGENT_REGISTRY,
            AGENT_REGISTRY_ABI,
            wallet,
        );
        const tx = await registry.updateCredit(agentAddr, creditScore, trustScore, {
            gasLimit: HEDERA_GAS_LIMIT,
            type: 0,
        });
        const receipt = await tx.wait();
        return { txHash: receipt.hash };
    } catch (err) {
        console.error("updateCredit on Hedera AgentRegistry failed:", err);
        return {};
    }
}

export async function POST(request: NextRequest) {
    // Auth: platform admin only — arbitrary credit writes are privileged
    const auth = requirePlatformAdmin(request);
    if (!auth.ok) return forbidden(auth.error);

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

    // Load agent from Firestore
    const agentRef = adminDb().collection("agents").doc(agentId);
    const agentSnap = await agentRef.get();
    if (!agentSnap.exists) {
        return Response.json({ error: "Agent not found" }, { status: 404 });
    }

    const agentData = agentSnap.data()!;
    const asn = (agentData.asn as string) || "";

    const creditScore = body.creditScore as number | undefined;
    const trustScore = body.trustScore as number | undefined;
    const reason = (body.reason as string) || undefined;

    if (creditScore === undefined || trustScore === undefined) {
        return Response.json(
            { error: "creditScore and trustScore are required" },
            { status: 400 },
        );
    }

    if (creditScore < 300 || creditScore > 900) {
        return Response.json({ error: "creditScore must be 300-900" }, { status: 400 });
    }
    if (trustScore < 0 || trustScore > 100) {
        return Response.json({ error: "trustScore must be 0-100" }, { status: 400 });
    }

    const previousCredit = (agentData.creditScore as number) || 680;
    const previousTrust = (agentData.trustScore as number) || 50;

    // Update Firestore
    await agentRef.update({
        creditScore,
        trustScore,
        lastCreditUpdate: FieldValue.serverTimestamp(),
        ...(reason ? { lastCreditReason: reason } : {}),
    });

    // Record credit audit entry
    recordCreditAudit({
        agentId,
        asn,
        source: "admin",
        performedBy: request.headers.get("x-wallet-address") || "platform-admin",
        creditBefore: previousCredit,
        creditAfter: creditScore,
        trustBefore: previousTrust,
        trustAfter: trustScore,
        reason: reason || "Admin credit override",
    }).catch((err) => console.error("Failed to record credit audit:", err));

    // Invalidate credit cache
    invalidateCache(`credit:${agentId}`);

    // Fire webhooks (non-blocking)
    fireWebhooks(agentId, "score_change", {
        previousCreditScore: previousCredit,
        newCreditScore: creditScore,
        previousTrustScore: previousTrust,
        newTrustScore: trustScore,
        delta: { credit: creditScore - previousCredit, trust: trustScore - previousTrust },
        trigger: "admin_update",
        reason,
    }).catch(err => console.error("[credit] Webhook dispatch error:", err));

    // Update on-chain (Hedera Testnet)
    const onChainResult = await updateCreditOnChain(
        agentData.walletAddress || "",
        creditScore,
        trustScore,
    );

    return Response.json({
        agentId,
        asn,
        creditScore,
        trustScore,
        reason,
        onChain: {
            chain: "hedera-testnet",
            txHash: onChainResult.txHash || null,
        },
    });
}
