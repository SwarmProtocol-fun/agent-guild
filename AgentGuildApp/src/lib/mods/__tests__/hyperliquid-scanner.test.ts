import { describe, it, expect } from "vitest";
import {
  findFundingArbs,
  findPairSpreads,
  findPremiumOutliers,
  hourlyRate,
  pairSpread,
  parsePredictedFundings,
  scannerSection,
  type PredictedFundingsRaw,
} from "../../../../mods/hyperliquid-trading/scanner";
import { buildCoinBlock, multiDecisionRequest, parseMultiDecision } from "../../../../mods/hyperliquid-trading/ai-trader-core";
import type { Candle } from "../../../../mods/hyperliquid-trading/indicators";

const RAW: PredictedFundingsRaw = [
  ["BTC", [
    ["BinPerp", { fundingRate: "0.0001", fundingIntervalHours: 8 }],
    ["HlPerp", { fundingRate: "0.0000125", fundingIntervalHours: 1 }],
    ["BybitPerp", { fundingRate: "0.0001", fundingIntervalHours: 8 }],
  ]],
  ["DOGE", [
    ["BinPerp", { fundingRate: "-0.0004", fundingIntervalHours: 4 }],
    ["HlPerp", { fundingRate: "0.00005", fundingIntervalHours: 1 }],
    null,
  ]],
  ["THIN", [["HlPerp", { fundingRate: "0.001" }], ["BinPerp", { fundingRate: "0" }]]],
];

function series(closes: number[], step = 3_600_000): Candle[] {
  return closes.map((c, i) => ({ t: i * step, o: c, h: c, l: c, c, v: 1 }));
}

describe("funding arbitrage", () => {
  it("normalises every venue to per-hour before comparing", () => {
    expect(hourlyRate("BinPerp", 0.0008, 8)).toBeCloseTo(0.0001);
    expect(hourlyRate("BybitPerp", 0.0008)).toBeCloseTo(0.0001); // CEX default 8h
    expect(hourlyRate("HlPerp", 0.0001)).toBeCloseTo(0.0001);
    const f = parsePredictedFundings(RAW);
    // BTC: HL 0.00125%/h, Binance 0.0001/8 = 0.00125%/h — no gap
    const btc = f.get("BTC")!;
    expect(btc.find((v) => v.venue === "HlPerp")!.hourly).toBeCloseTo(btc.find((v) => v.venue === "BinPerp")!.hourly);
  });

  it("ranks by annualised spread, says which HL side collects, and drops thin markets", () => {
    const arbs = findFundingArbs(parsePredictedFundings(RAW), new Map([["BTC", 5e9], ["DOGE", 5e8], ["THIN", 1_000]]));
    expect(arbs.map((a) => a.coin)).toEqual(["DOGE"]);
    const doge = arbs[0];
    // HL +0.005%/h vs Binance −0.01%/h → 0.015%/h × 8760 = 131.4% APR
    expect(doge.spreadAprPct).toBeCloseTo(131.4, 1);
    expect(doge.hlSide).toBe("short");
    expect(doge.other.venue).toBe("BinPerp");
  });

  it("skips coins Hyperliquid no longer lists", () => {
    const arbs = findFundingArbs(parsePredictedFundings(RAW), new Map([["BTC", 5e9]]));
    expect(arbs).toEqual([]);
  });
});

describe("premium and pair spreads", () => {
  it("finds perps far from their oracle", () => {
    const rows = findPremiumOutliers([
      { coin: "A", markPx: 101, oraclePx: 100, fundingRatePct: 0.01, volume24hUsd: 5e6 },
      { coin: "B", markPx: 100.01, oraclePx: 100, fundingRatePct: 0, volume24hUsd: 5e6 },
      { coin: "C", markPx: 95, oraclePx: 100, fundingRatePct: 0, volume24hUsd: 10 },
    ]);
    expect(rows.map((r) => r.coin)).toEqual(["A"]);
    expect(rows[0].premiumPct).toBeCloseTo(1);
  });

  it("flags the rich leg of a correlated pair whose spread is stretched", () => {
    // B wanders; A tracks it closely, then jumps 5% above it on the last bar.
    const b = Array.from({ length: 80 }, (_, i) => 100 * Math.exp(0.02 * Math.sin(i / 3) + 0.001 * i));
    const a = b.map((x, i) => 2 * x * (1 + 0.001 * Math.cos(i)) * (i === 79 ? 1.05 : 1));
    const p = pairSpread("A", series(a), "B", series(b))!;
    expect(p.correlation).toBeGreaterThan(0.6);
    expect(p.z).toBeGreaterThan(2);
    expect(p).toMatchObject({ shortLeg: "A", longLeg: "B" });

    const noise = series(Array.from({ length: 80 }, (_, i) => 100 + ((i * 37) % 11)));
    const found = findPairSpreads({ A: series(a), B: series(b), N: noise }, { minCorrelation: 0.6 });
    expect(found.map((x) => `${x.a}/${x.b}`)).toEqual(["A/B"]);
  });

  it("returns null with too little shared history", () => {
    expect(pairSpread("A", series([1, 2, 3]), "B", series([1, 2, 3]))).toBeNull();
  });

  it("renders only basket rows for the prompt", () => {
    const text = scannerSection({
      fundingArbs: findFundingArbs(parsePredictedFundings(RAW), new Map(), { minVolumeUsd: 0 }),
      premiums: [],
      pairs: [{ a: "BTC", b: "ETH", correlation: 0.9, beta: 1.1, z: -2.4, longLeg: "BTC", shortLeg: "ETH", bars: 100 }],
    }, ["BTC", "ETH"]);
    expect(text).toContain("PAIR SPREADS");
    expect(text).toContain("BTC,ETH,0.90,1.100,-2.40,BTC,ETH");
    expect(text).not.toContain("DOGE");
  });
});

describe("basket prompt and answers", () => {
  it("asks about every coin and shows positions and the scan", () => {
    const candles = series(Array.from({ length: 60 }, (_, i) => 100 + i));
    const q = multiDecisionRequest(
      ["BTC", "ETH"],
      [buildCoinBlock({ coin: "BTC", candles, interval: "1h", premiumPct: 0.12 }), buildCoinBlock({ coin: "ETH", candles, interval: "1h" })],
      "PAIR SPREADS …",
      { ETH: { isLong: false, size: -1, entryPx: 150, unrealizedPnl: -9 } },
      "Trade the BTC/ETH spread only.",
    );
    expect(q.system).toContain("basket of 2 coins: BTC, ETH");
    expect(q.system).toContain("pair trades");
    expect(q.system).toContain("GOAL: Trade the BTC/ETH spread only.");
    expect(q.prompt).toContain("## BTC-PERP");
    expect(q.prompt).toContain("premium_pct=0.120");
    expect(q.prompt).toContain("CROSS-MARKET SCAN");
    expect(q.prompt).toContain("ETH: SHORT 1 ETH");
    expect(q.prompt.split("\n").filter((l) => /^\d{4}-/.test(l))).toHaveLength(48); // 24 bars × 2 coins
  });

  it("parses a DECISIONS block, last line per coin wins, unknown coins ignored", () => {
    const text = "BTC looks cheap against ETH, I'd not go long SOL.\n\nDECISIONS\nBTC: LONG\nETH - SHORT\nDOGE: LONG\nETH: CLOSE\nSOL = NOTHING";
    expect(parseMultiDecision(text, ["BTC", "ETH", "SOL"])).toEqual({ BTC: "LONG", ETH: "CLOSE" });
  });

  it("accepts verb-first lines only inside a DECISIONS block", () => {
    expect(parseMultiDecision("DECISIONS\n- LONG btc\n- SHORT eth", ["BTC", "ETH"])).toEqual({ BTC: "LONG", ETH: "SHORT" });
    expect(parseMultiDecision("I would not go long BTC here. NOTHING", ["BTC"])).toEqual({});
  });

  it("matches coins case-insensitively but returns the exchange's symbol", () => {
    expect(parseMultiDecision("DECISIONS\nKPEPE: SHORT", ["kPEPE", "BTC"])).toEqual({ kPEPE: "SHORT" });
  });

  it("null when no decision at all, {} for an explicit nothing", () => {
    expect(parseMultiDecision("not sure", ["BTC"])).toBeNull();
    expect(parseMultiDecision("Choppy everywhere. Do nothing.", ["BTC"])).toEqual({});
  });
});
