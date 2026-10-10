/**
 * POST /api/v1/lending/loans/[id]/disburse
 * Platform admin only. Body: { txSig }.
 * The admin must have already sent the loan's principal in USDC from the
 * treasury to the borrower's wallet by hand. This verifies that transfer,
 * then flips the loan from "pending_disbursement" to "active" and starts its
 * interest clock. `from: "payout"` instead verifies a transfer from the
 * platform payout wallet — for reconciling an automatic payout that went out
 * but never confirmed (see lib/lending/auto-disburse.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { confirmLoanDisbursement, getLoan } from "@/lib/lending/lending-service";
import { payoutWalletAddress } from "@/lib/lending/auto-disburse";
import { assetOf } from "@/lib/lending/assets";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const admin = requirePlatformAdmin(req);
    if (!admin.ok) return forbidden(admin.error || "Platform admin required");

    let body: { txSig?: string; from?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!body.txSig || typeof body.txSig !== "string") {
        return NextResponse.json({ error: "txSig is required" }, { status: 400 });
    }

    try {
        let fromWallet: string | undefined;
        if (body.from === "payout") {
            const pending = await getLoan(id);
            fromWallet = (pending && payoutWalletAddress(assetOf(pending))) || undefined;
            if (!fromWallet) return NextResponse.json({ error: "No payout wallet is configured for this loan's chain" }, { status: 400 });
        }
        const loan = await confirmLoanDisbursement(id, body.txSig, { fromWallet });
        return NextResponse.json({ loan });
    } catch (error) {
        console.error("[lending/loans/disburse] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to confirm disbursement" }, { status: 400 });
    }
}
