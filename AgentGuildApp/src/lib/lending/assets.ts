/**
 * Lending assets. Each pool lends exactly one asset and is accounted in that
 * asset's units: a SOL pool takes SOL deposits, lends SOL, is repaid in SOL
 * and pays lenders back in SOL, so the treasury never holds one asset against
 * a liability in another.
 *
 * Historical naming: ledger amount fields end in `Usd` (principalUsd,
 * availableLiquidityUsd, amountUsd, ...) because lending started USDC-only.
 * They hold amounts in the record's `asset` units — for USDC that is dollars,
 * for SOL it is SOL, for ETH it is ETH. Records without `asset` are USDC.
 * USD values for limits and credit decisions come from prices.ts.
 */

export type LendingAsset = "usdc" | "sol" | "eth";
export type LendingChain = "solana" | "ethereum";

export interface AssetInfo {
    asset: LendingAsset;
    symbol: string;
    chain: LendingChain;
    /** Decimal places the ledger keeps. ETH is kept to gwei — finer than any real loan needs and exact in a JS number. */
    ledgerDecimals: number;
    /** On-chain base-unit decimals (USDC 6, lamports 9, wei 18). */
    chainDecimals: number;
    /** Payouts below this are dust and skipped. */
    dust: number;
}

export const LENDING_ASSETS: Record<LendingAsset, AssetInfo> = {
    usdc: { asset: "usdc", symbol: "USDC", chain: "solana", ledgerDecimals: 6, chainDecimals: 6, dust: 0.01 },
    sol: { asset: "sol", symbol: "SOL", chain: "solana", ledgerDecimals: 9, chainDecimals: 9, dust: 0.00001 },
    eth: { asset: "eth", symbol: "ETH", chain: "ethereum", ledgerDecimals: 9, chainDecimals: 18, dust: 0.000001 },
};

export function isLendingAsset(value: unknown): value is LendingAsset {
    return typeof value === "string" && value in LENDING_ASSETS;
}

/** A record's asset — anything stored before multi-asset pools is USDC. */
export function assetOf(record: { asset?: LendingAsset | null } | null | undefined): LendingAsset {
    return record?.asset ?? "usdc";
}

export function assetInfo(asset: LendingAsset): AssetInfo {
    return LENDING_ASSETS[asset];
}

/** Round to the asset's ledger precision. */
export function roundAmount(asset: LendingAsset, amount: number): number {
    const f = 10 ** LENDING_ASSETS[asset].ledgerDecimals;
    return Math.round(amount * f) / f;
}

/** Round down to ledger precision — for amounts credited, so the ledger never credits more than arrived. */
export function floorAmount(asset: LendingAsset, amount: number): number {
    const f = 10 ** LENDING_ASSETS[asset].ledgerDecimals;
    return Math.floor(amount * f + 1e-6) / f;
}

/** Round up to ledger precision — for amounts quoted as owed, so paying the quote always clears the balance. */
export function ceilAmount(asset: LendingAsset, amount: number): number {
    const f = 10 ** LENDING_ASSETS[asset].ledgerDecimals;
    return Math.ceil(amount * f - 1e-6) / f;
}

/** Ledger amount → on-chain base units (exact for amounts at ledger precision). */
export function toBaseUnits(asset: LendingAsset, amount: number): bigint {
    const { ledgerDecimals, chainDecimals } = LENDING_ASSETS[asset];
    const ledgerUnits = BigInt(Math.round(amount * 10 ** ledgerDecimals));
    return ledgerUnits * BigInt(10) ** BigInt(chainDecimals - ledgerDecimals);
}

/** On-chain base units → ledger amount (for display and records). */
export function fromBaseUnits(asset: LendingAsset, units: bigint): number {
    const { chainDecimals } = LENDING_ASSETS[asset];
    const scale = BigInt(10) ** BigInt(chainDecimals);
    const whole = units / scale;
    const frac = units % scale;
    return Number(whole) + Number(frac) / Number(scale);
}

/** "1,250.00 USDC", "0.5 SOL", "0.0125 ETH". */
export function formatAssetAmount(asset: LendingAsset, amount: number): string {
    const digits = asset === "usdc" ? 2 : asset === "sol" ? 4 : 6;
    return `${amount.toLocaleString(undefined, { minimumFractionDigits: asset === "usdc" ? 2 : 0, maximumFractionDigits: digits })} ${LENDING_ASSETS[asset].symbol}`;
}
