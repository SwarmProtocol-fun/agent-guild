/**
 * Higher-timeframe context for AI rounds. A bot deciding on 15-minute bars
 * only saw 15-minute bars, so it happily shorted a coin in a clean daily
 * uptrend. Each round now also gets a summary of the 1h / 4h / 1d charts
 * above its own interval: trend, distance from the averages, RSI,
 * volatility, the last 20 bars' change and where price sits in their range.
 *
 * Pure: candles in, text out. The server fetches and caches the candles.
 */
import { atr, rsi, sma, type Candle } from "./indicators";

/** The bigger-picture charts, shortest first. */
const CONTEXT_INTERVALS = ["1h", "4h", "1d"];
const ORDER = ["1m", "5m", "15m", "1h", "4h", "1d"];
/** Bars fetched per timeframe: SMA50 plus a little slack. */
export const TIMEFRAME_BARS = 60;
const RANGE_BARS = 20;

/** The context charts strictly longer than the bot's own; `max` keeps the longest ones. */
export function higherTimeframes(interval: string, max = 3): string[] {
  const own = ORDER.indexOf(interval);
  const longer = CONTEXT_INTERVALS.filter((tf) => ORDER.indexOf(tf) > own);
  return longer.slice(Math.max(0, longer.length - max));
}

export interface TimeframeSummary {
  interval: string;
  trend: "up" | "down" | "range";
  closeVsSma20Pct: number;
  sma20VsSma50Pct: number;
  rsi: number | null;
  atrPct: number | null;
  /** Close-to-close change over the last RANGE_BARS bars, %. */
  changePct: number;
  rangeLow: number;
  rangeHigh: number;
  /** Where the last close sits in that range: 0 = its low, 100 = its high. */
  rangePosPct: number;
}

/**
 * Up when close > SMA20 > SMA50, down when close < SMA20 < SMA50, else a
 * range. Null without enough bars for the SMA50.
 */
export function summarizeTimeframe(interval: string, candles: Candle[]): TimeframeSummary | null {
  if (candles.length < 50) return null;
  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1];
  const s20 = sma(closes, 20)!, s50 = sma(closes, 50)!;
  const recent = candles.slice(-RANGE_BARS);
  const rangeLow = Math.min(...recent.map((c) => c.l));
  const rangeHigh = Math.max(...recent.map((c) => c.h));
  const first = closes[closes.length - 1 - RANGE_BARS] ?? closes[0];
  const a = atr(candles, 14);
  return {
    interval,
    trend: last > s20 && s20 > s50 ? "up" : last < s20 && s20 < s50 ? "down" : "range",
    closeVsSma20Pct: ((last - s20) / s20) * 100,
    sma20VsSma50Pct: ((s20 - s50) / s50) * 100,
    rsi: rsi(closes, 14),
    atrPct: a != null ? (a / last) * 100 : null,
    changePct: ((last - first) / first) * 100,
    rangeLow, rangeHigh,
    rangePosPct: rangeHigh > rangeLow ? ((last - rangeLow) / (rangeHigh - rangeLow)) * 100 : 50,
  };
}

const signed = (n: number, digits = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
const px = (n: number) => String(+n.toPrecision(6));

/** One timeframe as one line of raw numbers. */
export function timeframeLine(s: TimeframeSummary): string {
  return [
    `${s.interval}: trend=${s.trend}`,
    `close_vs_sma20_pct=${signed(s.closeVsSma20Pct)}`,
    `sma20_vs_sma50_pct=${signed(s.sma20VsSma50Pct)}`,
    `rsi14=${s.rsi != null ? s.rsi.toFixed(1) : "n/a"}`,
    s.atrPct != null ? `atr14_pct=${s.atrPct.toFixed(3)}` : null,
    `change_${RANGE_BARS}bars_pct=${signed(s.changePct)}`,
    `range_${RANGE_BARS}bars=${px(s.rangeLow)}-${px(s.rangeHigh)} at_pct=${s.rangePosPct.toFixed(0)}`,
  ].filter(Boolean).join(" ");
}

/** The section a single-coin round gets. Empty when there's nothing above the bot's interval. */
export function timeframeSection(summaries: (TimeframeSummary | null)[]): string {
  const ok = summaries.filter((s): s is TimeframeSummary => s != null);
  if (!ok.length) return "";
  const trends = ok.map((s) => s.trend);
  const aligned = trends.every((t) => t === trends[0]) && trends[0] !== "range" ? `all ${trends[0]}` : "mixed";
  return [`HIGHER TIMEFRAMES (bigger picture, ${aligned})`, ...ok.map(timeframeLine)].join("\n");
}

/** The compact form a basket's coin block gets: just each timeframe's trend and RSI. */
export function timeframeBrief(summaries: (TimeframeSummary | null)[]): string | null {
  const ok = summaries.filter((s): s is TimeframeSummary => s != null);
  if (!ok.length) return null;
  return `htf: ${ok.map((s) => `${s.interval}=${s.trend}(rsi ${s.rsi != null ? s.rsi.toFixed(0) : "n/a"})`).join(" ")}`;
}
