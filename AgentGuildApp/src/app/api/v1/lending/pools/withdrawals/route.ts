/**
 * GET /api/v1/lending/pools/withdrawals?mine=1   — the caller's own withdrawal requests
 * GET /api/v1/lending/pools/withdrawals           — platform admin: all pending payouts
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, getWalletAddress, unauthorized, forbidden } from "@/lib/auth-guard";
import { listPendingPoolWithdrawals, listPoolWithdrawalsForWallet } from "@/lib/lending/lending-service";

export async function GET(req: NextRequest) {
    if (req.nextUrl.searchParams.get("mine")) {
        const wallet = getWalletAddress(req);
        if (!wallet) return unauthorized("Missing x-wallet-address header");
        const requests = await listPoolWithdrawalsForWallet(wallet);
        return NextResponse.json({ requests });
    }

    const admin = requirePlatformAdmin(req);
    if (!admin.ok) return forbidden(admin.error || "Platform admin required");

    try {
        const requests = await listPendingPoolWithdrawals();
        return NextResponse.json({ requests });
    } catch (error) {
        console.error("[lending/pools/withdrawals] error:", error);
        return NextResponse.json({ error: "Failed to load withdrawal requests" }, { status: 500 });
    }
}
