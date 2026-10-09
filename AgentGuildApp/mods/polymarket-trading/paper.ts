/**
 * Paper trading: fills simulated against the real live order book, with
 * Polymarket's taker fee, so paper results are an honest preview of live
 * ones (no mid-price fantasy fills). Pure functions — persistence is in
 * polymarket-store.ts.
 */

import type { BookLevel, FeeSchedule } from "./markets";

/** Polymarket's taker fee per share at a price: rate × (p(1−p))^exponent. Makers pay nothing. */
export function takerFeePerShare(price: number, fee: FeeSchedule | null): number {
  if (!fee) return 0;
  return fee.rate * (price * (1 - price)) ** fee.exponent;
}

export interface Fill {
  /** Shares bought or sold. */
  shares: number;
  /** USD notional at the fill prices, fees excluded. */
  notional: number;
  fee: number;
  /** notional / shares (0 when nothing filled). */
  avgPrice: number;
  /** Price of the deepest level touched. */
  worstPrice: number;
}

const EMPTY: Fill = { shares: 0, notional: 0, fee: 0, avgPrice: 0, worstPrice: 0 };

/** Polymarket share quantities are 2-decimal. */
function floor2(n: number): number {
  return Math.floor(n * 100 + 1e-9) / 100;
}

/**
 * Market/marketable-limit BUY spending up to `usd` (fees on top), walking
 * asks best-first and stopping at `limitPrice` if given. Fill-and-kill: what
 * the book can't cover at or under the limit is simply not bought.
 */
export function simulateBuy(asks: BookLevel[], usd: number, fee: FeeSchedule | null, limitPrice?: number): Fill {
  let left = usd;
  let shares = 0;
  let notional = 0;
  let fees = 0;
  let worst = 0;
  for (const level of asks) {
    if (left <= 0.0001) break;
    if (limitPrice != null && level.price > limitPrice + 1e-9) break;
    const take = floor2(Math.min(level.size, left / level.price));
    if (take <= 0) break;
    shares += take;
    notional += take * level.price;
    fees += take * takerFeePerShare(level.price, fee);
    left -= take * level.price;
    worst = level.price;
  }
  if (shares <= 0) return EMPTY;
  return { shares: floor2(shares), notional, fee: fees, avgPrice: notional / shares, worstPrice: worst };
}

/** Market/marketable-limit SELL of up to `shares`, walking bids best-first, stopping below `limitPrice`. */
export function simulateSell(bids: BookLevel[], shares: number, fee: FeeSchedule | null, limitPrice?: number): Fill {
  let left = floor2(shares);
  let sold = 0;
  let notional = 0;
  let fees = 0;
  let worst = 0;
  for (const level of bids) {
    if (left <= 0) break;
    if (limitPrice != null && level.price < limitPrice - 1e-9) break;
    const take = floor2(Math.min(level.size, left));
    if (take <= 0) break;
    sold += take;
    notional += take * level.price;
    fees += take * takerFeePerShare(level.price, fee);
    left = floor2(left - take);
    worst = level.price;
  }
  if (sold <= 0) return EMPTY;
  return { shares: floor2(sold), notional, fee: fees, avgPrice: notional / sold, worstPrice: worst };
}

export interface PaperPosition {
  shares: number;
  /** Average entry price per share, fees excluded (fees are booked as realized PnL when paid). */
  avgPrice: number;
  realizedPnl: number;
}

export function applyBuy(pos: PaperPosition | null, fill: Fill): PaperPosition {
  const prev = pos ?? { shares: 0, avgPrice: 0, realizedPnl: 0 };
  const shares = prev.shares + fill.shares;
  return {
    shares,
    avgPrice: shares > 0 ? (prev.shares * prev.avgPrice + fill.notional) / shares : 0,
    realizedPnl: prev.realizedPnl - fill.fee,
  };
}

/** Realized PnL of this sell = (sell price − entry) × shares − fee. */
export function applySell(pos: PaperPosition, fill: Fill): { position: PaperPosition; realized: number } {
  const realized = fill.notional - fill.shares * pos.avgPrice - fill.fee;
  const shares = floor2(pos.shares - fill.shares);
  return {
    position: { shares, avgPrice: shares > 0 ? pos.avgPrice : 0, realizedPnl: pos.realizedPnl + realized },
    realized,
  };
}

/** A resolved market pays $1 per winning share and $0 per losing one. */
export function settle(pos: PaperPosition, won: boolean): { payout: number; realized: number } {
  const payout = won ? pos.shares : 0;
  return { payout, realized: payout - pos.shares * pos.avgPrice };
}
