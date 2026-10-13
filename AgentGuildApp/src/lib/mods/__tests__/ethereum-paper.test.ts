import { describe, it, expect } from "vitest";
import {
  DEFAULT_POLICY, PaperTradeError, USDC_KEY, applyPaperSwap, newPaperWallet, normalizePolicy, tradePolicyViolation, transferPolicyViolation, valuePortfolio,
  type PaperFill,
} from "../../../../mods/ethereum/paper";
import { NATIVE, USDC } from "../../../../mods/ethereum/market";

const ETH = NATIVE.toLowerCase();
const buyEth = (usdc: number, eth: number, gasUsd = 2): PaperFill => ({
  inputToken: USDC, outputToken: NATIVE, inRaw: BigInt(usdc * 1e6), outRaw: BigInt(Math.round(eth * 1e6)) * 10n ** 12n,
  inDecimals: 6, outDecimals: 18, inSymbol: "USDC", outSymbol: "ETH", usdValue: usdc, gasUsd,
});

describe("applyPaperSwap", () => {
  it("charges gas out of the output and keeps equity consistent", () => {
    const { wallet, realizedUsd } = applyPaperSwap(newPaperWallet(), buyEth(2_000, 1, 2));
    expect(BigInt(wallet.holdings[USDC_KEY].raw)).toBe(8_000_000_000n);
    const eth = Number(BigInt(wallet.holdings[ETH].raw)) / 1e18;
    expect(eth).toBeCloseTo(0.999, 6); // $2 gas of a $2000 swap = 0.1%
    expect(realizedUsd).toBeCloseTo(-2, 6);
    expect(wallet.feesUsd).toBe(2);
    const p = valuePortfolio(wallet, { [USDC_KEY]: 1, [ETH]: 2_000 });
    expect(p.equityUsd).toBeCloseTo(9_998, 4);
    expect(p.pnlUsd).toBeCloseTo(p.realizedUsd + p.unrealizedUsd, 6);
  });

  it("realizes gains on the way out at average cost", () => {
    let { wallet } = applyPaperSwap(newPaperWallet(), buyEth(2_000, 1, 0));
    const sell: PaperFill = {
      inputToken: NATIVE, outputToken: USDC, inRaw: 10n ** 18n, outRaw: 3_000_000_000n, inDecimals: 18, outDecimals: 6,
      inSymbol: "ETH", outSymbol: "USDC", usdValue: 3_000, gasUsd: 0,
    };
    const out = applyPaperSwap(wallet, sell);
    wallet = out.wallet;
    expect(out.realizedUsd).toBeCloseTo(1_000, 6);
    expect(wallet.holdings[ETH]).toBeUndefined();
  });

  it("refuses overspending and swaps eaten by gas", () => {
    expect(() => applyPaperSwap(newPaperWallet(), buyEth(20_000, 10))).toThrow(PaperTradeError);
    expect(() => applyPaperSwap(newPaperWallet(), buyEth(1, 0.0005, 3))).toThrow(/Gas/);
  });

  it("matches token addresses case-insensitively", () => {
    const { wallet } = applyPaperSwap(newPaperWallet(), { ...buyEth(100, 0.05), inputToken: USDC.toUpperCase().replace("0X", "0x") });
    expect(BigInt(wallet.holdings[USDC_KEY].raw)).toBe(9_900_000_000n);
  });
});

describe("policy", () => {
  it("validates and lowercases owner edits", () => {
    const p = normalizePolicy({ maxTransferEth: "0.5", transferAllowlist: ["0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045"], maxTradeUsd: null });
    expect(p.maxTransferEth).toBe(0.5);
    expect(p.maxTradeUsd).toBeNull();
    expect(p.transferAllowlist).toEqual(["0xd8da6bf26964af9d7eed9e03e53415d37aa96045"]);
    expect(() => normalizePolicy({ allowedTokens: ["nope"] })).toThrow(/not a valid address/);
    expect(() => normalizePolicy({ maxTradeUsd: -1 })).toThrow(PaperTradeError);
  });

  it("enforces size, daily volume, token list and pause on trades", () => {
    const trade = { inputToken: USDC, outputToken: NATIVE, usdValue: 1_000 };
    expect(tradePolicyViolation(DEFAULT_POLICY, trade, 0)).toBeNull();
    expect(tradePolicyViolation({ ...DEFAULT_POLICY, maxTradeUsd: 500 }, trade, 0)).toMatch(/per-trade/);
    expect(tradePolicyViolation(DEFAULT_POLICY, trade, 24_500)).toMatch(/daily/);
    expect(tradePolicyViolation({ ...DEFAULT_POLICY, allowedTokens: ["0x514910771af9ca656af840dff83e8264ecf986ca"] }, trade, 0)).toMatch(/allowed list/);
    expect(tradePolicyViolation({ ...DEFAULT_POLICY, paused: true }, trade, 0)).toMatch(/paused/);
  });

  it("enforces allowlist and ETH cap on signing", () => {
    const pol = { ...DEFAULT_POLICY, transferAllowlist: ["0xd8da6bf26964af9d7eed9e03e53415d37aa96045"] };
    expect(transferPolicyViolation(pol, { to: "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045", eth: 0.5 })).toBeNull();
    expect(transferPolicyViolation(pol, { to: "0x0000000000000000000000000000000000000001", eth: null })).toMatch(/allowlist/);
    expect(transferPolicyViolation(DEFAULT_POLICY, { to: null, eth: 2 })).toMatch(/1 ETH/);
  });
});
