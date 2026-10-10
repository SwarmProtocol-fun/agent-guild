import { describe, it, expect } from "vitest";
import {
  atr14,
  boxQuotes,
  coa,
  corridorProbability,
  dogSide,
  dominantLiquidations,
  evaluateBoxArm,
  evaluateBoxBailout,
  evaluateBoxCompletion,
  evaluateCorridor,
  evaluateFlipEntry,
  evaluateLiqCascade,
  evaluateNearLiq,
  evaluateSmallLiq,
  evaluateSpreadQuote,
  flipExitPlan,
  medianWindowAtr4,
  nearLiqArm,
  spreadCancelReason,
  volumeRatio,
  windowAtr4,
  BOX_DEFAULTS,
  CASCADE_DEFAULTS,
  CORRIDOR_DEFAULTS,
  FLIP_DEFAULTS,
  NEAR_LIQ_DEFAULTS,
  SMALL_LIQ_DEFAULTS,
  SPREAD_DEFAULTS,
} from "../../../../mods/polymarket-trading/fleet";
import type { Candle, Liquidation, WhalePosition } from "../../../../mods/polymarket-trading/feeds";

const MIN = 60_000;
const W = 1_800_000_000_000; // a 5-minute window start
const bar = (t: number, o: number, h: number, l: number, c: number, v?: number): Candle => ({ t, o, h, l, c, ...(v != null ? { v } : {}) });

describe("shared volatility measures", () => {
  it("ATR4 uses the window's first four closed bars, else the last four", () => {
    const bars = [bar(W - 2 * MIN, 0, 30, 0, 0), bar(W - MIN, 0, 30, 0, 0), bar(W, 0, 10, 0, 0), bar(W + MIN, 0, 20, 0, 0), bar(W + 2 * MIN, 0, 30, 0, 0)];
    expect(windowAtr4(bars, W, W + 3 * MIN)).toBe(20); // three in-window bars closed: (10+20+30)/3
    expect(windowAtr4(bars, W, W + MIN + 1)).toBeCloseTo(70 / 3); // only one in-window bar closed: falls back to the closed bars before now
  });

  it("median ATR4 across windows, ATR14 as mean true range, coa, dog side", () => {
    const day = [0, 1, 2].flatMap((w) => [0, 1, 2, 3].map((m) => bar(W + w * 5 * MIN + m * MIN, 0, (w + 1) * 10, 0, 0)));
    expect(medianWindowAtr4(day)).toBe(20);
    const trend = Array.from({ length: 15 }, (_, i) => bar(W + i * MIN, 100 + i, 102 + i, 99 + i, 101 + i));
    expect(atr14(trend, W + 15 * MIN)).toBe(3);
    expect(coa(100_010, 100_000, 50)).toBeCloseTo(0.2);
    expect(dogSide(99, 100)).toBe(0);
    expect(dogSide(101, 100)).toBe(1);
    expect(dogSide(100, 100)).toBeNull();
  });

  it("volume ratio compares the last closed bar with the 20 before it", () => {
    const bars = Array.from({ length: 21 }, (_, i) => bar(W + i * MIN, 0, 0, 0, 0, i === 20 ? 30 : 10));
    expect(volumeRatio(bars, W + 21 * MIN)).toBe(3);
    expect(volumeRatio(bars.slice(0, 5), W + 21 * MIN)).toBe(0);
  });
});

describe("corridor collector", () => {
  const base = { elapsed15Ms: 620_000, p0: 100_000, p10: 100_150, atr14: 100, ask15: [0.8, 0.2] as [number, number], ask5: [0.5, 0.45] as [number, number], params: CORRIDOR_DEFAULTS };

  it("buys the 15m leader + 5m opposite when the pair is under fair − edge", () => {
    const d = evaluateCorridor(base); // 15bps lead → 44% corridor, fair 1.44; 0.80 + 0.45 = 1.25 ≤ 1.36
    expect(d).toMatchObject({ action: "pair", lead15: 0, opp5: 1, limit15: 0.8, limit5: 0.45 });
    expect(corridorProbability(15)).toBe(0.44);
  });

  it("skips outside the action window, the lead zone, the ATR gate, caps and the price gate", () => {
    expect(evaluateCorridor({ ...base, elapsed15Ms: 500_000 }).action).toBe("skip");
    expect(evaluateCorridor({ ...base, p10: 100_020 }).reason).toMatch(/outside the 5–30bps zone/);
    expect(evaluateCorridor({ ...base, atr14: 500 }).reason).toMatch(/ATR14/);
    expect(evaluateCorridor({ ...base, ask5: [0.5, 0.6] }).reason).toMatch(/above the 0.55 cap/);
    expect(evaluateCorridor({ ...base, ask15: [0.93, 0.07], ask5: [0.5, 0.5] }).reason).toMatch(/pair costs \$1.43/);
  });
});

describe("flip harvester", () => {
  const base = { remainingMs: 60_000, spot: 99_999, strike: 100_000, atr4: 10, asks: [0.35, 0.66] as [number, number], params: FLIP_DEFAULTS };

  it("buys the trailing side in the last minute of a coin flip", () => {
    expect(evaluateFlipEntry(base)).toMatchObject({ action: "buy", outcomeIndex: 0, limitPrice: 0.45 });
  });

  it("skips early, wide cushions, cheap or dear dogs", () => {
    expect(evaluateFlipEntry({ ...base, remainingMs: 120_000 }).action).toBe("skip");
    expect(evaluateFlipEntry({ ...base, spot: 99_990 }).reason).toMatch(/Not a coin flip/);
    expect(evaluateFlipEntry({ ...base, asks: [0.2, 0.8] }).reason).toMatch(/cheap dogs lose/);
    expect(evaluateFlipEntry({ ...base, asks: [0.5, 0.5] }).reason).toMatch(/above 0.45/);
  });

  it("sells all in high vol, half in low vol, at 62¢", () => {
    expect(flipExitPlan(30, 20, FLIP_DEFAULTS)).toEqual({ regime: "high", fraction: 1, price: 0.62 });
    expect(flipExitPlan(10, 20, FLIP_DEFAULTS)).toEqual({ regime: "low", fraction: 0.5, price: 0.62 });
  });
});

describe("box builder", () => {
  it("quotes both best bids trimmed to ≤ 94¢ in a wide book early in the window", () => {
    expect(boxQuotes([0.5, 0.5], [0.53, 0.53], 0.94)).toEqual([0.47, 0.47]);
    const d = evaluateBoxArm({ elapsedMs: 10_000, asks: [0.55, 0.5], bids: [0.5, 0.45], params: BOX_DEFAULTS });
    expect(d).toMatchObject({ action: "quote", prices: [0.49, 0.45] });
  });

  it("won't arm in a tight book or after the quote cutoff", () => {
    expect(evaluateBoxArm({ elapsedMs: 10_000, asks: [0.51, 0.5], bids: [0.5, 0.49], params: BOX_DEFAULTS }).reason).toMatch(/tight/);
    expect(evaluateBoxArm({ elapsedMs: 200_000, asks: [0.55, 0.5], bids: [0.5, 0.45], params: BOX_DEFAULTS }).action).toBe("skip");
  });

  it("completes with a taker leg when cheap enough, else raises the bid only to the 3¢ cap", () => {
    expect(evaluateBoxCompletion({ p1: 0.45, otherAsk: 0.53, otherBestBid: 0.5, currentBid: 0.45, params: BOX_DEFAULTS })).toMatchObject({ action: "take", limitPrice: 0.54 });
    expect(evaluateBoxCompletion({ p1: 0.45, otherAsk: 0.6, otherBestBid: 0.5, currentBid: 0.45, params: BOX_DEFAULTS })).toMatchObject({ action: "rebid", price: 0.51 });
    expect(evaluateBoxCompletion({ p1: 0.45, otherAsk: 0.6, otherBestBid: 0.58, currentBid: 0.52, params: BOX_DEFAULTS })).toMatchObject({ action: "wait" });
  });

  it("holds a stranded leg only when it's winning by ≥ 1× ATR4", () => {
    expect(evaluateBoxBailout({ heldIndex: 0, spot: 100_020, strike: 100_000, atr4: 10, params: BOX_DEFAULTS }).action).toBe("hold");
    expect(evaluateBoxBailout({ heldIndex: 0, spot: 100_005, strike: 100_000, atr4: 10, params: BOX_DEFAULTS }).action).toBe("cut");
    expect(evaluateBoxBailout({ heldIndex: 1, spot: 100_020, strike: 100_000, atr4: 10, params: BOX_DEFAULTS }).action).toBe("cut");
  });
});

describe("spread-harvest maker", () => {
  const base = { remainingMs: 100_000, spot: 99_998, strike: 100_000, atr4: 10, asks: [0.62, 0.52] as [number, number], bids: [0.4, 0.45] as [number, number], params: SPREAD_DEFAULTS };

  it("rests the dog bid at best bid + 1¢ inside the 40–48¢ band in a wide coin flip", () => {
    expect(evaluateSpreadQuote(base)).toMatchObject({ action: "quote", outcomeIndex: 0, price: 0.41 });
  });

  it("skips a narrow book or a broken flip, and pulls the quote when either happens later", () => {
    expect(evaluateSpreadQuote({ ...base, asks: [0.55, 0.5] }).reason).toMatch(/isn't wide/);
    expect(evaluateSpreadQuote({ ...base, spot: 99_990 }).reason).toMatch(/Not a coin flip/);
    expect(spreadCancelReason({ ...base, spot: 99_990 })).toMatch(/Flip broke/);
    expect(spreadCancelReason({ ...base, asks: [0.53, 0.5] })).toMatch(/Spread collapsed/);
    expect(spreadCancelReason(base)).toBeNull();
  });
});

describe("liquidation bots", () => {
  it("finds the dominant one-sided flow (longs liquidated → Down)", () => {
    expect(dominantLiquidations({ long: 30_000, short: 5_000 }, 2)).toEqual({ side: "long", usd: 30_000, direction: 1 });
    expect(dominantLiquidations({ long: 30_000, short: 20_000 }, 2)).toBeNull();
  });

  const cascade = { elapsedMs: 120_000, spot: 99_800, strike: 100_000, flow: { long: 50_000, short: 0 }, volRatio: 4, asks: [0.3, 0.7] as [number, number], params: CASCADE_DEFAULTS };
  it("cascade chaser buys the cascade side with a move, volume and a 50–85¢ price", () => {
    expect(evaluateLiqCascade(cascade)).toMatchObject({ action: "buy", outcomeIndex: 1 });
    expect(evaluateLiqCascade({ ...cascade, spot: 99_950 }).reason).toMatch(/needs 0.15% down/);
    expect(evaluateLiqCascade({ ...cascade, volRatio: 1.5 }).reason).toMatch(/volume/);
    expect(evaluateLiqCascade({ ...cascade, asks: [0.1, 0.9] }).reason).toMatch(/fee eats/);
    expect(evaluateLiqCascade({ ...cascade, elapsedMs: 200_000 }).action).toBe("skip");
  });

  const small = { remainingMs: 150_000, flow: { long: 0, short: 120_000 }, asks: [0.4, 0.62] as [number, number], params: SMALL_LIQ_DEFAULTS };
  it("small-liq buys the cheap continuation side, sizes up ≥ $100k, leaves ≥ $500k alone", () => {
    expect(evaluateSmallLiq(small)).toMatchObject({ action: "buy", outcomeIndex: 0, sizeMult: 1.5 });
    expect(evaluateSmallLiq({ ...small, flow: { long: 0, short: 40_000 } })).toMatchObject({ sizeMult: 1 });
    expect(evaluateSmallLiq({ ...small, flow: { long: 0, short: 600_000 } }).reason).toMatch(/cascade bot's trade/);
    expect(evaluateSmallLiq({ ...small, asks: [0.5, 0.5] }).reason).toMatch(/outside 0.30–0.45/);
  });

  const now = 1_800_000_000_000;
  const whales: WhalePosition[] = [
    { address: "0xa", side: "long", usd: 250_000, liquidationPx: 99_700 },
    { address: "0xb", side: "short", usd: 500_000, liquidationPx: 101_000 },
    { address: "0xc", side: "long", usd: 50_000, liquidationPx: 99_990 },
  ];
  const liqs: Liquidation[] = [{ ts: now - 30_000, side: "long", usd: 8_000, price: 99_900, venue: "okx" }];

  it("near-liq arms on the closest big position and fires only on a same-side liquidation", () => {
    expect(nearLiqArm(whales, 100_000, NEAR_LIQ_DEFAULTS)).toMatchObject({ whale: { address: "0xa" }, count: 1 });
    expect(evaluateNearLiq({ now, spot: 100_000, whales, liquidations: liqs, asks: [0.7, 0.3], params: NEAR_LIQ_DEFAULTS })).toMatchObject({ action: "buy", outcomeIndex: 1 });
    expect(evaluateNearLiq({ now, spot: 100_000, whales, liquidations: [{ ...liqs[0], side: "short" }], asks: [0.7, 0.3], params: NEAR_LIQ_DEFAULTS }).reason).toMatch(/waiting for a ≥ \$5k long liquidation/);
    expect(evaluateNearLiq({ now, spot: 100_000, whales, liquidations: [{ ...liqs[0], ts: now - 200_000 }], asks: [0.7, 0.3], params: NEAR_LIQ_DEFAULTS }).action).toBe("skip");
    expect(evaluateNearLiq({ now, spot: 101_000, whales: [whales[0]], liquidations: liqs, asks: [0.7, 0.3], params: NEAR_LIQ_DEFAULTS }).reason).toMatch(/Not armed/);
  });
});
