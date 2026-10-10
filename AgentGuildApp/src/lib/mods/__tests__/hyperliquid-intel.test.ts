import { describe, it, expect, vi, beforeEach } from "vitest";
import { aggregatePositions, intelSection, netBias, pickTraders, summarizeLiquidations, type LeaderboardRow } from "../../../../mods/hyperliquid-trading/intel";
import { clearIntelCache, getMarketIntel, getMarketIntelWithin } from "../../../../mods/hyperliquid-trading/intel-fetch";

const row = (addr: string, acct: number, monthPnl: number, vlm = 1e6): LeaderboardRow => ({
  ethAddress: addr, accountValue: String(acct),
  windowPerformances: [["day", { pnl: "0", roi: "0", vlm: "0" }], ["month", { pnl: String(monthPnl), roi: "0.1", vlm: String(vlm) }]],
});

describe("intel parsing", () => {
  it("picks the month's best and worst large, active accounts", () => {
    const rows = [row("a", 5e6, 900_000), row("b", 2e6, 50_000), row("c", 3e6, -400_000), row("dust", 1_000, 9e9), row("idle", 9e6, 8e6, 0), row("d", 1e6, -10)];
    const { smart, dumb } = pickTraders(rows, 2);
    expect(smart.map((t) => t.address)).toEqual(["a", "b"]);
    expect(dumb.map((t) => t.address)).toEqual(["c", "d"]);
  });

  it("sums positions per coin and gives a net bias", () => {
    const pos = (coin: string, szi: string, positionValue: string) => ({ position: { coin, szi, positionValue } });
    const agg = aggregatePositions([
      { assetPositions: [pos("BTC", "1", "80000"), pos("ETH", "-10", "20000")] },
      { assetPositions: [pos("BTC", "-0.25", "20000"), pos("ETH", "0", "0")] },
    ]);
    expect(agg.BTC).toEqual({ longUsd: 80000, shortUsd: 20000, longs: 1, shorts: 1 });
    expect(agg.ETH).toEqual({ longUsd: 0, shortUsd: 20000, longs: 0, shorts: 1 });
    expect(netBias(agg.BTC)).toBeCloseTo(0.6);
    expect(netBias(agg.ETH)).toBe(-1);
    expect(netBias(undefined)).toBeNull();
  });

  it("converts OKX contracts to dollars and buckets liquidations by window and side", () => {
    const now = 10 * 3_600_000;
    const d = (hoursAgo: number, side: string, sz: string) => ({ bkPx: "80000", posSide: side, sz, ts: String(now - hoursAgo * 3_600_000) });
    const s = summarizeLiquidations([d(0.5, "long", "10"), d(2, "short", "5"), d(8, "long", "1")], 0.01, now);
    expect(s.windows).toEqual([
      { window: "1h", longUsd: 8000, shortUsd: 0 },
      { window: "4h", longUsd: 8000, shortUsd: 4000 },
      { window: "12h", longUsd: 8800, shortUsd: 4000 },
    ]);
    expect(s.coveredMs).toBe(8 * 3_600_000);
  });

  it("renders raw lines for the prompt, only for the coins asked", () => {
    const text = intelSection({
      at: 0,
      coins: [
        { coin: "BTC", smart: { longUsd: 3e6, shortUsd: 1e6, longs: 3, shorts: 1 }, dumb: null, hlp: { longUsd: 0, shortUsd: 0, longs: 0, shorts: 0 }, okxLongShortRatio: 1.5, liquidations: [{ window: "1h", longUsd: 2e6, shortUsd: 5e4 }], liquidationsCoveredMs: 1 },
        { coin: "ETH", smart: null, dumb: null, hlp: null, okxLongShortRatio: null, liquidations: null, liquidationsCoveredMs: null },
      ],
      fearGreed: { value: 20, label: "Extreme Fear" }, dvol: { BTC: 40, ETH: null }, coinbasePremiumPct: 0.05,
      traders: { smart: 30, dumb: 30 }, errors: [],
    }, ["BTC"]);
    expect(text).toContain("SENTIMENT fear_greed=20 (Extreme Fear) btc_dvol=40.0 coinbase_premium_pct=0.050");
    expect(text).toContain("smart_money_net_bias=+0.50 (long 3.0M / short 1.0M, 3L/1S)");
    expect(text).toContain("dumb_money_net_bias=none");
    expect(text).toContain("okx_liquidations_usd 1h: longs 2.0M shorts 50K");
    expect(text).not.toContain("ETH:");
  });
});

/** Every outlet stubbed; `down` names hosts that answer 503. */
function stubOutlets(down: string[] = []) {
  const calls: string[] = [];
  const f = vi.fn(async (url: string, init?: { body?: string }) => {
    const host = new URL(url).host;
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push(body?.type ? `${host}:${body.type}` : host);
    if (down.includes(host)) return new Response("down", { status: 503 });
    const json = (d: unknown) => new Response(JSON.stringify(d));
    if (host === "stats-data.hyperliquid.xyz") return json({ leaderboardRows: [row("0xsmart", 5e6, 1e6), row("0xdumb", 5e6, -1e6)] });
    if (host === "api.hyperliquid.xyz") {
      if (body.type === "vaultDetails") return json({ relationship: { data: { childAddresses: ["0xchild"] } } });
      if (body.type === "allMids") return json({ BTC: "80000" });
      const side: Record<string, string> = { "0xsmart": "2", "0xdumb": "-2", "0xchild": "-0.5" };
      const szi = side[body.user];
      return json({ assetPositions: szi ? [{ position: { coin: "BTC", szi, positionValue: String(Math.abs(Number(szi)) * 80000) } }] : [] });
    }
    if (url.includes("/public/instruments")) return json({ data: [{ instId: "BTC-USDT-SWAP", ctVal: "0.01" }] });
    if (url.includes("long-short-account-ratio")) return json({ data: [["1", "1.8"]] });
    if (url.includes("liquidation-orders")) return json({ data: [{ details: [{ bkPx: "80000", posSide: "long", sz: "100", ts: String(Date.now() - 60_000) }] }] });
    if (host === "api.alternative.me") return json({ data: [{ value: "15", value_classification: "Extreme Fear" }] });
    if (host === "www.deribit.com") return json({ result: { data: [[0, 0, 0, 0, 55.5]] } });
    if (host === "api.exchange.coinbase.com") return json({ price: "80080" });
    throw new Error(`unstubbed ${url}`);
  });
  return { f: f as unknown as typeof fetch, calls };
}

describe("intel fetching", () => {
  beforeEach(() => clearIntelCache());

  it("builds intel from every outlet", async () => {
    const { f } = stubOutlets();
    const intel = await getMarketIntel(["BTC", "ETH"], f);
    expect(intel.errors).toEqual([]);
    expect(intel.traders).toEqual({ smart: 1, dumb: 1 });
    const btc = intel.coins[0];
    expect(btc.smart).toMatchObject({ longUsd: 160000, longs: 1 });
    expect(btc.dumb).toMatchObject({ shortUsd: 160000, shorts: 1 });
    expect(btc.hlp).toMatchObject({ shortUsd: 40000 });
    expect(btc.okxLongShortRatio).toBe(1.8);
    expect(btc.liquidations?.[0]).toEqual({ window: "1h", longUsd: 80000, shortUsd: 0 });
    expect(intel.coins[1]).toMatchObject({ coin: "ETH", okxLongShortRatio: null, smart: { longUsd: 0, shortUsd: 0 } });
    expect(intel).toMatchObject({ fearGreed: { value: 15 }, dvol: { BTC: 55.5 } });
    expect(intel.coinbasePremiumPct).toBeCloseTo(0.1);
  });

  it("a dead outlet only blanks its own fields", async () => {
    const { f } = stubOutlets(["stats-data.hyperliquid.xyz", "www.okx.com"]);
    const intel = await getMarketIntel(["BTC"], f);
    expect(intel.errors.map((e) => e.split(":")[0])).toEqual(expect.arrayContaining(["leaderboard", "okx"]));
    expect(intel.coins[0]).toMatchObject({ smart: null, dumb: null, okxLongShortRatio: null, hlp: { shortUsd: 40000 } });
    expect(intel.fearGreed?.value).toBe(15);
  });

  it("caches: the 39 MB leaderboard is fetched once, not every round", async () => {
    const { f, calls } = stubOutlets();
    await getMarketIntel(["BTC"], f);
    const first = calls.length;
    await getMarketIntel(["BTC"], f);
    expect(calls.length).toBe(first);
    expect(calls.filter((c) => c === "stats-data.hyperliquid.xyz")).toHaveLength(1);
  });

  it("an AI round gives up on slow outlets instead of waiting", async () => {
    const never = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const t = Date.now();
    expect(await getMarketIntelWithin(["BTC"], 50, never)).toBeNull();
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
