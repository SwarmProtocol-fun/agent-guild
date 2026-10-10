import { describe, it, expect } from "vitest";
import { PAIRS_DEFAULTS, backtestPairs, buildPairsParams, decidePairs, legSizes, type OpenPair, type PairsParams } from "../../../../mods/hyperliquid-trading/pairs";
import type { Candle } from "../../../../mods/hyperliquid-trading/indicators";

const H = 3_600_000;
const series = (closes: number[]): Candle[] => closes.map((c, i) => ({ t: i * H, o: c, h: c, l: c, c, v: 1 }));

/**
 * B swings; A = 2·B with ~1% spread noise (correlation ≈ 0.96), plus `kick`
 * (log) added to A from bar `from` on. Over 60 bars a last-bar kick of 2.5%
 * puts z ≈ 2.7, −2% ≈ −3.4, 8% ≈ 5.6, none ≈ −0.9.
 */
function pair(n: number, kick = 0, from = n): { A: Candle[]; B: Candle[] } {
  const b = Array.from({ length: n }, (_, i) => 100 * Math.exp(0.3 * Math.sin(i / 5)));
  const a = b.map((x, i) => 2 * x * Math.exp(0.01 * Math.sin(i * 2.3) + (i >= from ? kick : 0)));
  return { A: series(a), B: series(b) };
}

const params: PairsParams = { ...PAIRS_DEFAULTS, coins: ["A", "B"], lookbackBars: 60 };

describe("pairs rules", () => {
  it("opens long the cheap leg, short the rich leg, past entryZ", () => {
    const { A, B } = pair(60, 0.025, 59); // A jumps 2.5% rich on the last bar
    const d = decidePairs(params, { A, B }, null, 100, 59 * H);
    expect(d.action).toBe("open");
    if (d.action !== "open") return;
    expect(d.pair).toMatchObject({ longLeg: "B", shortLeg: "A" });
    expect(d.pair.z).toBeGreaterThan(2);
    expect(d.shortUsd).toBe(100); // A leg is sizeUsd
    expect(d.longUsd).toBeCloseTo(100 * Math.min(4, Math.max(0.25, d.pair.beta)));
  });

  it("holds inside the band and refuses a spread already past the stop", () => {
    const calm = pair(60);
    expect(decidePairs(params, calm, null, 100, 0).action).toBe("hold");
    const broken = pair(60, 0.08, 59);
    const d = decidePairs(params, broken, null, 100, 0);
    expect(d).toMatchObject({ action: "hold", reason: expect.stringMatching(/past the stop/) });
  });

  const open: OpenPair = { a: "A", b: "B", longLeg: "B", shortLeg: "A", entryZ: 2.5, beta: 1, openedAt: 0 };

  it("closes on convergence, on a sign flip, at the stop and on timeout", () => {
    const calm = pair(60);
    expect(decidePairs(params, calm, open, 100, H)).toMatchObject({ action: "close", reason: expect.stringMatching(/convergence/) });
    expect(decidePairs(params, pair(60, -0.02, 59), open, 100, H).action).toBe("close"); // crossed to the other side
    expect(decidePairs(params, pair(60, 0.08, 59), open, 100, H)).toMatchObject({ action: "close", reason: expect.stringMatching(/stop/) });
    const still = pair(60, 0.025, 59);
    expect(decidePairs(params, still, open, 100, H).action).toBe("hold");
    expect(decidePairs(params, still, open, 100, params.maxHoldBars * H)).toMatchObject({ action: "close", reason: expect.stringMatching(/Held 72 bars/) });
  });

  it("never holds one leg alone", () => {
    const d = decidePairs(params, pair(60, 0.025, 59), open, 100, H, { long: true, short: false });
    expect(d).toMatchObject({ action: "close", reason: expect.stringMatching(/A leg is gone/) });
  });

  it("picks the most stretched pair in a basket", () => {
    const { A, B } = pair(60, 0.025, 59);
    const noise = series(Array.from({ length: 60 }, (_, i) => 50 + ((i * 37) % 13)));
    const d = decidePairs({ ...params, coins: ["A", "B", "N"] }, { A, B, N: noise }, null, 100, 0);
    expect(d.action === "open" && `${d.pair.a}/${d.pair.b}`).toBe("A/B");
  });

  it("clamps β-weighting so a noisy hedge ratio can't blow up a leg", () => {
    expect(legSizes({ a: "A", b: "B", beta: 9, longLeg: "A" }, 100)).toEqual({ longUsd: 100, shortUsd: 400 });
    expect(legSizes({ a: "A", b: "B", beta: 0.01, longLeg: "B" }, 100)).toEqual({ longUsd: 25, shortUsd: 100 });
  });

  it("validates params", () => {
    const clean = (c: unknown) => (/^[A-Z]{1,5}$/.test(String(c).toUpperCase()) ? String(c).toUpperCase() : null);
    expect(buildPairsParams({ coins: "btc,eth" }, clean)).toMatchObject({ coins: ["BTC", "ETH"], entryZ: 2, exitZ: 0.5, stopZ: 4 });
    expect(buildPairsParams({ coins: ["BTC"] }, clean)).toEqual({ error: expect.stringMatching(/2 to 8/) });
    expect(buildPairsParams({ coins: ["BTC", "ETH"], entryZ: 1, exitZ: 1.5 }, clean)).toEqual({ error: expect.stringMatching(/exitZ < entryZ/) });
  });
});

describe("pairs backtest", () => {
  it("takes a stretch and books the convergence net of fees", () => {
    // A runs 3% rich for bars 80–84, then snaps back.
    const n = 140;
    const b = Array.from({ length: n }, (_, i) => 100 * Math.exp(0.3 * Math.sin(i / 5)));
    const a = b.map((x, i) => 2 * x * Math.exp(0.01 * Math.sin(i * 2.3) + (i >= 80 && i < 85 ? 0.03 : 0)));
    const r = backtestPairs({ ...params, lookbackBars: 60 }, { A: series(a), B: series(b) }, 100, H);
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    const t = r.trades[0];
    expect(t).toMatchObject({ longLeg: "B", shortLeg: "A", entryT: 80 * H });
    expect(t.exitT).toBe(85 * H);
    expect(t.pnl).toBeGreaterThan(1.5); // ~3% on the $100 short leg back, minus fees and leg noise
    expect(r.netPnl).toBeCloseTo(r.trades.reduce((s, x) => s + x.pnl, 0));
  });
});
