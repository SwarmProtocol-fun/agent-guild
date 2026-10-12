/**
 * Trading discipline for AI bots, enforced in code rather than asked of the
 * model. Paper bots lost money by trading 1-minute noise and closing trades
 * minutes later, barely green or barely red, so fees ate every edge. Three
 * guards, all on unless a bot's params set discipline: false:
 *
 *   1. Entry gate: an open (or a flip's new side) is refused when the coin's
 *      expected move over a typical hold can't cover the round-trip cost
 *      MIN_EDGE_MULT times over, and an open just after a close waits out a
 *      cooldown. The expected move is ATR% × √HOLD_BARS.
 *   2. Minimum hold: a close or flip within MIN_HOLD_ROUNDS rounds of the
 *      entry is refused; the automatic stop still protects the position.
 *   3. Bracket: every entry gets a stop loss and take profit sized to the
 *      expected move, so exits don't depend on the model reading noise.
 *
 * Plus auto-pause: a bot whose last PAUSE_TRIPS round trips lose money after
 * costs turns itself off instead of bleeding to its max drawdown.
 *
 * Pure: the server passes in the decision log, ATR and clock.
 */
import type { LogRow, Trip } from "./evolve";
import { atr, type Candle } from "./indicators";

/** Taker fees for a round trip (0.09%) plus spread and slippage. Matches the AI prompt's figure. */
export const ROUND_TRIP_COST_PCT = 0.15;
/** Bars of the bot's chart interval a trade is expected to last. */
export const HOLD_BARS = 8;
/** The expected move must be at least this many round-trip costs. */
export const MIN_EDGE_MULT = 2;
/** Rounds a position must be held before the bot may close or flip it. */
export const MIN_HOLD_ROUNDS = 3;
/** Rounds after a close before the bot may open again on that coin. */
export const COOLDOWN_ROUNDS = 2;
/** Closed round trips judged for auto-pause. */
export const PAUSE_TRIPS = 10;
/** Stop loss never tighter than this many round-trip costs. */
const MIN_STOP_COSTS = 3;
const MAX_STOP_PCT = 15;

/** Added to a disciplined bot's system prompt so the model plans for the rules instead of fighting them. */
export const GUARD_NOTE = [
  "This bot's trades are guarded in code:",
  "- every entry gets an automatic stop loss and take profit sized to recent volatility;",
  `- an entry is refused when the market is too quiet for the expected move to cover ${MIN_EDGE_MULT}× the round-trip cost, and for ${COOLDOWN_ROUNDS} rounds after an exit;`,
  `- a position can't be closed or flipped in its first ${MIN_HOLD_ROUNDS} rounds — its stop protects it meanwhile;`,
  `- the bot pauses itself if its last ${PAUSE_TRIPS} trades lose money after costs.`,
  "So enter only trades you would hold until the stop or target.",
].join("\n");

export type GuardedAction = "open-long" | "open-short" | "close" | "flip-long" | "flip-short" | "hold";

/** ATR(14) as a percent of the last close. Null without enough bars. */
export function atrPct(candles: Candle[]): number | null {
  const a = atr(candles, 14);
  const last = candles[candles.length - 1]?.c;
  return a != null && last > 0 ? (a / last) * 100 : null;
}

/** The move a trade can expect over HOLD_BARS bars, in percent. */
export function expectedMovePct(atr: number): number {
  return atr * Math.sqrt(HOLD_BARS);
}

/** Stop loss and take profit for a new entry: stop at the expected move (floored), target at twice the stop. */
export function bracketFor(atr: number): { stopLossPct: number; takeProfitPct: number } {
  const stop = Math.min(MAX_STOP_PCT, Math.max(expectedMovePct(atr), MIN_STOP_COSTS * ROUND_TRIP_COST_PCT));
  const round = (n: number) => Math.round(n * 100) / 100;
  return { stopLossPct: round(stop), takeProfitPct: round(stop * 2) };
}

/** For each coin, when the bot's log says its current position was opened. Rows with an error never traded. */
export function openPositions(rows: LogRow[], defaultCoin: string): Map<string, number> {
  const open = new Map<string, number>();
  for (const r of sortedRows(rows)) {
    const coin = r.coin || defaultCoin;
    const at = r.createdAt!.getTime();
    if (r.action === "open-long" || r.action === "open-short") {
      if (!open.has(coin)) open.set(coin, at);
    } else if (r.action === "flip-long" || r.action === "flip-short") {
      open.set(coin, at);
    } else if (r.action === "close") {
      open.delete(coin);
    }
  }
  return open;
}

/** When the bot last closed (or flipped out of) a position on `coin`. */
export function lastExitAt(rows: LogRow[], coin: string, defaultCoin: string): number | null {
  let last: number | null = null;
  for (const r of sortedRows(rows)) {
    if ((r.coin || defaultCoin) !== coin) continue;
    if (r.action === "close" || r.action === "flip-long" || r.action === "flip-short") last = r.createdAt!.getTime();
  }
  return last;
}

function sortedRows(rows: LogRow[]): LogRow[] {
  return rows.filter((r) => !r.error && r.createdAt).sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime());
}

/**
 * What the bot may actually do with the action its model chose. A refused
 * open becomes hold; a flip whose exit is allowed but whose new side isn't
 * becomes a plain close. `note` says why, for the decision log.
 */
export function guardAction(input: {
  action: GuardedAction;
  /** ATR% on the bot's chart interval; null if unknown (the entry gate is then skipped). */
  atr: number | null;
  openedAt: number | null;
  lastExitAt: number | null;
  roundMs: number;
  now: number;
}): { action: GuardedAction; note: string | null } {
  const { action, atr, openedAt, lastExitAt: exitedAt, roundMs, now } = input;
  if (action === "hold") return { action, note: null };
  const isExit = action === "close" || action === "flip-long" || action === "flip-short";
  const opens = action !== "close";

  if (isExit && openedAt != null) {
    const heldRounds = (now - openedAt) / roundMs;
    if (heldRounds < MIN_HOLD_ROUNDS) {
      return {
        action: "hold",
        note: `Not traded: the position is ${Math.max(0, Math.floor(heldRounds))} round(s) old and must be held ${MIN_HOLD_ROUNDS} before closing; its automatic stop still protects it.`,
      };
    }
  }

  if (opens) {
    const fallback: GuardedAction = isExit ? "close" : "hold";
    const verb = isExit ? "Closed instead of flipping" : "Not traded";
    if (!isExit && exitedAt != null && (now - exitedAt) / roundMs < COOLDOWN_ROUNDS) {
      return { action: fallback, note: `${verb}: cooling down for ${COOLDOWN_ROUNDS} rounds after the last exit.` };
    }
    if (atr != null) {
      const move = expectedMovePct(atr);
      const needed = MIN_EDGE_MULT * ROUND_TRIP_COST_PCT;
      if (move < needed) {
        return {
          action: fallback,
          note: `${verb}: the expected move over ${HOLD_BARS} bars is ${move.toFixed(2)}%, under the ${needed.toFixed(2)}% that ${MIN_EDGE_MULT}× a round trip costs. Too quiet to trade on this interval — wait, or use a longer one.`,
        };
      }
    }
  }
  return { action, note: null };
}

/**
 * Whether a bot should pause itself: its last PAUSE_TRIPS round trips (closed
 * after `since`) averaged a loss after costs. Null to keep trading.
 */
export function autoPauseReason(trips: Trip[], since: number | null): string | null {
  const recent = trips.filter((t) => since == null || t.closedAt > since).slice(-PAUSE_TRIPS);
  if (recent.length < PAUSE_TRIPS) return null;
  const net = recent.reduce((s, t) => s + t.pnlPct - ROUND_TRIP_COST_PCT, 0) / recent.length;
  if (net >= 0) return null;
  const wins = recent.filter((t) => t.pnlPct > ROUND_TRIP_COST_PCT).length;
  return `Auto-paused: the last ${recent.length} trades averaged ${net.toFixed(3)}% each after about ${ROUND_TRIP_COST_PCT}% costs (${wins} of ${recent.length} cleared their costs). Change its goal, interval or lessons, then turn it back on.`;
}
