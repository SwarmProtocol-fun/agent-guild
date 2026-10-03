import { describe, it, expect } from "vitest";
import { parseOrder, describeOrder } from "../../../../mods/hyperliquid-trading/orders";

describe("hyperliquid plain-text orders", () => {
  it("reads a market order with leverage and SL/TP", () => {
    expect(parseOrder("long ETH $25 5x sl 3 tp 8%")).toEqual({
      kind: "trade", coin: "ETH", isBuy: true, sizeUsd: 25, orderType: "market", leverage: 5, stopLossPct: 3, takeProfitPct: 8,
    });
  });

  it("reads a limit short in any word order", () => {
    expect(parseOrder("short 50 sol @ 140")).toEqual({
      kind: "trade", coin: "SOL", isBuy: false, sizeUsd: 50, orderType: "limit", limitPrice: 140,
    });
    expect(parseOrder("sell SOL 1.5k limit 140")).toMatchObject({ sizeUsd: 1500, limitPrice: 140, isBuy: false });
  });

  it("reads close", () => {
    expect(parseOrder("close btc")).toEqual({ kind: "close", coin: "BTC" });
  });

  it("explains what's missing instead of guessing", () => {
    expect(parseOrder("long ETH")).toEqual({ error: expect.stringMatching(/How much/) });
    expect(parseOrder("long $20")).toEqual({ error: expect.stringMatching(/Which coin/) });
    expect(parseOrder("yolo ETH 20")).toEqual({ error: expect.stringMatching(/Start with/) });
    expect(parseOrder("long ETH 20 BTC")).toEqual({ error: expect.stringMatching(/btc/) });
  });

  it("reads back the order before it's sent", () => {
    const o = parseOrder("long ETH $25 5x sl 3");
    expect("error" in o ? o.error : describeOrder(o)).toBe("Long ETH · $25 · market · 5x · SL 3%");
  });
});
