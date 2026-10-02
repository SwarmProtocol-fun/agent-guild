/**
 * POST /api/v1/lending/pools/withdrawals/[requestId]/cancel
 * Cancels a pending (unpaid) withdrawal and releases its reserved shares and
 * liquidity back to the pool. Allowed for the wallet that requested it or a
 * platform admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, getWalletAddress, unauthorized, forbidden } from "@/lib/auth-guard";
import { cancelPoolWithdrawal, getPoolWithdrawalRequest } from "@/lib/lending/lending-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
    const { requestId } = await params;

    const request = await getPoolWithdrawalRequest(requestId);
    if (!request) return NextResponse.json({ error: "Withdrawal request not found" }, { status: 404 });

    const admin = requirePlatformAdmin(req);
    if (!admin.ok) {
        const wallet = getWalletAddress(req);
        if (!wallet) return unauthorized("Missing x-wallet-address header");
        if (wallet !== request.walletAddress) return forbidden("Can only cancel your own withdrawal requests");
    }

    try {
        const cancelled = await cancelPoolWithdrawal(requestId);
        return NextResponse.json({ request: cancelled });
    } catch (error) {
        console.error("[lending/pools/withdrawals/cancel] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to cancel withdrawal" }, { status: 400 });
    }
}
