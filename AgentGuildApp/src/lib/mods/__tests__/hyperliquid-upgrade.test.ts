import { describe, it, expect } from "vitest";
import { runBacktest } from "../../../../mods/hyperliquid-trading/backtest";
import type { Candle } from "../../../../mods/hyperliquid-trading/indicators";
import { adverseMovePct, buildSmartDca, smartDcaSize, smartDcaTakeProfit, SMART_DCA_DEFAULTS } from "../../../../mods/hyperliquid-trading/smart-dca";
import { buildBasisParams, decideBasis, findBasis, mapSpotMarkets, BASIS_DEFAULTS, type BasisRow } from "../../../../mods/hyperliquid-trading/basis";
import { bookImbalance } from "../../../../mods/hyperliquid-trading/signals";
import { cmcSymbol, coinContextLine, globalContextLine, parseGlobal, parseQuotes } from "../../../../mods/hyperliquid-trading/cmc";
import { bookOrder, bookSpot, spotValue, summarize, SPOT_TAKER_FEE_RATE, type CoinMeta } from "../../../../mods/hyperliquid-trading/paper";
import { scannerSection } from "../../../../mods/hyperliquid-trading/scanner";
import { buildSnapshot } from "../../../../mods/hyperliquid-trading/ai-trader-core";

const H = 3_600_000;
const flat = (n: number, px = 100): Candle[] => Array.from({ length: n }, (_, i) => ({ t: i * H, o: px, h: px, l: px, c: px, v: 1 }));

describe("smart DCA", () => {
  const p = { stepPct: 5, multiplier: 2, maxSteps: 3, takeProfitPct: 10 };

  it("sizes up one step per stepPct under the average entry, capped at maxSteps", () => {
    expect(smartDcaSize(10, p, 100, null)).toEqual({ sizeUsd: 10, step: 0 });
    expect(smartDcaSize(10, p, 96, 100)).toEqual({ sizeUsd: 10, step: 0 });
    expect(smartDcaSize(10, p, 95, 100)).toEqual({ sizeUsd: 20, step: 1 });
    expect(smartDcaSize(10, p, 89, 100)).toEqual({ sizeUsd: 40, step: 2 });
    expect(smartDcaSize(10, p, 50, 100)).toEqual({ sizeUsd: 80, step: 3 });
    expect(smartDcaSize(10, p, 120, 100).step).toBe(0); // in profit
  });

  it("mirrors for a short stack", () => {
    expect(adverseMovePct(110, 100, false)).toBeCloseTo(10);
    expect(smartDcaSize(10, p, 110, 100, false).step).toBe(2);
    expect(smartDcaTakeProfit(p, 89, 100, false)).toBe(true);
  });

  it("takes profit on the whole stack past takeProfitPct", () => {
    expect(smartDcaTakeProfit(p, 109, 100)).toBe(false);
    expect(smartDcaTakeProfit(p, 110, 100)).toBe(true);
    expect(smartDcaTakeProfit({ ...p, takeProfitPct: undefined }, 200, 100)).toBe(false);
  });

  it("validates", () => {
    expect(buildSmartDca(undefined)).toBeNull();
    expect(buildSmartDca(true)).toEqual(SMART_DCA_DEFAULTS);
    expect(buildSmartDca({ takeProfitPct: 0 })).toMatchObject({ takeProfitPct: undefined });
    expect(buildSmartDca({ multiplier: 0.5 })).toHaveProperty("error");
    expect(buildSmartDca({ stepPct: 0 })).toHaveProperty("error");
  });

  it("backtest buys bigger as price falls, then banks the stack", () => {
    // 100 → 80 in 5% steps, then back to 100.
    const path = [100, 100, 95, 90, 85, 80, 80, 90, 100, 100, 100];
    const candles = path.map((c, i) => ({ t: i * H, o: c, h: c, l: c, c, v: 1 }));
    return runBacktest({
      candles, barMs: H, startingBalance: 10_000, sizeUsd: 10, leverage: 1, slippage: 0, feeRate: 0,
      strategy: { type: "dca", intervalMs: H, smart: { stepPct: 5, multiplier: 2, maxSteps: 3, takeProfitPct: 5 } },
    }).then((r) => {
      const buys = r.trades.filter((t) => t.side === "buy").map((t) => Math.round(t.notional));
      expect(buys[0]).toBe(10);
      expect(Math.max(...buys)).toBeGreaterThan(10);
      expect(r.trades.some((t) => t.reason.includes("take profit") && (t.realizedPnl ?? 0) > 0)).toBe(true);
    });
  });
});

describe("backtest stop loss, take profit and shorts", () => {
  it("a short DCA sells and profits as price falls", async () => {
    const candles = [100, 100, 90, 80].map((c, i) => ({ t: i * H, o: c, h: c, l: c, c, v: 1 }));
    const r = await runBacktest({ candles, barMs: H, startingBalance: 1000, sizeUsd: 100, leverage: 1, slippage: 0, feeRate: 0, strategy: { type: "dca", intervalMs: 10 * H, direction: "short" } });
    expect(r.trades[0].side).toBe("sell");
    expect(r.finalEquity).toBeGreaterThan(1000);
  });

  it("stops out inside the bar at the stop price", async () => {
    const candles: Candle[] = [
      { t: 0, o: 100, h: 100, l: 100, c: 100, v: 1 },
      { t: H, o: 100, h: 101, l: 99, c: 100, v: 1 },
      { t: 2 * H, o: 100, h: 100, l: 90, c: 92, v: 1 },
      { t: 3 * H, o: 92, h: 92, l: 92, c: 92, v: 1 },
    ];
    const r = await runBacktest({ candles, barMs: H, startingBalance: 1000, sizeUsd: 100, leverage: 1, slippage: 0, feeRate: 0, stopLossPct: 5, strategy: { type: "sniper", mode: "price-above", targetPrice: 99 } });
    const stop = r.trades.find((t) => t.reason.startsWith("stop loss"))!;
    expect(stop.price).toBeCloseTo(95);
    expect(stop.realizedPnl).toBeCloseTo(-5);
  });

  it("fills a gap through the stop at the open, and takes profit on the high", async () => {
    const gap: Candle[] = [
      { t: 0, o: 100, h: 100, l: 100, c: 100, v: 1 },
      { t: H, o: 100, h: 100, l: 100, c: 100, v: 1 },
      { t: 2 * H, o: 80, h: 82, l: 79, c: 81, v: 1 },
      { t: 3 * H, o: 81, h: 81, l: 81, c: 81, v: 1 },
    ];
    const r = await runBacktest({ candles: gap, barMs: H, startingBalance: 1000, sizeUsd: 100, leverage: 1, slippage: 0, feeRate: 0, stopLossPct: 5, strategy: { type: "sniper", mode: "price-above", targetPrice: 99 } });
    expect(r.trades.find((t) => t.reason.startsWith("stop loss"))!.price).toBe(80);

    const up: Candle[] = [...flat(2), { t: 2 * H, o: 100, h: 112, l: 100, c: 105, v: 1 }, { t: 3 * H, o: 105, h: 105, l: 105, c: 105, v: 1 }];
    const r2 = await runBacktest({ candles: up, barMs: H, startingBalance: 1000, sizeUsd: 100, leverage: 1, slippage: 0, feeRate: 0, takeProfitPct: 10, strategy: { type: "sniper", mode: "price-above", targetPrice: 99 } });
    expect(r2.trades.find((t) => t.reason.startsWith("take profit"))!.price).toBeCloseTo(110);
  });
});

describe("spot-perp basis", () => {
  const meta = {
    tokens: [{ index: 0, name: "USDC", szDecimals: 8 }, { index: 1, name: "UBTC", szDecimals: 5 }, { index: 2, name: "HYPE", szDecimals: 2 }, { index: 3, name: "UBTC2", szDecimals: 5 }],
    universe: [
      { name: "@1", index: 0, tokens: [1, 0] as [number, number] },
      { name: "@2", index: 1, tokens: [2, 0] as [number, number] },
      { name: "@3", index: 2, tokens: [3, 1] as [number, number] }, // not USDC-quoted
    ],
  };
  const ctxs = [
    { midPx: "100000", markPx: "100000", dayNtlVlm: "5000000" },
    { midPx: "40", markPx: "40", dayNtlVlm: "2000000" },
    { midPx: "1", markPx: "1", dayNtlVlm: "1" },
  ];

  it("maps perps to their USDC spot market, U-prefixed or plain", () => {
    const m = mapSpotMarkets(["BTC", "HYPE", "ETH"], meta, ctxs);
    expect(m.get("BTC")).toMatchObject({ pair: "@1", token: "UBTC", midPx: 100000, szDecimals: 5 });
    expect(m.get("HYPE")).toMatchObject({ pair: "@2", token: "HYPE" });
    expect(m.has("ETH")).toBe(false);
  });

  it("rows carry basis and funding APR, best carry first", () => {
    const rows = findBasis(
      [{ coin: "BTC", markPx: 100100, fundingRatePct: 0.001, volume24hUsd: 1e9 }, { coin: "HYPE", markPx: 40, fundingRatePct: 0.003, volume24hUsd: 1e8 }],
      mapSpotMarkets(["BTC", "HYPE"], meta, ctxs),
    );
    expect(rows.map((r) => r.coin)).toEqual(["HYPE", "BTC"]);
    expect(rows[1].basisPct).toBeCloseTo(0.1);
    expect(rows[1].fundingAprPct).toBeCloseTo(8.76);
  });

  const row = (fundingAprPct: number, basisPct = 0.05): BasisRow => ({
    coin: "BTC", spotPair: "@1", spotToken: "UBTC", spotPx: 100, perpPx: 100, basisPct, fundingAprPct, spotVolume24hUsd: 1e6, perpVolume24hUsd: 1e9,
  });
  const p = { coin: "BTC", ...BASIS_DEFAULTS };

  it("enters on rich funding, not into a deep discount, and exits on low funding or time", () => {
    expect(decideBasis(p, row(20), null, 0).action).toBe("open");
    expect(decideBasis(p, row(10), null, 0).action).toBe("hold");
    expect(decideBasis(p, row(20, -0.5), null, 0).action).toBe("hold");
    expect(decideBasis(p, null, null, 0).action).toBe("hold");
    const open = { coin: "BTC", openedAt: 0, entryBasisPct: 0, entryFundingAprPct: 20, spotSz: 1, spotPx: 100 };
    expect(decideBasis(p, row(10), open, H).action).toBe("hold");
    expect(decideBasis(p, row(2), open, H).action).toBe("close");
    expect(decideBasis(p, row(10), open, p.maxHoldHours * H).action).toBe("close");
  });

  it("validates", () => {
    expect(buildBasisParams({}, "BTC")).toMatchObject({ coin: "BTC", entryAprPct: 15 });
    expect(buildBasisParams({}, null)).toHaveProperty("error");
    expect(buildBasisParams({ exitAprPct: 20 }, "BTC")).toHaveProperty("error");
  });
});

describe("paper spot", () => {
  const meta: Record<string, CoinMeta> = { BTC: { szDecimals: 5, maxLeverage: 40 } };

  it("buys with free cash only, sells against average cost", () => {
    const buy = bookSpot(1000, [], {}, { pair: "@1", token: "UBTC", isBuy: true, sz: 0.005, px: 100_000, feeRate: SPOT_TAKER_FEE_RATE, szDecimals: 5 }, {}, meta);
    if ("error" in buy) throw new Error(buy.error);
    expect(buy.balance).toBeCloseTo(1000 - 500 - 0.35);
    expect(buy.holding).toMatchObject({ token: "UBTC", sz: 0.005, avgPx: 100_000 });

    const sell = bookSpot(buy.balance, [], { UBTC: buy.holding! }, { pair: "@1", token: "UBTC", isBuy: false, sz: 1, px: 110_000, feeRate: 0, szDecimals: 5 }, {}, meta);
    if ("error" in sell) throw new Error(sell.error);
    expect(sell.sz).toBe(0.005); // clamped to what's held
    expect(sell.realized).toBeCloseTo(50);
    expect(sell.holding).toBeNull();

    expect(bookSpot(100, [], {}, { pair: "@1", token: "UBTC", isBuy: true, sz: 0.005, px: 100_000, feeRate: 0, szDecimals: 5 }, {}, meta)).toHaveProperty("error");
    expect(bookSpot(100, [], {}, { pair: "@1", token: "UBTC", isBuy: false, sz: 1, px: 1, feeRate: 0, szDecimals: 5 }, {}, meta)).toHaveProperty("error");
  });

  it("spot counts toward equity and the perp margin check", () => {
    const holding = { UBTC: { pair: "@1", token: "UBTC", sz: 0.01, avgPx: 100_000 } };
    expect(spotValue(holding, { "@1": 110_000 })).toBeCloseTo(1100);
    expect(spotValue(holding, {})).toBeCloseTo(1000);
    expect(summarize(0, [], {}, meta, 1100).equity).toBeCloseTo(1100);
    // $0 cash but $1000 of spot backs a $500 short at 1x.
    const short = { coin: "BTC", isBuy: false, sz: 0.005, px: 100_000, feeRate: 0, leverage: 1, reduceOnly: false };
    expect(bookOrder(0, [], short, { BTC: 100_000 }, meta)).toHaveProperty("error");
    expect(bookOrder(0, [], short, { BTC: 100_000 }, meta, 1000)).not.toHaveProperty("error");
  });
});

describe("flow and market context", () => {
  it("book imbalance counts depth inside the band", () => {
    const b = bookImbalance("BTC", [{ px: 99.9, sz: 3 }, { px: 90, sz: 100 }], [{ px: 100.1, sz: 1 }], 0.5);
    expect(b.bidUsd).toBeCloseTo(299.7);
    expect(b.askUsd).toBeCloseTo(100.1);
    expect(b.imbalance).toBeCloseTo((299.7 - 100.1) / 399.8);
    expect(bookImbalance("X", [], [], 1).imbalance).toBe(0);
  });

  it("parses CMC quotes, picking the best-ranked coin for a shared symbol", () => {
    const q = parseQuotes({
      data: {
        BTC: [
          { cmc_rank: 3238, quote: { USD: { market_cap: 1 } } },
          { cmc_rank: 1, quote: { USD: { market_cap: 1.6e12, volume_24h: 1.4e10, percent_change_24h: 0.5, percent_change_7d: -2.3 } } },
        ],
        HYPE: [{ cmc_rank: null, quote: { USD: { market_cap: null } } }],
      },
    });
    expect(q.get("BTC")).toMatchObject({ rank: 1, marketCapUsd: 1.6e12, change7dPct: -2.3 });
    expect(q.has("HYPE")).toBe(false);
    expect(coinContextLine(q.get("BTC"))).toBe("cmc_rank=1 market_cap_usd=1600000000000 volume_24h_all_venues_usd=14000000000 change_7d_pct=-2.30");
    expect(cmcSymbol("kPEPE")).toBe("PEPE");
    expect(cmcSymbol("BTC")).toBe("BTC");
  });

  it("whole-market line leaves CMC's fear & greed out of the prompt", () => {
    const g = parseGlobal(
      { data: { btc_dominance: 59.46, eth_dominance: 10.9, quote: { USD: { total_market_cap: 2.8e12, total_market_cap_yesterday_percentage_change: 0.63 } } } },
      { data: { value: 57, value_classification: "Neutral" } },
    );
    expect(g.fearGreed).toEqual({ value: 57, label: "Neutral" });
    expect(globalContextLine(g)).toBe("btc_dominance_pct=59.46 eth_dominance_pct=10.90 total_market_cap_change_24h_pct=0.63");
  });

  it("the AI snapshot quotes imbalance and CMC context when given", () => {
    const s = buildSnapshot({ coin: "BTC", candles: flat(40), interval: "1h", bookImbalance: 0.25, marketContext: "cmc_rank=1", globalContext: "btc_dominance_pct=59.46" });
    expect(s).toContain("book_imbalance=0.250");
    expect(s).toContain("coinmarketcap: cmc_rank=1");
    expect(s).toContain("whole_market: btc_dominance_pct=59.46");
    expect(buildSnapshot({ coin: "BTC", candles: flat(40), interval: "1h" })).not.toContain("book_imbalance");
  });

  it("the scanner section lists basis and imbalance rows for the basket", () => {
    const text = scannerSection({
      fundingArbs: [], premiums: [], pairs: [],
      basis: [{ coin: "BTC", spotPair: "@1", spotToken: "UBTC", spotPx: 100, perpPx: 100.1, basisPct: 0.1, fundingAprPct: 12, spotVolume24hUsd: 1, perpVolume24hUsd: 1 }],
      imbalances: [{ coin: "BTC", bidUsd: 300, askUsd: 100, imbalance: 0.5, bandPct: 0.5 }, { coin: "ETH", bidUsd: 1, askUsd: 1, imbalance: 0, bandPct: 0.5 }],
    }, ["BTC"]);
    expect(text).toContain("SPOT-PERP BASIS");
    expect(text).toContain("BTC,UBTC,+0.100,+12.0");
    expect(text).toContain("BTC,+0.500,300,100,0.5");
    expect(text).not.toContain("ETH");
  });
});
