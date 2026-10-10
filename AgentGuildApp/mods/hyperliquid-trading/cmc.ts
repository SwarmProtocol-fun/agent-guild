/**
 * Market context from CoinMarketCap (CMC_API_KEY): each coin's rank, market
 * cap, volume across every venue and 7-day change, plus the whole market —
 * BTC/ETH dominance, total cap and CMC's fear & greed index. Hyperliquid's
 * own data only sees Hyperliquid; this is the rest of the market. The AI
 * prompt line leaves CMC's fear & greed out — ./intel.ts already quotes
 * alternative.me's, and two different "fear & greed" numbers would confuse it.
 *
 * Server-only (it reads the key). Optional: with no key every reader returns
 * null and the prompts simply leave the lines out. One batched quotes call
 * covers every Hyperliquid symbol, and everything is cached for CACHE_MS —
 * about 240 credits a day, inside the free plan's ~333.
 */

const BASE = "https://pro-api.coinmarketcap.com";
const CACHE_MS = 30 * 60_000;
/** CMC charges a credit per 100 symbols; stay at a few hundred per call. */
const MAX_SYMBOLS = 300;

export interface CoinContext {
  symbol: string;
  rank: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  change7dPct: number | null;
}

export interface GlobalContext {
  btcDominancePct: number | null;
  ethDominancePct: number | null;
  totalMarketCapUsd: number | null;
  totalMarketCapChange24hPct: number | null;
  fearGreed: { value: number; label: string } | null;
}

/** Hyperliquid perp name → CMC symbol: "kPEPE" (1000 PEPE) → "PEPE". */
export function cmcSymbol(coin: string): string {
  return /^k[A-Z0-9]{2,}$/.test(coin) ? coin.slice(1) : coin.toUpperCase();
}

type RawQuote = { cmc_rank?: number | null; quote?: { USD?: { market_cap?: number | null; volume_24h?: number | null; percent_change_24h?: number | null; percent_change_7d?: number | null } } };

/** Parses /v2/cryptocurrency/quotes/latest. A symbol several coins share resolves to the best-ranked one. */
export function parseQuotes(raw: { data?: Record<string, RawQuote[] | RawQuote> } | null): Map<string, CoinContext> {
  const out = new Map<string, CoinContext>();
  for (const [symbol, entry] of Object.entries(raw?.data ?? {})) {
    const list = (Array.isArray(entry) ? entry : [entry]).filter((x) => x?.quote?.USD);
    const ranked = list.filter((x) => x.cmc_rank != null).sort((a, b) => a.cmc_rank! - b.cmc_rank!);
    const best = ranked[0] ?? list.find((x) => x.quote?.USD?.market_cap) ?? null;
    if (!best) continue;
    const usd = best.quote!.USD!;
    out.set(symbol.toUpperCase(), {
      symbol: symbol.toUpperCase(),
      rank: best.cmc_rank ?? null,
      marketCapUsd: usd.market_cap ?? null,
      volume24hUsd: usd.volume_24h ?? null,
      change24hPct: usd.percent_change_24h ?? null,
      change7dPct: usd.percent_change_7d ?? null,
    });
  }
  return out;
}

export function parseGlobal(
  metrics: { data?: { btc_dominance?: number; eth_dominance?: number; quote?: { USD?: { total_market_cap?: number; total_market_cap_yesterday_percentage_change?: number } } } } | null,
  fng: { data?: { value?: number; value_classification?: string } } | null,
): GlobalContext {
  const usd = metrics?.data?.quote?.USD;
  return {
    btcDominancePct: metrics?.data?.btc_dominance ?? null,
    ethDominancePct: metrics?.data?.eth_dominance ?? null,
    totalMarketCapUsd: usd?.total_market_cap ?? null,
    totalMarketCapChange24hPct: usd?.total_market_cap_yesterday_percentage_change ?? null,
    fearGreed: fng?.data?.value != null ? { value: fng.data.value, label: fng.data.value_classification ?? "" } : null,
  };
}

/** One prompt line for a coin — raw numbers, same as the rest of the snapshot. */
export function coinContextLine(c: CoinContext | null | undefined): string | null {
  if (!c) return null;
  const parts = [
    c.rank != null ? `cmc_rank=${c.rank}` : null,
    c.marketCapUsd ? `market_cap_usd=${Math.round(c.marketCapUsd)}` : null,
    c.volume24hUsd ? `volume_24h_all_venues_usd=${Math.round(c.volume24hUsd)}` : null,
    c.change7dPct != null ? `change_7d_pct=${c.change7dPct.toFixed(2)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

export function globalContextLine(g: GlobalContext | null | undefined): string | null {
  if (!g) return null;
  const parts = [
    g.btcDominancePct != null ? `btc_dominance_pct=${g.btcDominancePct.toFixed(2)}` : null,
    g.ethDominancePct != null ? `eth_dominance_pct=${g.ethDominancePct.toFixed(2)}` : null,
    g.totalMarketCapChange24hPct != null ? `total_market_cap_change_24h_pct=${g.totalMarketCapChange24hPct.toFixed(2)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

// ── Fetching (server only) ──────────────────────────────────────────────────

let quotesCache: { at: number; key: string; value: Map<string, CoinContext> } | null = null;
let globalCache: { at: number; value: GlobalContext } | null = null;

export function cmcConfigured(): boolean {
  return !!process.env.CMC_API_KEY;
}

async function cmcGet<T>(path: string): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { "X-CMC_PRO_API_KEY": process.env.CMC_API_KEY ?? "", Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`CoinMarketCap ${path.split("?")[0]} returned ${resp.status}`);
  return resp.json() as Promise<T>;
}

/**
 * Context for every coin in `universe` (Hyperliquid perp names), keyed by the
 * perp name. Null when no key is set or CMC is unreachable — never throws.
 */
export async function getCoinContexts(universe: string[]): Promise<Map<string, CoinContext> | null> {
  if (!cmcConfigured()) return null;
  const symbols = [...new Set(universe.map(cmcSymbol))].filter((s) => /^[A-Z0-9]{1,15}$/.test(s)).sort().slice(0, MAX_SYMBOLS);
  const key = symbols.join(",");
  let bySymbol = quotesCache && quotesCache.key === key && Date.now() - quotesCache.at < CACHE_MS ? quotesCache.value : null;
  if (!bySymbol) {
    try {
      bySymbol = parseQuotes(await cmcGet(`/v2/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(key)}&skip_invalid=true`));
      quotesCache = { at: Date.now(), key, value: bySymbol };
    } catch (err) {
      console.warn("[hyperliquid-cmc] quotes failed:", (err as Error).message);
      bySymbol = quotesCache?.value ?? null;
      if (!bySymbol) return null;
    }
  }
  const out = new Map<string, CoinContext>();
  for (const coin of universe) {
    const c = bySymbol.get(cmcSymbol(coin));
    if (c) out.set(coin, c);
  }
  return out;
}

/** Whole-market context. Null when no key is set or CMC is unreachable. */
export async function getGlobalContext(): Promise<GlobalContext | null> {
  if (!cmcConfigured()) return null;
  if (globalCache && Date.now() - globalCache.at < CACHE_MS) return globalCache.value;
  try {
    const [metrics, fng] = await Promise.all([
      cmcGet<Parameters<typeof parseGlobal>[0]>("/v1/global-metrics/quotes/latest"),
      cmcGet<Parameters<typeof parseGlobal>[1]>("/v3/fear-and-greed/latest").catch(() => null),
    ]);
    globalCache = { at: Date.now(), value: parseGlobal(metrics, fng) };
    return globalCache.value;
  } catch (err) {
    console.warn("[hyperliquid-cmc] global metrics failed:", (err as Error).message);
    return globalCache?.value ?? null;
  }
}
