import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY, PAPER_NETWORK_FEE_USD, PaperTradeError, USDC_MINT, applyPaperSwap, newPaperWallet, normalizePolicy,
  tradePolicyViolation, transferPolicyViolation, valuePortfolio, type PaperFill,
} from "../../../../mods/solana-settlement/paper";

const SOL = "So11111111111111111111111111111111111111112";

const buySol = (usdc: number, solPrice: number): PaperFill => ({
  inputMint: USDC_MINT, outputMint: SOL,
  inRaw: BigInt(Math.round(usdc * 1e6)), outRaw: BigInt(Math.round((usdc / solPrice) * 1e9)),
  inDecimals: 6, outDecimals: 9, usdValue: usdc,
});
const sellSol = (sol: number, solPrice: number): PaperFill => ({
  inputMint: SOL, outputMint: USDC_MINT,
  inRaw: BigInt(Math.round(sol * 1e9)), outRaw: BigInt(Math.round(sol * solPrice * 1e6)),
  inDecimals: 9, outDecimals: 6, usdValue: sol * solPrice,
});

describe("paper swaps", () => {
  it("starts with 10,000 USDC at $1 cost", () => {
    const w = newPaperWallet();
    expect(w.holdings[USDC_MINT]).toEqual({ raw: "10000000000", decimals: 6, avgCostUsd: 1 });
    expect(valuePortfolio(w, { [USDC_MINT]: 1 }).equityUsd).toBe(10_000);
  });

  it("realizes the gain on a round trip, net of fees", () => {
    let w = newPaperWallet();
    w = applyPaperSwap(w, buySol(1000, 100)).wallet; // ~10 SOL at $100
    const sold = applyPaperSwap(w, sellSol(Number(BigInt(w.holdings[SOL].raw)) / 1e9, 120));
    expect(sold.realizedUsd).toBeCloseTo(200 - 2 * PAPER_NETWORK_FEE_USD, 1);
    expect(sold.wallet.holdings[SOL]).toBeUndefined();
    expect(sold.wallet.tradeCount).toBe(2);
    const p = valuePortfolio(sold.wallet, { [USDC_MINT]: 1 });
    expect(p.equityUsd).toBeCloseTo(10_200, 0);
    expect(p.returnPct).toBeCloseTo(2, 1);
  });

  it("averages cost across buys and marks unrealized P&L", () => {
    let w = newPaperWallet();
    w = applyPaperSwap(w, buySol(1000, 100)).wallet;
    w = applyPaperSwap(w, buySol(1000, 200)).wallet; // 10 + 5 SOL for $2000 → ~$133.33
    expect(w.holdings[SOL].avgCostUsd).toBeCloseTo(133.33, 0);
    const p = valuePortfolio(w, { [USDC_MINT]: 1, [SOL]: 150 }, { [SOL]: "SOL" });
    const sol = p.lines.find((l) => l.mint === SOL)!;
    expect(sol.unrealizedUsd).toBeCloseTo(15 * 150 - 2000, 0);
    // Equity reconciles: start + realized + unrealized.
    expect(p.equityUsd).toBeCloseTo(p.startUsd + p.realizedUsd + p.unrealizedUsd, 2);
  });

  it("refuses to spend more than the wallet holds", () => {
    expect(() => applyPaperSwap(newPaperWallet(), buySol(20_000, 100))).toThrow(PaperTradeError);
    expect(() => applyPaperSwap(newPaperWallet(), sellSol(1, 100))).toThrow(/holds 0/);
  });

  it("leaves unpriced tokens out of equity and lists them", () => {
    let w = newPaperWallet();
    w = applyPaperSwap(w, buySol(500, 100)).wallet;
    const p = valuePortfolio(w, { [USDC_MINT]: 1 });
    expect(p.unpriced).toEqual([SOL]);
    expect(p.equityUsd).toBeCloseTo(9500, 2);
  });
});

describe("agent policy", () => {
  it("enforces pause, per-trade size, daily volume and allowed tokens", () => {
    const trade = { inputMint: USDC_MINT, outputMint: SOL, usdValue: 100 };
    expect(tradePolicyViolation(DEFAULT_POLICY, trade, 0)).toBeNull();
    expect(tradePolicyViolation({ ...DEFAULT_POLICY, paused: true }, trade, 0)).toMatch(/paused/);
    expect(tradePolicyViolation({ ...DEFAULT_POLICY, maxTradeUsd: 50 }, trade, 0)).toMatch(/per-trade/);
    expect(tradePolicyViolation({ ...DEFAULT_POLICY, maxDailyVolumeUsd: 150 }, trade, 100)).toMatch(/daily/);
    expect(tradePolicyViolation({ ...DEFAULT_POLICY, allowedMints: ["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"] }, trade, 0)).toMatch(/allowed list/);
    // USDC is always tradable so an agent can get back to cash.
    expect(tradePolicyViolation({ ...DEFAULT_POLICY, allowedMints: [SOL] }, trade, 0)).toBeNull();
  });

  it("enforces the transfer allowlist and SOL cap", () => {
    const p = { ...DEFAULT_POLICY, transferAllowlist: ["Good111"], maxTransferSol: 1 };
    expect(transferPolicyViolation(p, { to: "Bad111", sol: 0.1 })).toMatch(/allowlist/);
    expect(transferPolicyViolation(p, { to: "Good111", sol: 2 })).toMatch(/limit/);
    expect(transferPolicyViolation(p, { to: "Good111", sol: null })).toBeNull();
  });

  it("validates an owner's edit and keeps fields they didn't send", () => {
    const p = normalizePolicy({ maxTradeUsd: "500", maxDailyVolumeUsd: null, paused: true });
    expect(p).toMatchObject({ maxTradeUsd: 500, maxDailyVolumeUsd: null, paused: true, maxTransferSol: DEFAULT_POLICY.maxTransferSol });
    expect(() => normalizePolicy({ maxTradeUsd: -1 })).toThrow(PaperTradeError);
    expect(() => normalizePolicy({ transferAllowlist: ["nope"] }, DEFAULT_POLICY, (a) => a !== "nope")).toThrow(/not a valid address/);
    expect(normalizePolicy({ allowedMints: [" A ", "A", ""] }).allowedMints).toEqual(["A"]);
  });
});
