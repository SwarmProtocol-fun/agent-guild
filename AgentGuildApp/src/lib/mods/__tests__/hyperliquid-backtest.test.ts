import { describe, it, expect } from "vitest";
import { runBacktest, TAKER_FEE } from "../../../../mods/hyperliquid-trading/backtest";
import { buildSnapshot, decisionRequest, decisionToAction, normalizeGoal, parseDecision, systemPrompt, type AiDecision } from "../../../../mods/hyperliquid-trading/ai-trader-core";
import { atr, maxDrawdownPct, rsi, sma, type Candle } from "../../../../mods/hyperliquid-trading/indicators";

const HOUR = 3_600_000;

/** Flat bars (o = h = l = c) through the given closes, one per hour. */
function bars(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ t: i * HOUR, o: c, h: c, l: c, c, v: 1 }));
}

describe("indicators", () => {
  it("atr is Wilder's average true range, gaps included", () => {
    const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: 1 });
    // Every bar ranges 2; a gap up from 100 to a 104–106 bar makes that bar's true range 6.
    const flat = Array.from({ length: 4 }, (_, i) => bar(i, 100, 101, 99, 100));
    expect(atr(flat, 3)).toBeCloseTo(2);
    expect(atr([...flat, bar(4, 105, 106, 104, 105)], 3)).toBeCloseTo((2 * 2 + 6) / 3);
    expect(atr(flat, 4)).toBeNull();
  });

  it("sma / rsi / drawdown", () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(sma([1], 2)).toBeNull();
    expect(rsi(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(100);
    expect(rsi(Array.from({ length: 20 }, () => 5))).toBe(50);
    expect(maxDrawdownPct([100, 120, 90, 130])).toBeCloseTo(25);
  });
});

describe("operator training goal", () => {
  it("keeps a written idea and rejects one that is too short or too long", () => {
    expect(normalizeGoal(null)).toEqual({ goal: null });
    expect(normalizeGoal("  Fade BTC when funding is extreme.  ").goal).toBe("Fade BTC when funding is extreme.");
    expect(normalizeGoal("buy").error).toMatch(/at least 8/);
    expect(normalizeGoal("x".repeat(801)).error).toMatch(/at most 800/);
    expect(normalizeGoal(12).error).toBe("goal must be text");
  });

  it("puts the goal in the question and still demands a decision word", () => {
    const goal = "Fade BTC when hourly funding is extreme. Stay flat otherwise.";
    const { system } = decisionRequest("BTC", "MARKET SNAPSHOT — BTC-PERP", null, goal);
    expect(system).toContain(`GOAL: ${goal}`);
    expect(system.endsWith("LONG, SHORT, CLOSE or NOTHING.")).toBe(true);
    expect(systemPrompt("ETH", null)).not.toContain("GOAL:");
  });
});

describe("AI decision mapping", () => {
  const long = { isLong: true, size: 1, entryPx: 100, unrealizedPnl: 0 };
  const short = { isLong: false, size: -1, entryPx: 100, unrealizedPnl: 0 };
  it.each<[AiDecision, typeof long | null, string]>([
    ["LONG", null, "open-long"],
    ["SHORT", null, "open-short"],
    ["CLOSE", null, "hold"],
    ["NOTHING", null, "hold"],
    ["LONG", long, "hold"],
    ["SHORT", long, "flip-short"],
    ["LONG", short, "flip-long"],
    ["CLOSE", short, "close"],
  ])("%s with %o → %s", (decision, position, action) => {
    expect(decisionToAction(decision, position)).toBe(action);
  });

  it("reads the decision from free text — the last decision word wins", () => {
    expect(parseDecision("Shorts look crowded, so not SHORT. Going LONG", false)).toBe("LONG");
    expect(parseDecision("I'd do nothing here.", false)).toBe("NOTHING");
    expect(parseDecision("CLOSE", false)).toBe("NOTHING"); // nothing to close while flat
    expect(parseDecision("close it", true)).toBe("CLOSE");
    expect(parseDecision("longer term unclear", false)).toBeNull(); // "longer" isn't LONG
  });

  it("snapshot shows only the candles it was given (no lookahead) and never the balance", () => {
    const candles = bars(Array.from({ length: 100 }, (_, i) => 100 + i));
    const snap = buildSnapshot({ coin: "ETH", candles: candles.slice(0, 50), interval: "1h" });
    expect(snap).toContain("last=149");
    expect(snap).toMatch(/atr14=[\d.]+ atr14_pct=[\d.]+/);
    expect(snap).not.toContain("150,");
    expect(snap.split("\n").filter((l) => /^\d{4}-/.test(l))).toHaveLength(50);
    expect(snap.toLowerCase()).not.toContain("balance");
  });
});

describe("runBacktest", () => {
  const base = { barMs: HOUR, startingBalance: 1000, sizeUsd: 1000, leverage: 1, slippage: 0 };

  it("buy & hold fills at the next open and marks to the close, net of the fee", async () => {
    // $990 of $1000: a 100% position can't also pay its own fee, so the engine refuses it.
    const r = await runBacktest({ ...base, sizeUsd: 990, candles: bars([100, 100, 110]), strategy: { type: "hold" } });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].price).toBe(100);
    expect(r.finalEquity).toBeCloseTo(1000 + 9.9 * 10 - 990 * TAKER_FEE);
    expect(r.buyHoldReturnPct).toBeCloseTo(10);
  });

  it("DCA buys once per interval, like the live tick", async () => {
    const r = await runBacktest({
      ...base, sizeUsd: 10, candles: bars(Array.from({ length: 10 }, () => 100)), strategy: { type: "dca", intervalMs: 3 * HOUR },
    });
    // Signals at bars 0, 3, 6 (bar 9 is last — nothing can fill after it).
    expect(r.trades.map((t) => t.t)).toEqual([1, 4, 7].map((i) => i * HOUR));
  });

  it("grid buys each level once and never sells it back", async () => {
    const r = await runBacktest({
      ...base, sizeUsd: 10,
      candles: bars([100, 90, 100, 110, 100, 90, 120]),
      strategy: { type: "grid", lowerPrice: 90, upperPrice: 110, levels: 2 },
    });
    expect(r.trades.every((t) => t.side === "buy")).toBe(true);
    expect(r.trades).toHaveLength(3); // levels 1 (100), 0 (90), 2 (110)
  });

  it("AI flips close the old side then open the new one, realizing PnL", async () => {
    const script: AiDecision[] = ["LONG", "NOTHING", "SHORT", "NOTHING"];
    let k = 0;
    const r = await runBacktest({
      ...base, sizeUsd: 500,
      candles: bars([100, 100, 120, 120, 120]),
      strategy: { type: "ai", everyBars: 1, decide: async () => ({ decision: script[k++] ?? "NOTHING" }) },
    });
    expect(r.decisions.map((d) => d.action)).toEqual(["open-long", "hold", "flip-short", "hold"]);
    const sides = r.trades.map((t) => t.side);
    expect(sides).toEqual(["buy", "sell", "sell"]);
    expect(r.trades[1].realizedPnl).toBeCloseTo(5 * 20); // 5 ETH long from 100 → 120
  });

  it("refuses orders the account can't margin", async () => {
    const r = await runBacktest({ ...base, startingBalance: 100, sizeUsd: 5000, candles: bars([100, 100, 100]), strategy: { type: "hold" } });
    expect(r.trades).toHaveLength(0);
    expect(r.skippedForMargin).toBe(1);
  });

  it("stops for good at the drawdown limit, closing the position", async () => {
    const r = await runBacktest({
      ...base, sizeUsd: 990, maxDrawdownStopPct: 50,
      candles: bars([100, 100, 80, 40, 30, 120]),
      strategy: { type: "hold" },
    });
    expect(r.stoppedOut).toMatch(/50%/);
    expect(r.trades.at(-1)?.reason).toBe("drawdown stop");
    expect(r.equity.length).toBeLessThan(6);
  });
});
