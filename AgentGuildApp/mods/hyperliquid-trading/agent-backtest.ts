/**
 * Server-side backtests for agents (POST /backtest, tool hyperliquid_backtest).
 * The panel runs ./backtest.ts in the browser; an agent has no browser, so the
 * hub runs the same engine on candles it fetches. Rule bots only — an AI bot's
 * backtest asks the agent one question per bar, which the panel already does.
 *
 * By default the history is split: the first part is "in sample", the last
 * outOfSamplePct is "out of sample". A setting tuned until the in-sample
 * numbers look good and then falls apart out of sample is overfit — the
 * report puts both side by side, each against buy & hold over the same bars.
 *
 * Funding (when the hub could fetch its history) and liquidation at the
 * coin's max leverage are charged like the paper account; trade stats are
 * per round trip, and a Monte Carlo resample of those trips shows how much
 * of the result was the order they happened to come in.
 *
 * Pure: candles and funding come in, a report comes out.
 */
import { monteCarlo, runBacktest, type BacktestResult, type BacktestStrategy, type Direction, type FundingPoint, type MonteCarloResult, type TripStats } from "./backtest";
import { breakoutWarmup, buildBreakoutParams } from "./breakout";
import { buildSmartDca } from "./smart-dca";
import type { Candle } from "./indicators";

export const BACKTEST_DEFAULT_BARS = 500;
export const BACKTEST_MAX_BARS = 5000;
export const BACKTEST_DEFAULT_OOS_PCT = 30;
const RECENT_TRADES = 10;

export interface AgentBacktestSpec {
  type: "hold" | "dca" | "grid" | "sniper" | "breakout";
  coin: string;
  interval: string;
  bars: number;
  sizeUsd: number;
  leverage: number;
  startingBalance: number;
  strategy: BacktestStrategy;
  stopLossPct?: number;
  takeProfitPct?: number;
  /** Bars the strategy needs before its first decision (indicator warm-up). */
  warmup: number;
  /** Share of the bars, at the end, held out for the out-of-sample run. 0 = one run over everything. */
  outOfSamplePct: number;
}

export interface BacktestSummary {
  from: string;
  to: string;
  bars: number;
  returnPct: number;
  buyHoldReturnPct: number;
  /** returnPct − buyHoldReturnPct: what the bot added over holding the coin. */
  edgePct: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  sortino: number | null;
  /** Share of fills that realized a profit (see stats.winRate for round trips). */
  winRate: number | null;
  /** Per round trip: win rate, profit factor, expectancy, hold time, losing streak. */
  stats: TripStats;
  /** Share of bars spent holding a position, %. */
  exposurePct: number;
  /** Net funding paid in USD (negative = received). */
  fundingPaid: number;
  liquidations: number;
  /** Null under the minimum number of trips. */
  monteCarlo: MonteCarloResult | null;
  trades: number;
  closingTrades: number;
  feesPaid: number;
  skippedForMargin: number;
  stoppedOut: string | null;
  recentTrades: { t: string; side: "buy" | "sell"; price: number; notional: number; realizedPnl: number | null; reason: string }[];
}

export interface AgentBacktestReport {
  coin: string;
  type: AgentBacktestSpec["type"];
  interval: string;
  /** False when the hub couldn't fetch funding history; the run then ignores funding. */
  fundingModelled: boolean;
  /** The whole history, when outOfSamplePct is 0. */
  full?: BacktestSummary;
  inSample?: BacktestSummary;
  outOfSample?: BacktestSummary;
  verdict: string;
  /** The body to POST to /strategy (add paper: true) to run exactly this bot. */
  startBot: Record<string, unknown> | null;
}

const num = (v: unknown) => (v == null || v === "" ? undefined : Number(v));

/**
 * Validates a backtest request. Accepts settings flat beside `type` (how agent
 * tools send them) or inside `params` (how the panel's bot spec looks).
 */
export function buildAgentBacktest(body: Record<string, unknown>, intervals: string[]): AgentBacktestSpec | { error: string } {
  const p = (body.params && typeof body.params === "object" ? { ...body, ...(body.params as Record<string, unknown>) } : body) as Record<string, unknown>;
  const type = p.type;
  if (type !== "hold" && type !== "dca" && type !== "grid" && type !== "sniper" && type !== "breakout") {
    return { error: "type must be dca, grid, sniper, breakout or hold (AI bots are backtested from the panel)" };
  }
  const coin = typeof p.coin === "string" ? p.coin.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{1,20}$/.test(coin)) return { error: "coin is required, e.g. BTC" };

  const bars = Math.round(num(p.bars) ?? BACKTEST_DEFAULT_BARS);
  if (!(bars >= 50 && bars <= BACKTEST_MAX_BARS)) return { error: `bars must be between 50 and ${BACKTEST_MAX_BARS}` };
  const startingBalance = num(p.startingBalance) ?? 10_000;
  if (!(startingBalance >= 100 && startingBalance <= 10_000_000)) return { error: "startingBalance must be between 100 and 10,000,000" };
  const leverage = num(p.leverage) ?? 1;
  if (!(leverage >= 1 && leverage <= 50)) return { error: "leverage must be between 1 and 50" };
  const outOfSamplePct = num(p.outOfSamplePct) ?? BACKTEST_DEFAULT_OOS_PCT;
  if (!(outOfSamplePct >= 0 && outOfSamplePct <= 50)) return { error: "outOfSamplePct must be between 0 and 50" };
  const sizeUsd = type === "hold" ? startingBalance * 0.99 * leverage : Number(p.sizeUsd);
  if (!(sizeUsd >= 10)) return { error: "sizeUsd must be at least 10" };

  let direction: Direction | undefined;
  if (p.direction != null && p.direction !== "") {
    if (p.direction !== "long" && p.direction !== "short") return { error: "direction must be long or short" };
    direction = p.direction;
  }
  const pct = (k: "stopLossPct" | "takeProfitPct", max: number): number | undefined | { error: string } => {
    const v = num(p[k]);
    if (v == null || v === 0) return undefined;
    return v > 0 && v < max ? v : { error: `${k} must be a positive percent under ${max}` };
  };
  const sl = pct("stopLossPct", 100), tp = pct("takeProfitPct", 1000);
  if (typeof sl === "object") return sl;
  if (typeof tp === "object") return tp;

  const interval = typeof p.interval === "string" && p.interval ? p.interval : type === "breakout" ? "4h" : "1h";
  if (!intervals.includes(interval)) return { error: `interval must be one of ${intervals.join(", ")}` };
  const base = { coin, interval, bars, sizeUsd, leverage, startingBalance, outOfSamplePct };

  switch (type) {
    case "hold":
      return { ...base, type, strategy: { type: "hold" }, warmup: 0 };
    case "dca": {
      const intervalMs = num(p.intervalMs);
      if (!(intervalMs != null && intervalMs >= 60_000)) return { error: "intervalMs must be at least 60000 (1 minute)" };
      const smart = buildSmartDca(p.smart);
      if (smart && "error" in smart) return smart;
      return { ...base, type, strategy: { type: "dca", intervalMs, direction, smart }, stopLossPct: sl, takeProfitPct: tp, warmup: 0 };
    }
    case "grid": {
      const lowerPrice = Number(p.lowerPrice), upperPrice = Number(p.upperPrice), levels = Number(p.levels);
      if (!(lowerPrice > 0 && upperPrice > lowerPrice)) return { error: "lowerPrice must be above 0 and below upperPrice" };
      if (!(Number.isInteger(levels) && levels >= 2 && levels <= 200)) return { error: "levels must be a whole number from 2 to 200" };
      return { ...base, type, strategy: { type: "grid", lowerPrice, upperPrice, levels, direction }, stopLossPct: sl, takeProfitPct: tp, warmup: 0 };
    }
    case "sniper": {
      if (p.mode !== "price-above" && p.mode !== "price-below") return { error: "mode must be price-above or price-below (new-listing can't be backtested)" };
      const targetPrice = Number(p.targetPrice);
      if (!(targetPrice > 0)) return { error: "targetPrice is required" };
      return { ...base, type, strategy: { type: "sniper", mode: p.mode, targetPrice, direction }, stopLossPct: sl, takeProfitPct: tp, warmup: 0 };
    }
    case "breakout": {
      const params = buildBreakoutParams({ ...p, interval }, intervals);
      if ("error" in params) return params;
      const warmup = breakoutWarmup(params);
      if (bars < warmup + 40) return { error: `A breakout backtest needs at least ${warmup + 40} bars` };
      // The breakout strategy carries its own stop and target.
      return { ...base, type, strategy: { type: "breakout", params }, warmup };
    }
  }
}

/** Market data a run needs besides candles. */
export interface BacktestMarket {
  funding?: FundingPoint[] | null;
  maxLeverage?: number;
}

function summarize(result: BacktestResult, candles: Candle[], startIndex: number): BacktestSummary {
  const iso = (t: number) => new Date(t).toISOString();
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const r2n = (n: number | null) => (n == null ? null : r2(n));
  const st = result.stats;
  const mc = monteCarlo(result.trips, result.startingBalance);
  return {
    from: iso(candles[startIndex].t),
    to: iso(candles[candles.length - 1].t),
    bars: candles.length - startIndex,
    returnPct: r2(result.returnPct),
    buyHoldReturnPct: r2(result.buyHoldReturnPct),
    edgePct: r2(result.returnPct - result.buyHoldReturnPct),
    maxDrawdownPct: r2(result.maxDrawdownPct),
    sharpe: r2n(result.sharpe),
    sortino: r2n(result.sortino),
    winRate: r2n(result.winRate),
    stats: {
      trips: st.trips, winRate: r2n(st.winRate), profitFactor: r2n(st.profitFactor),
      expectancy: r2n(st.expectancy), expectancyPct: r2n(st.expectancyPct),
      avgWin: r2n(st.avgWin), avgLoss: r2n(st.avgLoss), best: r2n(st.best), worst: r2n(st.worst),
      avgBarsHeld: r2n(st.avgBarsHeld), maxConsecutiveLosses: st.maxConsecutiveLosses,
    },
    exposurePct: r2(result.exposurePct),
    fundingPaid: r2(result.fundingPaid),
    liquidations: result.liquidations,
    monteCarlo: mc && {
      runs: mc.runs, p5ReturnPct: r2(mc.p5ReturnPct), p50ReturnPct: r2(mc.p50ReturnPct), p95ReturnPct: r2(mc.p95ReturnPct),
      lossChancePct: r2(mc.lossChancePct), p95DrawdownPct: r2(mc.p95DrawdownPct),
    },
    trades: result.trades.length,
    closingTrades: result.closingTrades,
    feesPaid: r2(result.feesPaid),
    skippedForMargin: result.skippedForMargin,
    stoppedOut: result.stoppedOut,
    recentTrades: result.trades.slice(-RECENT_TRADES).map((t) => ({
      t: iso(t.t), side: t.side, price: t.price, notional: r2(t.notional),
      realizedPnl: t.realizedPnl == null ? null : r2(t.realizedPnl), reason: t.reason,
    })),
  };
}

async function runOn(spec: AgentBacktestSpec, candles: Candle[], barMs: number, market: BacktestMarket): Promise<BacktestSummary> {
  // The last bar can't trade (nothing fills after it).
  const startIndex = Math.min(spec.warmup, candles.length - 2);
  const result = await runBacktest({
    candles, barMs, strategy: spec.strategy, startIndex,
    startingBalance: spec.startingBalance, sizeUsd: spec.sizeUsd, leverage: spec.leverage,
    stopLossPct: spec.stopLossPct, takeProfitPct: spec.takeProfitPct,
    funding: market.funding ?? undefined, maxLeverage: market.maxLeverage,
  });
  return summarize(result, candles, startIndex);
}

function describe(s: BacktestSummary): string {
  const sign = (n: number) => `${n >= 0 ? "+" : ""}${n}%`;
  const pf = s.stats.profitFactor != null ? `, profit factor ${s.stats.profitFactor}` : "";
  const liq = s.liquidations ? `, ${s.liquidations} liquidation(s)` : "";
  return `${sign(s.returnPct)} vs buy & hold ${sign(s.buyHoldReturnPct)}, max drawdown ${s.maxDrawdownPct}%, ${s.trades} fills / ${s.stats.trips} round trips${pf}${liq}`;
}

/** One line on what reshuffling the trips says, or "" with too few. */
export function luckLine(mc: MonteCarloResult | null): string {
  if (!mc) return "";
  const sign = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n * 10) / 10}%`;
  const verdict = mc.lossChancePct >= 40 ? " — the result leans on luck." : mc.lossChancePct <= 10 ? " — robust to the order of trades." : ".";
  return ` Resampling its trips ${mc.runs}×: 90% of outcomes land between ${sign(mc.p5ReturnPct)} and ${sign(mc.p95ReturnPct)}, ${Math.round(mc.lossChancePct)}% lose money${verdict}`;
}

/** Runs a validated spec over candles (oldest first) and builds the report. */
export async function runAgentBacktest(spec: AgentBacktestSpec, candles: Candle[], barMs: number, market: BacktestMarket = {}): Promise<AgentBacktestReport | { error: string }> {
  if (candles.length < spec.warmup + 20) {
    return { error: `Only ${candles.length} bars of history came back for ${spec.coin}; this backtest needs at least ${spec.warmup + 20}` };
  }
  const report: AgentBacktestReport = {
    coin: spec.coin, type: spec.type, interval: spec.interval, fundingModelled: market.funding != null, verdict: "", startBot: startBotBody(spec),
  };
  const split = Math.floor(candles.length * (1 - spec.outOfSamplePct / 100));
  // Each half needs its warm-up plus room to trade; otherwise run once over everything.
  const canSplit = spec.outOfSamplePct > 0 && split - spec.warmup >= 20 && candles.length - split >= 20;
  if (!canSplit) {
    report.full = await runOn(spec, candles, barMs, market);
    report.verdict = `${describe(report.full)}.${luckLine(report.full.monteCarlo)}${spec.outOfSamplePct > 0 ? " Too few bars to hold some out of sample — ask for more bars." : ""}`;
    return report;
  }
  report.inSample = await runOn(spec, candles.slice(0, split), barMs, market);
  // The out-of-sample run re-reads the warm-up bars before the split, but trades only after it.
  report.outOfSample = await runOn(spec, candles.slice(split - spec.warmup), barMs, market);
  const ins = report.inSample, oos = report.outOfSample;
  report.verdict = `In sample ${describe(ins)}. Out of sample ${describe(oos)}. ${judge(ins, oos)}${luckLine(oos.monteCarlo)}`;
  return report;
}

/** One line on whether the edge over buy & hold survived the held-out bars. */
export function judge(ins: Pick<BacktestSummary, "edgePct" | "returnPct">, oos: Pick<BacktestSummary, "edgePct" | "returnPct">): string {
  if (oos.edgePct > 0 && oos.returnPct > 0) return "The edge held on bars it wasn't tuned on.";
  if (oos.edgePct > 0) return "Out of sample it lost less than holding the coin, but still lost money.";
  if (ins.edgePct > 0) return "It beat holding in sample but not out of sample — likely overfit; don't run it as is.";
  return "It didn't beat holding the coin.";
}

/** The POST /strategy body that starts the backtested bot. */
function startBotBody(spec: AgentBacktestSpec): Record<string, unknown> | null {
  const s = spec.strategy;
  const extras = {
    ...("direction" in s && s.direction === "short" ? { direction: "short" } : {}),
    ...(spec.stopLossPct ? { stopLossPct: spec.stopLossPct } : {}),
    ...(spec.takeProfitPct ? { takeProfitPct: spec.takeProfitPct } : {}),
  };
  const head = { coin: spec.coin, sizeUsd: spec.sizeUsd };
  switch (s.type) {
    case "dca": return { ...head, type: "dca", params: { intervalMs: s.intervalMs, ...(s.smart ? { smart: s.smart } : {}), ...extras } };
    case "grid": return { ...head, type: "grid", params: { lowerPrice: s.lowerPrice, upperPrice: s.upperPrice, levels: s.levels, ...extras } };
    case "sniper": return { ...head, type: "sniper", params: { mode: s.mode, targetPrice: s.targetPrice, ...extras } };
    case "breakout": return { ...head, type: "breakout", params: { ...s.params, ...(spec.leverage > 1 ? { leverage: spec.leverage } : {}) } };
    default: return null;
  }
}
