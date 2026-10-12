/**
 * Backtester for the Hyperliquid bots. Replays historical candles through
 * the same rules the live tick uses (server.ts runHyperliquidStrategyTick /
 * runAiTraderTick), so a backtest is a prediction of what the bot would
 * have done — not an idealized version of the strategy:
 *
 *   - DCA buys sizeUsd every intervalMs; smart DCA (./smart-dca.ts) sizes
 *     each order up the further price is under its average entry, and can
 *     take profit on the whole stack.
 *   - Grid buys sizeUsd the first time price reaches each level (the live
 *     grid never trades a level back).
 *   - Sniper (price trigger) buys once when the close crosses the target.
 *   - DCA, grid and sniper can run short instead (direction "short"): they
 *     sell where they would have bought.
 *   - Breakout (./breakout.ts) opens on a squeeze breakout and closes on the
 *     rules' exit.
 *   - AI asks `decide` at every decision bar and opens / closes / flips a
 *     fixed sizeUsd position.
 *
 * Signals come from a bar's close and fill at the next bar's open, plus
 * slippage and a taker fee. Stop loss, liquidation and take profit are
 * checked inside each bar against its high and low, adverse side first (the
 * cautious reading when one bar touches both), and fill at the trigger — or
 * at the open when the bar gaps through it. Liquidation uses the paper
 * engine's rule: equity under half the initial margin at the coin's max
 * leverage. Hourly funding, when the caller passes its history, is paid or
 * received on the position held through each funding time. Equity is marked
 * at every close.
 *
 * A disciplined AI strategy (discipline: true, the live default) goes through
 * ./discipline.ts exactly as the live bot does: entry gate, cooldown, minimum
 * hold, an ATR bracket on every entry, and auto-pause after losing trips.
 *
 * Fills group into round trips (flat → flat, or up to a flip), which is what
 * the trade stats and the Monte Carlo resample judge. Pure and
 * environment-free — it runs in the browser (the panel's Backtest tab) and
 * in tests; the AI's `decide` is the only thing that reaches the network.
 */
import { decisionToAction, type AiDecision, type AiPosition } from "./ai-trader-core";
import { breakoutHistory, decideBreakout, type BreakoutParams } from "./breakout";
import { atrPct, autoPauseReason, bracketFor, guardAction, type GuardedAction } from "./discipline";
import { maxDrawdownPct, sharpe, sortino, type Candle } from "./indicators";
import { smartDcaSize, smartDcaTakeProfit, type SmartDcaParams } from "./smart-dca";

/** Hyperliquid's base-tier perp taker fee. */
export const TAKER_FEE = 0.00045;
export const DEFAULT_SLIPPAGE = 0.0005;

export type Direction = "long" | "short";

export type BacktestStrategy =
  | { type: "hold" }
  | { type: "dca"; intervalMs: number; direction?: Direction; smart?: SmartDcaParams | null }
  | { type: "grid"; lowerPrice: number; upperPrice: number; levels: number; direction?: Direction }
  | { type: "sniper"; mode: "price-above" | "price-below"; targetPrice: number; direction?: Direction }
  | { type: "breakout"; params: BreakoutParams }
  | {
      type: "ai";
      /** Decide at every Nth bar (1 = every bar). */
      everyBars: number;
      /** Guard the model's actions like a live disciplined bot (./discipline.ts). */
      discipline?: boolean;
      decide: (ctx: { index: number; candles: Candle[]; position: AiPosition | null }) => Promise<{ decision: AiDecision; reasoning?: string }>;
    };

export interface BacktestConfig {
  candles: Candle[];
  barMs: number;
  strategy: BacktestStrategy;
  startingBalance: number;
  sizeUsd: number;
  leverage: number;
  /** First bar the strategy may act on — earlier bars are indicator warm-up. */
  startIndex?: number;
  feeRate?: number;
  slippage?: number;
  /** Stop loss on the open position, a fixed % through its average entry. A breakout strategy defaults to its own. */
  stopLossPct?: number;
  /** Take profit on the open position, a fixed % through its average entry. A breakout strategy defaults to its own. */
  takeProfitPct?: number;
  /** Stop for good (closing any position) once equity falls this far below the start, like a live AI bot. */
  maxDrawdownStopPct?: number;
  /** The coin's max leverage; maintenance margin is half the initial margin at it. Default 50, like the paper engine. */
  maxLeverage?: number;
  /** Hourly funding history, oldest first (rate per payment, positive = longs pay). Omitted = no funding. */
  funding?: FundingPoint[];
  /** Called after each bar — lets a UI show progress through a slow (AI) run. */
  onProgress?: (done: number, total: number) => void;
  /** Checked before each bar; returning true ends the run early. */
  shouldStop?: () => boolean;
}

export interface BacktestTrade {
  t: number;
  side: "buy" | "sell";
  price: number;
  size: number;
  notional: number;
  fee: number;
  realizedPnl: number | null;
  reason: string;
}

export interface FundingPoint {
  t: number;
  rate: number;
}

export interface BacktestDecision {
  t: number;
  price: number;
  decision: AiDecision;
  action: string;
  reasoning?: string;
  /** Why discipline changed the model's action. */
  note?: string | null;
}

/** One position from flat back to flat (or to a flip). */
export interface BacktestTrip {
  side: "long" | "short";
  openedAt: number;
  closedAt: number;
  /** Average entry and exit prices, after slippage. */
  entryPx: number;
  exitPx: number;
  /** Price move in the trade's favour, %, before costs. */
  movePct: number;
  /** Net PnL in USD: realized minus fees minus funding. */
  pnl: number;
  /** pnl as a percent of the largest notional the trip held. */
  pnlPct: number;
  fees: number;
  funding: number;
  bars: number;
  exitReason: string;
}

export interface TripStats {
  trips: number;
  winRate: number | null;
  /** Gross wins over gross losses. Null when nothing lost (or nothing traded). */
  profitFactor: number | null;
  /** Average net USD per trip. */
  expectancy: number | null;
  /** Average net % per trip (on the trip's notional). */
  expectancyPct: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  best: number | null;
  worst: number | null;
  avgBarsHeld: number | null;
  maxConsecutiveLosses: number;
}

export interface BacktestResult {
  /** Equity marked at each close, with that close price. */
  equity: { t: number; value: number; px: number }[];
  trades: BacktestTrade[];
  trips: BacktestTrip[];
  stats: TripStats;
  decisions: BacktestDecision[];
  startingBalance: number;
  finalEquity: number;
  returnPct: number;
  /** Price return of simply holding the coin over the same bars (1x). */
  buyHoldReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  sortino: number | null;
  /** Share of marked bars that ended holding a position. */
  exposurePct: number;
  /** Net funding paid (negative = received). */
  fundingPaid: number;
  fundingPayments: number;
  liquidations: number;
  /** Share of position-reducing fills that realized a profit. */
  winRate: number | null;
  closingTrades: number;
  feesPaid: number;
  /** Orders skipped because the account didn't have the margin for them. */
  skippedForMargin: number;
  stoppedOut: string | null;
  endedEarly: boolean;
}

export async function runBacktest(cfg: BacktestConfig): Promise<BacktestResult> {
  const { candles, strategy, sizeUsd, leverage, startingBalance } = cfg;
  const fee = cfg.feeRate ?? TAKER_FEE;
  const slip = cfg.slippage ?? DEFAULT_SLIPPAGE;
  const mmr = 1 / (2 * Math.max(1, cfg.maxLeverage ?? 50));
  const start = Math.max(0, Math.min(cfg.startIndex ?? 0, candles.length - 1));
  const disciplined = strategy.type === "ai" && !!strategy.discipline;

  let cash = startingBalance; // realized balance: deposits + realized PnL − fees − funding
  let size = 0; // signed coin size; > 0 long
  let entry = 0;
  let feesPaid = 0;
  let fundingPaid = 0;
  let fundingPayments = 0;
  let liquidations = 0;
  let skippedForMargin = 0;
  let heldBars = 0;
  let stoppedOut: string | null = null;
  let endedEarly = false;
  const trades: BacktestTrade[] = [];
  const trips: BacktestTrip[] = [];
  const decisions: BacktestDecision[] = [];
  const equity: { t: number; value: number; px: number }[] = [];

  /** The round trip in progress. */
  let trip: { side: "long" | "short"; openedAt: number; openIdx: number; buyQty: number; buyVal: number; sellQty: number; sellVal: number; net: number; fees: number; funding: number; peak: number } | null = null;
  let barIdx = start;
  /** A disciplined AI entry's own stop and target (they replace cfg's while the position is open). */
  let bracket: { stopLossPct: number; takeProfitPct: number } | null = null;
  /** Decision-clock times the discipline rules read: when the position opened and when the last one closed. */
  let openedAt: number | null = null;
  let lastExitAt: number | null = null;

  const equityAt = (px: number) => cash + size * (px - entry);
  const position = (px: number): AiPosition | null =>
    size === 0 ? null : { isLong: size > 0, size, entryPx: entry, unrealizedPnl: size * (px - entry) };

  function openTrip(t: number, long: boolean) {
    trip = { side: long ? "long" : "short", openedAt: t, openIdx: barIdx, buyQty: 0, buyVal: 0, sellQty: 0, sellVal: 0, net: 0, fees: 0, funding: 0, peak: 0 };
  }

  function closeTrip(t: number, reason: string) {
    const tr = trip;
    trip = null;
    if (!tr) return;
    const long = tr.side === "long";
    const entryPx = long ? tr.buyVal / tr.buyQty : tr.sellVal / tr.sellQty;
    const exitPx = long ? tr.sellVal / tr.sellQty : tr.buyVal / tr.buyQty;
    trips.push({
      side: tr.side, openedAt: tr.openedAt, closedAt: t, entryPx, exitPx,
      movePct: ((exitPx - entryPx) / entryPx) * 100 * (long ? 1 : -1),
      pnl: tr.net, pnlPct: tr.peak ? (tr.net / tr.peak) * 100 : 0,
      fees: tr.fees, funding: tr.funding, bars: barIdx - tr.openIdx, exitReason: reason,
    });
  }

  /** Fills a market order for `notional` USD at `px`; returns false if refused for margin. */
  function fill(t: number, isBuy: boolean, notional: number, px: number, reason: string, reduceOnly = false, exact = false): boolean {
    const price = exact ? px : px * (isBuy ? 1 + slip : 1 - slip);
    let qty = notional / price;
    if (reduceOnly) qty = Math.min(qty, Math.abs(size));
    if (qty <= 0) return false;
    const signed = isBuy ? qty : -qty;
    const next = size + signed;
    const opening = Math.abs(next) > Math.abs(size);
    if (opening && (Math.abs(next) * price) / leverage > equityAt(px) - qty * price * fee) {
      skippedForMargin++;
      return false;
    }

    let realized: number | null = null;
    const closingQty = size !== 0 && Math.sign(signed) !== Math.sign(size) ? Math.min(qty, Math.abs(size)) : 0;
    if (closingQty) {
      realized = closingQty * (price - entry) * Math.sign(size);
      cash += realized;
    }
    const f = qty * price * fee;
    cash -= f;
    feesPaid += f;

    // Round-trip bookkeeping: the closing part (and its share of the fee) belongs to the open trip.
    if (size === 0) openTrip(t, isBuy);
    const flips = next !== 0 && size !== 0 && Math.sign(next) !== Math.sign(size);
    if (trip) {
      const share = flips ? closingQty / qty : 1;
      const q = flips ? closingQty : qty;
      if (isBuy) { trip.buyQty += q; trip.buyVal += q * price; } else { trip.sellQty += q; trip.sellVal += q * price; }
      trip.net += (realized ?? 0) - f * share;
      trip.fees += f * share;
    }
    const flat = Math.abs(next) < 1e-12;
    if (flat || flips) closeTrip(t, reason);
    if (flips) {
      openTrip(t, isBuy);
      const q = qty - closingQty;
      if (isBuy) { trip!.buyQty += q; trip!.buyVal += q * price; } else { trip!.sellQty += q; trip!.sellVal += q * price; }
      trip!.net -= f * (1 - closingQty / qty);
      trip!.fees += f * (1 - closingQty / qty);
    }

    if (flat) {
      entry = 0;
    } else if (size === 0 || flips) {
      entry = price; // fresh position, or flipped through zero
    } else if (Math.abs(next) > Math.abs(size)) {
      entry = (entry * Math.abs(size) + price * qty) / Math.abs(next);
    }
    size = flat ? 0 : next;
    if (trip) trip.peak = Math.max(trip.peak, Math.abs(size) * entry);
    if (size === 0 || flips) bracket = null;

    trades.push({ t, side: isBuy ? "buy" : "sell", price, size: qty, notional: qty * price, fee: f, realizedPnl: realized, reason });
    return true;
  }

  function closeAll(t: number, px: number, reason: string, exact = false) {
    if (size !== 0) fill(t, size < 0, Math.abs(size) * px * 1.01, px, reason, true, exact);
  }

  const stopLossPct = cfg.stopLossPct ?? (strategy.type === "breakout" ? strategy.params.stopLossPct : undefined);
  const takeProfitPct = cfg.takeProfitPct ?? (strategy.type === "breakout" ? strategy.params.takeProfitPct : undefined);

  /** The price at which equity meets maintenance margin, or null if the position can't be liquidated. */
  function liquidationPx(): number | null {
    if (size === 0) return null;
    const px = (size * entry - cash) / (size * (1 - Math.sign(size) * mmr));
    return px > 0 && Number.isFinite(px) ? px : null;
  }

  /**
   * Fires the stop loss, liquidation or take profit the bar's range reached.
   * The adverse trigger nearest the entry goes first; exits fill at the
   * trigger, or the open if the bar gapped through it. Returns the exit reason.
   */
  function checkTriggers(bar: Candle): string | null {
    if (size === 0) return null;
    const long = size > 0;
    const slPct = bracket?.stopLossPct ?? stopLossPct;
    const tpPct = bracket?.takeProfitPct ?? takeProfitPct;
    const sl = slPct ? entry * (long ? 1 - slPct / 100 : 1 + slPct / 100) : null;
    const tp = tpPct ? entry * (long ? 1 + tpPct / 100 : 1 - tpPct / 100) : null;
    const liq = liquidationPx();
    const reached = (px: number | null, adverse: boolean) =>
      px != null && (long === adverse ? bar.l <= px : bar.h >= px);
    const fillPx = (px: number, adverse: boolean) => (long === adverse ? Math.min(bar.o, px) : Math.max(bar.o, px));

    // Of the adverse triggers, the one nearer the entry is hit first.
    const stopFirst = sl != null && (liq == null || (long ? sl >= liq : sl <= liq));
    if (stopFirst && reached(sl, true)) {
      const reason = `stop loss ${slPct}%`;
      closeAll(bar.t, fillPx(sl!, true), reason);
      return reason;
    }
    if (reached(liq, true)) {
      // Liquidations close at the liquidation price (or a worse open) with no extra slippage.
      closeAll(bar.t, fillPx(liq!, true), "liquidation", true);
      liquidations++;
      if (cash < 0) cash = 0; // the backstop absorbs a gap past zero
      return "liquidation";
    }
    if (tp != null && reached(tp, false)) {
      const reason = `take profit ${tpPct}%`;
      closeAll(bar.t, fillPx(tp, false), reason);
      return reason;
    }
    return null;
  }

  // Funding times at or before the first traded bar's open can't touch a position.
  const funding = cfg.funding ?? [];
  let fi = 0;
  while (fi < funding.length && funding[fi].t <= (candles[start]?.t ?? 0)) fi++;
  const barMs = cfg.barMs;
  /** Pays the funding due in (bar open, bar close] on the position held at the close. */
  function payFunding(bar: Candle) {
    while (fi < funding.length && funding[fi].t <= bar.t + barMs) {
      if (size !== 0) {
        const pay = size * bar.c * funding[fi].rate; // long pays a positive rate
        cash -= pay;
        fundingPaid += pay;
        fundingPayments++;
        if (trip) { trip.net -= pay; trip.funding += pay; }
      }
      fi++;
    }
  }

  // Strategy state, mirroring the live tick.
  let lastDcaAt = -Infinity;
  const visitedLevels = new Set<number>();
  let sniperFired = false;
  let holdOpened = false;
  let pending: { isBuy?: boolean; action?: string; reason: string; sizeUsd?: number; bracket?: { stopLossPct: number; takeProfitPct: number } | null } | null = null;
  const sideBuy = (d?: Direction) => d !== "short";

  for (let i = start; i < candles.length; i++) {
    if (cfg.shouldStop?.()) {
      endedEarly = true;
      break;
    }
    const bar = candles[i];
    barIdx = i;

    // 1. Orders signalled at the previous close fill at this bar's open.
    if (pending) {
      const p = pending;
      pending = null;
      if (p.action) {
        if (p.action === "close") closeAll(bar.t, bar.o, p.reason);
        else if (p.action === "flip-long" || p.action === "flip-short") {
          closeAll(bar.t, bar.o, p.reason);
          if (fill(bar.t, p.action === "flip-long", sizeUsd, bar.o, p.reason)) bracket = p.bracket ?? null;
        } else if (p.action === "open-long" || p.action === "open-short") {
          if (fill(bar.t, p.action === "open-long", sizeUsd, bar.o, p.reason)) bracket = p.bracket ?? null;
        }
        if (size === 0) openedAt = null;
      } else if (p.isBuy != null) {
        fill(bar.t, p.isBuy, p.sizeUsd ?? sizeUsd, bar.o, p.reason);
      }
    }

    // 1b. Stop loss / liquidation / take profit inside the bar.
    if (checkTriggers(bar)) {
      // Live, the bot's next round logs the exit; its cooldown counts from there.
      openedAt = null;
      lastExitAt = bar.t;
    }

    // 1c. Funding on the position held through this bar.
    payFunding(bar);

    // 2. Mark to the close; enforce the drawdown stop.
    if (size !== 0) heldBars++;
    const value = equityAt(bar.c);
    equity.push({ t: bar.t, value, px: bar.c });
    if (cfg.maxDrawdownStopPct != null && value <= startingBalance * (1 - cfg.maxDrawdownStopPct / 100)) {
      closeAll(bar.t, bar.c, "drawdown stop");
      equity[equity.length - 1] = { t: bar.t, value: equityAt(bar.c), px: bar.c };
      stoppedOut = `Equity fell ${cfg.maxDrawdownStopPct}% below the start — stopped`;
      break;
    }
    cfg.onProgress?.(i - start + 1, candles.length - start);
    if (i === candles.length - 1) break; // nothing can fill after the last bar

    // 3. Decide at the close, for the next bar's open.
    if (strategy.type === "hold") {
      if (!holdOpened) {
        holdOpened = true;
        pending = { isBuy: true, reason: "buy & hold" };
      }
    } else if (strategy.type === "dca") {
      const isBuy = sideBuy(strategy.direction);
      const smart = strategy.smart;
      const held = size !== 0 && (size > 0) === isBuy ? entry : null;
      if (smart && held != null && smartDcaTakeProfit(smart, bar.c, held, isBuy)) {
        pending = { action: "close", reason: `smart DCA take profit ${smart.takeProfitPct}%` };
      } else if (bar.t - lastDcaAt >= strategy.intervalMs) {
        lastDcaAt = bar.t;
        if (smart) {
          const next = smartDcaSize(sizeUsd, smart, bar.c, held, isBuy);
          pending = { isBuy, sizeUsd: next.sizeUsd, reason: `smart DCA ${isBuy ? "buy" : "sell"} step ${next.step}` };
        } else {
          pending = { isBuy, reason: `DCA ${isBuy ? "buy" : "sell"}` };
        }
      }
    } else if (strategy.type === "breakout") {
      const window = candles.slice(Math.max(0, i + 1 - breakoutHistory(strategy.params)), i + 1);
      const d = decideBreakout(strategy.params, window, size === 0 ? null : { isLong: size > 0 });
      if (d.action !== "hold") pending = { action: d.action, reason: `breakout: ${d.action}` };
    } else if (strategy.type === "grid") {
      const { lowerPrice, upperPrice, levels } = strategy;
      if (bar.c >= lowerPrice && bar.c <= upperPrice) {
        const step = (upperPrice - lowerPrice) / levels;
        const level = Math.round((bar.c - lowerPrice) / step);
        if (!visitedLevels.has(level)) {
          visitedLevels.add(level);
          pending = { isBuy: sideBuy(strategy.direction), reason: `grid level ${level}` };
        }
      }
    } else if (strategy.type === "sniper") {
      const hit = strategy.mode === "price-above" ? bar.c >= strategy.targetPrice : bar.c <= strategy.targetPrice;
      if (!sniperFired && hit) {
        sniperFired = true;
        pending = { isBuy: sideBuy(strategy.direction), reason: `sniper ${strategy.mode} ${strategy.targetPrice}` };
      }
    } else if (strategy.type === "ai" && (i - start) % Math.max(1, strategy.everyBars) === 0) {
      if (disciplined) {
        const reason = autoPauseReason(trips.map((tr) => ({
          coin: "", side: tr.side, entryPx: tr.entryPx, exitPx: tr.exitPx, pnlPct: tr.movePct,
          openedAt: tr.openedAt, closedAt: tr.closedAt, entryReason: "", exitReason: tr.exitReason,
        })), null);
        if (reason) {
          closeAll(bar.t, bar.c, "auto-pause");
          stoppedOut = reason;
          break;
        }
      }
      const pos = position(bar.c);
      const seen = candles.slice(0, i + 1);
      const { decision, reasoning } = await strategy.decide({ index: i, candles: seen, position: pos });
      let action = decisionToAction(decision, pos);
      let note: string | null = null;
      let entryBracket: { stopLossPct: number; takeProfitPct: number } | null = null;
      if (disciplined && action !== "hold") {
        const atr = atrPct(seen.slice(-40));
        const guarded = guardAction({
          action: action as GuardedAction,
          atr: action === "close" ? null : atr,
          openedAt, lastExitAt,
          roundMs: barMs * Math.max(1, strategy.everyBars),
          now: bar.t,
        });
        action = guarded.action as typeof action;
        note = guarded.note;
        if (atr != null && (action as string) !== "hold" && action !== "close") entryBracket = bracketFor(atr);
      }
      decisions.push({ t: bar.t, price: bar.c, decision, action, reasoning, ...(note ? { note } : {}) });
      if (action !== "hold") {
        pending = { action, reason: `AI ${decision}`, bracket: entryBracket };
        if (action === "close" || action.startsWith("flip")) lastExitAt = bar.t;
        if (action !== "close") openedAt = bar.t;
      }
    }
  }

  const values = equity.map((e) => e.value);
  const finalEquity = values.length ? values[values.length - 1] : startingBalance;
  const firstPx = candles[start]?.c ?? 0;
  const lastPx = equity.length ? equity[equity.length - 1].px : firstPx;
  const closing = trades.filter((t) => t.realizedPnl != null);

  return {
    equity,
    trades,
    trips,
    stats: tripStats(trips),
    decisions,
    startingBalance,
    finalEquity,
    returnPct: ((finalEquity - startingBalance) / startingBalance) * 100,
    buyHoldReturnPct: firstPx ? ((lastPx - firstPx) / firstPx) * 100 : 0,
    maxDrawdownPct: maxDrawdownPct(values),
    sharpe: sharpe(values, cfg.barMs),
    sortino: sortino(values, cfg.barMs),
    exposurePct: equity.length ? (heldBars / equity.length) * 100 : 0,
    fundingPaid,
    fundingPayments,
    liquidations,
    winRate: closing.length ? closing.filter((t) => (t.realizedPnl ?? 0) > 0).length / closing.length : null,
    closingTrades: closing.length,
    feesPaid,
    skippedForMargin,
    stoppedOut,
    endedEarly,
  };
}

/** Win rate, profit factor, expectancy and streaks over closed round trips. */
export function tripStats(trips: BacktestTrip[]): TripStats {
  const n = trips.length;
  const wins = trips.filter((t) => t.pnl > 0);
  const losses = trips.filter((t) => t.pnl <= 0);
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);
  const grossWin = sum(wins.map((t) => t.pnl));
  const grossLoss = -sum(losses.map((t) => t.pnl));
  let streak = 0;
  let maxConsecutiveLosses = 0;
  for (const t of trips) {
    streak = t.pnl > 0 ? 0 : streak + 1;
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, streak);
  }
  return {
    trips: n,
    winRate: n ? wins.length / n : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: avg(trips.map((t) => t.pnl)),
    expectancyPct: avg(trips.map((t) => t.pnlPct)),
    avgWin: avg(wins.map((t) => t.pnl)),
    avgLoss: avg(losses.map((t) => t.pnl)),
    best: n ? Math.max(...trips.map((t) => t.pnl)) : null,
    worst: n ? Math.min(...trips.map((t) => t.pnl)) : null,
    avgBarsHeld: avg(trips.map((t) => t.bars)),
    maxConsecutiveLosses,
  };
}

export interface MonteCarloResult {
  runs: number;
  /** Final return percentiles over resampled trip sequences. */
  p5ReturnPct: number;
  p50ReturnPct: number;
  p95ReturnPct: number;
  /** Share of runs that ended below the start, %. */
  lossChancePct: number;
  /** The drawdown 95% of runs stayed within. */
  p95DrawdownPct: number;
}

/** Minimum closed trips before a resample means anything. */
export const MONTE_CARLO_MIN_TRIPS = 8;

/**
 * Resamples the trips' net PnL with replacement `runs` times, each run as
 * many trips long as the backtest. A result that only looks good in its one
 * historical order shows a wide band and a real chance of loss here. Seeded,
 * so the same backtest always reports the same numbers. Null with too few trips.
 */
export function monteCarlo(trips: BacktestTrip[], startingBalance: number, runs = 1000, seed = 1): MonteCarloResult | null {
  if (trips.length < MONTE_CARLO_MIN_TRIPS || !(startingBalance > 0)) return null;
  let state = seed >>> 0 || 1;
  const rand = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pnls = trips.map((t) => t.pnl);
  const finals: number[] = [];
  const drawdowns: number[] = [];
  for (let r = 0; r < runs; r++) {
    let eq = startingBalance;
    let peak = eq;
    let dd = 0;
    for (let k = 0; k < pnls.length; k++) {
      eq += pnls[Math.floor(rand() * pnls.length)];
      peak = Math.max(peak, eq);
      if (peak > 0) dd = Math.max(dd, ((peak - Math.max(eq, 0)) / peak) * 100);
    }
    finals.push(((eq - startingBalance) / startingBalance) * 100);
    drawdowns.push(dd);
  }
  finals.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);
  const at = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  return {
    runs,
    p5ReturnPct: at(finals, 0.05),
    p50ReturnPct: at(finals, 0.5),
    p95ReturnPct: at(finals, 0.95),
    lossChancePct: (finals.filter((f) => f < 0).length / runs) * 100,
    p95DrawdownPct: at(drawdowns, 0.95),
  };
}

export interface SegmentStats {
  from: number;
  to: number;
  bars: number;
  returnPct: number;
  buyHoldReturnPct: number;
  edgePct: number;
  maxDrawdownPct: number;
  trips: number;
  tripWinRate: number | null;
}

/**
 * Splits one run's equity curve at `splitAt` (an index into result.equity)
 * into the part before and the held-out part after, each measured from its
 * own first bar and against holding the coin over the same bars. Trips count
 * toward the part they closed in. Null if either part is under 2 bars.
 */
export function splitResult(result: BacktestResult, splitAt: number): { inSample: SegmentStats; outOfSample: SegmentStats } | null {
  const eq = result.equity;
  if (splitAt < 2 || eq.length - splitAt < 2) return null;
  const seg = (a: number, b: number): SegmentStats => {
    const part = eq.slice(a, b);
    const first = a === 0 ? { value: result.startingBalance, px: part[0].px } : eq[a - 1];
    const last = part[part.length - 1];
    const from = part[0].t, to = last.t;
    const closed = result.trips.filter((t) => t.closedAt >= from && t.closedAt <= to);
    const returnPct = ((last.value - first.value) / first.value) * 100;
    const buyHoldReturnPct = ((last.px - first.px) / first.px) * 100;
    return {
      from, to, bars: part.length, returnPct, buyHoldReturnPct, edgePct: returnPct - buyHoldReturnPct,
      maxDrawdownPct: maxDrawdownPct([first.value, ...part.map((e) => e.value)]),
      trips: closed.length,
      tripWinRate: closed.length ? closed.filter((t) => t.pnl > 0).length / closed.length : null,
    };
  };
  return { inSample: seg(0, splitAt), outOfSample: seg(splitAt, eq.length) };
}
