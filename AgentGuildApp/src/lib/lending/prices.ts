/**
 * USD prices for lending's dollar-denominated rules — loan caps, eligibility
 * limits, pool TVL and per-wallet deposit caps. Pools themselves are
 * accounted in their own asset (see assets.ts), so a price is never used to
 * decide what anyone is owed; it only sizes what they may open.
 *
 * Median of three keyless public sources (Coinbase, Kraken, CoinGecko).
 * Fails closed: fewer than two answers, or answers more than 3% apart, throws
 * — callers block new risk rather than size it on a bad price. Repayments
 * never need a price.
 */
import type { LendingAsset } from "./assets";

const CACHE_MS = 60_000;
const MAX_SPREAD = 0.03;
const TIMEOUT_MS = 5_000;

type PricedAsset = Exclude<LendingAsset, "usdc">;

const SOURCES: Record<PricedAsset, Array<{ name: string; url: string; parse: (body: unknown) => number }>> = {
    sol: [
        { name: "coinbase", url: "https://api.coinbase.com/v2/prices/SOL-USD/spot", parse: (b) => Number((b as { data: { amount: string } }).data.amount) },
        { name: "kraken", url: "https://api.kraken.com/0/public/Ticker?pair=SOLUSD", parse: (b) => Number((b as { result: Record<string, { c: string[] }> }).result.SOLUSD.c[0]) },
        { name: "coingecko", url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", parse: (b) => Number((b as { solana: { usd: number } }).solana.usd) },
    ],
    eth: [
        { name: "coinbase", url: "https://api.coinbase.com/v2/prices/ETH-USD/spot", parse: (b) => Number((b as { data: { amount: string } }).data.amount) },
        { name: "kraken", url: "https://api.kraken.com/0/public/Ticker?pair=ETHUSD", parse: (b) => Number((b as { result: Record<string, { c: string[] }> }).result.XETHZUSD.c[0]) },
        { name: "coingecko", url: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", parse: (b) => Number((b as { ethereum: { usd: number } }).ethereum.usd) },
    ],
};

const cache = new Map<PricedAsset, { usd: number; at: number }>();

export function medianPrice(prices: number[]): number {
    const sorted = [...prices].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Combine source quotes into one price, or throw if they can't be trusted. */
export function aggregatePrice(asset: LendingAsset, quotes: number[]): number {
    const valid = quotes.filter((p) => Number.isFinite(p) && p > 0);
    if (valid.length < 2) throw new Error(`${asset.toUpperCase()} price unavailable right now (need 2 sources, got ${valid.length}) — try again shortly`);
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    if (max / min - 1 > MAX_SPREAD) throw new Error(`${asset.toUpperCase()} price sources disagree by more than ${MAX_SPREAD * 100}% — try again shortly`);
    return medianPrice(valid);
}

async function fetchQuote(url: string, parse: (body: unknown) => number): Promise<number> {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parse(await res.json());
}

/** USD per one unit of `asset`. USDC is pinned at 1. */
export async function getUsdPrice(asset: LendingAsset): Promise<number> {
    if (asset === "usdc") return 1;
    const hit = cache.get(asset);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.usd;
    const settled = await Promise.allSettled(SOURCES[asset].map((s) => fetchQuote(s.url, s.parse)));
    const usd = aggregatePrice(asset, settled.map((r) => (r.status === "fulfilled" ? r.value : NaN)));
    cache.set(asset, { usd, at: Date.now() });
    return usd;
}

export function clearPriceCache(): void {
    cache.clear();
}
