import { describe, expect, it } from "vitest";
import { maxUint256, type Hex } from "viem";
import {
  checkTrigger, describeTrigger, eip681Url, parseOrderAmount, parsePriceTrigger, scanRange, stepPriceWatch, summarizeActivity, taggedAmount,
  type Watch,
} from "../../../../mods/ethereum/automation";
import { approvalFlags, externalSignRefusal, parseTxCall, tokenVerdict, type TokenFacts, type TxPreview } from "../../../../mods/ethereum/chainchecks";

const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ME = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x2222222222222222222222222222222222222222";
const resolve = (v: string) => (v === "ETH" ? ETH : v === "USDC" ? USDC : v);

describe("price triggers", () => {
  it("parses above/below/trail, accepts `mint` as an alias, rejects nonsense", () => {
    expect(parsePriceTrigger({ token: "ETH", op: "below", usd: 2000 }, resolve)).toEqual({ token: ETH, op: "below", usd: 2000 });
    expect(parsePriceTrigger({ mint: "ETH", op: "trail", trailPct: 5 }, resolve)).toEqual({ token: ETH, op: "trail", trailPct: 5, peakUsd: null });
    expect(() => parsePriceTrigger({ token: "ETH", op: "below", usd: 0 }, resolve)).toThrow(/positive/);
    expect(() => parsePriceTrigger({ token: "ETH", op: "trail", trailPct: 0.1 }, resolve)).toThrow(/0.5 and 50/);
    expect(() => parsePriceTrigger({ op: "above", usd: 1 }, resolve)).toThrow(/token is required/);
  });

  it("fires at the level, tracks a trailing high, and never fires without a price", () => {
    expect(checkTrigger({ token: ETH, op: "above", usd: 3000 }, 3000).hit).toBe(true);
    expect(checkTrigger({ token: ETH, op: "below", usd: 3000 }, null).hit).toBe(false);
    const t = checkTrigger({ token: ETH, op: "trail", trailPct: 10, peakUsd: 2000 }, 2500);
    expect(t).toMatchObject({ hit: false, changed: true, next: { peakUsd: 2500 } });
    expect(checkTrigger(t.next, 2249).hit).toBe(true);
    expect(describeTrigger(t.next, "ETH")).toBe("ETH falls 10% from its high (high $2,500)");
  });

  it("a repeating price watch fires once per crossing", () => {
    const w: Extract<Watch, { kind: "price" }> = {
      id: "w", agentId: "a", orgId: "o", status: "active", createdAt: "", expiresAt: "", note: null, repeat: true, fireCount: 0,
      kind: "price", armed: true, trigger: { token: ETH, op: "above", usd: 3000 },
    };
    let s = stepPriceWatch(w, 3100);
    expect(s.fire).toBe(true);
    s = stepPriceWatch(s.next, 3200);
    expect(s.fire).toBe(false);
    s = stepPriceWatch(s.next, 2900);
    expect(s.next.armed).toBe(true);
    expect(stepPriceWatch(s.next, 3001).fire).toBe(true);
  });

  it("validates order amounts", () => {
    expect(parseOrderAmount("25%")).toBe("25%");
    expect(parseOrderAmount(" ALL ")).toBe("all");
    expect(() => parseOrderAmount("0")).toThrow();
    expect(() => parseOrderAmount("150%")).toThrow(/between 0 and 100/);
  });
});

describe("block scanning and activity summaries", () => {
  it("scans forward in capped windows and stops when caught up", () => {
    expect(scanRange(100n, 100n)).toBeNull();
    expect(scanRange(100n, 105n)).toEqual({ from: 101n, to: 105n });
    expect(scanRange(0n, 10_000n, 2_000n)).toEqual({ from: 1n, to: 2_000n });
  });

  it("summarizes sends, ETH change and net token moves", () => {
    expect(summarizeActivity({ address: ME, sentTxs: 0, balanceDeltaWei: 0n, moves: [] })).toBeNull();
    const line = summarizeActivity({
      address: ME, sentTxs: 2, balanceDeltaWei: -500000000000000000n,
      moves: [
        { token: USDC, symbol: "USDC", decimals: 6, direction: "in", raw: "25000000" },
        { token: USDC, symbol: "USDC", decimals: 6, direction: "out", raw: "5000000" },
      ],
    });
    expect(line).toBe("sent 2 transactions, ETH −0.5, USDC +20 (2 transfers)");
  });
});

describe("payment requests", () => {
  it("tags the amount with 1–9,999 base units so each request is unique", () => {
    expect(taggedAmount(25_000_000n, 6, () => 0)).toBe(25_000_001n);
    expect(taggedAmount(25_000_000n, 6, () => 0.99999)).toBe(25_009_999n);
    // Few-decimal tokens: a tag would be visible money, so none.
    expect(taggedAmount(5n, 2, () => 0.5)).toBe(5n);
    expect(() => taggedAmount(0n, 18)).toThrow();
  });

  it("builds EIP-681 links for ETH and ERC-20", () => {
    expect(eip681Url({ chainId: 8453, recipient: ME, token: null, amountRaw: "1000" })).toBe(`ethereum:${ME}@8453?value=1000`);
    expect(eip681Url({ chainId: 1, recipient: ME, token: USDC, amountRaw: "25000001" })).toBe(`ethereum:${USDC}@1/transfer?address=${ME}&uint256=25000001`);
  });
});

describe("previewing external transactions", () => {
  const approve = (amount: bigint) => ({ selector: "0x095ea7b3", signature: "approve(address,uint256)", functionName: "approve", args: [SPENDER, amount.toString()], candidates: [] });
  const call = { to: USDC, data: "0x095ea7b3" as Hex, valueEth: 0, from: ME };

  it("flags an unlimited approval to a plain wallet as high risk, to a verified contract as caution", () => {
    const eoa = approvalFlags(call, approve(maxUint256), { address: SPENDER, isContract: false, verified: false });
    expect(eoa).toEqual([expect.objectContaining({ severity: "high", code: "unlimited-approval" })]);
    expect(eoa[0].message).toMatch(/plain wallet/);
    const router = approvalFlags(call, approve(maxUint256), { address: SPENDER, isContract: true, verified: true });
    expect(router[0]).toMatchObject({ severity: "medium", code: "unlimited-approval" });
    expect(approvalFlags(call, approve(1_000_000n), { address: SPENDER, isContract: true, verified: true })[0]).toMatchObject({ severity: "info", code: "approval" });
  });

  it("flags operator grants and unknown functions", () => {
    const op = { selector: "0xa22cb465", signature: "setApprovalForAll(address,bool)", functionName: "setApprovalForAll", args: [SPENDER, true], candidates: [] };
    expect(approvalFlags(call, op, { address: SPENDER, isContract: true, verified: false })[0]).toMatchObject({ severity: "high", code: "operator-approval" });
    const unknown = { selector: "0xdeadbeef", signature: null, functionName: null, args: null, candidates: [] };
    expect(approvalFlags({ ...call, data: "0xdeadbeef" }, unknown, null)).toEqual([expect.objectContaining({ code: "unknown-function" })]);
  });

  const preview = (over: Partial<TxPreview> = {}): TxPreview => ({
    call: { from: ME, to: USDC, valueEth: "0", data: "0x" }, decoded: null, target: null,
    simulation: { success: true, error: null, gasUsed: "50000" }, assetChanges: [], flags: [], verdict: "no-red-flags", ...over,
  });

  it("refuses failing, over-limit and unaccepted high-risk transactions", () => {
    expect(externalSignRefusal(preview({ simulation: { success: false, error: "ERC20: insufficient", gasUsed: null } }), { maxTransferEth: 1 }, true)).toMatch(/fails in simulation/);
    expect(externalSignRefusal(preview({ call: { from: ME, to: USDC, valueEth: "2", data: "0x" } }), { maxTransferEth: 1 }, false)).toMatch(/over this agent's 1 ETH limit/);
    const risky = preview({ flags: [{ severity: "high", code: "unlimited-approval", message: "Grants an UNLIMITED allowance" }] });
    expect(externalSignRefusal(risky, { maxTransferEth: 1 }, false)).toMatch(/acceptRisks/);
    expect(externalSignRefusal(risky, { maxTransferEth: 1 }, true)).toBeNull();
    expect(externalSignRefusal(preview(), { maxTransferEth: null }, false)).toBeNull();
  });

  it("parses wallet-style tx requests with value in wei", () => {
    expect(parseTxCall({ to: USDC.toLowerCase(), data: "0x", value: "0x10" })).toEqual({ to: USDC, data: "0x", valueWei: 16n });
    expect(() => parseTxCall({ to: "nope" })).toThrow(/0x address/);
    expect(() => parseTxCall({ to: USDC, value: "1.5" })).toThrow(/wei/);
    expect(() => parseTxCall({})).toThrow(/needs a `to`/);
  });
});

describe("token safety verdicts", () => {
  const facts = (over: Partial<TokenFacts> = {}): TokenFacts => ({
    address: USDC, isContract: true, name: "Token", symbol: "TKN", decimals: 18, totalSupply: "1000", verified: true,
    implementation: null, proxyAdmin: null, owner: null, ownerRenounced: false, functions: ["transfer(address to, uint256 amount)"], ...over,
  });

  it("passes a plain verified token with deep liquidity", () => {
    const r = tokenVerdict(facts(), { priceUsd: 1, buyImpactPct: 0.1, sellImpactPct: 0.1, roundTripLossPct: 0.4 });
    expect(r).toMatchObject({ verdict: "no-red-flags", findings: [] });
  });

  it("flags owner powers, proxies and round-trip losses", () => {
    const r = tokenVerdict(
      facts({ owner: SPENDER, implementation: "0x3333333333333333333333333333333333333333", functions: ["setSellFee(uint256)", "blacklist(address)", "mint(address,uint256)"] }),
      { priceUsd: 0.01, buyImpactPct: 1, sellImpactPct: 1, roundTripLossPct: 22 },
    );
    expect(r.verdict).toBe("high-risk");
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["upgradeable", "mintable", "blacklist", "adjustable-fee", "round-trip-loss"]));
  });

  it("downgrades owner powers once ownership is renounced", () => {
    const r = tokenVerdict(facts({ ownerRenounced: true, functions: ["mint(address,uint256)"] }), null);
    expect(r.findings).toEqual([expect.objectContaining({ code: "mintable", severity: "info" })]);
    expect(r.verdict).toBe("no-red-flags");
  });

  it("calls out a missing contract or no way to sell", () => {
    expect(tokenVerdict(facts({ isContract: false, decimals: null }), null).findings[0].code).toBe("not-a-contract");
    expect(tokenVerdict(facts(), { priceUsd: 2, buyImpactPct: null, sellImpactPct: null, roundTripLossPct: null }).findings.map((f) => f.code)).toContain("no-sell-route");
  });
});
