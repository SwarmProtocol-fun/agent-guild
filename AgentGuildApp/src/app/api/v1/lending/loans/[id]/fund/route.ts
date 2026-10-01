/**
 * POST /api/v1/lending/loans/[id]/fund
 * Body: { txSig: string }
 * Solo lender commits capital to a pending solo loan request. The lender must
 * have already sent the loan's principal in USDC directly to the borrower's
 * wallet (peer-to-peer — no platform treasury involved in solo loans); this
 * verifies that transfer before activating the loan.
 * Requires x-wallet-address header.
 */
import { NextRequest, NextResponse } from "next/server";
import { getWalletAddress, unauthorized } from "@/lib/auth-guard";
import { fundLoanSolo } from "@/lib/lending/lending-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const wallet = getWalletAddress(req);
    if (!wallet) return unauthorized("Missing x-wallet-address header");

    let body: { txSig?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!body.txSig || typeof body.txSig !== "string") {
        return NextResponse.json({ error: "txSig is required — send the USDC to the borrower's wallet first" }, { status: 400 });
    }

    try {
        const loan = await fundLoanSolo(id, wallet, body.txSig);
        return NextResponse.json({ loan });
    } catch (error) {
        console.error("[lending/loans/fund] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to fund loan" }, { status: 400 });
    }
}
