import { describe, it, expect } from "vitest";
import {
  toNative,
  shortAddress,
  getCurrencySymbol,
  getCurrencyDecimals,
  getChainById,
  getExplorerTxUrl,
} from "../chains";

describe("toNative", () => {
  it("converts lamports to SOL (9 decimals, default)", () => {
    expect(toNative(1_000_000_000)).toBeCloseTo(1);
  });

  it("converts wei to ETH (18 decimals, chainId 8453 / Base)", () => {
    expect(toNative(1_000_000_000_000_000_000, 8453)).toBeCloseTo(1);
  });

  it("handles zero", () => {
    expect(toNative(0)).toBe(0);
  });

  it("defaults to 9 decimals for unknown chainId", () => {
    expect(toNative(1_000_000_000, 999999)).toBeCloseTo(1);
  });
});

describe("shortAddress", () => {
  it("shortens a valid address", () => {
    expect(shortAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")).toBe(
      "0xabcd...abcd"
    );
  });

  it("returns dash for zero address", () => {
    expect(shortAddress("0x0000000000000000000000000000000000000000")).toBe(
      "—"
    );
  });

  it("returns dash for empty input", () => {
    expect(shortAddress("")).toBe("—");
  });
});

describe("getCurrencySymbol", () => {
  it("returns SOL for undefined chainId", () => {
    expect(getCurrencySymbol()).toBe("SOL");
  });

  it("returns ETH for Base (8453)", () => {
    expect(getCurrencySymbol(8453)).toBe("ETH");
  });

  it("returns SOL for unknown chainId", () => {
    expect(getCurrencySymbol(999999)).toBe("SOL");
  });
});

describe("getCurrencyDecimals", () => {
  it("returns 18 for Base (8453)", () => {
    expect(getCurrencyDecimals(8453)).toBe(18);
  });

  it("defaults to 9 for undefined chainId", () => {
    expect(getCurrencyDecimals()).toBe(9);
  });

  it("defaults to 9 for unknown chainId", () => {
    expect(getCurrencyDecimals(999999)).toBe(9);
  });
});

describe("getChainById", () => {
  it("finds Base by chainId (8453)", () => {
    const chain = getChainById(8453);
    expect(chain).toBeDefined();
    expect(chain!.key).toBe("base");
  });

  it("returns undefined for unknown chainId", () => {
    expect(getChainById(999999)).toBeUndefined();
  });
});

describe("getExplorerTxUrl", () => {
  it("returns Solscan devnet URL for undefined chainId", () => {
    const url = getExplorerTxUrl("abc123");
    expect(url).toContain("solscan.io");
    expect(url).toContain("abc123");
  });

  it("returns BaseScan URL for Base (8453)", () => {
    const url = getExplorerTxUrl("0xabc", 8453);
    expect(url).toContain("basescan.org");
    expect(url).toContain("0xabc");
  });
});
