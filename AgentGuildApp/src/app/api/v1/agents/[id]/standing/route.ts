/**
 * GET /api/v1/agents/:id/standing?org=<orgId>
 *
 * An agent's anti-sybil standing for the dashboard: provisional status and
 * what's left to clear it, its bond, and where/how much to send to post one.
 * Org members only.
 */
import { NextRequest } from "next/server";
import { requireOrgMember } from "@/lib/auth-guard";
import { adminDb } from "@/lib/firebase-admin";
import { evaluateStanding, agentBondUsd, ownerAgentQuota } from "@/lib/agent-standing";
import { treasuryAddress } from "@/lib/solana/lending-verify";
import { isOwnerHumanVerified } from "@/lib/human-verification";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const orgId = req.nextUrl.searchParams.get("org");
    if (!orgId) return Response.json({ error: "?org= is required" }, { status: 400 });
    const auth = await requireOrgMember(req, orgId);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

    const snap = await adminDb().collection("agents").doc(id).get();
    const data = snap.data();
    if (!snap.exists || data!.orgId !== orgId) return Response.json({ error: "Agent not found" }, { status: 404 });

    const ownerWallet = (data!.ownerWallet as string | undefined) ?? null;
    const humanVerified = ownerWallet ? await isOwnerHumanVerified(ownerWallet) : false;
    let treasury: string | null = null;
    try {
        treasury = treasuryAddress();
    } catch {
        // Treasury not configured on this deployment — bond posting unavailable.
    }

    return Response.json({
        standing: evaluateStanding(data!),
        bond: data!.bond ?? null,
        retiredAt: data!.retiredAt ?? null,
        bondRequiredUsd: agentBondUsd(),
        bondTreasury: treasury,
        ownerWallet,
        ownerHumanVerified: humanVerified,
        ownerQuota: ownerAgentQuota(humanVerified),
    });
}
