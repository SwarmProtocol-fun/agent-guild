/**
 * Pairs arbitrage (statistical arbitrage) — the rule-based bot behind the
 * Scanner's pair-spread rows. No model decides anything:
 *
 *   - Flat: among the bot's coins, take the correlated pair whose spread
 *     `ln A − β·ln B` is furthest from its mean. Past ±entryZ, long the cheap
 *     leg and short the rich leg. Leg sizes are β-weighted so a common move
 *     in both coins nets out.
 *   - In a pair: close both legs together when the spread is back inside
 *     ±exitZ or has crossed zero (the edge is gone), when it runs out to
 *     ±stopZ (the relationship broke), or after maxHoldBars.
 *   - Never one leg alone: a missing leg (stopped, liquidated or closed by
 *     hand) closes the other.
 *
 * Pure and browser-safe: the live bot and the backtest call the same rules.
 */
import type { Candle } from "./indicators";
import { findPairSpreads, pairSpread, type PairSpread } from "./scanner";

export interface PairsParams {
  /** 2 coins = a fixed pair; up to 8 = the bot picks the most stretched pair among them. */
  coins: string[];
  interval: string;
  /** Bars of history the spread's mean and deviation are measured over. */
  lookbackBars: number;
  entryZ: number;
  exitZ: number;
  stopZ: number;
  maxHoldBars: number;
  minCorrelation: number;
}

export const PAIRS_DEFAULTS: Omit<PairsParams, "coins"> = {
  interval: "1h",
  lookbackBars: 168,
  entryZ: 2,
  exitZ: 0.5,
  stopZ: 4,
  maxHoldBars: 72,
  minCorrelation: 0.6,
};

export const PAIRS_MAX_COINS = 8;

/** The pair a bot is in, recorded when both legs open. */
export interface OpenPair {
  a: string;
  b: string;
  longLeg: string;
  shortLeg: string;
  /** Signed z at entry — its sign says which way the spread has to come back. */
  entryZ: number;
  beta: number;
  openedAt: number;
}

export type PairsDecision =
  | { action: "open"; pair: PairSpread; longUsd: number; shortUsd: number; reason: string }
  | { action: "close"; reason: string; z: number | null }
  | { action: "hold"; reason: string; z: number | null };

/**
 * Leg notionals for one pair: the A leg is `sizeUsd`, the B leg is β × that,
 * with β clamped to [0.25, 4] so a noisy estimate can't make one leg tiny or huge.
 */
export function legSizes(pair: Pick<PairSpread, "a" | "b" | "beta" | "longLeg">, sizeUsd: number): { longUsd: number; shortUsd: number } {
  const bUsd = sizeUsd * Math.min(4, Math.max(0.25, Math.abs(pair.beta)));
  return pair.longLeg === pair.a ? { longUsd: sizeUsd, shortUsd: bUsd } : { longUsd: bUsd, shortUsd: sizeUsd };
}

function lastBars(candles: Candle[], n: number): Candle[] {
  return candles.length > n ? candles.slice(-n) : candles;
}

/**
 * One evaluation. `candles` holds each coin's bars (oldest first), `open` the
 * pair the bot is in (or null), `heldLegs` which of its legs still exist on
 * the account, `now` the bar time or clock.
 */
export function decidePairs(
  params: PairsParams,
  candles: Record<string, Candle[]>,
  open: OpenPair | null,
  sizeUsd: number,
  now: number,
  heldLegs?: { long: boolean; short: boolean },
  barMs = 3_600_000,
): PairsDecision {
  if (open) {
    if (heldLegs && (!heldLegs.long || !heldLegs.short)) {
      return { action: "close", z: null, reason: `The ${!heldLegs.long ? open.longLeg : open.shortLeg} leg is gone — closing the other so it isn't held alone.` };
    }
    const a = candles[open.a];
    const b = candles[open.b];
    const p = a && b ? pairSpread(open.a, lastBars(a, params.lookbackBars), open.b, lastBars(b, params.lookbackBars)) : null;
    if (!p) return { action: "hold", z: null, reason: "Not enough shared history to measure the spread this round." };
    const z = p.z;
    const sameSide = Math.sign(z) === Math.sign(open.entryZ);
    if (!sameSide || Math.abs(z) <= params.exitZ) {
      return { action: "close", z, reason: `Spread back to z ${z.toFixed(2)} (entered at ${open.entryZ.toFixed(2)}) — taking the convergence.` };
    }
    if (Math.abs(z) >= params.stopZ) {
      return { action: "close", z, reason: `Spread ran to z ${z.toFixed(2)}, past the ±${params.stopZ} stop — the relationship may have broken.` };
    }
    if (now - open.openedAt >= params.maxHoldBars * barMs) {
      return { action: "close", z, reason: `Held ${params.maxHoldBars} bars without converging (z ${z.toFixed(2)}) — closing.` };
    }
    return { action: "hold", z, reason: `In the pair, z ${z.toFixed(2)} — waiting for it to come back inside ±${params.exitZ}.` };
  }

  const window = Object.fromEntries(params.coins.filter((c) => candles[c]?.length).map((c) => [c, lastBars(candles[c], params.lookbackBars)]));
  const best = findPairSpreads(window, { minCorrelation: params.minCorrelation, limit: 1 })[0];
  if (!best) return { action: "hold", z: null, reason: `No pair has return correlation ≥ ${params.minCorrelation} right now.` };
  if (Math.abs(best.z) < params.entryZ) {
    return { action: "hold", z: best.z, reason: `Most stretched: ${best.a}/${best.b} at z ${best.z.toFixed(2)}, inside ±${params.entryZ}.` };
  }
  if (Math.abs(best.z) >= params.stopZ) {
    return { action: "hold", z: best.z, reason: `${best.a}/${best.b} is at z ${best.z.toFixed(2)}, already past the stop — not entering a broken spread.` };
  }
  return {
    action: "open", pair: best, ...legSizes(best, sizeUsd),
    reason: `${best.a}/${best.b} spread at z ${best.z.toFixed(2)} (correlation ${best.correlation.toFixed(2)}): long ${best.longLeg}, short ${best.shortLeg}.`,
  };
}

/** Validates params from a request body, filling defaults. */
export function buildPairsParams(raw: Record<string, unknown> | undefined, cleanCoin: (c: unknown) => string | null): PairsParams | { error: string } {
  const list = typeof raw?.coins === "string" ? raw.coins.split(/[\s,/]+/).filter(Boolean) : Array.isArray(raw?.coins) ? raw.coins : [];
  const coins = [...new Set(list.map(cleanCoin).filter((c): c is string => c != null))];
  if (coins.length !== list.length) return { error: "every coin must be a perp symbol such as BTC" };
  if (coins.length < 2 || coins.length > PAIRS_MAX_COINS) return { error: `a pairs bot needs 2 to ${PAIRS_MAX_COINS} coins` };
  const num = (k: keyof typeof PAIRS_DEFAULTS) => (raw?.[k] == null || raw[k] === "" ? (PAIRS_DEFAULTS[k] as number) : Number(raw[k]));
  const p: PairsParams = {
    coins,
    interval: typeof raw?.interval === "string" && raw.interval ? raw.interval : PAIRS_DEFAULTS.interval,
    lookbackBars: Math.round(num("lookbackBars")),
    entryZ: num("entryZ"),
    exitZ: num("exitZ"),
    stopZ: num("stopZ"),
    maxHoldBars: Math.round(num("maxHoldBars")),
    minCorrelation: num("minCorrelation"),
  };
  if (!(p.lookbackBars >= 30 && p.lookbackBars <= 1000)) return { error: "lookbackBars must be between 30 and 1000" };
  if (!(p.exitZ >= 0 && p.exitZ < p.entryZ && p.entryZ < p.stopZ)) return { error: "z levels must satisfy 0 ≤ exitZ < entryZ < stopZ" };
  if (!(p.maxHoldBars >= 1)) return { error: "maxHoldBars must be at least 1" };
  if (!(p.minCorrelation > 0 && p.minCorrelation < 1)) return { error: "minCorrelation must be between 0 and 1" };
  return p;
}

export interface PairsBacktestTrade {
  a: string;
  b: string;
  longLeg: string;
  shortLeg: string;
  entryT: number;
  exitT: number;
  entryZ: number;
  exitZ: number | null;
  pnl: number;
  reason: string;
}

/**
 * Replays the rules bar by bar over shared history. Fills at each bar's
 * close, both legs paying `feeRate` on entry and exit. Returns the trades and
 * net PnL in USD for `sizeUsd` on the A leg.
 */
export function backtestPairs(
  params: PairsParams,
  candles: Record<string, Candle[]>,
  sizeUsd: number,
  barMs: number,
  feeRate = 0.00045,
): { trades: PairsBacktestTrade[]; netPnl: number; winRate: number } {
  const base = candles[params.coins[0]] ?? [];
  const times = base.map((c) => c.t);
  const index = Object.fromEntries(params.coins.map((c) => [c, new Map((candles[c] ?? []).map((k, i) => [k.t, i]))]));
  const trades: PairsBacktestTrade[] = [];
  let open: (OpenPair & { longPx: number; shortPx: number; longUsd: number; shortUsd: number }) | null = null;

  const pxAt = (coin: string, t: number) => {
    const i = index[coin]?.get(t);
    return i == null ? null : candles[coin][i].c;
  };
  const upTo = (t: number) => Object.fromEntries(params.coins.map((c) => {
    const i = index[c]?.get(t);
    return [c, i == null ? [] : candles[c].slice(Math.max(0, i + 1 - params.lookbackBars), i + 1)];
  }));

  for (let k = params.lookbackBars; k < times.length; k++) {
    const t = times[k];
    const d = decidePairs(params, upTo(t), open, sizeUsd, t, undefined, barMs);
    if (d.action === "open" && !open) {
      const longPx = pxAt(d.pair.longLeg, t);
      const shortPx = pxAt(d.pair.shortLeg, t);
      if (longPx == null || shortPx == null) continue;
      open = {
        a: d.pair.a, b: d.pair.b, longLeg: d.pair.longLeg, shortLeg: d.pair.shortLeg, entryZ: d.pair.z, beta: d.pair.beta, openedAt: t,
        longPx, shortPx, longUsd: d.longUsd, shortUsd: d.shortUsd,
      };
    } else if (d.action === "close" && open) {
      const longPx = pxAt(open.longLeg, t);
      const shortPx = pxAt(open.shortLeg, t);
      if (longPx == null || shortPx == null) continue;
      const gross = open.longUsd * (longPx / open.longPx - 1) + open.shortUsd * (1 - shortPx / open.shortPx);
      const fees = feeRate * (open.longUsd + open.shortUsd) * 2;
      trades.push({
        a: open.a, b: open.b, longLeg: open.longLeg, shortLeg: open.shortLeg, entryT: open.openedAt, exitT: t,
        entryZ: open.entryZ, exitZ: d.z, pnl: gross - fees, reason: d.reason,
      });
      open = null;
    }
  }
  const netPnl = trades.reduce((s, x) => s + x.pnl, 0);
  return { trades, netPnl, winRate: trades.length ? trades.filter((x) => x.pnl > 0).length / trades.length : 0 };
}
