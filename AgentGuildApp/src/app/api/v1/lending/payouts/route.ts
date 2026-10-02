/**
 * GET /api/v1/lending/payouts?mine=1  — payouts owed to / by the caller's wallet
 * GET /api/v1/lending/payouts         — platform admin: every pending payout
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, getWalletAddress, unauthorized, forbidden } from "@/lib/auth-guard";
import { listPendingPayouts, listPayoutsForWallet } from "@/lib/lending/payouts";

export async function GET(req: NextRequest) {
    try {
        if (req.nextUrl.searchParams.get("mine")) {
            const wallet = getWalletAddress(req);
            if (!wallet) return unauthorized("Missing x-wallet-address header");
            return NextResponse.json(await listPayoutsForWallet(wallet));
        }

        const admin = requirePlatformAdmin(req);
        if (!admin.ok) return forbidden(admin.error || "Platform admin required");
        return NextResponse.json({ payouts: await listPendingPayouts() });
    } catch (error) {
        console.error("[lending/payouts] GET error:", error);
        return NextResponse.json({ error: "Failed to load payouts" }, { status: 500 });
    }
}
