/**
 * POST /api/v1/agents/:id/bond
 *
 * Record an agent's anti-sybil bond after the USDC transfer to the lending
 * treasury lands on-chain (verified, replay-guarded — lib/agent-bond.ts).
 * Org owner only. Body: { orgId, txSig, fromWallet }
 */
import { NextRequest } from "next/server";
import { requireOrgAdmin } from "@/lib/auth-guard";
import { adminDb } from "@/lib/firebase-admin";
import { postBond } from "@/lib/agent-bond";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const orgId = typeof body.orgId === "string" ? body.orgId : "";
    const txSig = typeof body.txSig === "string" ? body.txSig.trim() : "";
    const fromWallet = typeof body.fromWallet === "string" ? body.fromWallet.trim() : "";
    if (!orgId || !txSig || !fromWallet) {
        return Response.json({ error: "orgId, txSig and fromWallet are required" }, { status: 400 });
    }

    const auth = await requireOrgAdmin(req, orgId);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });
    const snap = await adminDb().collection("agents").doc(id).get();
    if (!snap.exists || snap.data()!.orgId !== orgId) return Response.json({ error: "Agent not found" }, { status: 404 });

    try {
        const bond = await postBond(id, { txSig, fromWallet });
        return Response.json({ bond });
    } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Bond verification failed" }, { status: 400 });
    }
}
