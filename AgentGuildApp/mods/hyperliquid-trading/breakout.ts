/**
 * Squeeze breakout — a rule-based bot, no model. Volatility runs in cycles:
 * a quiet stretch (Bollinger Bands at their narrowest in a while) tends to
 * end in a directional move. The bot waits for that:
 *
 *   - Squeeze: the band width was the lowest of the last `squeezeLookback`
 *     bars at some point in the last `squeezeWithin` bars.
 *   - Entry: the close breaks out of the bands with a trend behind it — ADX
 *     at least `minAdx`, and +DI above −DI for a long (the reverse for a
 *     short, when shorts are allowed).
 *   - Exit: the close falls back through the middle band (when `exitOnMid`),
 *     or the order's stop loss / take profit fires.
 *
 * Pure and browser-safe: the live tick and the backtester call the same
 * rules, so a backtest predicts what the bot would have done.
 */
import { adx, bollinger, type Candle } from "./indicators";

export interface BreakoutParams {
  interval: string;
  bbLength: number;
  bbMult: number;
  squeezeLookback: number;
  squeezeWithin: number;
  adxLength: number;
  minAdx: number;
  allowShort: boolean;
  exitOnMid: boolean;
  stopLossPct?: number;
  takeProfitPct?: number;
}

/** 4h by default: on 1h bars a full squeeze-plus-trend setup is rare (real BTC history: none in 1000 bars). */
export const BREAKOUT_DEFAULTS: BreakoutParams = {
  interval: "4h",
  bbLength: 20,
  bbMult: 2,
  squeezeLookback: 120,
  squeezeWithin: 6,
  adxLength: 14,
  minAdx: 20,
  allowShort: true,
  exitOnMid: true,
  stopLossPct: 3,
  takeProfitPct: 6,
};

export type BreakoutAction = "open-long" | "open-short" | "close" | "hold";

export interface BreakoutDecision {
  action: BreakoutAction;
  reason: string;
}

/** Bars of history one decision needs. */
export function breakoutWarmup(p: BreakoutParams): number {
  return Math.max(p.bbLength + p.squeezeLookback + p.squeezeWithin, 2 * p.adxLength + 1) + 1;
}

/**
 * Bars a decision is computed over, live and in a backtest alike — Wilder
 * smoothing depends on where it starts, so both see the same window.
 */
export function breakoutHistory(p: BreakoutParams): number {
  return breakoutWarmup(p) + 50;
}

/** Band width for each of the last `count` bars, oldest first (null where there isn't enough history). */
export function widthSeries(closes: number[], p: Pick<BreakoutParams, "bbLength" | "bbMult">, count: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let end = closes.length - count + 1; end <= closes.length; end++) {
    out.push(end > 0 ? bollinger(closes.slice(0, end), p.bbLength, p.bbMult)?.widthPct ?? null : null);
  }
  return out;
}

/** Whether a squeeze printed in the last `squeezeWithin` bars. */
export function recentSqueeze(closes: number[], p: BreakoutParams): boolean {
  const widths = widthSeries(closes, p, p.squeezeLookback + p.squeezeWithin);
  for (let k = widths.length - p.squeezeWithin; k < widths.length; k++) {
    const w = widths[k];
    if (w == null) continue;
    const window = widths.slice(Math.max(0, k - p.squeezeLookback + 1), k + 1).filter((x): x is number => x != null);
    if (window.length >= Math.min(p.squeezeLookback, 30) && w <= Math.min(...window) + 1e-12) return true;
  }
  return false;
}

/** One decision at the latest close. `position` is the bot's open side, or null when flat. */
export function decideBreakout(p: BreakoutParams, candles: Candle[], position: { isLong: boolean } | null): BreakoutDecision {
  if (candles.length < breakoutWarmup(p)) return { action: "hold", reason: `Needs ${breakoutWarmup(p)} bars of history, has ${candles.length}.` };
  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1];
  const bands = bollinger(closes, p.bbLength, p.bbMult);
  const trend = adx(candles, p.adxLength);
  if (!bands || !trend) return { action: "hold", reason: "Not enough history for the bands or ADX." };

  if (position) {
    if (p.exitOnMid && (position.isLong ? last < bands.mid : last > bands.mid)) {
      return { action: "close", reason: `Close ${fmt(last)} is back through the middle band ${fmt(bands.mid)}. Exiting the ${position.isLong ? "long" : "short"}.` };
    }
    return { action: "hold", reason: `Holding the ${position.isLong ? "long" : "short"}; mid band ${fmt(bands.mid)}, ADX ${trend.adx.toFixed(1)}.` };
  }

  const squeeze = recentSqueeze(closes, p);
  const trending = trend.adx >= p.minAdx;
  if (last > bands.upper && squeeze && trending && trend.plusDi > trend.minusDi) {
    return { action: "open-long", reason: `Breakout above ${fmt(bands.upper)} after a squeeze; ADX ${trend.adx.toFixed(1)}, +DI ${trend.plusDi.toFixed(1)} > −DI ${trend.minusDi.toFixed(1)}.` };
  }
  if (p.allowShort && last < bands.lower && squeeze && trending && trend.minusDi > trend.plusDi) {
    return { action: "open-short", reason: `Breakdown below ${fmt(bands.lower)} after a squeeze; ADX ${trend.adx.toFixed(1)}, −DI ${trend.minusDi.toFixed(1)} > +DI ${trend.plusDi.toFixed(1)}.` };
  }
  const why = !squeeze ? "no squeeze lately" : !trending ? `ADX ${trend.adx.toFixed(1)} under ${p.minAdx}` : "price inside the bands";
  return { action: "hold", reason: `Flat: ${why} (width ${bands.widthPct.toFixed(2)}%).` };
}

function fmt(n: number): string {
  return String(+n.toPrecision(6));
}

/** Validates params from a request body, filling defaults. */
export function buildBreakoutParams(raw: Record<string, unknown> | undefined, intervals: string[]): BreakoutParams | { error: string } {
  const num = (k: keyof BreakoutParams) => (raw?.[k] == null || raw[k] === "" ? (BREAKOUT_DEFAULTS[k] as number | undefined) : Number(raw[k]));
  const bool = (k: "allowShort" | "exitOnMid") => (raw?.[k] == null ? BREAKOUT_DEFAULTS[k] : raw[k] === true || raw[k] === "true");
  const p: BreakoutParams = {
    interval: typeof raw?.interval === "string" && raw.interval ? raw.interval : BREAKOUT_DEFAULTS.interval,
    bbLength: Math.round(num("bbLength")!),
    bbMult: num("bbMult")!,
    squeezeLookback: Math.round(num("squeezeLookback")!),
    squeezeWithin: Math.round(num("squeezeWithin")!),
    adxLength: Math.round(num("adxLength")!),
    minAdx: num("minAdx")!,
    allowShort: bool("allowShort"),
    exitOnMid: bool("exitOnMid"),
    stopLossPct: num("stopLossPct") || undefined,
    takeProfitPct: num("takeProfitPct") || undefined,
  };
  if (!intervals.includes(p.interval)) return { error: `interval must be one of ${intervals.join(", ")}` };
  if (!(p.bbLength >= 5 && p.bbLength <= 200)) return { error: "bbLength must be between 5 and 200" };
  if (!(p.bbMult > 0 && p.bbMult <= 5)) return { error: "bbMult must be between 0 and 5" };
  if (!(p.squeezeLookback >= 20 && p.squeezeLookback <= 500)) return { error: "squeezeLookback must be between 20 and 500" };
  if (!(p.squeezeWithin >= 1 && p.squeezeWithin <= 50)) return { error: "squeezeWithin must be between 1 and 50" };
  if (!(p.adxLength >= 5 && p.adxLength <= 100)) return { error: "adxLength must be between 5 and 100" };
  if (!(p.minAdx >= 0 && p.minAdx <= 100)) return { error: "minAdx must be between 0 and 100" };
  if (p.stopLossPct != null && !(p.stopLossPct > 0 && p.stopLossPct < 100)) return { error: "stopLossPct must be between 0 and 100" };
  if (p.takeProfitPct != null && !(p.takeProfitPct > 0 && p.takeProfitPct < 1000)) return { error: "takeProfitPct must be above 0" };
  return p;
}
