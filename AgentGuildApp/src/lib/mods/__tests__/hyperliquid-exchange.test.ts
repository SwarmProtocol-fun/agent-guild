import { describe, it, expect, vi, afterEach } from "vitest";
import { recoverTypedDataAddress, type Hex } from "viem";
import { placeOrder, roundPrice, roundSize, walletAddress } from "../../../../mods/hyperliquid-trading/exchange";
import { actionHash, type L1Action } from "../../../../mods/hyperliquid-trading/signing";

// Throwaway key — never funded.
const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";

type Call = { url: string; body: Record<string, unknown> };

/** Fakes Hyperliquid's /info and /exchange; `exchange` answers each signed action in turn. */
function fakeHyperliquid(exchange: (action: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    let out: unknown;
    if (url.endsWith("/info")) {
      if (body.type === "allMids") out = { BTC: "100000", ETH: "2500.5" };
      else if (body.type === "meta") out = { universe: [{ name: "BTC", szDecimals: 5 }, { name: "ETH", szDecimals: 4 }] };
      else if (body.type === "userFills") out = [{ oid: 77, closedPnl: "4.5" }, { oid: 77, closedPnl: "-1.25" }, { oid: 1, closedPnl: "100" }];
    } else {
      out = exchange(body.action);
    }
    return new Response(JSON.stringify(out), { status: 200 });
  }));
  return calls;
}

const ok = (...statuses: unknown[]) => ({ status: "ok", response: { type: "order", data: { statuses } } });

afterEach(() => vi.unstubAllGlobals());

describe("hyperliquid native order placement", () => {
  it("rounds like the Python worker", () => {
    expect(roundPrice(101234.56, 5)).toBe(101230);
    expect(roundPrice(2525.505, 4)).toBe(2525.5);
    expect(roundPrice(0.0123456, 0)).toBe(0.012346);
    expect(roundSize(0.000251234, 5)).toBe(0.00025);
  });

  it("sends a market buy as an IOC 1% through the mid, signed by the agent's key", async () => {
    const calls = fakeHyperliquid(() => ok({ filled: { totalSz: "0.0002", avgPx: "100010", oid: 9 } }));
    const res = await placeOrder({ coin: "BTC", isBuy: true, sizeUsd: 20, privateKey: KEY, network: "testnet" });

    const ex = calls.filter((c) => c.url.endsWith("/exchange"));
    expect(ex).toHaveLength(1);
    expect(ex[0].url).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    const { action, nonce, signature } = ex[0].body as { action: L1Action; nonce: number; signature: { r: Hex; s: Hex; v: number } };
    expect(action).toEqual({ type: "order", orders: [{ a: 0, b: true, p: "101000", s: "0.0002", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" });

    const signer = await recoverTypedDataAddress({
      domain: { chainId: 1337, name: "Exchange", verifyingContract: "0x0000000000000000000000000000000000000000", version: "1" },
      types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
      primaryType: "Agent",
      message: { source: "b", connectionId: actionHash(action, nonce) },
      signature: { r: signature.r, s: signature.s, v: BigInt(signature.v) },
    });
    expect(signer).toBe(walletAddress(KEY));

    expect(res).toMatchObject({ coin: "BTC", isBuy: true, sz: 0.0002, limitPx: 101000, midPriceAtOrder: 100000, raw: { avgPx: "100010", oid: 9 }, triggers: null, realizedPnl: null });
  });

  it("refuses an opening order under $10 without sending anything", async () => {
    const calls = fakeHyperliquid(() => ok({}));
    await expect(placeOrder({ coin: "ETH", isBuy: true, sizeUsd: 5, privateKey: KEY, network: "testnet" })).rejects.toThrow(/\$10 minimum/);
    expect(calls.some((c) => c.url.endsWith("/exchange"))).toBe(false);
  });

  it("surfaces Hyperliquid's rejection as an error", async () => {
    fakeHyperliquid(() => ok({ error: "Insufficient margin to place order." }));
    await expect(placeOrder({ coin: "ETH", isBuy: true, sizeUsd: 50, privateKey: KEY, network: "testnet" })).rejects.toThrow("Insufficient margin");
  });

  it("stops before the order when leverage is refused", async () => {
    const calls = fakeHyperliquid((a) => (a.type === "updateLeverage" ? { status: "err", response: "Invalid leverage value" } : ok({})));
    await expect(placeOrder({ coin: "ETH", isBuy: true, sizeUsd: 50, leverage: 99, privateKey: KEY, network: "mainnet" })).rejects.toThrow(/Leverage 99x refused/);
    const actions = calls.filter((c) => c.url.endsWith("/exchange")).map((c) => (c.body.action as { type: string }).type);
    expect(actions).toEqual(["updateLeverage"]);
  });

  it("sets leverage, fills, then attaches SL and TP as reduce-only triggers in one action", async () => {
    const calls = fakeHyperliquid((a) => {
      if (a.type === "updateLeverage") return { status: "ok", response: { type: "default" } };
      const orders = a.orders as unknown[];
      return orders.length === 1 ? ok({ filled: { totalSz: "0.02", avgPx: "2500", oid: 5 } }) : ok({ resting: { oid: 6 } }, { resting: { oid: 7 } });
    });
    const res = await placeOrder({
      coin: "ETH", isBuy: false, sizeUsd: 50, leverage: 5, stopLossPct: 2, takeProfitPct: 4, privateKey: KEY, network: "mainnet",
    });
    const actions = calls.filter((c) => c.url.endsWith("/exchange")).map((c) => c.body.action as Record<string, unknown>);
    expect(actions[0]).toEqual({ type: "updateLeverage", asset: 1, isCross: true, leverage: 5 });
    expect((actions[1].orders as { b: boolean; p: string }[])[0]).toMatchObject({ b: false, p: "2475.5" });
    // Short entry at 2500: SL 2% above, TP 4% below, both buys, reduce-only.
    expect(actions[2].orders).toEqual([
      { a: 1, b: true, p: "2550", s: "0.02", r: true, t: { trigger: { isMarket: true, triggerPx: "2550", tpsl: "sl" } } },
      { a: 1, b: true, p: "2400", s: "0.02", r: true, t: { trigger: { isMarket: true, triggerPx: "2400", tpsl: "tp" } } },
    ]);
    expect(res.triggers).toEqual({ stopLoss: { triggerPx: 2550, raw: { resting: { oid: 6 } } }, takeProfit: { triggerPx: 2400, raw: { resting: { oid: 7 } } } });
  });

  it("reads realized PnL for a reduce-only close from that order's fills", async () => {
    fakeHyperliquid(() => ok({ filled: { totalSz: "0.01", avgPx: "2490", oid: 77 } }));
    const res = await placeOrder({ coin: "ETH", isBuy: true, sizeUsd: 5, reduceOnly: true, privateKey: KEY, network: "testnet" });
    expect(res.realizedPnl).toBeCloseTo(3.25);
  });

  it("rejects an unknown coin", async () => {
    fakeHyperliquid(() => ok({}));
    await expect(placeOrder({ coin: "NOPE", isBuy: true, sizeUsd: 50, privateKey: KEY, network: "testnet" })).rejects.toThrow(/Unknown coin/);
  });
});
