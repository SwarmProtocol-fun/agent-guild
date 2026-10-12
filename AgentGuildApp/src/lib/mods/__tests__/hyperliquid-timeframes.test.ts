import { describe, it, expect } from "vitest";
import { higherTimeframes, summarizeTimeframe, timeframeBrief, timeframeSection } from "../../../../mods/hyperliquid-trading/timeframes";
import { buildCoinBlock, buildSnapshot } from "../../../../mods/hyperliquid-trading/ai-trader-core";

const HOUR = 3_600_000;
/** Candles following `closes`, each opening at the previous close, with a 1% range. */
const candles = (closes: number[], barMs = HOUR) => closes.map((c, i) => {
  const o = i ? closes[i - 1] : c;
  return { t: i * barMs, o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, v: 1 };
});
const ramp = (from: number, to: number, n: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));

describe("higher-timeframe context", () => {
  it("picks the longer charts above the bot's own", () => {
    expect(higherTimeframes("1m")).toEqual(["1h", "4h", "1d"]);
    expect(higherTimeframes("15m")).toEqual(["1h", "4h", "1d"]);
    expect(higherTimeframes("1h")).toEqual(["4h", "1d"]);
    expect(higherTimeframes("15m", 2)).toEqual(["4h", "1d"]);
    expect(higherTimeframes("1d")).toEqual([]);
  });

  it("reads trend, range position and change off the candles", () => {
    const up = summarizeTimeframe("4h", candles(ramp(100, 160, 60)))!;
    expect(up).toMatchObject({ interval: "4h", trend: "up" });
    expect(up.closeVsSma20Pct).toBeGreaterThan(0);
    expect(up.rangePosPct).toBeGreaterThan(90);
    expect(up.changePct).toBeGreaterThan(10); // the last 20 of 60 bars climbed about 140 → 160
    expect(summarizeTimeframe("1d", candles(ramp(160, 100, 60)))!.trend).toBe("down");
    const chop = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 1 : -1));
    expect(summarizeTimeframe("1h", candles(chop))!.trend).toBe("range");
    expect(summarizeTimeframe("1h", candles(ramp(100, 110, 30)))).toBeNull();
  });

  it("says when the bigger charts agree, and puts the section in the question", () => {
    const up4h = summarizeTimeframe("4h", candles(ramp(100, 160, 60)));
    const up1d = summarizeTimeframe("1d", candles(ramp(80, 160, 60)));
    const down1h = summarizeTimeframe("1h", candles(ramp(170, 160, 60)));
    expect(timeframeSection([up4h, up1d])).toMatch(/^HIGHER TIMEFRAMES \(bigger picture, all up\)\n4h: trend=up .*\n1d: trend=up /);
    expect(timeframeSection([down1h, up4h, null])).toMatch(/mixed/);
    expect(timeframeSection([null])).toBe("");
    expect(timeframeBrief([up4h, up1d])).toMatch(/^htf: 4h=up\(rsi \d+\) 1d=up\(rsi \d+\)$/);

    const base = { coin: "ETH", candles: candles(ramp(100, 101, 60), 15 * 60_000), interval: "15m" };
    expect(buildSnapshot({ ...base, higherTimeframes: timeframeSection([up4h, up1d]) })).toContain("HIGHER TIMEFRAMES (bigger picture, all up)");
    expect(buildCoinBlock({ ...base, higherTimeframes: timeframeBrief([up4h]) })).toContain("htf: 4h=up");
    expect(buildSnapshot(base)).not.toContain("HIGHER TIMEFRAMES");
  });
});
