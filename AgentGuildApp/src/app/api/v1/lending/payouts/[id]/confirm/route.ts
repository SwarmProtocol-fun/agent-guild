/**
 * POST /api/v1/lending/payouts/[id]/confirm
 * Body: { txSig: string }
 * Confirms a queued payout after its sender has sent the USDC on-chain.
 * Treasury payouts: platform admin only. Payouts owed by a user's own wallet
 * (e.g. a solo lender refunding an overpayment): that wallet, or an admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, getWalletAddress, forbidden } from "@/lib/auth-guard";
import { canConfirmPayout, confirmPayout, getPayout } from "@/lib/lending/payouts";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    let body: { txSig?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!body.txSig || typeof body.txSig !== "string") {
        return NextResponse.json({ error: "txSig is required" }, { status: 400 });
    }

    const payout = await getPayout(id);
    if (!payout) return NextResponse.json({ error: "Payout not found" }, { status: 404 });

    if (!canConfirmPayout(payout, getWalletAddress(req), requirePlatformAdmin(req).ok)) {
        return forbidden("Only the payout's sender (or a platform admin, for treasury payouts) can confirm it");
    }

    try {
        return NextResponse.json({ payout: await confirmPayout(id, body.txSig) });
    } catch (error) {
        console.error("[lending/payouts/confirm] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to confirm payout" }, { status: 400 });
    }
}
