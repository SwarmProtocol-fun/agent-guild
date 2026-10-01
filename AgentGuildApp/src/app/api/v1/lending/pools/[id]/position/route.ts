/**
 * GET /api/v1/lending/pools/[id]/position
 * Requires x-wallet-address header. Returns the caller's position in this pool, or null.
 */
import { NextRequest, NextResponse } from "next/server";
import { getWalletAddress, unauthorized } from "@/lib/auth-guard";
import { getPoolPosition } from "@/lib/lending/lending-service";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const wallet = getWalletAddress(req);
    if (!wallet) return unauthorized("Missing x-wallet-address header");

    try {
        const position = await getPoolPosition(id, wallet);
        return NextResponse.json({ position });
    } catch (error) {
        console.error("[lending/pools/position] error:", error);
        return NextResponse.json({ error: "Failed to load position" }, { status: 500 });
    }
}
