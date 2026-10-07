import { describe, it, expect, vi, afterEach } from "vitest";
import { roundAmount, floorAmount, ceilAmount, toBaseUnits, fromBaseUnits, assetOf, formatAssetAmount, isLendingAsset } from "../assets";
import { aggregatePrice, medianPrice, getUsdPrice, clearPriceCache } from "../prices";

describe("asset amounts", () => {
    it("defaults records without an asset to USDC", () => {
        expect(assetOf({})).toBe("usdc");
        expect(assetOf(null)).toBe("usdc");
        expect(assetOf({ asset: "eth" })).toBe("eth");
        expect(isLendingAsset("sol")).toBe(true);
        expect(isLendingAsset("btc")).toBe(false);
    });

    it("rounds to each asset's ledger precision", () => {
        expect(roundAmount("usdc", 1.0000005)).toBe(1.000001);
        expect(roundAmount("sol", 0.1234567894)).toBe(0.123456789);
        expect(floorAmount("eth", 0.1234567899)).toBe(0.123456789);
        expect(ceilAmount("eth", 0.1234567891)).toBe(0.12345679);
        // Exact values survive float noise in both directions.
        expect(floorAmount("usdc", 0.1 + 0.2)).toBe(0.3);
        expect(ceilAmount("usdc", 0.1 + 0.2)).toBe(0.3);
    });

    it("converts to and from on-chain base units exactly", () => {
        expect(toBaseUnits("usdc", 12.34)).toBe(BigInt(12_340_000));
        expect(toBaseUnits("sol", 1.5)).toBe(BigInt(1_500_000_000));
        expect(toBaseUnits("eth", 0.123456789)).toBe(BigInt("123456789000000000"));
        expect(fromBaseUnits("eth", BigInt("2500000000000000000"))).toBe(2.5);
        expect(fromBaseUnits("sol", BigInt(250_000_000))).toBe(0.25);
    });

    it("formats with the asset symbol", () => {
        expect(formatAssetAmount("usdc", 1250)).toMatch(/1,250\.00 USDC/);
        expect(formatAssetAmount("eth", 0.0125)).toBe("0.0125 ETH");
    });
});

describe("price aggregation", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        clearPriceCache();
    });

    it("takes the median of agreeing sources", () => {
        expect(medianPrice([3, 1, 2])).toBe(2);
        expect(medianPrice([1, 2, 3, 4])).toBe(2.5);
        expect(aggregatePrice("sol", [116.4, 116.5, 116.47])).toBe(116.47);
    });

    it("fails closed with too few sources or sources that disagree", () => {
        expect(() => aggregatePrice("sol", [116, Number.NaN, Number.NaN])).toThrow(/need 2 sources/);
        expect(() => aggregatePrice("eth", [2500, 2700])).toThrow(/disagree/);
        expect(() => aggregatePrice("eth", [0, -1, 2500])).toThrow(/need 2 sources/);
    });

    it("USDC is pinned at $1 without any network call", async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        expect(await getUsdPrice("usdc")).toBe(1);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("parses each source's response, tolerates one failing, and caches", async () => {
        const fetchSpy = vi.fn(async (url: string) => {
            if (url.includes("coinbase")) return new Response(JSON.stringify({ data: { amount: "2555.70" } }));
            if (url.includes("kraken")) return new Response(JSON.stringify({ error: [], result: { XETHZUSD: { c: ["2555.65", "0.1"] } } }));
            return new Response("rate limited", { status: 429 });
        });
        vi.stubGlobal("fetch", fetchSpy);
        expect(await getUsdPrice("eth")).toBeCloseTo(2555.675, 6);
        expect(await getUsdPrice("eth")).toBeCloseTo(2555.675, 6);
        expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
});
