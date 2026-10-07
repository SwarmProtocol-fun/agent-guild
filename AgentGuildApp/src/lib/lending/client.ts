/**
 * Client-side lending helpers — where to send each asset and how to label it.
 * Mirrors GET /api/v1/lending/treasury; safe to import from components.
 */
import type { LendingAsset } from "./assets";

export interface LendingTreasuryInfo {
    treasuryAddress: string;
    usdcMint: string;
    solanaCluster: "devnet" | "mainnet-beta";
    assets: {
        usdc: { treasuryAddress: string; mint: string };
        sol: { treasuryAddress: string };
        eth: { treasuryAddress: string; network: "mainnet" | "sepolia" } | null;
    };
    pricesUsd: { usdc: number; sol: number | null; eth: number | null };
}

export async function fetchLendingTreasury(): Promise<LendingTreasuryInfo> {
    const res = await fetch("/api/v1/lending/treasury");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Lending treasury not configured");
    return body as LendingTreasuryInfo;
}

export function treasuryAddressFor(info: LendingTreasuryInfo, asset: LendingAsset): string | null {
    return info.assets[asset]?.treasuryAddress ?? null;
}

export const ETH_CHAIN_IDS = { mainnet: 1, sepolia: 11155111 } as const;

/** "USDC (Solana devnet)", "SOL (Solana)", "ETH (Sepolia)". */
export function sendAssetLabel(info: LendingTreasuryInfo | null, asset: LendingAsset): string {
    if (asset === "eth") return info?.assets.eth?.network === "mainnet" ? "ETH (Ethereum)" : "ETH (Sepolia testnet)";
    const cluster = info?.solanaCluster === "mainnet-beta" ? "Solana" : "Solana devnet";
    return `${asset === "sol" ? "SOL" : "USDC"} (${cluster})`;
}
