/**
 * POST /api/v1/lending/offers/[id]/withdraw
 * Lender pulls an open offer off the marketplace before anyone accepts it.
 * Requires x-wallet-address header matching the offer's lender.
 */
import { NextRequest, NextResponse } from "next/server";
import { getWalletAddress, unauthorized } from "@/lib/auth-guard";
import { withdrawLoanOffer } from "@/lib/lending/lending-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const wallet = getWalletAddress(req);
    if (!wallet) return unauthorized("Missing x-wallet-address header");

    try {
        const offer = await withdrawLoanOffer(id, wallet);
        return NextResponse.json({ offer });
    } catch (error) {
        console.error("[lending/offers/withdraw] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to withdraw offer" }, { status: 400 });
    }
}
