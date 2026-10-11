/**
 * On-chain spot flow from DexScreener (free, no key): for the Hyperliquid
 * perps whose real market is a DEX token — memecoins, Solana/Base/Ethereum
 * DeFi — how deep the spot pools are, how much trades there, whether buyers
 * or sellers dominate the last hour, and how far spot sits from the perp.
 * CMC (./cmc.ts) sees every venue's totals; this is the DEX tape itself.
 *
 * Coins are matched by pinned contract address, never by symbol: a symbol
 * search returns dozens of copycat tokens. A coin missing from DEX_TOKENS
 * simply gets no line. Server-only; every reader returns null on failure.
 *
 * Request budget: one /token-pairs/v1 call per coin every CACHE_MS — at most
 * ~25 calls per 2 minutes against DexScreener's 300/min.
 */

const BASE = "https://api.dexscreener.com";
const CACHE_MS = 2 * 60_000;
/** Pools thinner than this are skipped — dust pools quote nonsense prices. */
const MIN_POOL_LIQUIDITY_USD = 10_000;

export interface DexToken {
  chainId: "solana" | "ethereum" | "base";
  address: string;
  /** How many tokens one perp unit is: kPEPE is 1000 PEPE. */
  perpUnits?: number;
}

/** Hyperliquid perp → its canonical DEX token (addresses checked live 2026-10-10). Only coins whose spot trades mainly on-chain. */
export const DEX_TOKENS: Record<string, DexToken> = {
  WIF: { chainId: "solana", address: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  kBONK: { chainId: "solana", address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", perpUnits: 1000 },
  POPCAT: { chainId: "solana", address: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr" },
  FARTCOIN: { chainId: "solana", address: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump" },
  PNUT: { chainId: "solana", address: "2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump" },
  GOAT: { chainId: "solana", address: "CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump" },
  MOODENG: { chainId: "solana", address: "ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY" },
  TRUMP: { chainId: "solana", address: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN" },
  PENGU: { chainId: "solana", address: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv" },
  JUP: { chainId: "solana", address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  JTO: { chainId: "solana", address: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL" },
  PYTH: { chainId: "solana", address: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3" },
  W: { chainId: "solana", address: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ" },
  kPEPE: { chainId: "ethereum", address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", perpUnits: 1000 },
  kFLOKI: { chainId: "ethereum", address: "0xcf0C122c6b73ff809C693DB761e7BaeBe62b6a2E", perpUnits: 1000 },
  kNEIRO: { chainId: "ethereum", address: "0x812Ba41e071C7b7fA4EBcFB62dF5F45f6fA853Ee", perpUnits: 1000 },
  kSHIB: { chainId: "ethereum", address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", perpUnits: 1000 },
  SPX: { chainId: "ethereum", address: "0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C" },
  UNI: { chainId: "ethereum", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984" },
  AAVE: { chainId: "ethereum", address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9" },
  AERO: { chainId: "base", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" },
  BRETT: { chainId: "base", address: "0x532f27101965dd16442E59d40670FaF5eBB142E4" },
  VIRTUAL: { chainId: "base", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" },
};

export interface DexContext {
  /**
   * USD price of one token, liquidity-weighted across pools: DexScreener
   * quotes ~4 significant digits and pools disagree by tens of bps, so one
   * pool's price alone is too coarse to compare with the perp.
   */
  priceUsd: number | null;
  liquidityUsd: number;
  volume1hUsd: number;
  volume24hUsd: number;
  buys1h: number;
  sells1h: number;
  buys5m: number;
  sells5m: number;
  pools: number;
}

type Window = { m5?: number; h1?: number; h6?: number; h24?: number };
export type RawPair = {
  chainId?: string;
  baseToken?: { address?: string };
  priceUsd?: string | null;
  liquidity?: { usd?: number | null } | null;
  volume?: Window | null;
  txns?: { m5?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } } | null;
};

const sameAddress = (chainId: string, a?: string, b?: string) =>
  !!a && !!b && (chainId === "solana" ? a === b : a.toLowerCase() === b.toLowerCase());

/**
 * Sums every pool where `token` is the base token (pools quoting it as the
 * quote token are someone else's market), priced liquidity-weighted. Null when no pool clears
 * MIN_POOL_LIQUIDITY_USD.
 */
export function aggregatePairs(token: DexToken, pairs: RawPair[]): DexContext | null {
  const pools = pairs.filter(
    (p) => p.chainId === token.chainId && sameAddress(token.chainId, p.baseToken?.address, token.address) && (p.liquidity?.usd ?? 0) >= MIN_POOL_LIQUIDITY_USD,
  );
  if (!pools.length) return null;
  const sum = (pick: (p: RawPair) => number | undefined | null) => pools.reduce((s, p) => s + (pick(p) ?? 0), 0);
  const priced = pools.filter((p) => Number(p.priceUsd) > 0);
  const pricedLiquidity = priced.reduce((s, p) => s + p.liquidity!.usd!, 0);
  const price = pricedLiquidity > 0 ? priced.reduce((s, p) => s + Number(p.priceUsd) * p.liquidity!.usd!, 0) / pricedLiquidity : null;
  return {
    priceUsd: price,
    liquidityUsd: sum((p) => p.liquidity?.usd),
    volume1hUsd: sum((p) => p.volume?.h1),
    volume24hUsd: sum((p) => p.volume?.h24),
    buys1h: sum((p) => p.txns?.h1?.buys),
    sells1h: sum((p) => p.txns?.h1?.sells),
    buys5m: sum((p) => p.txns?.m5?.buys),
    sells5m: sum((p) => p.txns?.m5?.sells),
    pools: pools.length,
  };
}

/** Buys share of trades, −1 (all sells) … +1 (all buys); null with no trades. */
function txImbalance(buys: number, sells: number): number | null {
  return buys + sells > 0 ? (buys - sells) / (buys + sells) : null;
}

/**
 * One prompt line — raw numbers, same as the rest of the snapshot.
 * `perpPx` (the Hyperliquid mark) adds how far DEX spot sits from the perp.
 */
export function dexContextLine(d: DexContext | null | undefined, perpPx?: number | null, perpUnits = 1): string | null {
  if (!d) return null;
  const imb1h = txImbalance(d.buys1h, d.sells1h);
  const imb5m = txImbalance(d.buys5m, d.sells5m);
  const spotPerUnit = d.priceUsd != null ? d.priceUsd * perpUnits : null;
  const gapBps = spotPerUnit != null && perpPx ? ((spotPerUnit - perpPx) / perpPx) * 10_000 : null;
  return [
    `dex_liquidity_usd=${Math.round(d.liquidityUsd)}`,
    `dex_volume_1h_usd=${Math.round(d.volume1hUsd)}`,
    `dex_volume_24h_usd=${Math.round(d.volume24hUsd)}`,
    `dex_buys_1h=${d.buys1h} dex_sells_1h=${d.sells1h}`,
    imb1h != null ? `dex_tx_imbalance_1h=${imb1h.toFixed(3)}` : null,
    imb5m != null ? `dex_tx_imbalance_5m=${imb5m.toFixed(3)}` : null,
    gapBps != null ? `dex_spot_vs_perp_bps=${gapBps.toFixed(1)}` : null,
  ].filter(Boolean).join(" ");
}

// ── Fetching (server only) ──────────────────────────────────────────────────

type Fetch = typeof fetch;
/** Per coin: its last good context (null = no pool cleared the bar), kept past CACHE_MS as a fallback. */
const cache = new Map<string, { at: number; value: DexContext | null }>();
const inflight = new Map<string, Promise<DexContext | null>>();

/** Test hook: forget what is cached. */
export function clearDexCache() {
  cache.clear();
  inflight.clear();
}

/** Every pool for one token — /tokens/v1 returns only one pool per token, and not the deepest. */
async function loadCoin(f: Fetch, coin: string): Promise<DexContext | null> {
  const t = DEX_TOKENS[coin];
  const resp = await f(`${BASE}/token-pairs/v1/${t.chainId}/${t.address}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`DexScreener ${coin} returned ${resp.status}`);
  const body = (await resp.json()) as RawPair[] | null;
  return aggregatePairs(t, Array.isArray(body) ? body : []);
}

function coinContext(f: Fetch, coin: string): Promise<DexContext | null> {
  const hit = cache.get(coin);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.value);
  const pending = inflight.get(coin);
  if (pending) return pending;
  const p = loadCoin(f, coin)
    .then((value) => {
      cache.set(coin, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(coin));
  inflight.set(coin, p);
  return p;
}

/**
 * DEX context for each of `coins` (Hyperliquid perp names) that DEX_TOKENS
 * knows, keyed by perp name. One dead coin falls back to its last good value
 * or is left out; null only when every coin failed with nothing cached — never throws.
 */
export async function getDexContexts(coins: string[], f: Fetch = fetch): Promise<Map<string, DexContext> | null> {
  const known = [...new Set(coins)].filter((c) => DEX_TOKENS[c]);
  const out = new Map<string, DexContext>();
  if (!known.length) return out;
  const results = await Promise.allSettled(known.map((c) => coinContext(f, c)));
  let failed = 0;
  results.forEach((r, i) => {
    const coin = known[i];
    if (r.status === "rejected") {
      failed++;
      console.warn("[hyperliquid-dexscreener] fetch failed:", (r.reason as Error)?.message);
    }
    const value = r.status === "fulfilled" ? r.value : cache.get(coin)?.value ?? null;
    if (value) out.set(coin, value);
  });
  return failed === known.length && !out.size ? null : out;
}
