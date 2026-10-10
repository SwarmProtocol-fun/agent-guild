/**
 * POST /api/v1/agents/:id/bond/refund
 *
 * Retire the agent and queue its bond back to the wallet that posted it
 * (paid out through the lending payout queue). Irreversible — a retired ASN
 * can't reconnect. Org owner only. Body: { orgId }
 */
import { NextRequest } from "next/server";
import { requireOrgAdmin } from "@/lib/auth-guard";
import { adminDb } from "@/lib/firebase-admin";
import { requestBondRefund } from "@/lib/agent-bond";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const orgId = typeof body.orgId === "string" ? body.orgId : "";
    if (!orgId) return Response.json({ error: "orgId is required" }, { status: 400 });

    const auth = await requireOrgAdmin(req, orgId);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });
    const snap = await adminDb().collection("agents").doc(id).get();
    if (!snap.exists || snap.data()!.orgId !== orgId) return Response.json({ error: "Agent not found" }, { status: 404 });

    try {
        return Response.json(await requestBondRefund(id));
    } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Refund failed" }, { status: 400 });
    }
}
