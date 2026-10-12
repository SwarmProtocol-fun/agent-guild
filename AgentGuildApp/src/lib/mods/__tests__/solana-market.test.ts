import { describe, expect, it, vi } from "vitest";
import { resolveMint, swapQuote, toRaw, toUi, tokenPrices, SYMBOL_MINTS } from "../../../../mods/solana-settlement/market";
import { DevtoolsInputError } from "../../../../mods/solana-settlement/devtools";

const SOL = SYMBOL_MINTS.SOL;
const USDC = SYMBOL_MINTS.USDC;

function fakeJupiter(routes: Record<string, { status?: number; body: unknown }>) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url));
    const hit = routes[u.pathname];
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
  }) as unknown as typeof fetch;
}

const PRICES = {
  [SOL]: { usdPrice: 107.5, priceChange24h: -3.4, decimals: 9 },
  [USDC]: { usdPrice: 0.9997, priceChange24h: 0.01, decimals: 6 },
};

describe("unit conversion", () => {
  it("round-trips UI and base units without float error", () => {
    expect(toRaw("1.5", 9)).toBe(1_500_000_000n);
    expect(toRaw("0.1", 6)).toBe(100_000n);
    expect(toUi("10757362", 6)).toBe("10.757362");
    expect(toUi("100000000", 9)).toBe("0.1");
    expect(toUi("5", 0)).toBe("5");
  });

  it("rejects amounts it can't represent exactly", () => {
    expect(() => toRaw("0.0000001", 6)).toThrow(DevtoolsInputError);
    expect(() => toRaw("-1", 6)).toThrow(DevtoolsInputError);
    expect(() => toRaw("0", 6)).toThrow(DevtoolsInputError);
    expect(() => toRaw("1e3", 6)).toThrow(DevtoolsInputError);
  });
});

describe("mint resolution", () => {
  it("takes symbols case-insensitively or a base58 mint", () => {
    expect(resolveMint("sol")).toBe(SOL);
    expect(resolveMint(USDC)).toBe(USDC);
    expect(() => resolveMint("NOTATOKEN")).toThrow(DevtoolsInputError);
  });
});

describe("Jupiter market data", () => {
  it("prices tokens and returns null for unlisted ones", async () => {
    const other = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const f = fakeJupiter({ "/price/v3": { body: { ...PRICES, [other]: null } } });
    const prices = await tokenPrices(["SOL", "usdc", other], f);
    expect(prices.map((p) => p.usdPrice)).toEqual([107.5, 0.9997, null]);
    expect(prices[1].symbol).toBe("USDC");
  });

  it("quotes in UI units using each token's decimals", async () => {
    const f = fakeJupiter({
      "/price/v3": { body: PRICES },
      "/swap/v1/quote": {
        body: {
          inAmount: "1500000000", outAmount: "161250000", otherAmountThreshold: "160443750", priceImpactPct: "0.0012",
          swapUsdValue: "161.2", routePlan: [{ swapInfo: { label: "Orca" } }, { swapInfo: { label: "Raydium" } }],
        },
      },
    });
    const q = await swapQuote({ inputMint: "SOL", outputMint: "USDC", amount: "1.5" }, f);
    expect(q).toMatchObject({ inUi: "1.5", outUi: "161.25", minOutUi: "160.44375", rate: 107.5, slippageBps: 50, usdValue: 161.2, route: ["Orca", "Raydium"] });
    expect(q.priceImpactPct).toBeCloseTo(0.12);
    const quoteUrl = new URL(String(vi.mocked(f).mock.calls[1][0]));
    expect(quoteUrl.searchParams.get("amount")).toBe("1500000000");
  });

  it("turns Jupiter's request errors into input errors the agent can fix", async () => {
    const f = fakeJupiter({
      "/price/v3": { body: PRICES },
      "/swap/v1/quote": { status: 400, body: { error: "Could not find any route" } },
    });
    await expect(swapQuote({ inputMint: "SOL", outputMint: "USDC", amount: "1" }, f)).rejects.toThrow(/Could not find any route/);
    await expect(swapQuote({ inputMint: "SOL", outputMint: "SOL", amount: "1" }, f)).rejects.toThrow(/same token/);
    await expect(swapQuote({ inputMint: "SOL", outputMint: "USDC", amount: "1", slippageBps: 5000 }, f)).rejects.toThrow(/slippageBps/);
  });
});
