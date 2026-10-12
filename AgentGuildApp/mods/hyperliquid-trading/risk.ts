/**
 * The position-size limit, checked against the whole position rather than
 * one order: ten $100 orders on one coin are a $1,000 position, and a
 * maxPositionUsd of $100 has to stop the second one. Live and paper both
 * call this, so the two accounts enforce the same rule.
 */

/** Signed USD notional of a position: positive long, negative short. */
export function signedNotional(szi: number, px: number): number {
  return szi * px;
}

/**
 * Null when an order keeps the coin's position within maxPositionUsd,
 * else the reason it doesn't. An order that shrinks the position is always
 * allowed, even if the position is already over the limit (the limit was
 * lowered, or the price moved), so the agent can always trade its way back down.
 */
export function positionLimitError(
  coin: string,
  currentUsd: number,
  isBuy: boolean,
  sizeUsd: number,
  maxPositionUsd: number,
): string | null {
  const after = currentUsd + (isBuy ? sizeUsd : -sizeUsd);
  if (Math.abs(after) <= maxPositionUsd + 1e-9) return null;
  if (Math.abs(after) < Math.abs(currentUsd)) return null;
  const held = Math.abs(currentUsd) > 0.005
    ? ` on top of the $${Math.abs(currentUsd).toFixed(2)} ${currentUsd > 0 ? "long" : "short"} already open`
    : "";
  return `$${sizeUsd} ${coin} order${held} would make a $${Math.abs(after).toFixed(2)} position, over maxPositionUsd ${maxPositionUsd}`;
}

/**
 * One live order between "risk check passed" and "fill visible on
 * Hyperliquid". `usd` is signed (+ buy, − sell). The worker path binds
 * `taskId` once the order is queued; a native order is released as soon as
 * it returns, so it never gets one.
 */
export interface LiveReservation {
  id: string;
  coin: string;
  usd: number;
  taskId: string | null;
  at: number;
}

/** How long a reservation with no task yet stays counted (a crash between reserve and enqueue). */
export const UNBOUND_RESERVATION_MS = 2 * 60 * 1000;

/**
 * The reservations that still count. A queued order counts until its task
 * ends (completed, failed, timed out, cancelled — `isTaskOpen` false), however
 * long that takes: a task nobody has claimed can still fill later. An
 * unbound reservation counts for UNBOUND_RESERVATION_MS.
 */
export function openReservations(
  entries: LiveReservation[],
  now: number,
  isTaskOpen: (taskId: string) => boolean,
): LiveReservation[] {
  return entries.filter((e) => (e.taskId ? isTaskOpen(e.taskId) : now - e.at < UNBOUND_RESERVATION_MS));
}

/** Signed USD of the open reservations in one coin. */
export function reservedUsd(entries: LiveReservation[], coin: string): number {
  return entries.filter((e) => e.coin === coin).reduce((sum, e) => sum + e.usd, 0);
}

/**
 * positionLimitError with live orders still in flight counted as if filled:
 * two orders sent seconds apart can't both pass against the same open position.
 */
export function positionLimitWithPendingError(
  coin: string,
  currentUsd: number,
  pendingUsd: number,
  isBuy: boolean,
  sizeUsd: number,
  maxPositionUsd: number,
): string | null {
  const err = positionLimitError(coin, currentUsd + pendingUsd, isBuy, sizeUsd, maxPositionUsd);
  if (!err || Math.abs(pendingUsd) < 0.005) return err;
  return `${err} (counting $${Math.abs(pendingUsd).toFixed(2)} of ${coin} live orders still in flight)`;
}

/** Protection every paper and testnet entry gets when neither the order nor the risk config sets one. */
export const DEFAULT_STOP_LOSS_PCT = 5;
export const DEFAULT_TAKE_PROFIT_PCT = 10;

/**
 * The stop loss and take profit an entry goes out with: the order's own, else
 * the agent's risk-config defaults, else (paper and testnet only, where
 * `always` is set) DEFAULT_STOP_LOSS_PCT / DEFAULT_TAKE_PROFIT_PCT, so no
 * position opens unprotected. A trailing stop stands in for the stop loss.
 * Closes (reduceOnly) never carry one.
 */
export function entryProtection(
  order: { stopLossPct?: number; takeProfitPct?: number; trailingStopPct?: number; reduceOnly?: boolean },
  risk: { defaultStopLossPct?: number; defaultTakeProfitPct?: number } | null | undefined,
  always: boolean,
): { stopLossPct?: number; takeProfitPct?: number; defaulted: boolean } {
  if (order.reduceOnly) return { defaulted: false };
  const pick = (v: number | undefined) => (v != null && v > 0 ? v : undefined);
  let stopLossPct = pick(order.stopLossPct) ?? pick(risk?.defaultStopLossPct);
  let takeProfitPct = pick(order.takeProfitPct) ?? pick(risk?.defaultTakeProfitPct);
  let defaulted = false;
  if (always) {
    if (stopLossPct == null && !pick(order.trailingStopPct)) { stopLossPct = DEFAULT_STOP_LOSS_PCT; defaulted = true; }
    if (takeProfitPct == null) { takeProfitPct = DEFAULT_TAKE_PROFIT_PCT; defaulted = true; }
  }
  return { ...(stopLossPct != null ? { stopLossPct } : {}), ...(takeProfitPct != null ? { takeProfitPct } : {}), defaulted };
}
