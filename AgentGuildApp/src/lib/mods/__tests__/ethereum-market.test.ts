import { describe, it, expect } from "vitest";
import { NATIVE, USDC, resolveToken, swapQuote, tokenPrices } from "../../../../mods/ethereum/market";
import { DevtoolsInputError } from "../../../../mods/ethereum/devtools";

/** Routes DefiLlama and KyberSwap URLs to canned responses. */
function fakeFetch(kyber: unknown) {
  return (async (url: string) => {
    const u = new URL(url);
    if (u.host === "coins.llama.fi" && u.pathname.startsWith("/prices")) {
      return new Response(JSON.stringify({
        coins: {
          "ethereum:0x0000000000000000000000000000000000000000": { price: 2500, symbol: "ETH", decimals: 18 },
          [`ethereum:${USDC}`]: { price: 1, symbol: "USDC", decimals: 6 },
        },
      }));
    }
    if (u.host === "coins.llama.fi") return new Response(JSON.stringify({ coins: { "ethereum:0x0000000000000000000000000000000000000000": -2.5 } }));
    if (u.host === "aggregator-api.kyberswap.com") {
      expect(u.searchParams.get("amountIn")).toBe("1500000000000000000");
      return new Response(JSON.stringify(kyber));
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
}

const ROUTE = {
  code: 0, message: "successfully",
  data: { routeSummary: { amountIn: "1500000000000000000", amountInUsd: "3750", amountOut: "3740000000", amountOutUsd: "3740", gasUsd: "0.42", route: [[{ exchange: "uniswapv3" }, { exchange: "curve" }], [{ exchange: "uniswapv3" }]] } },
};

describe("market", () => {
  it("resolves symbols and checksums addresses", () => {
    expect(resolveToken("eth")).toBe(NATIVE);
    expect(resolveToken(USDC.toLowerCase())).toBe(USDC);
    expect(() => resolveToken("NOTATOKEN")).toThrow(DevtoolsInputError);
  });

  it("prices native ETH via the zero address and attaches 24h change", async () => {
    const [eth, usdc] = await tokenPrices(["ETH", "USDC"], fakeFetch(ROUTE));
    expect(eth).toMatchObject({ token: NATIVE, symbol: "ETH", usdPrice: 2500, decimals: 18, priceChange24hPct: -2.5 });
    expect(usdc.priceChange24hPct).toBeNull();
  });

  it("turns a KyberSwap route into a quote", async () => {
    const q = await swapQuote({ inputToken: "ETH", outputToken: "USDC", amount: "1.5", slippageBps: 100 }, fakeFetch(ROUTE));
    expect(q.outUi).toBe("3740");
    expect(q.minOutUi).toBe("3702.6");
    expect(q.rate).toBeCloseTo(2493.33, 2);
    expect(q.priceImpactPct).toBeCloseTo((10 / 3750) * 100, 6);
    expect(q.gasUsd).toBe(0.42);
    expect(q.route).toEqual(["uniswapv3", "curve"]);
  });

  it("surfaces 'no route' as bad input", async () => {
    await expect(swapQuote({ inputToken: "ETH", outputToken: "USDC", amount: "1.5" }, fakeFetch({ code: 4008, message: "route not found" }))).rejects.toThrow(/route not found/);
  });
});
