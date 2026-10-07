/**
 * POST /api/v1/lending/pools/[id]/withdraw
 * Body: { amount: number }
 * Requires x-wallet-address header. Locks in the amount and shares to burn at
 * today's share price, reserves them so they can't be requested twice or lent
 * out, and opens a pending payout request (cancellable via
 * withdrawals/[requestId]/cancel) — the pool has no
 * signing key to pay it out itself, so a platform admin sends the USDC from
 * the treasury by hand and confirms it (see withdraw/[requestId]/confirm).
 */
import { NextRequest, NextResponse } from "next/server";
import { getWalletAddress, unauthorized } from "@/lib/auth-guard";
import { requestPoolWithdrawal } from "@/lib/lending/lending-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const wallet = getWalletAddress(req);
    if (!wallet) return unauthorized("Missing x-wallet-address header");

    let body: { amount?: number; /** @deprecated use `amount` */ amountUsd?: number };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const amount = Number(body.amount ?? body.amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
    }

    try {
        const request = await requestPoolWithdrawal(id, wallet, amount);
        return NextResponse.json({ request }, { status: 201 });
    } catch (error) {
        console.error("[lending/pools/withdraw] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Withdrawal request failed" }, { status: 400 });
    }
}
