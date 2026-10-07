/**
 * GET /api/v1/lending/pools/[id]/deposit-limit
 * Requires x-wallet-address header. How much the caller may deposit right now
 * under the lending beta guards — call this BEFORE sending USDC. Anything sent
 * beyond it is credited as nothing and refunded through the payout queue.
 * Returns { capacity: number | null (null = uncapped), paused, allowed }.
 */
import { NextRequest, NextResponse } from "next/server";
import { getWalletAddress, unauthorized } from "@/lib/auth-guard";
import { getDepositCapacity } from "@/lib/lending/lending-service";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const wallet = getWalletAddress(req);
    if (!wallet) return unauthorized("Missing x-wallet-address header");

    try {
        return NextResponse.json(await getDepositCapacity(id, wallet));
    } catch (error) {
        console.error("[lending/pools/deposit-limit] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load deposit limit" }, { status: 400 });
    }
}
