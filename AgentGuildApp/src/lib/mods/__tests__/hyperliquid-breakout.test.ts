import { describe, it, expect } from "vitest";
import { adx, bollinger, stdev, type Candle } from "../../../../mods/hyperliquid-trading/indicators";
import {
  BREAKOUT_DEFAULTS,
  breakoutHistory,
  breakoutWarmup,
  buildBreakoutParams,
  decideBreakout,
  recentSqueeze,
  type BreakoutParams,
} from "../../../../mods/hyperliquid-trading/breakout";

const H = 3_600_000;
const bar = (t: number, c: number, spread = 0.002): Candle => ({ t: t * H, o: c, h: c * (1 + spread), l: c * (1 - spread), c, v: 1 });

/** Noisy chop for `n` bars, then `quiet` near-flat bars (the squeeze), then optionally a breakout bar. */
function squeezeThen(breakout: number | null, n = 140, quiet = 20): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) out.push(bar(i, 100 * (1 + 0.04 * Math.sin(i / 3)), 0.01));
  for (let i = 0; i < quiet; i++) out.push(bar(n + i, 100 * (1 + 0.001 * Math.sin(i)), 0.001));
  if (breakout != null) {
    // A run of rising closes so ADX and +DI register a trend, ending in the breakout close.
    const start = n + quiet;
    for (let k = 1; k <= 3; k++) {
      const c = 100 * (1 + (breakout / 100) * (k / 3));
      const o = out[out.length - 1].c;
      out.push({ t: (start + k) * H, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1 });
    }
  }
  return out;
}

const params: BreakoutParams = { ...BREAKOUT_DEFAULTS, squeezeLookback: 100, squeezeWithin: 8, minAdx: 10 };

describe("bollinger / stdev / adx", () => {
  it("bands are mean ± mult·σ", () => {
    const closes = [1, 2, 3, 4, 5];
    const b = bollinger(closes, 5, 2)!;
    expect(b.mid).toBe(3);
    expect(stdev(closes, 5)).toBeCloseTo(Math.sqrt(2));
    expect(b.upper).toBeCloseTo(3 + 2 * Math.sqrt(2));
    expect(b.widthPct).toBeCloseTo(((4 * Math.sqrt(2)) / 3) * 100);
    expect(bollinger([1, 2], 5)).toBeNull();
  });

  it("ADX is high with +DI on top in a steady uptrend, null without enough bars", () => {
    const up = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i, 0.001));
    const a = adx(up, 14)!;
    expect(a.adx).toBeGreaterThan(50);
    expect(a.plusDi).toBeGreaterThan(a.minusDi);
    const down = Array.from({ length: 60 }, (_, i) => bar(i, 200 - i, 0.001));
    expect(adx(down, 14)!.minusDi).toBeGreaterThan(adx(down, 14)!.plusDi);
    expect(adx(up.slice(0, 28), 14)).toBeNull();
  });
});

describe("breakout rules", () => {
  it("needs the warm-up history", () => {
    expect(decideBreakout(params, squeezeThen(null).slice(0, 50), null).action).toBe("hold");
    expect(breakoutHistory(params)).toBe(breakoutWarmup(params) + 50);
  });

  it("detects the squeeze after a quiet stretch", () => {
    expect(recentSqueeze(squeezeThen(null).map((c) => c.c), params)).toBe(true);
    const chop = Array.from({ length: 160 }, (_, i) => 100 * (1 + 0.04 * Math.sin(i / 3)));
    expect(recentSqueeze(chop, params)).toBe(false);
  });

  it("opens long on a close above the upper band after a squeeze", () => {
    const d = decideBreakout(params, squeezeThen(3), null);
    expect(d.action).toBe("open-long");
  });

  it("opens short on a breakdown only when shorts are allowed", () => {
    const candles = squeezeThen(-3);
    expect(decideBreakout(params, candles, null).action).toBe("open-short");
    expect(decideBreakout({ ...params, allowShort: false }, candles, null).action).toBe("hold");
  });

  it("stays flat without a trend strong enough", () => {
    expect(decideBreakout({ ...params, minAdx: 99 }, squeezeThen(3), null).action).toBe("hold");
  });

  it("closes a long when the close falls back through the middle band", () => {
    const candles = squeezeThen(null);
    const last = candles[candles.length - 1];
    candles.push({ ...last, t: last.t + H, c: last.c * 0.99, l: last.c * 0.985 });
    expect(decideBreakout(params, candles, { isLong: true }).action).toBe("close");
    expect(decideBreakout({ ...params, exitOnMid: false }, candles, { isLong: true }).action).toBe("hold");
    expect(decideBreakout(params, candles, { isLong: false }).action).toBe("hold");
  });

  it("validates params", () => {
    const iv = ["15m", "1h", "4h"];
    expect(buildBreakoutParams({}, iv)).toMatchObject({ interval: "4h", bbLength: 20, allowShort: true, stopLossPct: 3 });
    expect(buildBreakoutParams({ allowShort: "false", stopLossPct: 0 }, iv)).toMatchObject({ allowShort: false, stopLossPct: undefined });
    expect(buildBreakoutParams({ interval: "2h" }, iv)).toHaveProperty("error");
    expect(buildBreakoutParams({ bbLength: 2 }, iv)).toHaveProperty("error");
    expect(buildBreakoutParams({ minAdx: 120 }, iv)).toHaveProperty("error");
  });
});
