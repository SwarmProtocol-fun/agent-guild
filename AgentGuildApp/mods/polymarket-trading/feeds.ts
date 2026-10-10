/**
 * Market data the BTC fleet reads besides Polymarket itself:
 *
 *  - BTC candles from Hyperliquid (free; the platform already uses it). 1-minute
 *    bars carry volume and trade count, which the liquidation bots use as the
 *    "elevated tape" check.
 *  - BTC liquidations from OKX's public REST feed. Binance and Bybit block US
 *    servers (451 / CloudFront), OKX doesn't, and Moon Dev measured OKX at a
 *    ~36s median detection lag, inside the 2-minute windows these rules use.
 *  - Big Hyperliquid BTC positions and their liquidation prices, for the
 *    near-liquidation bot. Hyperliquid has no "all positions" endpoint, so the
 *    universe is the largest leaderboard accounts that hold BTC, refreshed a few
 *    times a day (see refreshWhaleUniverse). That is narrower than a paid feed:
 *    a whale outside the top accounts is invisible here.
 *
 * Parsing is pure and exported for tests; fetchers are thin.
 */

const HL_INFO = "https://api.hyperliquid.xyz/info";
const HL_LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const OKX_LIQUIDATIONS = "https://www.okx.com/api/v5/public/liquidation-orders";

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Base volume (BTC). Only on candles from Hyperliquid. */
  v?: number;
  /** Trade count. Only on candles from Hyperliquid. */
  n?: number;
}

export async function hlInfo<T>(body: unknown): Promise<T> {
  const resp = await fetch(HL_INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`Hyperliquid info ${resp.status}`);
  return resp.json() as Promise<T>;
}

export async function btcCandles(interval: "1m" | "5m" | "15m", startTime: number, endTime: number): Promise<Candle[]> {
  const raw = await hlInfo<{ t: number; o: string; h: string; l: string; c: string; v?: string; n?: number }[]>(
    { type: "candleSnapshot", req: { coin: "BTC", interval, startTime, endTime } },
  );
  return raw.map((k) => ({
    t: k.t, o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c),
    ...(k.v != null ? { v: Number(k.v) } : {}), ...(k.n != null ? { n: Number(k.n) } : {}),
  }));
}

// ── Liquidations ────────────────────────────────────────────────────────────

/** One forced close. `side` is whose position died: a long liquidation is forced selling. */
export interface Liquidation {
  ts: number;
  side: "long" | "short";
  usd: number;
  price: number;
  venue: string;
}

/** BTC per contract, by OKX instrument family. Inverse (BTC-USD) contracts are $100 each. */
const OKX_CONTRACTS: { uly: string; usdPerContract: (price: number) => number }[] = [
  { uly: "BTC-USDT", usdPerContract: (price) => 0.01 * price },
  { uly: "BTC-USD", usdPerContract: () => 100 },
];

interface OkxDetail { posSide?: string; side?: string; sz?: string; bkPx?: string; ts?: string; time?: string }

/** OKX `liquidation-orders` → Liquidation[]. posSide long/short when set; in net mode a forced sell is a long. */
export function parseOkxLiquidations(raw: unknown, usdPerContract: (price: number) => number): Liquidation[] {
  const rows = (raw as { data?: { details?: OkxDetail[] }[] })?.data ?? [];
  const out: Liquidation[] = [];
  for (const row of rows) {
    for (const d of row.details ?? []) {
      const price = Number(d.bkPx);
      const sz = Number(d.sz);
      const ts = Number(d.ts ?? d.time);
      if (!(price > 0) || !(sz > 0) || !(ts > 0)) continue;
      const side = d.posSide === "long" || d.posSide === "short" ? d.posSide : d.side === "sell" ? "long" : "short";
      out.push({ ts, side, usd: sz * usdPerContract(price), price, venue: "okx" });
    }
  }
  return out;
}

export async function recentBtcLiquidations(): Promise<Liquidation[]> {
  const lists = await Promise.all(OKX_CONTRACTS.map(async ({ uly, usdPerContract }) => {
    const qs = new URLSearchParams({ instType: "SWAP", uly, state: "filled", limit: "100" });
    const resp = await fetch(`${OKX_LIQUIDATIONS}?${qs}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!resp.ok) throw new Error(`OKX liquidations ${resp.status}`);
    return parseOkxLiquidations(await resp.json(), usdPerContract);
  }));
  return lists.flat().sort((a, b) => a.ts - b.ts);
}

/** Long vs short liquidation USD inside [now − windowMs, now]. */
export function liquidationTotals(liqs: Liquidation[], now: number, windowMs = 120_000): { long: number; short: number; biggest: Liquidation | null } {
  let long = 0, short = 0;
  let biggest: Liquidation | null = null;
  for (const l of liqs) {
    if (l.ts < now - windowMs || l.ts > now) continue;
    if (l.side === "long") long += l.usd; else short += l.usd;
    if (!biggest || l.usd > biggest.usd) biggest = l;
  }
  return { long, short, biggest };
}

// ── Big Hyperliquid BTC positions ───────────────────────────────────────────

export interface WhalePosition {
  address: string;
  side: "long" | "short";
  /** Position value, USD. */
  usd: number;
  liquidationPx: number;
}

interface HlAssetPosition { position?: { coin?: string; szi?: string; positionValue?: string; liquidationPx?: string | null } }

/** The BTC position in a clearinghouseState, if any (and if it can be liquidated). */
export function parseBtcPosition(address: string, state: unknown): WhalePosition | null {
  const list = (state as { assetPositions?: HlAssetPosition[] })?.assetPositions ?? [];
  for (const a of list) {
    const p = a.position;
    if (p?.coin !== "BTC") continue;
    const szi = Number(p.szi);
    const usd = Number(p.positionValue);
    const liquidationPx = Number(p.liquidationPx);
    if (!szi || !(usd > 0) || !(liquidationPx > 0)) return null;
    return { address, side: szi > 0 ? "long" : "short", usd, liquidationPx };
  }
  return null;
}

/** Distance from spot to a position's liquidation price, as a positive % (0 = at liquidation). */
export function liquidationDistancePct(p: WhalePosition, spot: number): number {
  return p.side === "long" ? ((spot - p.liquidationPx) / spot) * 100 : ((p.liquidationPx - spot) / spot) * 100;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export async function btcPositions(addresses: string[]): Promise<WhalePosition[]> {
  const states = await mapLimit(addresses, 12, (user) =>
    hlInfo<unknown>({ type: "clearinghouseState", user }).then((s) => parseBtcPosition(user, s)).catch(() => null));
  return states.filter((p): p is WhalePosition => p !== null);
}

/** Largest accounts by value from Hyperliquid's leaderboard. */
export function topLeaderboardAddresses(raw: unknown, count: number): string[] {
  const rows = (raw as { leaderboardRows?: { ethAddress?: string; accountValue?: string }[] })?.leaderboardRows ?? [];
  return rows
    .filter((r) => typeof r.ethAddress === "string" && Number(r.accountValue) > 0)
    .sort((a, b) => Number(b.accountValue) - Number(a.accountValue))
    .slice(0, count)
    .map((r) => r.ethAddress!.toLowerCase());
}

/**
 * The near-liquidation bot's universe: the top `scan` leaderboard accounts that
 * hold at least `minUsd` of BTC right now. The leaderboard file is ~40 MB, so
 * this runs on its own schedule, not in the minute tick.
 */
export async function refreshWhaleUniverse(scan = 300, minUsd = 50_000): Promise<string[]> {
  const resp = await fetch(HL_LEADERBOARD, { cache: "no-store" });
  if (!resp.ok) throw new Error(`Hyperliquid leaderboard ${resp.status}`);
  const top = topLeaderboardAddresses(await resp.json(), scan);
  const held = await btcPositions(top);
  return held.filter((p) => p.usd >= minUsd).map((p) => p.address);
}
