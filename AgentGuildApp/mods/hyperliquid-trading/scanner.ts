/**
 * Cross-market scanner: where the edges are right now, beyond one coin's chart.
 *
 *   - Funding arbitrage: Hyperliquid's `predictedFundings` carries the next
 *     funding rate for each coin on Hyperliquid, Binance and Bybit. Venues
 *     settle on different intervals (HL hourly, CEXs every 4h or 8h), so every
 *     rate is normalised to per-hour and annualised before comparing. A wide
 *     gap means one side gets paid to hold a hedged position.
 *   - Premium: a perp's mark price against its oracle (spot index). A large
 *     premium tends to close and is what funding is charged on.
 *   - Pair spreads (statistical arbitrage): two coins whose returns move
 *     together, with the log-price spread `ln A − β·ln B` stretched far from
 *     its mean. Long the cheap leg and short the rich one, both on Hyperliquid.
 *
 *   - Spot-perp basis (./basis.ts): perps with a Hyperliquid spot market,
 *     their basis and the carry a long-spot / short-perp position collects.
 *   - Order-book imbalance near the mid (./signals.ts).
 *
 * Only the Hyperliquid leg of a cross-venue funding trade is tradeable here;
 * the scanner reports the other venue so an operator can hedge it themselves.
 *
 * Pure and browser-safe: the server fetches, this module computes, the client
 * renders the same rows and the AI Trader quotes them into its prompt.
 */
import type { BasisRow } from "./basis";
import type { Candle } from "./indicators";
import type { Imbalance } from "./signals";

export type FundingVenue = "HlPerp" | "BinPerp" | "BybitPerp";

/** Raw `predictedFundings` entry: [coin, [[venue, {fundingRate, nextFundingTime, fundingIntervalHours?}] | null, ...]]. */
export type PredictedFundingsRaw = [string, ([string, { fundingRate: string; nextFundingTime?: number; fundingIntervalHours?: number } | null] | null)[]][];

export interface VenueFunding {
  venue: FundingVenue;
  /** Funding per hour, as a fraction (0.0001 = 0.01%/h). */
  hourly: number;
  aprPct: number;
}

export interface FundingArb {
  coin: string;
  hl: VenueFunding;
  other: VenueFunding;
  /** |HL − other| annualised, in percent — what the hedged carry earns before fees. */
  spreadAprPct: number;
  /** The Hyperliquid side that collects the spread: short HL when HL pays more. */
  hlSide: "short" | "long";
  volume24hUsd: number | null;
}

export interface PremiumRow {
  coin: string;
  markPx: number;
  oraclePx: number;
  /** (mark − oracle) / oracle, in percent. Positive: perp trades rich. */
  premiumPct: number;
  fundingAprPct: number;
  volume24hUsd: number;
}

export interface PairSpread {
  a: string;
  b: string;
  /** Correlation of the two coins' per-bar log returns. */
  correlation: number;
  /** Hedge ratio: units of B's log price per unit of A's. */
  beta: number;
  /** How many standard deviations the current spread sits from its mean. */
  z: number;
  /** z > 0: A is rich against B — short A, long B. z < 0: the reverse. */
  longLeg: string;
  shortLeg: string;
  bars: number;
}

export interface ScannerMarketRow {
  coin: string;
  markPx: number;
  oraclePx: number;
  fundingRatePct: number;
  volume24hUsd: number;
}

const HOURS_PER_YEAR = 24 * 365;
const VENUES: FundingVenue[] = ["HlPerp", "BinPerp", "BybitPerp"];

export function venueLabel(v: FundingVenue): string {
  return v === "HlPerp" ? "Hyperliquid" : v === "BinPerp" ? "Binance" : "Bybit";
}

/** Normalises one venue's rate to per-hour. Binance/Bybit default to 8h when the interval is missing. */
export function hourlyRate(venue: FundingVenue, rate: number, intervalHours?: number): number {
  const hours = intervalHours && intervalHours > 0 ? intervalHours : venue === "HlPerp" ? 1 : 8;
  return rate / hours;
}

export function parsePredictedFundings(raw: PredictedFundingsRaw): Map<string, VenueFunding[]> {
  const out = new Map<string, VenueFunding[]>();
  for (const entry of raw ?? []) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1])) continue;
    const rows: VenueFunding[] = [];
    for (const v of entry[1]) {
      if (!v || !VENUES.includes(v[0] as FundingVenue) || !v[1]) continue;
      const rate = Number(v[1].fundingRate);
      if (!Number.isFinite(rate)) continue;
      const hourly = hourlyRate(v[0] as FundingVenue, rate, v[1].fundingIntervalHours);
      rows.push({ venue: v[0] as FundingVenue, hourly, aprPct: hourly * HOURS_PER_YEAR * 100 });
    }
    if (rows.length) out.set(entry[0], rows);
  }
  return out;
}

/**
 * Coins where Hyperliquid's funding differs most from another venue's, widest
 * first. Thin markets (under minVolumeUsd of 24h HL volume) and coins absent
 * from a non-empty `volumes` map are dropped — a 300% APR gap on a coin nobody trades can't be filled.
 */
export function findFundingArbs(
  fundings: Map<string, VenueFunding[]>,
  volumes: Map<string, number>,
  opts: { minSpreadAprPct?: number; minVolumeUsd?: number; limit?: number } = {},
): FundingArb[] {
  const minSpread = opts.minSpreadAprPct ?? 10;
  const minVolume = opts.minVolumeUsd ?? 1_000_000;
  const arbs: FundingArb[] = [];
  for (const [coin, rows] of fundings) {
    const hl = rows.find((r) => r.venue === "HlPerp");
    if (!hl) continue;
    const volume = volumes.get(coin) ?? null;
    // With a volume map, a coin missing from it isn't tradeable on Hyperliquid (delisted) — skip it.
    if (volumes.size && volume == null) continue;
    if (volume != null && volume < minVolume) continue;
    let best: VenueFunding | null = null;
    for (const r of rows) {
      if (r.venue === "HlPerp") continue;
      if (!best || Math.abs(hl.hourly - r.hourly) > Math.abs(hl.hourly - best.hourly)) best = r;
    }
    if (!best) continue;
    const spreadAprPct = Math.abs(hl.aprPct - best.aprPct);
    if (spreadAprPct < minSpread) continue;
    arbs.push({ coin, hl, other: best, spreadAprPct, hlSide: hl.hourly > best.hourly ? "short" : "long", volume24hUsd: volume });
  }
  arbs.sort((x, y) => y.spreadAprPct - x.spreadAprPct);
  return arbs.slice(0, opts.limit ?? 15);
}

/** Perps trading furthest from their oracle, by |premium|. */
export function findPremiumOutliers(
  market: ScannerMarketRow[],
  opts: { minAbsPremiumPct?: number; minVolumeUsd?: number; limit?: number } = {},
): PremiumRow[] {
  const minPremium = opts.minAbsPremiumPct ?? 0.1;
  const minVolume = opts.minVolumeUsd ?? 1_000_000;
  return market
    .filter((m) => m.markPx > 0 && m.oraclePx > 0 && m.volume24hUsd >= minVolume)
    .map((m) => ({
      coin: m.coin,
      markPx: m.markPx,
      oraclePx: m.oraclePx,
      premiumPct: ((m.markPx - m.oraclePx) / m.oraclePx) * 100,
      fundingAprPct: (m.fundingRatePct / 100) * HOURS_PER_YEAR * 100,
      volume24hUsd: m.volume24hUsd,
    }))
    .filter((r) => Math.abs(r.premiumPct) >= minPremium)
    .sort((x, y) => Math.abs(y.premiumPct) - Math.abs(x.premiumPct))
    .slice(0, opts.limit ?? 15);
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Closes of `a` and `b` on the bar times they share, oldest first. */
export function alignCloses(a: Candle[], b: Candle[]): { a: number[]; b: number[] } {
  const bByT = new Map(b.map((c) => [c.t, c.c]));
  const outA: number[] = [];
  const outB: number[] = [];
  for (const c of a) {
    const pb = bByT.get(c.t);
    if (pb != null && c.c > 0 && pb > 0) {
      outA.push(c.c);
      outB.push(pb);
    }
  }
  return { a: outA, b: outB };
}

/** Correlation, hedge ratio and spread z-score for one pair. Null when there's too little shared history. */
export function pairSpread(aCoin: string, a: Candle[], bCoin: string, b: Candle[], minBars = 30): PairSpread | null {
  const { a: pa, b: pb } = alignCloses(a, b);
  if (pa.length < minBars) return null;
  const la = pa.map(Math.log);
  const lb = pb.map(Math.log);
  const ra = la.slice(1).map((x, i) => x - la[i]);
  const rb = lb.slice(1).map((x, i) => x - lb[i]);
  const ma = mean(ra);
  const mb = mean(rb);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  if (!(va > 0 && vb > 0)) return null;
  const correlation = cov / Math.sqrt(va * vb);
  const beta = cov / vb;
  const spread = la.map((x, i) => x - beta * lb[i]);
  const m = mean(spread);
  const sd = Math.sqrt(spread.reduce((s, x) => s + (x - m) ** 2, 0) / spread.length);
  if (!(sd > 0)) return null;
  const z = (spread[spread.length - 1] - m) / sd;
  return {
    a: aCoin, b: bCoin, correlation, beta, z,
    longLeg: z > 0 ? bCoin : aCoin,
    shortLeg: z > 0 ? aCoin : bCoin,
    bars: pa.length,
  };
}

/** Every pair in `candles` that moves together (|corr| ≥ minCorrelation), most stretched first. */
export function findPairSpreads(
  candles: Record<string, Candle[]>,
  opts: { minCorrelation?: number; minAbsZ?: number; limit?: number } = {},
): PairSpread[] {
  const minCorr = opts.minCorrelation ?? 0.7;
  const minZ = opts.minAbsZ ?? 0;
  const coins = Object.keys(candles);
  const out: PairSpread[] = [];
  for (let i = 0; i < coins.length; i++) {
    for (let j = i + 1; j < coins.length; j++) {
      const p = pairSpread(coins[i], candles[coins[i]], coins[j], candles[coins[j]]);
      if (p && p.correlation >= minCorr && Math.abs(p.z) >= minZ) out.push(p);
    }
  }
  out.sort((x, y) => Math.abs(y.z) - Math.abs(x.z));
  return out.slice(0, opts.limit ?? 10);
}

export interface ScannerResult {
  fundingArbs: FundingArb[];
  premiums: PremiumRow[];
  pairs: PairSpread[];
  basis?: BasisRow[];
  imbalances?: Imbalance[];
}

const pct = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;

/**
 * The scanner as plain lines for an AI Trader prompt, limited to `coins` when
 * given (the bot can only trade its own basket). Empty when nothing qualifies.
 */
export function scannerSection(result: ScannerResult, coins?: string[]): string {
  const keep = coins ? new Set(coins.map((c) => c.toUpperCase())) : null;
  const inBasket = (c: string) => !keep || keep.has(c.toUpperCase());
  const lines: string[] = [];
  const funding = result.fundingArbs.filter((f) => inBasket(f.coin));
  if (funding.length) {
    lines.push("FUNDING VS OTHER VENUES (annualised %, + = longs pay shorts)");
    lines.push("coin,hyperliquid_apr,other_venue,other_apr,spread_apr,hl_side_that_collects");
    for (const f of funding) {
      lines.push(`${f.coin},${pct(f.hl.aprPct, 1)},${venueLabel(f.other.venue)},${pct(f.other.aprPct, 1)},${f.spreadAprPct.toFixed(1)},${f.hlSide.toUpperCase()}`);
    }
  }
  const premiums = result.premiums.filter((p) => inBasket(p.coin));
  if (premiums.length) {
    if (lines.length) lines.push("");
    lines.push("PERP PREMIUM TO ORACLE (%, + = perp rich)");
    lines.push("coin,premium_pct,funding_apr");
    for (const p of premiums) lines.push(`${p.coin},${pct(p.premiumPct, 3)},${pct(p.fundingAprPct, 1)}`);
  }
  const pairs = result.pairs.filter((p) => inBasket(p.a) && inBasket(p.b));
  if (pairs.length) {
    if (lines.length) lines.push("");
    lines.push("PAIR SPREADS (ln A − beta·ln B; z = standard deviations from its mean)");
    lines.push("a,b,return_correlation,beta,z,cheap_leg,rich_leg");
    for (const p of pairs) lines.push(`${p.a},${p.b},${p.correlation.toFixed(2)},${p.beta.toFixed(3)},${pct(p.z)},${p.longLeg},${p.shortLeg}`);
  }
  const basis = (result.basis ?? []).filter((b) => inBasket(b.coin));
  if (basis.length) {
    if (lines.length) lines.push("");
    lines.push("SPOT-PERP BASIS ON HYPERLIQUID (basis = (perp − spot) / spot)");
    lines.push("coin,spot_token,basis_pct,funding_apr");
    for (const b of basis) lines.push(`${b.coin},${b.spotToken},${pct(b.basisPct, 3)},${pct(b.fundingAprPct, 1)}`);
  }
  const books = (result.imbalances ?? []).filter((b) => inBasket(b.coin));
  if (books.length) {
    if (lines.length) lines.push("");
    lines.push("ORDER BOOK IMBALANCE ((bid − ask) / (bid + ask) depth within the band; + = more bids)");
    lines.push("coin,imbalance,bid_depth_usd,ask_depth_usd,band_pct");
    for (const b of books) lines.push(`${b.coin},${pct(b.imbalance, 3)},${Math.round(b.bidUsd)},${Math.round(b.askUsd)},${b.bandPct}`);
  }
  return lines.join("\n");
}
