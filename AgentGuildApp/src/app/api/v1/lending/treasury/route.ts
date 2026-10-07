/**
 * GET /api/v1/lending/treasury
 * Where to send each lending asset: the Solana treasury (USDC and SOL) and,
 * when configured, the Ethereum treasury (ETH), plus the USDC mint and
 * networks, for clients to show "send to this address" UI. No secret key is
 * ever exposed or held anywhere in this app. `pricesUsd` is best-effort
 * (null when unavailable) and only used for display and USD limits.
 *
 * `treasuryAddress` / `usdcMint` are kept at the top level for older clients.
 */
import { NextResponse } from "next/server";
import { treasuryAddress, usdcMintAddress, lendingCluster } from "@/lib/solana/lending-verify";
import { ethTreasuryAddress, ethLendingNetwork } from "@/lib/ethereum/lending-verify";
import { getUsdPrice } from "@/lib/lending/prices";

export async function GET() {
    try {
        const solanaTreasury = treasuryAddress();
        let eth: { treasuryAddress: string; network: string } | null = null;
        if (process.env.ETH_LENDING_TREASURY_ADDRESS) eth = { treasuryAddress: ethTreasuryAddress(), network: ethLendingNetwork() };
        const [sol, ethPrice] = await Promise.all([getUsdPrice("sol").catch(() => null), eth ? getUsdPrice("eth").catch(() => null) : null]);
        return NextResponse.json({
            treasuryAddress: solanaTreasury,
            usdcMint: usdcMintAddress(),
            solanaCluster: lendingCluster(),
            assets: {
                usdc: { chain: "solana", treasuryAddress: solanaTreasury, mint: usdcMintAddress() },
                sol: { chain: "solana", treasuryAddress: solanaTreasury },
                eth: eth ? { chain: "ethereum", ...eth } : null,
            },
            pricesUsd: { usdc: 1, sol, eth: ethPrice },
        });
    } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "Lending treasury not configured" }, { status: 500 });
    }
}
