import { describe, it, expect } from "vitest";
import {
  liquidationDistancePct,
  liquidationTotals,
  parseBtcPosition,
  parseOkxLiquidations,
  topLeaderboardAddresses,
} from "../../../../mods/polymarket-trading/feeds";
import { restingFillShares, makerFill } from "../../../../mods/polymarket-trading/paper";
import { btc15mWindow, parseTapeRow } from "../../../../mods/polymarket-trading/markets";

describe("OKX liquidations", () => {
  const raw = {
    code: "0",
    data: [{ details: [
      { posSide: "short", side: "buy", sz: "2", bkPx: "100000", ts: "1000" },
      { posSide: "net", side: "sell", sz: "1", bkPx: "100000", ts: "2000" },
      { posSide: "long", side: "sell", sz: "bad", bkPx: "1", ts: "3000" },
    ] }],
  };

  it("parses sides (net-mode forced sells are longs) and USD from contracts", () => {
    const liqs = parseOkxLiquidations(raw, (p) => 0.01 * p);
    expect(liqs).toEqual([
      { ts: 1000, side: "short", usd: 2000, price: 100000, venue: "okx" },
      { ts: 2000, side: "long", usd: 1000, price: 100000, venue: "okx" },
    ]);
    expect(liquidationTotals(liqs, 2000, 1500)).toMatchObject({ long: 1000, short: 2000 });
    expect(liquidationTotals(liqs, 2000, 500)).toMatchObject({ long: 1000, short: 0 });
    expect(parseOkxLiquidations({}, () => 1)).toEqual([]);
  });
});

describe("Hyperliquid positions", () => {
  it("reads the BTC position and its distance to liquidation", () => {
    const state = { assetPositions: [
      { position: { coin: "ETH", szi: "1", positionValue: "3000", liquidationPx: "1000" } },
      { position: { coin: "BTC", szi: "-5", positionValue: "500000", liquidationPx: "101000" } },
    ] };
    const p = parseBtcPosition("0xw", state)!;
    expect(p).toEqual({ address: "0xw", side: "short", usd: 500000, liquidationPx: 101000 });
    expect(liquidationDistancePct(p, 100_000)).toBeCloseTo(1);
    expect(liquidationDistancePct({ ...p, side: "long", liquidationPx: 99_500 }, 100_000)).toBeCloseTo(0.5);
    expect(parseBtcPosition("0xw", { assetPositions: [{ position: { coin: "BTC", szi: "1", positionValue: "1", liquidationPx: null } }] })).toBeNull();
  });

  it("takes the largest leaderboard accounts", () => {
    const raw = { leaderboardRows: [
      { ethAddress: "0xA", accountValue: "10" }, { ethAddress: "0xB", accountValue: "30" }, { ethAddress: "0xC", accountValue: "20" }, { accountValue: "99" },
    ] };
    expect(topLeaderboardAddresses(raw, 2)).toEqual(["0xb", "0xc"]);
  });
});

describe("resting paper orders", () => {
  const prints = [
    { price: 0.44, size: 3, ts: 100 },
    { price: 0.45, size: 50, ts: 200 }, // at our price: assumed ahead of us in the queue
    { price: 0.43, size: 4, ts: 300 },
    { price: 0.40, size: 9, ts: 900 }, // after the window we're checking
  ];

  it("a resting bid fills only from prints strictly below it, inside the window", () => {
    expect(restingFillShares({ side: "buy", price: 0.45, remaining: 10 }, prints, 0, 500, null)).toBe(7);
    expect(restingFillShares({ side: "buy", price: 0.45, remaining: 5 }, prints, 0, 500, null)).toBe(5);
    expect(restingFillShares({ side: "buy", price: 0.45, remaining: 10 }, prints, 150, 500, null)).toBe(4);
  });

  it("a crossed book fills it too; a resting sell mirrors the rule", () => {
    const book = { bids: [{ price: 0.63, size: 2 }], asks: [{ price: 0.45, size: 1 }, { price: 0.46, size: 10 }] };
    expect(restingFillShares({ side: "buy", price: 0.45, remaining: 10 }, [], 0, 500, book)).toBe(1);
    expect(restingFillShares({ side: "sell", price: 0.62, remaining: 10 }, [{ price: 0.65, size: 3, ts: 10 }, { price: 0.6, size: 9, ts: 20 }], 0, 500, book)).toBe(5);
    expect(makerFill(5, 0.62)).toMatchObject({ shares: 5, notional: 3.1, fee: 0, avgPrice: 0.62 });
  });

  it("parses the data-api tape and the 15-minute window slug", () => {
    expect(parseTapeRow({ asset: "t1", price: 0.5, size: 10, timestamp: 1700 })).toEqual({ tokenId: "t1", price: 0.5, size: 10, ts: 1_700_000 });
    expect(parseTapeRow({ asset: "t1", price: "x" })).toBeNull();
    const w = btc15mWindow(1_800_000_123_000);
    expect(w.slug).toBe(`btc-updown-15m-${w.startMs / 1000}`);
    expect(w.startMs % 900_000).toBe(0);
  });
});
