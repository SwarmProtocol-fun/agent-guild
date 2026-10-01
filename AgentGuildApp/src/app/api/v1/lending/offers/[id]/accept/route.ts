/**
 * POST /api/v1/lending/offers/[id]/accept
 * Body: { agentId, orgId, amountUsd? }
 * Borrower accepts a lender's standing offer, creating a pending solo loan on
 * the offer's terms reserved for that lender to fund. Still subject to the
 * accepting agent's own eligibility gate (amount/rate band).
 */
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireOrgMember, getWalletAddress, unauthorized, forbidden } from "@/lib/auth-guard";
import { acceptLoanOffer } from "@/lib/lending/lending-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    let body: { agentId?: string; orgId?: string; amountUsd?: number };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { agentId, orgId } = body;
    if (!agentId || !orgId) {
        return NextResponse.json({ error: "agentId and orgId are required" }, { status: 400 });
    }

    const orgAuth = await requireOrgMember(req, orgId);
    if (!orgAuth.ok) return orgAuth.status === 401 ? unauthorized(orgAuth.error) : forbidden(orgAuth.error);

    const agentSnap = await adminDb().collection("agents").doc(agentId).get();
    if (!agentSnap.exists) {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    if (agentSnap.data()?.orgId !== orgId) {
        return forbidden("Agent does not belong to this organization");
    }

    try {
        const loan = await acceptLoanOffer({
            offerId: id,
            agentId,
            orgId,
            amountUsd: body.amountUsd,
            requestedByWallet: getWalletAddress(req) || undefined,
        });
        return NextResponse.json({ loan }, { status: 201 });
    } catch (error) {
        console.error("[lending/offers/accept] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to accept offer" }, { status: 400 });
    }
}
