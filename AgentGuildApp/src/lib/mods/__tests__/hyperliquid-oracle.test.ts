import { describe, it, expect, vi } from "vitest";
import {
  ORACLE_PX_PRECOMPILE,
  activeAssetCtxSubscription,
  decodeOraclePx,
  encodeOracleCall,
  findPerpAsset,
  hlWsUrl,
  parseActiveAssetCtx,
  readOraclePxOnchain,
} from "../../../../mods/hyperliquid-trading/oracle";

const universe = [
  { name: "BTC", szDecimals: 5 },
  { name: "ETH", szDecimals: 4 },
  { name: "SOL", szDecimals: 2 },
];

describe("hyperliquid oracle — on-chain precompile", () => {
  it("encodes the asset index as a 32-byte word", () => {
    expect(encodeOracleCall(0)).toBe("0x" + "0".repeat(64));
    expect(encodeOracleCall(3)).toBe("0x" + "0".repeat(63) + "3");
    expect(() => encodeOracleCall(-1)).toThrow();
  });

  it("scales the raw uint64 by 10^(6 - szDecimals)", () => {
    // Real mainnet BTC read: 0xc973e = 825150 → 82515.0
    expect(decodeOraclePx("0x" + "0".repeat(59) + "c973e", 5)).toBe(82515);
    expect(decodeOraclePx("0x" + (1_501_234).toString(16).padStart(64, "0"), 2)).toBeCloseTo(150.1234);
    expect(() => decodeOraclePx("0x", 5)).toThrow();
  });

  it("finds asset index and szDecimals case-insensitively", () => {
    expect(findPerpAsset(universe, "eth")).toEqual({ index: 1, szDecimals: 4 });
    expect(findPerpAsset(universe, "DOGE")).toBeNull();
  });

  it("eth_calls the 0x807 precompile on the network's HyperEVM RPC", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.method).toBe("eth_call");
      expect(body.params[0]).toEqual({ to: ORACLE_PX_PRECOMPILE, data: encodeOracleCall(2) });
      return new Response(JSON.stringify({ result: "0x" + (1_501_234).toString(16).padStart(64, "0") }));
    });
    const px = await readOraclePxOnchain({ index: 2, szDecimals: 2 }, "mainnet", fetchFn as unknown as typeof fetch);
    expect(px).toBeCloseTo(150.1234);
    expect(fetchFn.mock.calls[0][0]).toBe("https://rpc.hyperliquid.xyz/evm");
  });

  it("surfaces RPC errors and zero prices", async () => {
    const err = vi.fn(async () => new Response(JSON.stringify({ error: { message: "precompile reverted" } })));
    await expect(readOraclePxOnchain({ index: 9, szDecimals: 2 }, "testnet", err as unknown as typeof fetch)).rejects.toThrow("precompile reverted");
    const zero = vi.fn(async () => new Response(JSON.stringify({ result: "0x" + "0".repeat(64) })));
    await expect(readOraclePxOnchain({ index: 0, szDecimals: 5 }, "testnet", zero as unknown as typeof fetch)).rejects.toThrow("zero");
  });
});

describe("hyperliquid oracle — websocket", () => {
  it("builds the activeAssetCtx subscription for the right network", () => {
    expect(activeAssetCtxSubscription("BTC")).toEqual({ method: "subscribe", subscription: { type: "activeAssetCtx", coin: "BTC" } });
    expect(hlWsUrl("mainnet")).toBe("wss://api.hyperliquid.xyz/ws");
    expect(hlWsUrl("testnet")).toBe("wss://api.hyperliquid-testnet.xyz/ws");
  });

  it("parses oracle, mark and mid from a perp ctx push", () => {
    const msg = {
      channel: "activeAssetCtx",
      data: { coin: "BTC", ctx: { funding: "0.0000125", oraclePx: "82515.3", markPx: "82492.0", midPx: "82495.5" } },
    };
    expect(parseActiveAssetCtx(msg)).toEqual({ coin: "BTC", oraclePx: 82515.3, markPx: 82492, midPx: 82495.5 });
  });

  it("ignores acks and leaves missing fields null", () => {
    expect(parseActiveAssetCtx({ channel: "subscriptionResponse", data: {} })).toBeNull();
    expect(parseActiveAssetCtx(null)).toBeNull();
    expect(parseActiveAssetCtx({ channel: "activeAssetCtx", data: { coin: "PURR/USDC", ctx: { markPx: "0.2" } } }))
      .toEqual({ coin: "PURR/USDC", oraclePx: null, markPx: 0.2, midPx: null });
  });
});
