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
 * slippage and a taker fee. Stop loss and take profit are checked inside
 * each bar against its high and low, stop first (the cautious reading when
 * one bar touches both), and fill at the trigger — or at the open when the
 * bar gaps through it. Equity is marked at every close. Pure and
 * environment-free — it runs in the browser (the panel's Backtest tab) and
 * in tests; the AI's `decide` is the only thing that reaches the network.
 */
import { decisionToAction, type AiDecision, type AiPosition } from "./ai-trader-core";
import { breakoutHistory, decideBreakout, type BreakoutParams } from "./breakout";
import { maxDrawdownPct, sharpe, type Candle } from "./indicators";
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

export interface BacktestDecision {
  t: number;
  price: number;
  decision: AiDecision;
  action: string;
  reasoning?: string;
}

export interface BacktestResult {
  equity: { t: number; value: number }[];
  trades: BacktestTrade[];
  decisions: BacktestDecision[];
  startingBalance: number;
  finalEquity: number;
  returnPct: number;
  /** Price return of simply holding the coin over the same bars (1x). */
  buyHoldReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number | null;
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
  const start = Math.max(0, Math.min(cfg.startIndex ?? 0, candles.length - 1));

  let cash = startingBalance; // realized balance: deposits + realized PnL − fees
  let size = 0; // signed coin size; > 0 long
  let entry = 0;
  let feesPaid = 0;
  let skippedForMargin = 0;
  let stoppedOut: string | null = null;
  let endedEarly = false;
  const trades: BacktestTrade[] = [];
  const decisions: BacktestDecision[] = [];
  const equity: { t: number; value: number }[] = [];

  const equityAt = (px: number) => cash + size * (px - entry);
  const position = (px: number): AiPosition | null =>
    size === 0 ? null : { isLong: size > 0, size, entryPx: entry, unrealizedPnl: size * (px - entry) };

  /** Fills a market order for `notional` USD at `px`; returns false if refused for margin. */
  function fill(t: number, isBuy: boolean, notional: number, px: number, reason: string, reduceOnly = false): boolean {
    const price = px * (isBuy ? 1 + slip : 1 - slip);
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
    if (size !== 0 && Math.sign(signed) !== Math.sign(size)) {
      const closing = Math.min(Math.abs(signed), Math.abs(size));
      realized = closing * (price - entry) * Math.sign(size);
      cash += realized;
    }
    if (next === 0) {
      entry = 0;
    } else if (size === 0 || Math.sign(next) !== Math.sign(size)) {
      entry = price; // fresh position, or flipped through zero
    } else if (Math.abs(next) > Math.abs(size)) {
      entry = (entry * Math.abs(size) + price * qty) / Math.abs(next);
    }
    size = Math.abs(next) < 1e-12 ? 0 : next;

    const f = qty * price * fee;
    cash -= f;
    feesPaid += f;
    trades.push({ t, side: isBuy ? "buy" : "sell", price, size: qty, notional: qty * price, fee: f, realizedPnl: realized, reason });
    return true;
  }

  function closeAll(t: number, px: number, reason: string) {
    if (size !== 0) fill(t, size < 0, Math.abs(size) * px * 1.01, px, reason, true);
  }

  const stopLossPct = cfg.stopLossPct ?? (strategy.type === "breakout" ? strategy.params.stopLossPct : undefined);
  const takeProfitPct = cfg.takeProfitPct ?? (strategy.type === "breakout" ? strategy.params.takeProfitPct : undefined);
  /** Fires a stop loss or take profit the bar's range reached. Exits at the trigger, or the open if the bar gapped through it. */
  function checkTriggers(bar: Candle) {
    if (size === 0 || (!stopLossPct && !takeProfitPct)) return;
    const long = size > 0;
    const sl = stopLossPct ? entry * (long ? 1 - stopLossPct / 100 : 1 + stopLossPct / 100) : null;
    const tp = takeProfitPct ? entry * (long ? 1 + takeProfitPct / 100 : 1 - takeProfitPct / 100) : null;
    if (sl != null && (long ? bar.l <= sl : bar.h >= sl)) {
      closeAll(bar.t, long ? Math.min(bar.o, sl) : Math.max(bar.o, sl), `stop loss ${stopLossPct}%`);
    } else if (tp != null && (long ? bar.h >= tp : bar.l <= tp)) {
      closeAll(bar.t, long ? Math.max(bar.o, tp) : Math.min(bar.o, tp), `take profit ${takeProfitPct}%`);
    }
  }

  // Strategy state, mirroring the live tick.
  let lastDcaAt = -Infinity;
  const visitedLevels = new Set<number>();
  let sniperFired = false;
  let holdOpened = false;
  let pending: { isBuy?: boolean; action?: string; reason: string; sizeUsd?: number } | null = null;
  const sideBuy = (d?: Direction) => d !== "short";

  for (let i = start; i < candles.length; i++) {
    if (cfg.shouldStop?.()) {
      endedEarly = true;
      break;
    }
    const bar = candles[i];

    // 1. Orders signalled at the previous close fill at this bar's open.
    if (pending) {
      const p = pending;
      pending = null;
      if (p.action) {
        if (p.action === "close") closeAll(bar.t, bar.o, p.reason);
        else if (p.action === "flip-long" || p.action === "flip-short") {
          closeAll(bar.t, bar.o, p.reason);
          fill(bar.t, p.action === "flip-long", sizeUsd, bar.o, p.reason);
        } else if (p.action === "open-long" || p.action === "open-short") {
          fill(bar.t, p.action === "open-long", sizeUsd, bar.o, p.reason);
        }
      } else if (p.isBuy != null) {
        fill(bar.t, p.isBuy, p.sizeUsd ?? sizeUsd, bar.o, p.reason);
      }
    }

    // 1b. Stop loss / take profit inside the bar.
    checkTriggers(bar);

    // 2. Mark to the close; enforce the drawdown stop.
    const value = equityAt(bar.c);
    equity.push({ t: bar.t, value });
    if (cfg.maxDrawdownStopPct != null && value <= startingBalance * (1 - cfg.maxDrawdownStopPct / 100)) {
      closeAll(bar.t, bar.c, "drawdown stop");
      equity[equity.length - 1] = { t: bar.t, value: equityAt(bar.c) };
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
      const pos = position(bar.c);
      const { decision, reasoning } = await strategy.decide({ index: i, candles: candles.slice(0, i + 1), position: pos });
      const action = decisionToAction(decision, pos);
      decisions.push({ t: bar.t, price: bar.c, decision, action, reasoning });
      if (action !== "hold") pending = { action, reason: `AI ${decision}` };
    }
  }

  const values = equity.map((e) => e.value);
  const finalEquity = values.length ? values[values.length - 1] : startingBalance;
  const firstPx = candles[start]?.c ?? 0;
  const lastPx = candles[Math.min(start + Math.max(equity.length - 1, 0), candles.length - 1)]?.c ?? firstPx;
  const closing = trades.filter((t) => t.realizedPnl != null);

  return {
    equity,
    trades,
    decisions,
    startingBalance,
    finalEquity,
    returnPct: ((finalEquity - startingBalance) / startingBalance) * 100,
    buyHoldReturnPct: firstPx ? ((lastPx - firstPx) / firstPx) * 100 : 0,
    maxDrawdownPct: maxDrawdownPct(values),
    sharpe: sharpe(values, cfg.barMs),
    winRate: closing.length ? closing.filter((t) => (t.realizedPnl ?? 0) > 0).length / closing.length : null,
    closingTrades: closing.length,
    feesPaid,
    skippedForMargin,
    stoppedOut,
    endedEarly,
  };
}
