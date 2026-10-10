/**
 * Server side of ./intel.ts: fetches each free data outlet, caches it for as
 * long as it stays useful, and never lets one dead source sink the rest —
 * a failed source is listed in `errors` and its fields come back null.
 *
 * Always reads Hyperliquid mainnet: smart-money and HLP positioning only
 * mean anything there, even for a testnet bot.
 *
 * Request budget: the 39 MB leaderboard is fetched at most hourly and only
 * the chosen addresses are kept; their positions (≈60 clearinghouseState
 * calls, weight 2 each against Hyperliquid's 1200/min) every 10 minutes.
 */
import {
  aggregatePositions,
  pickTraders,
  summarizeLiquidations,
  type CoinIntel,
  type CoinPositioning,
  type LeaderboardRow,
  type MarketIntel,
  type OkxLiquidationDetail,
  type PositionsState,
  type Trader,
} from "./intel";

const HL_INFO = "https://api.hyperliquid.xyz/info";
const HL_LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const HLP_VAULT = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
const OKX = "https://www.okx.com/api/v5";

const MIN = 60_000;
const TTL = {
  leaderboard: 60 * MIN,
  positions: 10 * MIN,
  okx: 5 * MIN,
  okxInstruments: 24 * 60 * MIN,
  fearGreed: 60 * MIN,
  dvol: 15 * MIN,
  premium: MIN,
};

/** Accounts per side of the smart/dumb split. */
const TRADERS_PER_SIDE = 30;

type Fetch = typeof fetch;

const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

/** Cached by key; concurrent callers share one fetch. */
async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = load()
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Test hook: forget everything cached. */
export function clearIntelCache() {
  cache.clear();
  inflight.clear();
}

async function getJson<T>(f: Fetch, url: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  const resp = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`${new URL(url).host} ${resp.status}`);
  return resp.json() as Promise<T>;
}

const hlInfo = <T>(f: Fetch, body: object) =>
  getJson<T>(f, HL_INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Runs `fn` over `items` at most `limit` at a time. */
async function pool<I, O>(items: I[], limit: number, fn: (i: I) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function traders(f: Fetch): Promise<{ smart: Trader[]; dumb: Trader[] }> {
  return cached("leaderboard", TTL.leaderboard, async () => {
    const body = await getJson<{ leaderboardRows: LeaderboardRow[] }>(f, HL_LEADERBOARD, undefined, 45_000);
    return pickTraders(body.leaderboardRows, TRADERS_PER_SIDE);
  });
}

async function positionsOf(f: Fetch, key: string, addresses: string[]): Promise<Record<string, CoinPositioning>> {
  return cached(`positions:${key}`, TTL.positions, async () => {
    const states = await pool(addresses, 8, (user) =>
      hlInfo<PositionsState>(f, { type: "clearinghouseState", user }).catch(() => ({ assetPositions: [] })));
    return aggregatePositions(states);
  });
}

async function hlpPositions(f: Fetch): Promise<Record<string, CoinPositioning>> {
  return cached("positions:hlp", TTL.positions, async () => {
    const vault = await hlInfo<{ relationship?: { data?: { childAddresses?: string[] } } }>(f, { type: "vaultDetails", vaultAddress: HLP_VAULT });
    const children = vault.relationship?.data?.childAddresses ?? [];
    const states = await pool([HLP_VAULT, ...children], 8, (user) =>
      hlInfo<PositionsState>(f, { type: "clearinghouseState", user }).catch(() => ({ assetPositions: [] })));
    return aggregatePositions(states);
  });
}

/** Contract size (coins per contract) of every OKX USDT perp. */
async function okxContractValues(f: Fetch): Promise<Record<string, number>> {
  return cached("okx:instruments", TTL.okxInstruments, async () => {
    const body = await getJson<{ data: { instId: string; ctVal: string }[] }>(f, `${OKX}/public/instruments?instType=SWAP`);
    return Object.fromEntries(body.data.filter((i) => i.instId.endsWith("-USDT-SWAP")).map((i) => [i.instId.replace("-USDT-SWAP", ""), Number(i.ctVal)]));
  });
}

/** Hyperliquid's 1000x coins (kPEPE, kBONK) are plain PEPE/BONK on OKX. */
function okxSymbol(coin: string): string {
  return /^k[A-Z]/.test(coin) ? coin.slice(1) : coin.toUpperCase();
}

async function okxCoin(f: Fetch, coin: string, ctVals: Record<string, number>, now: number) {
  const sym = okxSymbol(coin);
  const ctVal = ctVals[sym];
  if (!ctVal) return { ratio: null, liquidations: null, coveredMs: null };
  return cached(`okx:${sym}`, TTL.okx, async () => {
    const [ratio, liq] = await Promise.all([
      getJson<{ data: [string, string][] }>(f, `${OKX}/rubik/stat/contracts/long-short-account-ratio?ccy=${sym}&period=1H`).catch(() => null),
      getJson<{ data: { details: OkxLiquidationDetail[] }[] }>(f, `${OKX}/public/liquidation-orders?instType=SWAP&uly=${sym}-USDT&state=filled&limit=100`).catch(() => null),
    ]);
    const summary = liq?.data?.[0] ? summarizeLiquidations(liq.data[0].details, ctVal, now) : null;
    return {
      ratio: ratio?.data?.[0] ? Number(ratio.data[0][1]) : null,
      liquidations: summary?.windows ?? null,
      coveredMs: summary?.coveredMs ?? null,
    };
  });
}

async function fearGreed(f: Fetch) {
  return cached("fng", TTL.fearGreed, async () => {
    const body = await getJson<{ data: { value: string; value_classification: string }[] }>(f, "https://api.alternative.me/fng/?limit=1");
    return { value: Number(body.data[0].value), label: body.data[0].value_classification };
  });
}

async function dvol(f: Fetch, currency: "BTC" | "ETH", now: number): Promise<number | null> {
  return cached(`dvol:${currency}`, TTL.dvol, async () => {
    const body = await getJson<{ result: { data: [number, number, number, number, number][] } }>(
      f, `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}&start_timestamp=${now - 3 * 3_600_000}&end_timestamp=${now}&resolution=3600`,
    );
    const last = body.result.data[body.result.data.length - 1];
    return last ? last[4] : null;
  });
}

async function coinbasePremium(f: Fetch): Promise<number | null> {
  return cached("cbprem", TTL.premium, async () => {
    const [cb, mids] = await Promise.all([
      getJson<{ price: string }>(f, "https://api.exchange.coinbase.com/products/BTC-USD/ticker"),
      hlInfo<Record<string, string>>(f, { type: "allMids" }),
    ]);
    const hl = Number(mids.BTC);
    return hl ? ((Number(cb.price) - hl) / hl) * 100 : null;
  });
}

/** Settles a source: its value, or null with the source's name added to errors. */
async function soft<T>(name: string, errors: string[], p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    errors.push(`${name}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Intel for `coins`. Per-coin rows come back in the order asked. Only
 * coins Hyperliquid lists are meaningful; OKX fields are null for coins OKX
 * doesn't list.
 */
export async function getMarketIntel(coins: string[], f: Fetch = fetch): Promise<MarketIntel> {
  const now = Date.now();
  const errors: string[] = [];
  const [picked, hlp, ctVals, fng, btcVol, ethVol, premium] = await Promise.all([
    soft("leaderboard", errors, traders(f)),
    soft("hlp", errors, hlpPositions(f)),
    soft("okx", errors, okxContractValues(f)),
    soft("fear-greed", errors, fearGreed(f)),
    soft("deribit", errors, dvol(f, "BTC", now)),
    soft("deribit-eth", errors, dvol(f, "ETH", now)),
    soft("coinbase", errors, coinbasePremium(f)),
  ]);
  const [smart, dumb] = await Promise.all([
    picked ? soft("smart-money", errors, positionsOf(f, "smart", picked.smart.map((t) => t.address))) : null,
    picked ? soft("dumb-money", errors, positionsOf(f, "dumb", picked.dumb.map((t) => t.address))) : null,
  ]);
  const okx = await Promise.all(coins.map((c) => (ctVals ? okxCoin(f, c, ctVals, now).catch(() => null) : null)));

  const rows: CoinIntel[] = coins.map((coin, i) => ({
    coin,
    smart: smart?.[coin] ?? (smart ? { longUsd: 0, shortUsd: 0, longs: 0, shorts: 0 } : null),
    dumb: dumb?.[coin] ?? (dumb ? { longUsd: 0, shortUsd: 0, longs: 0, shorts: 0 } : null),
    hlp: hlp?.[coin] ?? (hlp ? { longUsd: 0, shortUsd: 0, longs: 0, shorts: 0 } : null),
    okxLongShortRatio: okx[i]?.ratio ?? null,
    liquidations: okx[i]?.liquidations ?? null,
    liquidationsCoveredMs: okx[i]?.coveredMs ?? null,
  }));
  return {
    at: now,
    coins: rows,
    fearGreed: fng,
    dvol: { BTC: btcVol, ETH: ethVol },
    coinbasePremiumPct: premium,
    traders: { smart: picked?.smart.length ?? 0, dumb: picked?.dumb.length ?? 0 },
    errors,
  };
}

/** getMarketIntel, but gives up after `ms` so a slow source can't hold up an AI round. */
export async function getMarketIntelWithin(coins: string[], ms: number, f: Fetch = fetch): Promise<MarketIntel | null> {
  return Promise.race([
    getMarketIntel(coins, f).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}
