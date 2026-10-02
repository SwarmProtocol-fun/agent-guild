/**
 * GET /api/v1/lending/treasury
 * Public address of the lending treasury (devnet USDC), and the mint, for
 * clients to show "send to this address" UI. No secret key is ever exposed
 * or held anywhere in this app. solUsdRate is non-null only on devnet, where
 * pool deposits may also be paid in native SOL at that rate.
 */
import { NextResponse } from "next/server";
import { treasuryAddress, usdcMintAddress, devnetSolUsdRate } from "@/lib/solana/lending-verify";

export async function GET() {
    try {
        return NextResponse.json({ treasuryAddress: treasuryAddress(), usdcMint: usdcMintAddress(), solUsdRate: devnetSolUsdRate() });
    } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "Lending treasury not configured" }, { status: 500 });
    }
}
