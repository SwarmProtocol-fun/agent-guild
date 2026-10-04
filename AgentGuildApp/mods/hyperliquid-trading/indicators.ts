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
