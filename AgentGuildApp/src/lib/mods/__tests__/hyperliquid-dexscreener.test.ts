import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregatePairs,
  clearDexCache,
  DEX_TOKENS,
  dexContextLine,
  getDexContexts,
  type RawPair,
} from "../../../../mods/hyperliquid-trading/dexscreener";
import { buildCoinBlock, buildSnapshot } from "../../../../mods/hyperliquid-trading/ai-trader-core";
import type { Candle } from "../../../../mods/hyperliquid-trading/indicators";

const H = 3_600_000;
const flat = (n: number, px = 100): Candle[] => Array.from({ length: n }, (_, i) => ({ t: i * H, o: px, h: px, l: px, c: px, v: 1 }));

const WIF = DEX_TOKENS.WIF;
const PEPE = DEX_TOKENS.kPEPE;

const pair = (over: Partial<RawPair> & { liq: number; price?: string; addr?: string; chain?: string }): RawPair => ({
  chainId: over.chain ?? "solana",
  baseToken: { address: over.addr ?? WIF.address },
  priceUsd: over.price ?? "1.50",
  liquidity: { usd: over.liq },
  volume: { h1: 1_000, h24: 20_000 },
  txns: { m5: { buys: 3, sells: 1 }, h1: { buys: 60, sells: 40 } },
  ...over,
});

describe("dexscreener aggregation", () => {
  it("sums every pool where the coin is the base token, priced liquidity-weighted", () => {
    const d = aggregatePairs(WIF, [
      pair({ liq: 2_000_000, price: "1.50" }),
      pair({ liq: 500_000, price: "1.49" }),
    ])!;
    expect(d.pools).toBe(2);
    expect(d.priceUsd).toBeCloseTo((1.5 * 2_000_000 + 1.49 * 500_000) / 2_500_000, 10);
    expect(d.liquidityUsd).toBe(2_500_000);
    expect(d.volume1hUsd).toBe(2_000);
    expect(d.buys1h).toBe(120);
    expect(d.sells1h).toBe(80);
  });

  it("ignores dust pools, other chains and pools quoting the coin as the quote token", () => {
    const d = aggregatePairs(WIF, [
      pair({ liq: 1_000_000 }),
      pair({ liq: 5_000, price: "99" }), // dust
      pair({ liq: 9_000_000, addr: "So11111111111111111111111111111111111111112" }), // WIF is the quote side
      pair({ liq: 9_000_000, chain: "base" }),
    ])!;
    expect(d.pools).toBe(1);
    expect(d.liquidityUsd).toBe(1_000_000);
    expect(aggregatePairs(WIF, [pair({ liq: 5_000 })])).toBeNull();
  });

  it("matches EVM addresses case-insensitively but Solana's exactly", () => {
    expect(aggregatePairs(PEPE, [pair({ chain: "ethereum", addr: PEPE.address.toLowerCase(), liq: 1e6 })])).not.toBeNull();
    expect(aggregatePairs(WIF, [pair({ addr: WIF.address.toLowerCase(), liq: 1e6 })])).toBeNull();
  });

  it("prompt line carries flow, imbalance and the spot-vs-perp gap, scaled for k-coins", () => {
    const d = aggregatePairs(PEPE, [pair({ chain: "ethereum", addr: PEPE.address, liq: 3e7, price: "0.000004" })])!;
    // kPEPE perp at 0.003990 = 1000 PEPE; spot 1000 × 0.000004 = 0.004 → +25.1 bps
    const line = dexContextLine(d, 0.00399, PEPE.perpUnits)!;
    expect(line).toContain("dex_liquidity_usd=30000000");
    expect(line).toContain("dex_buys_1h=60 dex_sells_1h=40");
    expect(line).toContain("dex_tx_imbalance_1h=0.200");
    expect(line).toContain("dex_tx_imbalance_5m=0.500");
    expect(line).toContain("dex_spot_vs_perp_bps=25.1");
    expect(dexContextLine(d)).not.toContain("dex_spot_vs_perp_bps");
    expect(dexContextLine(null)).toBeNull();
  });

  it("every pinned token names a supported chain and a plausible address", () => {
    for (const [coin, t] of Object.entries(DEX_TOKENS)) {
      if (t.chainId === "solana") expect(t.address, coin).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      else expect(t.address, coin).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(t.perpUnits === undefined || coin.startsWith("k"), coin).toBe(true);
    }
  });
});

describe("dexscreener fetching", () => {
  beforeEach(() => clearDexCache());

  const okFetch = () =>
    vi.fn(async (url: string) => {
      const body = url.includes("/solana/")
        ? [pair({ liq: 1e6 })]
        : [pair({ chain: "ethereum", addr: PEPE.address, liq: 2e7, price: "0.000004" })];
      return new Response(JSON.stringify(body), { status: 200 });
    });

  it("fetches every pool per known coin, skips unknown coins and caches per coin", async () => {
    const f = okFetch();
    const out = await getDexContexts(["WIF", "kPEPE", "BTC"], f as unknown as typeof fetch);
    expect([...out!.keys()].sort()).toEqual(["WIF", "kPEPE"]);
    expect(f.mock.calls.map(([u]) => u).sort()).toEqual([
      `https://api.dexscreener.com/token-pairs/v1/ethereum/${PEPE.address}`,
      `https://api.dexscreener.com/token-pairs/v1/solana/${WIF.address}`,
    ]);
    // A different basket sharing WIF reuses its cached value.
    await getDexContexts(["WIF", "POPCAT"], f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("one dead coin does not sink the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async (url: string) =>
      url.includes("/solana/") ? new Response("x", { status: 500 }) : new Response(JSON.stringify([pair({ chain: "ethereum", addr: PEPE.address, liq: 2e7 })])),
    );
    const out = await getDexContexts(["WIF", "kPEPE"], f as unknown as typeof fetch);
    expect([...out!.keys()]).toEqual(["kPEPE"]);
    warn.mockRestore();
  });

  it("makes no call when no coin is a DEX token", async () => {
    const f = okFetch();
    expect((await getDexContexts(["BTC", "ETH"], f as unknown as typeof fetch))!.size).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });

  it("returns null instead of throwing when DexScreener is down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async () => new Response("rate limited", { status: 429 }));
    expect(await getDexContexts(["WIF"], f as unknown as typeof fetch)).toBeNull();
    warn.mockRestore();
  });
});

describe("dexscreener in AI prompts", () => {
  it("the single-coin snapshot and basket block quote the DEX line", () => {
    const s = buildSnapshot({ coin: "WIF", candles: flat(40), interval: "1h", dexContext: "dex_liquidity_usd=1000000" });
    expect(s).toContain("dexscreener: dex_liquidity_usd=1000000");
    expect(buildCoinBlock({ coin: "WIF", candles: flat(40), interval: "1h", dexContext: "dex_buys_1h=60" })).toContain("dex_buys_1h=60");
    expect(buildSnapshot({ coin: "BTC", candles: flat(40), interval: "1h" })).not.toContain("dexscreener");
  });
});
