/**
 * The rest of Moon Dev's BTC 5-minute fleet, as pure rules. Same deal as
 * strategies.ts: ideas and published parameters from
 * github.com/moondevonyt/Polymarket-Trading-Bot-Examples-By-Moon-Dev (no
 * license, so no code reused), each returning a decision with a plain-English
 * reason. His README says it plainly: "I have not cracked the 5-minute market."
 * These are experiments with a logbook, and they default to paper.
 *
 * Index convention: every [a, b] pair here is [Up, Down]. The server maps to
 * the market's own outcome order.
 *
 * Timing: the hub ticks about once a minute, Moon Dev's scripts poll every few
 * seconds. Entry windows below are widened a few seconds so a minute tick lands
 * inside them, and resting orders are filled from the real trade tape between
 * ticks (paper.ts restingFillShares), so a quote isn't only "seen" once a minute.
 */

import type { Candle, Liquidation, WhalePosition } from "./feeds";
import { liquidationDistancePct } from "./feeds";

export type FleetBotType = "corridor" | "flip-harvest" | "box-builder" | "spread-maker" | "liq-cascade" | "small-liq" | "near-liq";
export const FLEET_BOT_TYPES: FleetBotType[] = ["corridor", "flip-harvest", "box-builder", "spread-maker", "liq-cascade", "small-liq", "near-liq"];

export type Skip = { action: "skip"; reason: string };
export type Buy = { action: "buy"; outcomeIndex: 0 | 1; limitPrice: number; reason: string; sizeMult?: number };
const skip = (reason: string): Skip => ({ action: "skip", reason });

const px = (n: number) => n.toFixed(2);
const tick = (n: number) => Math.round(n * 100) / 100;
const floorTick = (n: number) => Math.floor(n * 100 + 1e-9) / 100;
const usdK = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}k`);
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;
const sideName = (i: 0 | 1) => (i === 0 ? "Up" : "Down");

// ── Shared volatility measures ──────────────────────────────────────────────

const MINUTE = 60_000;

/**
 * "ATR4": mean high−low of the window's first four 1-minute bars (Moon Dev's
 * coin-flip gate). Early in a window fewer than four have closed, so it uses
 * what has (two at least), else the last four closed bars before now.
 */
export function windowAtr4(bars: Candle[], windowStartMs: number, now: number): number {
  const closed = bars.filter((b) => b.t + MINUTE <= now);
  const inWindow = closed.filter((b) => b.t >= windowStartMs).slice(0, 4);
  const use = inWindow.length >= 2 ? inWindow : closed.slice(-4);
  return use.length ? use.reduce((s, b) => s + (b.h - b.l), 0) / use.length : 0;
}

/** Median ATR4 across the 5-minute windows in `bars` (the flip harvester's vol regime line). */
export function medianWindowAtr4(bars: Candle[], windowMs = 5 * MINUTE): number {
  const byWindow = new Map<number, Candle[]>();
  for (const b of bars) {
    const w = Math.floor(b.t / windowMs) * windowMs;
    byWindow.set(w, [...(byWindow.get(w) ?? []), b]);
  }
  const atrs = [...byWindow.values()]
    .filter((list) => list.length >= 4)
    .map((list) => list.sort((a, b) => a.t - b.t).slice(0, 4).reduce((s, b) => s + (b.h - b.l), 0) / 4)
    .sort((a, b) => a - b);
  if (!atrs.length) return 0;
  const mid = Math.floor(atrs.length / 2);
  return atrs.length % 2 ? atrs[mid] : (atrs[mid - 1] + atrs[mid]) / 2;
}

/** Wilder-free ATR14: mean true range of the 14 one-minute bars closed by `endMs`. */
export function atr14(bars: Candle[], endMs: number): number {
  const closed = bars.filter((b) => b.t + MINUTE <= endMs).sort((a, b) => a.t - b.t).slice(-15);
  if (closed.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < closed.length; i++) {
    const b = closed[i], prev = closed[i - 1].c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev)));
  }
  return trs.reduce((s, x) => s + x, 0) / trs.length;
}

/** Cushion over ATR4: how many "typical minutes" spot sits from the strike. ≤ 0.2 is a coin flip. */
export function coa(spot: number, strike: number, atr4: number): number {
  return atr4 > 0 ? Math.abs(spot - strike) / atr4 : Infinity;
}

/** The trailing side (the "dog"): Up when BTC is below the strike, Down when above, none on a dead tie. */
export function dogSide(spot: number, strike: number): 0 | 1 | null {
  if (spot === strike) return null;
  return spot < strike ? 0 : 1;
}

/** Last closed 1-minute bar's volume vs the mean of the `lookback` bars before it. */
export function volumeRatio(bars: Candle[], now: number, lookback = 20): number {
  const closed = bars.filter((b) => b.t + MINUTE <= now && b.v != null).sort((a, b) => a.t - b.t);
  if (closed.length < lookback + 1) return 0;
  const last = closed[closed.length - 1].v!;
  const base = closed.slice(-lookback - 1, -1).reduce((s, b) => s + b.v!, 0) / lookback;
  return base > 0 ? last / base : 0;
}

// ── Corridor collector (15-minute + 5-minute pair) ──────────────────────────
// Buy the 15m window's leader + the opposite side of the 5m window that shares
// its close. At least one leg always wins ($1 floor); when the close lands
// between the two opens, both do ($2). Acts once, in the first 90s of the 15m
// window's final third, only in the lead zone where the corridor hit 41% of
// the time in Moon Dev's 52-week study, and only when the pair costs less than
// fair value minus an edge buffer.

export interface CorridorParams {
  minLeadBps: number;
  maxLeadBps: number;
  minLeadAtr: number;
  edge: number;
  ask5Cap: number;
  ask15Cap: number;
  /** Act between these offsets into the 15m window (ms). */
  actFromMs: number;
  actUntilMs: number;
}

export const CORRIDOR_DEFAULTS: CorridorParams = {
  minLeadBps: 5, maxLeadBps: 30, minLeadAtr: 1, edge: 0.08, ask5Cap: 0.55, ask15Cap: 0.93, actFromMs: 600_000, actUntilMs: 690_000,
};

/** P(close lands in the corridor) by 10-minute lead size in bps, from Moon Dev's published table. */
export const CORRIDOR_TABLE: [number, number, number][] = [
  [0, 2, 0.072], [2, 5, 0.219], [5, 10, 0.326], [10, 15, 0.405], [15, 20, 0.44], [20, 30, 0.464], [30, 50, 0.497],
];

export function corridorProbability(leadBps: number): number {
  for (const [lo, hi, p] of CORRIDOR_TABLE) if (leadBps >= lo && leadBps < hi) return p;
  return CORRIDOR_TABLE[CORRIDOR_TABLE.length - 1][2];
}

export type CorridorDecision =
  | Skip
  | { action: "pair"; lead15: 0 | 1; opp5: 0 | 1; limit15: number; limit5: number; fair: number; reason: string };

export function evaluateCorridor(input: {
  elapsed15Ms: number;
  /** BTC at the 15m window's open and at its 10-minute mark (the 5m window's open). */
  p0: number;
  p10: number;
  atr14: number;
  ask15: [number | null, number | null];
  ask5: [number | null, number | null];
  params: CorridorParams;
}): CorridorDecision {
  const { elapsed15Ms, p0, p10, atr14: atr, ask15, ask5, params } = input;
  if (elapsed15Ms < params.actFromMs || elapsed15Ms > params.actUntilMs) {
    return skip(`Acts ${secs(params.actFromMs)}–${secs(params.actUntilMs)} into the 15m window (now ${secs(elapsed15Ms)})`);
  }
  if (!(p0 > 0) || !(p10 > 0) || !(atr > 0)) return skip("Waiting on BTC price data");
  const lead = Math.abs(p10 - p0);
  const leadBps = (lead / p0) * 10_000;
  const leadAtr = lead / atr;
  const lead15: 0 | 1 = p10 >= p0 ? 0 : 1;
  const opp5: 0 | 1 = lead15 === 0 ? 1 : 0;
  const zone = `lead ${leadBps.toFixed(1)}bps (${leadAtr.toFixed(1)}× ATR14)`;
  if (leadBps < params.minLeadBps || leadBps > params.maxLeadBps) return skip(`${zone}: outside the ${params.minLeadBps}–${params.maxLeadBps}bps zone`);
  if (leadAtr < params.minLeadAtr) return skip(`${zone}: needs ≥ ${params.minLeadAtr}× ATR14`);
  const a15 = ask15[lead15], a5 = ask5[opp5];
  if (a15 == null || a5 == null) return skip(`${zone}, but a leg has no ask`);
  if (a15 > params.ask15Cap) return skip(`15m ${sideName(lead15)} ask ${px(a15)} is above the ${px(params.ask15Cap)} cap`);
  if (a5 > params.ask5Cap) return skip(`5m ${sideName(opp5)} ask ${px(a5)} is above the ${px(params.ask5Cap)} cap (a coin flip)`);
  const p = corridorProbability(leadBps);
  const fair = 1 + p;
  const sum = a15 + a5;
  if (sum > fair - params.edge + 1e-9) {
    return skip(`${zone} → corridor ${(p * 100).toFixed(0)}%, fair $${fair.toFixed(2)}; pair costs $${sum.toFixed(2)} > $${(fair - params.edge).toFixed(2)}`);
  }
  return {
    action: "pair", lead15, opp5, limit15: a15, limit5: a5, fair,
    reason: `${zone} → corridor ${(p * 100).toFixed(0)}%, fair $${fair.toFixed(2)}; 15m ${sideName(lead15)} ${px(a15)} + 5m ${sideName(opp5)} ${px(a5)} = $${sum.toFixed(2)}`,
  };
}

// ── Flip harvester (underdog entry, sell the touch) ─────────────────────────
// In the last minute of a coin-flip window, buy the trailing side cheap; then
// rest a sell at 62¢. Dogs touch the lead far more often than they win, and
// Moon Dev's breakeven for selling the touch is 59.5¢. High-vol touches fade,
// so sell everything; low-vol touches stick, so sell half and hold half.
// Researched in his repo, never built there.

export interface FlipParams {
  /** Enter with between these many ms left in the window. */
  entryMaxRemainingMs: number;
  entryMinRemainingMs: number;
  maxCoa: number;
  maxCushionBps: number;
  minAsk: number;
  maxAsk: number;
  exitPrice: number;
  highVolSellPct: number;
  lowVolSellPct: number;
}

export const FLIP_DEFAULTS: FlipParams = {
  entryMaxRemainingMs: 65_000, entryMinRemainingMs: 5_000, maxCoa: 0.2, maxCushionBps: 1.5, minAsk: 0.22, maxAsk: 0.45,
  exitPrice: 0.62, highVolSellPct: 1, lowVolSellPct: 0.5,
};

export function evaluateFlipEntry(input: {
  remainingMs: number;
  spot: number;
  strike: number;
  atr4: number;
  asks: [number | null, number | null];
  params: FlipParams;
}): Buy | Skip {
  const { remainingMs, spot, strike, atr4, asks, params } = input;
  if (remainingMs > params.entryMaxRemainingMs || remainingMs < params.entryMinRemainingMs) {
    return skip(`Enters with ${secs(params.entryMaxRemainingMs)}–${secs(params.entryMinRemainingMs)} left (${secs(remainingMs)} left)`);
  }
  const dog = dogSide(spot, strike);
  if (dog == null) return skip("BTC is exactly on the strike: no underdog");
  const c = coa(spot, strike, atr4);
  const cushionBps = (Math.abs(spot - strike) / spot) * 10_000;
  if (c > params.maxCoa) return skip(`Not a coin flip: cushion ${c.toFixed(2)}× ATR4 (needs ≤ ${params.maxCoa})`);
  if (cushionBps > params.maxCushionBps) return skip(`Cushion ${cushionBps.toFixed(2)}bps (needs ≤ ${params.maxCushionBps}bps)`);
  const ask = asks[dog];
  if (ask == null) return skip(`${sideName(dog)} (the dog) has no ask`);
  if (ask < params.minAsk) return skip(`${sideName(dog)} ask ${px(ask)} is below ${px(params.minAsk)}: cheap dogs lose`);
  if (ask > params.maxAsk) return skip(`${sideName(dog)} ask ${px(ask)} is above ${px(params.maxAsk)}`);
  return {
    action: "buy", outcomeIndex: dog, limitPrice: params.maxAsk,
    reason: `Coin flip (cushion ${c.toFixed(2)}× ATR4, ${cushionBps.toFixed(2)}bps); dog ${sideName(dog)} at ${px(ask)}`,
  };
}

/** How much of the filled dog to rest a sell on, by volatility regime. */
export function flipExitPlan(atr4: number, medianAtr4: number, params: FlipParams): { regime: "high" | "low"; fraction: number; price: number } {
  const regime = medianAtr4 > 0 && atr4 >= medianAtr4 ? "high" : "low";
  return { regime, fraction: regime === "high" ? params.highVolSellPct : params.lowVolSellPct, price: params.exitPrice };
}

// ── Box builder (two-sided maker) ───────────────────────────────────────────
// Rest bids on BOTH Up and Down early in a window with a wide book, summing to
// ≤ 94¢: a filled pair redeems for $1 whatever BTC does. After one leg fills,
// chase the other only up to a locked ≥3¢ box (or take its ask for ≥1¢). A
// stranded leg is held only when it's comfortably winning at T-90.

export interface BoxParams {
  armMinAskSum: number;
  bidSumCap: number;
  completeMakerCap: number;
  completeTakerCap: number;
  quoteUntilMs: number;
  bailoutRemainingMs: number;
  cancelRemainingMs: number;
  repriceBehind: number;
  minCoaHold: number;
}

export const BOX_DEFAULTS: BoxParams = {
  armMinAskSum: 1.03, bidSumCap: 0.94, completeMakerCap: 0.97, completeTakerCap: 0.99,
  quoteUntilMs: 150_000, bailoutRemainingMs: 90_000, cancelRemainingMs: 10_000, repriceBehind: 0.02, minCoaHold: 1,
};

/** Best bids on both sides, each strictly under its ask, trimmed so the pair sums to ≤ the cap. */
export function boxQuotes(bids: [number | null, number | null], asks: [number, number], cap: number): [number, number] | null {
  const q = [0, 1].map((i) => {
    const bid = bids[i] ?? asks[i] - 0.05;
    return floorTick(Math.min(bid, asks[i] - 0.01));
  }) as [number, number];
  let excess = tick(q[0] + q[1] - cap);
  while (excess > 1e-9) {
    const hi = q[0] >= q[1] ? 0 : 1;
    q[hi] = tick(q[hi] - 0.01);
    excess = tick(excess - 0.01);
  }
  return q[0] >= 0.01 && q[1] >= 0.01 ? q : null;
}

export function evaluateBoxArm(input: {
  elapsedMs: number;
  asks: [number | null, number | null];
  bids: [number | null, number | null];
  params: BoxParams;
}): Skip | { action: "quote"; prices: [number, number]; reason: string } {
  const { elapsedMs, asks, bids, params } = input;
  if (elapsedMs > params.quoteUntilMs) return skip(`No new boxes after ${secs(params.quoteUntilMs)} into the window`);
  if (asks[0] == null || asks[1] == null) return skip("A side has no ask");
  const sum = asks[0] + asks[1];
  if (sum < params.armMinAskSum - 1e-9) return skip(`Book is tight (asks sum ${px(sum)} < ${px(params.armMinAskSum)}): lowball bids would only catch losers`);
  const prices = boxQuotes(bids, [asks[0], asks[1]], params.bidSumCap);
  if (!prices) return skip("No room for two bids under the cap");
  return { action: "quote", prices, reason: `Asks sum ${px(sum)}; bidding Up ${px(prices[0])} + Down ${px(prices[1])} = ${px(prices[0] + prices[1])}` };
}

/** One leg filled at p1: how to finish the box on the other side. */
export function evaluateBoxCompletion(input: {
  p1: number;
  otherAsk: number | null;
  otherBestBid: number | null;
  currentBid: number;
  params: BoxParams;
}): { action: "take"; limitPrice: number; reason: string } | { action: "rebid"; price: number; reason: string } | { action: "wait"; reason: string } {
  const { p1, otherAsk, otherBestBid, currentBid, params } = input;
  const takerMax = tick(params.completeTakerCap - p1);
  if (otherAsk != null && otherAsk <= takerMax + 1e-9) {
    return { action: "take", limitPrice: takerMax, reason: `Other side's ask ${px(otherAsk)} ≤ ${px(takerMax)}: lifting it locks ≥ ${px(1 - p1 - otherAsk)}/box` };
  }
  const makerMax = floorTick(params.completeMakerCap - p1);
  let target = Math.min(makerMax, otherAsk != null ? otherAsk - 0.01 : makerMax);
  if (otherBestBid != null) target = Math.min(target, Math.max(currentBid, otherBestBid + 0.01));
  target = floorTick(target);
  if (target > currentBid + 1e-9) return { action: "rebid", price: target, reason: `Raising the other bid to ${px(target)} (cap ${px(makerMax)} keeps ≥ 3¢ locked)` };
  return { action: "wait", reason: `Other bid ${px(currentBid)} is at its cap` };
}

/** T-90 with one leg: keep it only if it's winning by ≥ minCoaHold typical minutes. */
export function evaluateBoxBailout(input: { heldIndex: 0 | 1; spot: number; strike: number; atr4: number; params: BoxParams }): { action: "hold" | "cut"; reason: string } {
  const { heldIndex, spot, strike, atr4, params } = input;
  const winning = heldIndex === 0 ? spot > strike : spot < strike;
  const c = coa(spot, strike, atr4);
  if (winning && c >= params.minCoaHold) return { action: "hold", reason: `Stranded ${sideName(heldIndex)} is winning by ${c.toFixed(1)}× ATR4: holding` };
  return { action: "cut", reason: `Stranded ${sideName(heldIndex)} is ${winning ? `only ${c.toFixed(1)}× ATR4 ahead` : "losing"}: selling at the bid` };
}

// ── Spread-harvest maker ────────────────────────────────────────────────────
// When a coin-flip window's book goes wide (asks sum ≥ $1.10), rest one bid
// inside the hole on the underdog at best bid + 1¢, banded 40–48¢, never
// crossing. Pull it the moment the flip breaks or the spread collapses.

export interface SpreadParams {
  quoteMaxRemainingMs: number;
  quoteMinRemainingMs: number;
  maxCoa: number;
  minAskSum: number;
  minBid: number;
  maxBid: number;
  cancelCoa: number;
  cancelAskSum: number;
}

export const SPREAD_DEFAULTS: SpreadParams = {
  quoteMaxRemainingMs: 125_000, quoteMinRemainingMs: 30_000, maxCoa: 0.4, minAskSum: 1.1, minBid: 0.4, maxBid: 0.48, cancelCoa: 0.6, cancelAskSum: 1.05,
};

export function evaluateSpreadQuote(input: {
  remainingMs: number;
  spot: number;
  strike: number;
  atr4: number;
  asks: [number | null, number | null];
  bids: [number | null, number | null];
  params: SpreadParams;
}): Skip | { action: "quote"; outcomeIndex: 0 | 1; price: number; reason: string } {
  const { remainingMs, spot, strike, atr4, asks, bids, params } = input;
  if (remainingMs > params.quoteMaxRemainingMs || remainingMs < params.quoteMinRemainingMs) {
    return skip(`Quotes with ${secs(params.quoteMaxRemainingMs)}–${secs(params.quoteMinRemainingMs)} left (${secs(remainingMs)} left)`);
  }
  const c = coa(spot, strike, atr4);
  if (c > params.maxCoa) return skip(`Not a coin flip: cushion ${c.toFixed(2)}× ATR4 (needs ≤ ${params.maxCoa})`);
  if (asks[0] == null || asks[1] == null) return skip("A side has no ask");
  const sum = asks[0] + asks[1];
  if (sum < params.minAskSum - 1e-9) return skip(`Book isn't wide: asks sum ${px(sum)} < ${px(params.minAskSum)}`);
  const dog = dogSide(spot, strike) ?? (asks[0] <= asks[1] ? 0 : 1);
  const dogAsk = asks[dog]!;
  const price = floorTick(Math.min(params.maxBid, Math.max(params.minBid, (bids[dog] ?? params.minBid - 0.01) + 0.01)));
  if (price >= dogAsk - 1e-9) return skip(`${sideName(dog)} bid ${px(price)} would cross its ask ${px(dogAsk)}`);
  return { action: "quote", outcomeIndex: dog, price, reason: `Wide coin flip (asks sum ${px(sum)}, cushion ${c.toFixed(2)}× ATR4); resting ${sideName(dog)} ${px(price)}` };
}

/** Why a resting spread quote must come down now, or null to leave it. */
export function spreadCancelReason(input: { spot: number; strike: number; atr4: number; asks: [number | null, number | null]; params: SpreadParams }): string | null {
  const { spot, strike, atr4, asks, params } = input;
  const c = coa(spot, strike, atr4);
  if (c > params.cancelCoa) return `Flip broke (cushion ${c.toFixed(2)}× ATR4 > ${params.cancelCoa})`;
  if (asks[0] != null && asks[1] != null && asks[0] + asks[1] < params.cancelAskSum) return `Spread collapsed (asks sum ${px(asks[0] + asks[1])} < ${px(params.cancelAskSum)})`;
  return null;
}

// ── Liquidation bots ────────────────────────────────────────────────────────

export interface LiqFlow {
  long: number;
  short: number;
}

/** The dominant liquidated side, if one side is at least `ratio`× the other. Longs liquidated = forced selling = Down. */
export function dominantLiquidations(flow: LiqFlow, ratio: number): { side: "long" | "short"; usd: number; direction: 0 | 1 } | null {
  const side = flow.long >= flow.short ? "long" : "short";
  const usd = Math.max(flow.long, flow.short);
  const other = Math.min(flow.long, flow.short);
  if (!(usd > 0) || other * ratio > usd) return null;
  return { side, usd, direction: side === "long" ? 1 : 0 };
}

// Liquidation cascade chaser: ≥ $10k of one-sided BTC liquidations in the
// last 2 minutes, the window already moving ≥ 0.15% that way on heavy volume,
// and the cascade side still priced 50–85¢ in the window's first 3 minutes.
// Taker entry (the stink-bid entry is what lost money), hold to resolution.

export interface CascadeParams {
  minLiqUsd: number;
  oneSidedRatio: number;
  minMovePct: number;
  minVolRatio: number;
  minAsk: number;
  maxAsk: number;
  entryUntilMs: number;
}

export const CASCADE_DEFAULTS: CascadeParams = { minLiqUsd: 10_000, oneSidedRatio: 2, minMovePct: 0.15, minVolRatio: 3, minAsk: 0.5, maxAsk: 0.85, entryUntilMs: 185_000 };

export function evaluateLiqCascade(input: {
  elapsedMs: number;
  spot: number;
  strike: number;
  flow: LiqFlow;
  volRatio: number;
  asks: [number | null, number | null];
  params: CascadeParams;
}): Buy | Skip {
  const { elapsedMs, spot, strike, flow, volRatio, asks, params } = input;
  if (elapsedMs > params.entryUntilMs) return skip(`Only in the window's first ${secs(params.entryUntilMs)}`);
  const dom = dominantLiquidations(flow, params.oneSidedRatio);
  if (!dom || dom.usd < params.minLiqUsd) {
    return skip(`Liquidations last 2m: longs ${usdK(flow.long)}, shorts ${usdK(flow.short)}; needs ≥ ${usdK(params.minLiqUsd)} one-sided`);
  }
  const movePct = ((spot - strike) / strike) * 100;
  const aligned = dom.direction === 1 ? -movePct : movePct;
  if (aligned < params.minMovePct) return skip(`${usdK(dom.usd)} of ${dom.side}s liquidated, but BTC moved ${movePct.toFixed(3)}% (needs ${params.minMovePct}% ${sideName(dom.direction).toLowerCase()})`);
  if (volRatio < params.minVolRatio) return skip(`Cascade setup, but volume is ${volRatio.toFixed(1)}× normal (needs ${params.minVolRatio}×)`);
  const ask = asks[dom.direction];
  if (ask == null) return skip(`${sideName(dom.direction)} has no ask`);
  if (ask < params.minAsk) return skip(`${sideName(dom.direction)} ask ${px(ask)} < ${px(params.minAsk)}: the market disagrees with the cascade`);
  if (ask > params.maxAsk) return skip(`${sideName(dom.direction)} ask ${px(ask)} > ${px(params.maxAsk)}: the fee eats the edge`);
  return {
    action: "buy", outcomeIndex: dom.direction, limitPrice: params.maxAsk,
    reason: `${usdK(dom.usd)} of ${dom.side}s liquidated, BTC ${movePct.toFixed(3)}% on ${volRatio.toFixed(1)}× volume; ${sideName(dom.direction)} at ${px(ask)}`,
  };
}

// Small-liquidation continuation: the $25k–$500k tier, where the continuation
// side is still cheap (30–45¢) with 1–4 minutes left. ≥ $100k bursts size up
// 1.5×; ≥ $500k is the cascade bot's trade, so this one skips it.

export interface SmallLiqParams {
  minLiqUsd: number;
  maxLiqUsd: number;
  kickerUsd: number;
  kickerMult: number;
  oneSidedRatio: number;
  minAsk: number;
  maxAsk: number;
  minRemainingMs: number;
  maxRemainingMs: number;
}

export const SMALL_LIQ_DEFAULTS: SmallLiqParams = {
  minLiqUsd: 25_000, maxLiqUsd: 500_000, kickerUsd: 100_000, kickerMult: 1.5, oneSidedRatio: 1, minAsk: 0.3, maxAsk: 0.45, minRemainingMs: 60_000, maxRemainingMs: 245_000,
};

export function evaluateSmallLiq(input: { remainingMs: number; flow: LiqFlow; asks: [number | null, number | null]; params: SmallLiqParams }): Buy | Skip {
  const { remainingMs, flow, asks, params } = input;
  if (remainingMs < params.minRemainingMs || remainingMs > params.maxRemainingMs) {
    return skip(`Enters with ${secs(params.maxRemainingMs)}–${secs(params.minRemainingMs)} left (${secs(remainingMs)} left)`);
  }
  const dom = dominantLiquidations(flow, params.oneSidedRatio);
  if (!dom || dom.usd < params.minLiqUsd) return skip(`Liquidations last 2m: longs ${usdK(flow.long)}, shorts ${usdK(flow.short)}; needs ≥ ${usdK(params.minLiqUsd)}`);
  if (dom.usd >= params.maxLiqUsd) return skip(`${usdK(dom.usd)} burst is the cascade bot's trade (≥ ${usdK(params.maxLiqUsd)})`);
  const ask = asks[dom.direction];
  if (ask == null) return skip(`${sideName(dom.direction)} has no ask`);
  if (ask < params.minAsk || ask > params.maxAsk) return skip(`${sideName(dom.direction)} ask ${px(ask)} outside ${px(params.minAsk)}–${px(params.maxAsk)}`);
  const kicker = dom.usd >= params.kickerUsd;
  return {
    action: "buy", outcomeIndex: dom.direction, limitPrice: params.maxAsk, sizeMult: kicker ? params.kickerMult : 1,
    reason: `${usdK(dom.usd)} of ${dom.side}s liquidated; continuation ${sideName(dom.direction)} at ${px(ask)}${kicker ? ` (≥ ${usdK(params.kickerUsd)}: ${params.kickerMult}× size)` : ""}`,
  };
}

// Near-liquidation trigger: ARM when a ≥ $100k BTC position sits within 0.5% of
// its liquidation price (the closest one sets the side); FIRE only after
// someone on that same side is actually liquidated for ≥ $5k in the last 2
// minutes. Long pile near liq → forced selling → Down. Hold to expiry.

export interface NearLiqParams {
  minWhaleUsd: number;
  maxDistancePct: number;
  minTriggerUsd: number;
  triggerWindowMs: number;
  maxAsk: number;
}

export const NEAR_LIQ_DEFAULTS: NearLiqParams = { minWhaleUsd: 100_000, maxDistancePct: 0.5, minTriggerUsd: 5_000, triggerWindowMs: 120_000, maxAsk: 0.9 };

export function nearLiqArm(whales: WhalePosition[], spot: number, params: NearLiqParams): { whale: WhalePosition; distancePct: number; count: number } | null {
  const qualifying = whales
    .filter((w) => w.usd >= params.minWhaleUsd)
    .map((w) => ({ whale: w, distancePct: liquidationDistancePct(w, spot) }))
    .filter((x) => x.distancePct >= 0 && x.distancePct <= params.maxDistancePct)
    .sort((a, b) => a.distancePct - b.distancePct);
  return qualifying.length ? { ...qualifying[0], count: qualifying.length } : null;
}

export function evaluateNearLiq(input: {
  now: number;
  spot: number;
  whales: WhalePosition[];
  liquidations: Liquidation[];
  asks: [number | null, number | null];
  params: NearLiqParams;
}): Buy | Skip {
  const { now, spot, whales, liquidations, asks, params } = input;
  const arm = nearLiqArm(whales, spot, params);
  if (!arm) return skip(`Not armed: no BTC position ≥ ${usdK(params.minWhaleUsd)} within ${params.maxDistancePct}% of liquidation (${whales.length} watched)`);
  const { whale, distancePct } = arm;
  const direction: 0 | 1 = whale.side === "long" ? 1 : 0;
  const armed = `Armed: ${usdK(whale.usd)} ${whale.side.toUpperCase()} ${distancePct.toFixed(2)}% from liq $${whale.liquidationPx.toFixed(0)}`;
  const domino = liquidations
    .filter((l) => l.side === whale.side && l.ts >= now - params.triggerWindowMs && l.ts <= now && l.usd >= params.minTriggerUsd)
    .sort((a, b) => b.usd - a.usd)[0];
  if (!domino) return skip(`${armed}; waiting for a ≥ ${usdK(params.minTriggerUsd)} ${whale.side} liquidation`);
  const ask = asks[direction];
  if (ask == null) return skip(`${armed}, triggered, but ${sideName(direction)} has no ask`);
  if (ask > params.maxAsk) return skip(`${armed}, triggered, but ${sideName(direction)} ask ${px(ask)} > ${px(params.maxAsk)}`);
  return {
    action: "buy", outcomeIndex: direction, limitPrice: params.maxAsk,
    reason: `${armed}; ${usdK(domino.usd)} ${domino.side} liquidated on ${domino.venue} → ${sideName(direction)} at ${px(ask)}`,
  };
}
