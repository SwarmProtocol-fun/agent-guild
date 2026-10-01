/**
 * POST /api/v1/lending/loans/[id]/disburse
 * Platform admin only. Body: { txSig }.
 * The admin must have already sent the loan's principal in USDC from the
 * treasury to the borrower's wallet by hand. This verifies that transfer,
 * then flips the loan from "pending_disbursement" to "active" and starts its
 * interest clock.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { confirmLoanDisbursement } from "@/lib/lending/lending-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const admin = requirePlatformAdmin(req);
    if (!admin.ok) return forbidden(admin.error || "Platform admin required");

    let body: { txSig?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!body.txSig || typeof body.txSig !== "string") {
        return NextResponse.json({ error: "txSig is required" }, { status: 400 });
    }

    try {
        const loan = await confirmLoanDisbursement(id, body.txSig);
        return NextResponse.json({ loan });
    } catch (error) {
        console.error("[lending/loans/disburse] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to confirm disbursement" }, { status: 400 });
    }
}
