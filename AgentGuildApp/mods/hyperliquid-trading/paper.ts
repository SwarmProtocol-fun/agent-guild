/**
 * Paper trading for Hyperliquid perps: fills simulated against the real
 * mainnet order book with Hyperliquid's own sizing, slippage cap and fees,
 * on a cross-margin account with TP/SL, funding and liquidation — so a paper
 * result is an honest preview of the live one. Pure functions; persistence
 * is in hyperliquid-store.ts and the market reads/tick are in server.ts.
 */
import { maxDrawdownPct } from "./indicators";

/** Virtual USDC a new paper account starts with. */
export const PAPER_START_BALANCE = 10_000;
/** Hyperliquid's base-tier perp fees: takers 0.045%, makers 0.015%. */
export const TAKER_FEE_RATE = 0.00045;
export const MAKER_FEE_RATE = 0.00015;
/** Hyperliquid's base-tier spot taker fee. */
export const SPOT_TAKER_FEE_RATE = 0.0007;

export interface BookLevel { px: number; sz: number }
export interface CoinMeta { szDecimals: number; maxLeverage: number }

export interface PaperPosition {
  coin: string;
  /** Signed size in coins: positive long, negative short. */
  szi: number;
  entryPx: number;
  leverage: number;
  slPx: number | null;
  tpPx: number | null;
  /** Trailing stop distance in percent: slPx follows the best mark by this much and never moves back. */
  trailPct?: number | null;
}

export function roundSize(sz: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return Math.floor(sz * f + 1e-9) / f;
}

/**
 * Fill-and-kill walk of one side of the book (asks for a buy, bids for a
 * sell), best level first, never past `limitPx`. What the book can't cover
 * within the limit is left unfilled — the caller rests or drops it.
 */
export function walkBook(levels: BookLevel[], sz: number, isBuy: boolean, limitPx: number, szDecimals: number): { sz: number; notional: number; avgPx: number } {
  let left = sz;
  let filled = 0;
  let notional = 0;
  for (const level of levels) {
    if (left <= 0) break;
    if (isBuy ? level.px > limitPx + 1e-12 : level.px < limitPx - 1e-12) break;
    const take = Math.min(level.sz, left);
    filled += take;
    notional += take * level.px;
    left -= take;
  }
  filled = roundSize(filled, szDecimals);
  if (filled <= 0) return { sz: 0, notional: 0, avgPx: 0 };
  const avgPx = notional / Math.max(filled, 1e-12);
  return { sz: filled, notional: filled * avgPx, avgPx };
}

/**
 * One fill against a position. Same side adds at a size-weighted entry; the
 * other side realizes (exit − entry) × closed size and, past zero, flips to
 * a fresh position at the fill price. Fees are not included here.
 */
export function applyFill(
  pos: PaperPosition | null,
  coin: string,
  isBuy: boolean,
  sz: number,
  px: number,
  leverage: number,
  szDecimals: number,
): { position: PaperPosition | null; realized: number } {
  const signed = isBuy ? sz : -sz;
  if (!pos || pos.szi === 0) {
    return { position: { coin, szi: signed, entryPx: px, leverage, slPx: null, tpPx: null, trailPct: null }, realized: 0 };
  }
  if (Math.sign(pos.szi) === Math.sign(signed)) {
    const total = Math.abs(pos.szi) + sz;
    return {
      position: { ...pos, szi: roundSize(Math.abs(pos.szi) + sz, szDecimals) * Math.sign(pos.szi), entryPx: (Math.abs(pos.szi) * pos.entryPx + sz * px) / total, leverage },
      realized: 0,
    };
  }
  const closed = Math.min(Math.abs(pos.szi), sz);
  const realized = closed * (px - pos.entryPx) * Math.sign(pos.szi);
  const remaining = Math.sign(pos.szi + signed) * roundSize(Math.abs(pos.szi + signed), szDecimals);
  if (remaining === 0) return { position: null, realized };
  if (Math.sign(remaining) === Math.sign(pos.szi)) return { position: { ...pos, szi: remaining }, realized };
  return { position: { coin, szi: remaining, entryPx: px, leverage, slPx: null, tpPx: null, trailPct: null }, realized };
}

/** SL/TP trigger prices a fixed % through the entry — the same rule live orders use (exchange.ts). */
export function triggerPrices(isLong: boolean, entry: number, stopLossPct?: number, takeProfitPct?: number): { slPx: number | null; tpPx: number | null } {
  return {
    slPx: stopLossPct ? (isLong ? entry * (1 - stopLossPct / 100) : entry * (1 + stopLossPct / 100)) : null,
    tpPx: takeProfitPct ? (isLong ? entry * (1 + takeProfitPct / 100) : entry * (1 - takeProfitPct / 100)) : null,
  };
}

export interface MarkedPosition extends PaperPosition {
  markPx: number;
  notionalUsd: number;
  unrealizedPnl: number;
  marginUsed: number;
}

export interface PaperSummary {
  balance: number;
  /** Cash + unrealized perp PnL + spot holdings at their mids. */
  equity: number;
  /** Paper spot holdings at their mids (the basis bot's spot legs). Counts toward equity, like a unified Hyperliquid account. */
  spotValue: number;
  unrealizedPnl: number;
  marginUsed: number;
  /** Equity below this gets the whole account liquidated (Hyperliquid: half the initial margin at max leverage). */
  maintenanceMargin: number;
  /** Equity not tied up as margin — what a new order's margin comes out of. */
  available: number;
  positions: MarkedPosition[];
}

/** Marks every position to `marks` (falling back to entry when a coin has no price). `spotUsd` is the account's spot holdings, already valued. */
export function summarize(balance: number, positions: PaperPosition[], marks: Record<string, number>, meta: Record<string, CoinMeta>, spotUsd = 0): PaperSummary {
  let unrealizedPnl = 0;
  let marginUsed = 0;
  let maintenanceMargin = 0;
  const marked = positions.map((p) => {
    const markPx = marks[p.coin] || p.entryPx;
    const notionalUsd = Math.abs(p.szi) * markPx;
    const upnl = p.szi * (markPx - p.entryPx);
    const margin = notionalUsd / Math.max(1, p.leverage);
    unrealizedPnl += upnl;
    marginUsed += margin;
    maintenanceMargin += notionalUsd / (2 * Math.max(1, meta[p.coin]?.maxLeverage ?? 50));
    return { ...p, markPx, notionalUsd, unrealizedPnl: upnl, marginUsed: margin };
  });
  const equity = balance + unrealizedPnl + spotUsd;
  return { balance, equity, spotValue: spotUsd, unrealizedPnl, marginUsed, maintenanceMargin, available: equity - marginUsed, positions: marked };
}

export interface PaperOrder {
  coin: string;
  isBuy: boolean;
  sz: number;
  px: number;
  feeRate: number;
  leverage: number;
  reduceOnly: boolean;
  stopLossPct?: number;
  takeProfitPct?: number;
  /** Trailing stop distance in percent. Paper only — Hyperliquid has no native trailing stop. Replaces stopLossPct. */
  trailingStopPct?: number;
}

export interface BookedOrder {
  balance: number;
  /** The coin's position after the fill; null when it closed out. */
  position: PaperPosition | null;
  sz: number;
  fee: number;
  /** PnL of the fill, fees excluded. */
  realized: number;
}

/**
 * Books one fill on the account. A reduce-only order is clamped to the open
 * size and refused if it would add; anything that adds exposure must leave
 * equity covering every position's initial margin, like Hyperliquid's own
 * cross-margin check.
 */
export function bookOrder(
  balance: number,
  positions: PaperPosition[],
  order: PaperOrder,
  marks: Record<string, number>,
  meta: Record<string, CoinMeta>,
  spotUsd = 0,
): BookedOrder | { error: string } {
  const coinMeta = meta[order.coin] ?? { szDecimals: 4, maxLeverage: 50 };
  const prev = positions.find((p) => p.coin === order.coin) ?? null;
  let sz = order.sz;
  if (order.reduceOnly) {
    if (!prev || prev.szi === 0 || (prev.szi > 0) === order.isBuy) return { error: `No open ${order.coin} position to reduce` };
    sz = Math.min(sz, Math.abs(prev.szi));
  }
  if (!(sz > 0)) return { error: "Order size rounds to zero" };

  const leverage = order.reduceOnly ? prev!.leverage : Math.max(1, Math.min(Math.floor(order.leverage), coinMeta.maxLeverage));
  const { position, realized } = applyFill(prev, order.coin, order.isBuy, sz, order.px, leverage, coinMeta.szDecimals);
  const fee = sz * order.px * order.feeRate;

  let next = position;
  if (next && !order.reduceOnly && (order.stopLossPct || order.takeProfitPct || order.trailingStopPct)) {
    const stopPct = order.trailingStopPct || order.stopLossPct;
    next = { ...next, ...triggerPrices(next.szi > 0, order.px, stopPct, order.takeProfitPct), trailPct: order.trailingStopPct || null };
  }

  const nextBalance = balance + realized - fee;
  const adds = !!next && (!prev || Math.sign(prev.szi) !== Math.sign(next.szi) || Math.abs(next.szi) > Math.abs(prev.szi));
  if (adds) {
    const after = summarize(nextBalance, [...positions.filter((p) => p.coin !== order.coin), next!], { ...marks, [order.coin]: marks[order.coin] || order.px }, meta, spotUsd);
    if (after.available < -1e-9) {
      return { error: `Not enough paper margin: needs $${after.marginUsed.toFixed(2)}, equity is $${after.equity.toFixed(2)}` };
    }
  }
  return { balance: nextBalance, position: next, sz, fee, realized };
}

/** Which of a position's triggers the mark has crossed, if any (stop loss checked first). */
export function triggerHit(pos: PaperPosition, markPx: number): "sl" | "tp" | null {
  const isLong = pos.szi > 0;
  if (pos.slPx != null && (isLong ? markPx <= pos.slPx : markPx >= pos.slPx)) return "sl";
  if (pos.tpPx != null && (isLong ? markPx >= pos.tpPx : markPx <= pos.tpPx)) return "tp";
  return null;
}

/**
 * A trailing stop's new stop price once the mark has moved in the position's
 * favor, or null when it stays put. It only ever tightens.
 */
export function ratchetTrail(pos: PaperPosition, markPx: number): number | null {
  if (!pos.trailPct || !(markPx > 0)) return null;
  const isLong = pos.szi > 0;
  const candidate = isLong ? markPx * (1 - pos.trailPct / 100) : markPx * (1 + pos.trailPct / 100);
  if (pos.slPx == null) return candidate;
  return (isLong ? candidate > pos.slPx : candidate < pos.slPx) ? candidate : null;
}

/** A resting limit fills once the mid trades through it. */
export function restingFillable(isBuy: boolean, limitPx: number, mid: number): boolean {
  return isBuy ? mid <= limitPx : mid >= limitPx;
}

/** One hour of funding, as a credit to the balance: positive rates make longs pay shorts. */
export function fundingPayment(szi: number, oraclePx: number, hourlyRate: number): number {
  return -szi * oraclePx * hourlyRate;
}

export function isLiquidatable(summary: PaperSummary): boolean {
  return summary.positions.length > 0 && summary.equity < summary.maintenanceMargin;
}

export interface PerformanceTrade {
  realizedPnl: number;
  fee: number;
  /** ms since epoch; null sorts first. */
  at: number | null;
}

export interface PaperPerformance {
  /** Fills that realized PnL — a close, a reduce or a flip. */
  closed: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Net of every fee, opening fills included. */
  netPnl: number;
  fees: number;
  grossProfit: number;
  grossLoss: number;
  /** Gross profit over gross loss; null with no losing trade yet. */
  profitFactor: number | null;
  avgWin: number;
  avgLoss: number;
  /** Average net result per closed trade. */
  expectancy: number;
  largestWin: number;
  largestLoss: number;
  maxDrawdownPct: number;
  /** Account value after each fill, oldest first, starting from startBalance. Funding not included. */
  curve: { t: number | null; equity: number }[];
}

/**
 * Trade-level performance of a run of paper fills. A closing fill's result is
 * its realized PnL less its own fee; opening fees still count against netPnl
 * and the curve, so the curve ends where the fills left the balance.
 */
export function paperPerformance(trades: PerformanceTrade[], startBalance: number): PaperPerformance {
  const ordered = [...trades].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  let equity = startBalance;
  const curve: PaperPerformance["curve"] = [{ t: ordered[0]?.at ?? null, equity }];
  let fees = 0, grossProfit = 0, grossLoss = 0, wins = 0, losses = 0, largestWin = 0, largestLoss = 0, closed = 0;
  for (const t of ordered) {
    fees += t.fee;
    equity += t.realizedPnl - t.fee;
    curve.push({ t: t.at, equity });
    if (t.realizedPnl === 0) continue;
    closed++;
    const net = t.realizedPnl - t.fee;
    if (net > 0) {
      wins++;
      grossProfit += net;
      largestWin = Math.max(largestWin, net);
    } else {
      losses++;
      grossLoss += -net;
      largestLoss = Math.min(largestLoss, net);
    }
  }
  return {
    closed, wins, losses,
    winRate: closed ? wins / closed : 0,
    netPnl: equity - startBalance,
    fees, grossProfit, grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgWin: wins ? grossProfit / wins : 0,
    avgLoss: losses ? -grossLoss / losses : 0,
    expectancy: closed ? (grossProfit - grossLoss) / closed : 0,
    largestWin, largestLoss,
    maxDrawdownPct: maxDrawdownPct(curve.map((p) => p.equity)),
    curve,
  };
}

// ── Paper spot ──────────────────────────────────────────────────────────────
//
// Spot holdings for the basis bot's long leg: coins bought on Hyperliquid
// spot with paper USDC, at the real spot book. Keyed by spot token (UBTC).

export interface SpotHolding {
  /** The spot market's book key ("@142"). */
  pair: string;
  token: string;
  sz: number;
  avgPx: number;
}

/** Spot holdings valued at `spotMids` (keyed by pair), falling back to cost. */
export function spotValue(spot: Record<string, SpotHolding> | undefined, spotMids: Record<string, number>): number {
  return Object.values(spot ?? {}).reduce((s, h) => s + h.sz * (spotMids[h.pair] || h.avgPx), 0);
}

export interface SpotOrder {
  pair: string;
  token: string;
  isBuy: boolean;
  sz: number;
  px: number;
  feeRate: number;
  szDecimals: number;
}

/**
 * Books one spot fill. A buy is paid from free cash — cash plus unrealized
 * perp PnL less the margin perps already use — and never from spot or
 * borrowed funds. A sell is clamped to what's held and realizes against the
 * average cost.
 */
export function bookSpot(
  balance: number,
  positions: PaperPosition[],
  spot: Record<string, SpotHolding>,
  order: SpotOrder,
  marks: Record<string, number>,
  meta: Record<string, CoinMeta>,
): { balance: number; holding: SpotHolding | null; sz: number; fee: number; realized: number } | { error: string } {
  const held = spot[order.token] ?? null;
  let sz = roundSize(order.sz, order.szDecimals);
  if (!order.isBuy) {
    if (!held || held.sz <= 0) return { error: `No ${order.token} spot to sell` };
    sz = Math.min(sz, held.sz);
  }
  if (!(sz > 0)) return { error: "Spot order size rounds to zero" };
  const cost = sz * order.px;
  const fee = cost * order.feeRate;
  if (order.isBuy) {
    const perps = summarize(balance, positions, marks, meta);
    if (perps.available < cost + fee - 1e-9) {
      return { error: `Not enough free paper cash for spot: needs $${(cost + fee).toFixed(2)}, has $${perps.available.toFixed(2)}` };
    }
    const total = (held?.sz ?? 0) + sz;
    const avgPx = ((held?.sz ?? 0) * (held?.avgPx ?? 0) + cost) / total;
    return { balance: balance - cost - fee, holding: { pair: order.pair, token: order.token, sz: roundSize(total, order.szDecimals), avgPx }, sz, fee, realized: 0 };
  }
  const realized = sz * (order.px - held!.avgPx);
  const left = roundSize(held!.sz - sz, order.szDecimals);
  return { balance: balance + cost - fee, holding: left > 0 ? { ...held!, sz: left } : null, sz, fee, realized };
}
