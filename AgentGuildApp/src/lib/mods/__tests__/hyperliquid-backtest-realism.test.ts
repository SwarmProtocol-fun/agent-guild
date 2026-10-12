import { describe, it, expect } from "vitest";
import { monteCarlo, runBacktest, splitResult, tripStats, TAKER_FEE, type BacktestStrategy, type BacktestTrip } from "../../../../mods/hyperliquid-trading/backtest";
import { luckLine } from "../../../../mods/hyperliquid-trading/agent-backtest";
import { MIN_HOLD_ROUNDS, PAUSE_TRIPS } from "../../../../mods/hyperliquid-trading/discipline";
import { sortino, type Candle } from "../../../../mods/hyperliquid-trading/indicators";
import type { AiDecision } from "../../../../mods/hyperliquid-trading/ai-trader-core";

const HOUR = 3_600_000;

/** Hourly bars through `closes`, each opening at the previous close, with a ±`range` fraction high/low around it. */
function bars(closes: number[], range = 0): Candle[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: i * HOUR, o, h: Math.max(o, c) * (1 + range), l: Math.min(o, c) * (1 - range), c, v: 1 };
  });
}
const flat = (n: number, px = 100) => Array.from({ length: n }, () => px);
const hold: BacktestStrategy = { type: "hold" };
const base = { barMs: HOUR, startingBalance: 1000, sizeUsd: 990, leverage: 1, slippage: 0, feeRate: 0 };

describe("funding", () => {
  it("charges a long the hourly rate on its notional, and pays a short", async () => {
    const candles = bars(flat(6));
    const funding = candles.map((k) => ({ t: k.t, rate: 0.001 }));
    const long = await runBacktest({ ...base, candles, strategy: hold, funding });
    // Opens at bar 1's open; pays at the funding times ending bars 1..5 (t = 2h..6h, the last one is past the data's end → 4 inside).
    expect(long.fundingPayments).toBeGreaterThanOrEqual(4);
    expect(long.fundingPaid).toBeCloseTo(long.fundingPayments * 9.9 * 100 * 0.001, 6);
    expect(long.finalEquity).toBeCloseTo(1000 - long.fundingPaid, 6);

    const short = await runBacktest({ ...base, candles, strategy: { type: "dca", intervalMs: 1000 * HOUR, direction: "short" }, funding });
    expect(short.fundingPaid).toBeLessThan(0);
    expect(short.finalEquity).toBeGreaterThan(1000);
  });

  it("ignores funding from before the first traded bar and when no history is passed", async () => {
    const candles = bars(flat(6));
    const early = await runBacktest({ ...base, candles, strategy: hold, funding: [{ t: -5 * HOUR, rate: 0.5 }] });
    expect(early.fundingPaid).toBe(0);
    expect((await runBacktest({ ...base, candles, strategy: hold })).fundingPayments).toBe(0);
  });

  it("books funding into the round trip it was paid during", async () => {
    const candles = bars([100, 100, 100, 100, 120]);
    const r = await runBacktest({ ...base, candles, strategy: hold, funding: candles.map((k) => ({ t: k.t, rate: 0.001 })), takeProfitPct: 10 });
    expect(r.trips).toHaveLength(1);
    expect(r.trips[0].funding).toBeCloseTo(r.fundingPaid, 6);
    expect(r.trips[0].pnl).toBeCloseTo(r.trips[0].exitPx * 9.9 - 990 - r.fundingPaid, 4);
  });
});

describe("liquidation", () => {
  it("liquidates a 10x long when the bar's low reaches the maintenance price", async () => {
    // 10x on $1000 = $10,000 notional; max leverage 50 → 1% maintenance. Liquidation ≈ 9.1% under entry.
    const candles = bars([100, 100, 100, 88, 88]);
    const r = await runBacktest({ ...base, candles, strategy: hold, sizeUsd: 9900, leverage: 10, maxLeverage: 50 });
    expect(r.liquidations).toBe(1);
    const liq = r.trades.find((t) => t.reason === "liquidation")!;
    expect(liq.price).toBeGreaterThan(90);
    expect(liq.price).toBeLessThan(91);
    // What's left is roughly the maintenance margin.
    expect(r.finalEquity).toBeGreaterThan(0);
    expect(r.finalEquity).toBeLessThan(120);
    expect(r.trips[0].exitReason).toBe("liquidation");
  });

  it("lets a stop nearer the entry fire before liquidation", async () => {
    const candles = bars([100, 100, 100, 88, 88]);
    const r = await runBacktest({ ...base, candles, strategy: hold, sizeUsd: 9900, leverage: 10, maxLeverage: 50, stopLossPct: 5 });
    expect(r.liquidations).toBe(0);
    expect(r.trades.at(-1)!.reason).toBe("stop loss 5%");
  });

  it("uses the coin's max leverage: a 3x-max coin liquidates sooner", async () => {
    // 2.5x long from 100: with 3x max (16.7% maintenance) it liquidates near 71.5; with 50x max near 60.
    const candles = bars([100, 100, 100, 70, 70]);
    const tight = await runBacktest({ ...base, candles, strategy: hold, sizeUsd: 2475, leverage: 2.5, maxLeverage: 3 });
    const loose = await runBacktest({ ...base, candles, strategy: hold, sizeUsd: 2475, leverage: 2.5, maxLeverage: 50 });
    expect(tight.liquidations).toBe(1);
    expect(loose.liquidations).toBe(0);
  });

  it("never liquidates an unlevered long", async () => {
    const r = await runBacktest({ ...base, candles: bars([100, 100, 10, 5]), strategy: hold });
    expect(r.liquidations).toBe(0);
  });
});

describe("round trips", () => {
  it("groups DCA buys and their take profit into one trip, net of fees", async () => {
    const candles = bars([100, 100, 90, 90, 120, 120]);
    const r = await runBacktest({ ...base, feeRate: TAKER_FEE, sizeUsd: 100, candles, strategy: { type: "dca", intervalMs: HOUR }, takeProfitPct: 20 });
    const trip = r.trips[0];
    expect(trip.side).toBe("long");
    // Average entry sits between the 100 and 90 buys.
    expect(trip.entryPx).toBeGreaterThan(90);
    expect(trip.entryPx).toBeLessThan(100);
    const realized = r.trades.filter((t) => t.t <= trip.closedAt).reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
    expect(trip.pnl).toBeCloseTo(realized - trip.fees, 6);
    expect(trip.exitReason).toMatch(/take profit/);
    expect(r.stats.trips).toBe(r.trips.length);
  });

  it("splits a flip into the trip it closes and the one it opens", async () => {
    const answers: AiDecision[] = ["LONG", "SHORT", "NOTHING"];
    const r = await runBacktest({
      ...base, sizeUsd: 500, candles: bars([100, 110, 110, 110, 110]),
      strategy: { type: "ai", everyBars: 1, decide: async () => ({ decision: answers.shift() ?? "NOTHING" }) },
    });
    expect(r.trips).toHaveLength(1);
    expect(r.trips[0].side).toBe("long");
    expect(r.trips[0].exitPx).toBe(110);
    expect(r.trips[0].pnl).toBeCloseTo(50, 6);
    // The short opened by the flip is still open at the end.
    expect(r.trades.at(-1)!.side).toBe("sell");
  });

  it("tracks exposure as the share of bars holding a position", async () => {
    const r = await runBacktest({ ...base, candles: bars(flat(10)), strategy: hold });
    expect(r.exposurePct).toBeCloseTo(90);
  });
});

describe("tripStats", () => {
  const trip = (pnl: number): BacktestTrip => ({
    side: "long", openedAt: 0, closedAt: 1, entryPx: 100, exitPx: 100, movePct: 0, pnl, pnlPct: pnl, fees: 0, funding: 0, bars: 4, exitReason: "x",
  });
  it("computes profit factor, expectancy and the losing streak", () => {
    const s = tripStats([10, -5, -5, -5, 20].map(trip));
    expect(s.profitFactor).toBeCloseTo(2);
    expect(s.expectancy).toBeCloseTo(3);
    expect(s.winRate).toBeCloseTo(0.4);
    expect(s.maxConsecutiveLosses).toBe(3);
    expect(s.avgWin).toBe(15);
    expect(s.avgLoss).toBe(-5);
    expect(s.avgBarsHeld).toBe(4);
  });
  it("has no profit factor without losses, and nothing at all without trips", () => {
    expect(tripStats([trip(1)]).profitFactor).toBeNull();
    expect(tripStats([])).toMatchObject({ trips: 0, winRate: null, expectancy: null, maxConsecutiveLosses: 0 });
  });
});

describe("monteCarlo", () => {
  const trips = (pnls: number[]) => pnls.map((pnl): BacktestTrip => ({
    side: "long", openedAt: 0, closedAt: 1, entryPx: 1, exitPx: 1, movePct: 0, pnl, pnlPct: 0, fees: 0, funding: 0, bars: 1, exitReason: "x",
  }));
  it("needs enough trips", () => {
    expect(monteCarlo(trips([1, 2, 3]), 1000)).toBeNull();
  });
  it("is reproducible, ordered, and never loses with only winners", () => {
    const t = trips([5, 8, 2, 9, 4, 6, 7, 3]);
    const a = monteCarlo(t, 1000)!;
    expect(monteCarlo(t, 1000)).toEqual(a);
    expect(a.p5ReturnPct).toBeLessThanOrEqual(a.p50ReturnPct);
    expect(a.p50ReturnPct).toBeLessThanOrEqual(a.p95ReturnPct);
    expect(a.lossChancePct).toBe(0);
    expect(a.p95DrawdownPct).toBe(0);
  });
  it("shows a real chance of loss for a coin-flip edge", () => {
    const mc = monteCarlo(trips([30, -28, 25, -30, 32, -27, 29, -31, 26, -24]), 1000)!;
    expect(mc.lossChancePct).toBeGreaterThan(20);
    expect(mc.p5ReturnPct).toBeLessThan(0);
    expect(luckLine(mc)).toMatch(/lose money/);
    expect(luckLine(null)).toBe("");
  });
});

describe("splitResult", () => {
  it("scores the held-out bars on their own against holding over the same bars", async () => {
    // Up 10% then down 10%: buy & hold makes money in sample and loses out of sample.
    const closes = [...Array.from({ length: 11 }, (_, i) => 100 + i), ...Array.from({ length: 10 }, (_, i) => 109 - i)];
    const r = await runBacktest({ ...base, candles: bars(closes), strategy: hold });
    const split = splitResult(r, 11)!;
    expect(split.inSample.returnPct).toBeGreaterThan(5);
    expect(split.outOfSample.returnPct).toBeLessThan(-5);
    // Holding is the strategy here, so its edge over holding is about zero in both parts.
    expect(Math.abs(split.outOfSample.edgePct)).toBeLessThan(0.5);
    expect(split.inSample.to).toBeLessThan(split.outOfSample.from);
    expect(splitResult(r, 1)).toBeNull();
  });
});

describe("AI discipline in the backtest", () => {
  // ±1% bars around a slow drift: ATR ≈ 2%, plenty of room for the entry gate.
  const lively = (n: number) => bars(Array.from({ length: n }, (_, i) => 100 + (i % 2)), 0.01);
  const ai = (answers: AiDecision[], discipline = true): BacktestStrategy => ({
    type: "ai", everyBars: 1, discipline, decide: async () => ({ decision: answers.shift() ?? "NOTHING" }),
  });

  it("refuses a close inside the minimum hold, then allows it", async () => {
    const r = await runBacktest({ ...base, sizeUsd: 500, startIndex: 20, candles: lively(30), strategy: ai(["LONG", "CLOSE", "CLOSE", "CLOSE", "CLOSE"]) });
    const closes = r.decisions.filter((d) => d.decision === "CLOSE");
    expect(closes[0].action).toBe("hold");
    expect(closes[0].note).toMatch(/must be held/);
    expect(closes.findIndex((d) => d.action === "close")).toBe(MIN_HOLD_ROUNDS - 1);
  });

  it("puts an ATR bracket on every entry", async () => {
    // Long, then a crash: the bracket's stop takes it out without a model decision.
    const closes = [...Array.from({ length: 22 }, (_, i) => 100 + (i % 2)), 80, 80, 80];
    const r = await runBacktest({ ...base, sizeUsd: 500, startIndex: 20, candles: bars(closes, 0.01), strategy: ai(["LONG"]) });
    expect(r.trips[0].exitReason).toMatch(/^stop loss/);
    const off = await runBacktest({ ...base, sizeUsd: 500, startIndex: 20, candles: bars(closes, 0.01), strategy: ai(["LONG"], false) });
    expect(off.trips).toHaveLength(0); // undisciplined: still holding at the end
  });

  it("refuses entries in a market too quiet to cover costs", async () => {
    const r = await runBacktest({ ...base, sizeUsd: 500, startIndex: 20, candles: bars(flat(30)), strategy: ai(["LONG"]) });
    expect(r.trades).toHaveLength(0);
    expect(r.decisions[0].note).toMatch(/Too quiet/);
  });

  it("auto-pauses after a run of losing trips", async () => {
    // Every bar opens 1% below the last close: each long is stopped or closed at a loss.
    const closes: number[] = [];
    let px = 1000;
    for (let i = 0; i < 400; i++) { closes.push(px); px *= i % 2 ? 0.985 : 1.002; }
    const always: AiDecision[] = Array.from({ length: 400 }, (_, i) => (i % 6 < 3 ? "LONG" : "CLOSE"));
    const r = await runBacktest({ ...base, sizeUsd: 200, startIndex: 20, candles: bars(closes, 0.01), strategy: ai(always) });
    expect(r.trips.length).toBeGreaterThanOrEqual(PAUSE_TRIPS);
    expect(r.stoppedOut).toMatch(/Auto-paused/);
  });
});

describe("sortino", () => {
  it("ignores upside volatility", () => {
    expect(sortino([100, 101, 102, 103], HOUR)).toBeNull();
    expect(sortino([100, 105, 103, 110, 108], HOUR)).toBeGreaterThan(0);
  });
});
