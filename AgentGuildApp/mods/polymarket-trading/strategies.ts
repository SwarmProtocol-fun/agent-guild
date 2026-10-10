/**
 * Bot rules, as pure functions of a market snapshot. The server's tick
 * gathers the inputs (book, BTC candles, the window clock) and executes what
 * these return; every skip carries a plain-English reason so the bot log
 * records why nothing happened, not just when something did.
 *
 * The two BTC 5-minute bots are ideas from Moon Dev's public Polymarket
 * experiments (github.com/moondevonyt/Polymarket-Trading-Bot-Examples-By-Moon-Dev).
 * That repo has no license, so only the published rules are reused here, not
 * code. Its own README is blunt about it: thin edges, not money printers. The
 * bots default to paper for exactly that reason.
 */

import type { FleetBotType } from "./fleet";

export type BotType = "ai" | "mid-price" | "streak-fade" | "price-trigger" | FleetBotType;

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export type Decision =
  | { action: "buy"; outcomeIndex: number; limitPrice: number; reason: string }
  | { action: "sell"; limitPrice: number | null; reason: string }
  | { action: "skip"; reason: string };

const skip = (reason: string): Decision => ({ action: "skip", reason });

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const px = (n: number) => n.toFixed(2);

// ── Mid-price continuation ──────────────────────────────────────────────────
// Once BTC is clearly through the window's strike, the leading side should
// cost more than ~50¢, but the book lags. Buy the leader only while its ask
// is still in the 40–55¢ band; above that is where the strategy loses, so it
// never chases. Hold to resolution.

export interface MidPriceParams {
  /** BTC must be at least this far through the strike, in percent. */
  minMovePct: number;
  minAsk: number;
  maxAsk: number;
  /** Entries only in the first N ms of the window (i.e. with 5:00 → 2:00 left). */
  entryUntilMs: number;
}

export const MID_PRICE_DEFAULTS: MidPriceParams = { minMovePct: 0.05, minAsk: 0.4, maxAsk: 0.55, entryUntilMs: 180_000 };

export function evaluateMidPrice(input: {
  spot: number;
  strike: number;
  elapsedMs: number;
  remainingMs: number;
  /** Best ask per outcome, indexed [Up, Down]. */
  asks: [number | null, number | null];
  params: MidPriceParams;
}): Decision {
  const { spot, strike, elapsedMs, remainingMs, asks, params } = input;
  if (elapsedMs > params.entryUntilMs) return skip(`Outside the entry window (${clock(remainingMs)} left)`);
  const movePct = ((spot - strike) / strike) * 100;
  const signedMove = `${movePct >= 0 ? "+" : ""}${movePct.toFixed(3)}%`;
  if (Math.abs(movePct) < params.minMovePct) {
    return skip(`BTC ${signedMove} from the strike, needs ±${params.minMovePct}% for a clear leader`);
  }
  const lead = movePct > 0 ? 0 : 1;
  const side = lead === 0 ? "Up" : "Down";
  const ask = asks[lead];
  if (ask == null) return skip(`${side} leads (BTC ${signedMove}) but has no ask`);
  if (ask < params.minAsk) return skip(`${side} ask ${px(ask)} is below the ${px(params.minAsk)}–${px(params.maxAsk)} band`);
  if (ask > params.maxAsk) return skip(`${side} ask ${px(ask)} is above ${px(params.maxAsk)}, too expensive, never chase`);
  return {
    action: "buy",
    outcomeIndex: lead,
    limitPrice: params.maxAsk,
    reason: `BTC ${signedMove} through the strike; ${side} ask ${px(ask)} is in band`,
  };
}

// ── Streak fader ────────────────────────────────────────────────────────────
// After 4+ same-direction 5-minute windows whose last-4-window move stretched
// more than 3× the hourly "ATR" (the mean |open→close| move of the last 12
// five-minute windows), the next window reversed slightly more often than
// chance in Moon Dev's 52-week sample. Without the stretch filter the edge is
// gone, so both conditions are required. Enters early, ≤52¢ only.

export interface StreakParams {
  minStreak: number;
  atrMult: number;
  maxAsk: number;
  entryUntilMs: number;
}

export const STREAK_DEFAULTS: StreakParams = { minStreak: 4, atrMult: 3, maxAsk: 0.52, entryUntilMs: 60_000 };

/** Windows per hour: the ATR averages this many 5-minute moves. */
export const ATR_WINDOWS = 12;

/** Mean absolute open→close move of the last `count` windows. */
export function windowAtr(windows: Candle[], count = ATR_WINDOWS): number {
  const tail = windows.slice(-count);
  return tail.length ? tail.reduce((s, w) => s + Math.abs(w.c - w.o), 0) / tail.length : 0;
}

/** The run of same-direction closed windows ending at the latest one. */
export function trailingStreak(windows: Candle[]): { direction: "up" | "down"; length: number } | null {
  if (!windows.length) return null;
  const last = windows[windows.length - 1];
  const direction = last.c >= last.o ? "up" : "down";
  let length = 0;
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i];
    if ((w.c >= w.o ? "up" : "down") !== direction) break;
    length++;
  }
  return { direction, length };
}

export function evaluateStreak(input: {
  /** Closed BTC 5-minute candles, oldest first, ending with the window just before this one (12+ for a full ATR). */
  windows: Candle[];
  elapsedMs: number;
  asks: [number | null, number | null];
  params: StreakParams;
}): Decision {
  const { windows, elapsedMs, asks, params } = input;
  if (elapsedMs > params.entryUntilMs) return skip(`Past the first ${Math.round(params.entryUntilMs / 1000)}s of the window`);
  const streak = trailingStreak(windows);
  if (!streak) return skip("No BTC history");
  const dir = streak.direction === "up" ? "Up" : "Down";
  if (streak.length < params.minStreak) return skip(`Streak is ${streak.length}× ${dir}, needs ${params.minStreak}+`);
  // Stretch = move over the last minStreak windows vs. the mean move of the last hour's windows.
  const recent = windows.slice(-params.minStreak);
  const move = Math.abs(recent[recent.length - 1].c - recent[0].o);
  const need = params.atrMult * windowAtr(windows);
  if (!(move > need)) {
    return skip(`${streak.length}× ${dir}, last ${params.minStreak} moved $${move.toFixed(0)}, needs > ${params.atrMult}× ATR ($${need.toFixed(0)})`);
  }
  const rev = streak.direction === "up" ? 1 : 0;
  const side = rev === 0 ? "Up" : "Down";
  const ask = asks[rev];
  if (ask == null) return skip(`Fade signal on, but ${side} has no ask`);
  if (ask > params.maxAsk) return skip(`Fade signal on, but ${side} ask ${px(ask)} is above ${px(params.maxAsk)}`);
  return {
    action: "buy",
    outcomeIndex: rev,
    limitPrice: params.maxAsk,
    reason: `${streak.length}× ${dir} stretched $${move.toFixed(0)} (> $${need.toFixed(0)}); fading with ${side} at ${px(ask)}`,
  };
}

// ── Price trigger ───────────────────────────────────────────────────────────

export interface TriggerParams {
  /** Which outcome of the bot's market to trade. */
  outcomeIndex: number;
  when: "ask-below" | "ask-above";
  price: number;
  /** Sell the position once the best bid reaches this. */
  takeProfit: number | null;
  /** Sell the position once the best bid falls to this. */
  stopLoss: number | null;
  phase: "armed" | "holding" | "done";
}

export function evaluateTrigger(input: {
  bestAsk: number | null;
  bestBid: number | null;
  params: TriggerParams;
  holdingShares: number;
}): Decision {
  const { bestAsk, bestBid, params, holdingShares } = input;
  if (params.phase === "armed") {
    if (bestAsk == null) return skip("No ask on the book");
    const hit = params.when === "ask-below" ? bestAsk <= params.price : bestAsk >= params.price;
    if (!hit) return skip(`Ask ${px(bestAsk)}, waiting for ${params.when === "ask-below" ? "≤" : "≥"} ${px(params.price)}`);
    return {
      action: "buy",
      outcomeIndex: params.outcomeIndex,
      // Buying a dip never pays above the trigger; a breakout buy takes the current ask.
      limitPrice: params.when === "ask-below" ? params.price : bestAsk,
      reason: `Ask ${px(bestAsk)} hit the ${px(params.price)} trigger`,
    };
  }
  if (params.phase === "holding") {
    if (holdingShares <= 0) return skip("Position is gone (sold or resolved)");
    if (bestBid == null) return skip("No bid on the book");
    if (params.takeProfit != null && bestBid >= params.takeProfit) {
      return { action: "sell", limitPrice: params.takeProfit, reason: `Bid ${px(bestBid)} reached take-profit ${px(params.takeProfit)}` };
    }
    if (params.stopLoss != null && bestBid <= params.stopLoss) {
      return { action: "sell", limitPrice: null, reason: `Bid ${px(bestBid)} hit stop-loss ${px(params.stopLoss)}` };
    }
    return skip(`Holding; bid ${px(bestBid)}`);
  }
  return skip("Done");
}

/** Index of the Up outcome in a BTC up/down market (["Up","Down"] today, but never assumed). */
export function upDownIndexes(outcomes: { name: string }[]): [number, number] | null {
  const up = outcomes.findIndex((o) => /^up$/i.test(o.name));
  const down = outcomes.findIndex((o) => /^down$/i.test(o.name));
  return up >= 0 && down >= 0 ? [up, down] : null;
}
