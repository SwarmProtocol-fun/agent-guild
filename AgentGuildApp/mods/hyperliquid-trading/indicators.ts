/**
 * Plain-math indicators shared by the AI trader's market snapshot and the
 * backtester. Hand-rolled (no TA library) so the same candles always give
 * the same numbers on every machine — a backtest must agree with the live
 * bot it's meant to predict.
 */

export interface Candle {
  /** Bar open time, ms since epoch. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Simple moving average of the last `length` values, or null if there aren't enough. */
export function sma(values: number[], length: number): number | null {
  if (length <= 0 || values.length < length) return null;
  let sum = 0;
  for (let i = values.length - length; i < values.length; i++) sum += values[i];
  return sum / length;
}

/** Wilder's RSI over closes (the TA-Lib / TradingView definition), or null if there aren't enough. */
export function rsi(closes: number[], length = 14): number | null {
  if (closes.length <= length) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / length;
  let avgLoss = loss / length;
  for (let i = length + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (length - 1) + Math.max(d, 0)) / length;
    avgLoss = (avgLoss * (length - 1) + Math.max(-d, 0)) / length;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Wilder's Average True Range over candles, or null if there aren't enough. */
export function atr(candles: Candle[], length = 14): number | null {
  if (length <= 0 || candles.length <= length) return null;
  const tr = (i: number) => {
    const c = candles[i];
    const prev = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev));
  };
  let value = 0;
  for (let i = 1; i <= length; i++) value += tr(i);
  value /= length;
  for (let i = length + 1; i < candles.length; i++) value = (value * (length - 1) + tr(i)) / length;
  return value;
}

/** Largest peak-to-trough fall of an equity curve, as a positive percent. */
export function maxDrawdownPct(equity: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    if (peak > 0) worst = Math.max(worst, ((peak - e) / peak) * 100);
  }
  return worst;
}

/** Sharpe ratio of per-bar returns, annualized for the bar length (risk-free rate 0). Null with too little data or no variance. */
export function sharpe(equity: number[], barMs: number): number | null {
  if (equity.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    if (equity[i - 1] > 0) rets.push(equity[i] / equity[i - 1] - 1);
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  if (!sd) return null;
  const barsPerYear = (365 * 24 * 3_600_000) / barMs;
  return (mean / sd) * Math.sqrt(barsPerYear);
}

/** Population standard deviation of the last `length` values, or null if there aren't enough. */
export function stdev(values: number[], length: number): number | null {
  const mean = sma(values, length);
  if (mean == null) return null;
  let sum = 0;
  for (let i = values.length - length; i < values.length; i++) sum += (values[i] - mean) ** 2;
  return Math.sqrt(sum / length);
}

export interface Bands {
  mid: number;
  upper: number;
  lower: number;
  /** (upper − lower) / mid, in percent — the squeeze measure. */
  widthPct: number;
}

/** Bollinger Bands over the last `length` closes, or null if there aren't enough. */
export function bollinger(closes: number[], length = 20, mult = 2): Bands | null {
  const mid = sma(closes, length);
  const sd = stdev(closes, length);
  if (mid == null || sd == null || !(mid > 0)) return null;
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd, widthPct: ((2 * mult * sd) / mid) * 100 };
}

export interface Adx {
  adx: number;
  plusDi: number;
  minusDi: number;
}

/**
 * Wilder's ADX with its +DI/−DI lines (the TA-Lib / TradingView definition).
 * Needs 2 × length + 1 candles; null with fewer.
 */
export function adx(candles: Candle[], length = 14): Adx | null {
  if (length <= 0 || candles.length < 2 * length + 1) return null;
  let tr = 0, plus = 0, minus = 0;
  const step = (i: number) => {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.h - p.h;
    const down = p.l - c.l;
    return {
      tr: Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)),
      plus: up > down && up > 0 ? up : 0,
      minus: down > up && down > 0 ? down : 0,
    };
  };
  for (let i = 1; i <= length; i++) {
    const s = step(i);
    tr += s.tr;
    plus += s.plus;
    minus += s.minus;
  }
  const di = () => ({ p: tr > 0 ? (100 * plus) / tr : 0, m: tr > 0 ? (100 * minus) / tr : 0 });
  const dx = () => {
    const { p, m } = di();
    return p + m > 0 ? (100 * Math.abs(p - m)) / (p + m) : 0;
  };
  const dxs = [dx()];
  for (let i = length + 1; i < candles.length; i++) {
    const s = step(i);
    tr = tr - tr / length + s.tr;
    plus = plus - plus / length + s.plus;
    minus = minus - minus / length + s.minus;
    dxs.push(dx());
  }
  let value = dxs.slice(0, length).reduce((a, b) => a + b, 0) / length;
  for (let i = length; i < dxs.length; i++) value = (value * (length - 1) + dxs[i]) / length;
  const { p, m } = di();
  return { adx: value, plusDi: p, minusDi: m };
}
