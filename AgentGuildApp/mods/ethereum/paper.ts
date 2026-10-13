/**
 * Paper spot trading on Ethereum mainnet: swaps filled at the real
 * KyberSwap quote for the exact amount (route, pool fees and price impact
 * included), charged the quote's own mainnet gas cost, against a virtual
 * wallet with average-cost P&L per token. Pure functions only —
 * persistence is in paper-store.ts and quotes come from market.ts.
 *
 * Balances are kept in base units (strings of integers) so a paper wallet
 * never drifts from what a real one would hold.
 */
import { isAddress } from "viem";
import { USDC } from "./market";

/** Virtual USDC a new paper wallet starts with. */
export const PAPER_START_USDC = 10_000;
export const USDC_DECIMALS = 6;
/** Used when a quote comes back without a gas estimate. */
export const FALLBACK_GAS_USD = 1;

const key = (token: string) => token.toLowerCase();
export const USDC_KEY = key(USDC);

export interface PaperHolding {
  /** Base units. */
  raw: string;
  decimals: number;
  /** Average USD cost per whole token. */
  avgCostUsd: number;
  symbol: string | null;
}

export interface PaperWallet {
  /** Keyed by lowercase token address (NATIVE for ETH). */
  holdings: Record<string, PaperHolding>;
  realizedUsd: number;
  feesUsd: number;
  startUsd: number;
  tradeCount: number;
  volumeUsd: number;
}

export function newPaperWallet(startUsdc = PAPER_START_USDC): PaperWallet {
  const raw = BigInt(Math.round(startUsdc * 10 ** USDC_DECIMALS)).toString();
  return {
    holdings: { [USDC_KEY]: { raw, decimals: USDC_DECIMALS, avgCostUsd: 1, symbol: "USDC" } },
    realizedUsd: 0, feesUsd: 0, startUsd: startUsdc, tradeCount: 0, volumeUsd: 0,
  };
}

export class PaperTradeError extends Error {}

export interface PaperFill {
  inputToken: string;
  outputToken: string;
  inRaw: bigint;
  outRaw: bigint;
  inDecimals: number;
  outDecimals: number;
  inSymbol: string | null;
  outSymbol: string | null;
  /** USD value of the swap. */
  usdValue: number;
  /** Gas the swap would have cost on mainnet, in USD. */
  gasUsd: number;
}

export interface PaperTradeResult {
  wallet: PaperWallet;
  /** Output credited after gas, base units. */
  netOutRaw: bigint;
  /** P&L realized by disposing of the input token, net of gas. */
  realizedUsd: number;
}

const toWhole = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

/**
 * Applies one swap. Disposing of the input realizes (value − its average
 * cost − gas); the output joins its holding at a size-weighted average
 * cost. Throws PaperTradeError when the wallet can't cover the input.
 */
export function applyPaperSwap(wallet: PaperWallet, fill: PaperFill): PaperTradeResult {
  const inKey = key(fill.inputToken);
  const outKey = key(fill.outputToken);
  if (inKey === outKey) throw new PaperTradeError("Input and output are the same token");
  if (fill.inRaw <= 0n || fill.outRaw <= 0n) throw new PaperTradeError("Swap amounts must be positive");
  if (!(fill.usdValue >= 0)) throw new PaperTradeError("Swap has no USD value");
  const gas = Number.isFinite(fill.gasUsd) && fill.gasUsd >= 0 ? fill.gasUsd : FALLBACK_GAS_USD;
  if (gas >= fill.usdValue) throw new PaperTradeError(`Gas (~$${gas.toFixed(2)}) would eat the whole $${fill.usdValue.toFixed(2)} swap — trade a bigger size`);

  const holdings = { ...wallet.holdings };
  const src = holdings[inKey];
  const have = src ? BigInt(src.raw) : 0n;
  if (have < fill.inRaw) {
    throw new PaperTradeError(`Paper wallet holds ${src ? toWhole(have, src.decimals) : 0} ${fill.inSymbol ?? "of the input token"} — not enough to swap ${toWhole(fill.inRaw, fill.inDecimals)}`);
  }

  const costOfSold = toWhole(fill.inRaw, fill.inDecimals) * (src?.avgCostUsd ?? 0);
  const realized = fill.usdValue - costOfSold - gas;
  const left = have - fill.inRaw;
  if (left === 0n) delete holdings[inKey];
  else holdings[inKey] = { ...src!, raw: left.toString() };

  // Gas comes out of what's received, so equity = start + realized + unrealized holds.
  const feeShare = Math.min(gas / fill.usdValue, 1);
  const netOut = fill.outRaw - BigInt(Math.ceil(Number(fill.outRaw) * feeShare));
  const netValue = fill.usdValue - gas;

  const dst = holdings[outKey];
  const dstHave = dst ? BigInt(dst.raw) : 0n;
  const dstCost = dst ? toWhole(dstHave, dst.decimals) * dst.avgCostUsd : 0;
  const newRaw = dstHave + netOut;
  const newWhole = toWhole(newRaw, fill.outDecimals);
  holdings[outKey] = {
    raw: newRaw.toString(),
    decimals: fill.outDecimals,
    avgCostUsd: newWhole > 0 ? (dstCost + netValue) / newWhole : 0,
    symbol: dst?.symbol ?? fill.outSymbol,
  };

  return {
    realizedUsd: realized,
    netOutRaw: netOut,
    wallet: {
      ...wallet,
      holdings,
      realizedUsd: wallet.realizedUsd + realized,
      feesUsd: wallet.feesUsd + gas,
      tradeCount: wallet.tradeCount + 1,
      volumeUsd: wallet.volumeUsd + fill.usdValue,
    },
  };
}

export interface PortfolioLine {
  token: string;
  symbol: string | null;
  amount: number;
  priceUsd: number | null;
  valueUsd: number | null;
  avgCostUsd: number;
  unrealizedUsd: number | null;
  /** Share of equity, 0–100. */
  weightPct: number | null;
}

export interface PortfolioSummary {
  equityUsd: number;
  startUsd: number;
  pnlUsd: number;
  returnPct: number;
  realizedUsd: number;
  unrealizedUsd: number;
  feesUsd: number;
  tradeCount: number;
  volumeUsd: number;
  /** Holdings with no price — left out of equity. */
  unpriced: string[];
  lines: PortfolioLine[];
}

/** Marks a wallet to market. `prices` maps lowercase token → USD (missing = unpriced). */
export function valuePortfolio(wallet: PaperWallet, prices: Record<string, number | null>): PortfolioSummary {
  const lines: PortfolioLine[] = Object.entries(wallet.holdings).map(([token, h]) => {
    const amount = toWhole(BigInt(h.raw), h.decimals);
    const priceUsd = prices[token] ?? null;
    const valueUsd = priceUsd == null ? null : amount * priceUsd;
    return {
      token, symbol: h.symbol, amount, priceUsd, valueUsd, avgCostUsd: h.avgCostUsd,
      unrealizedUsd: valueUsd == null ? null : valueUsd - amount * h.avgCostUsd, weightPct: null,
    };
  });
  const equityUsd = lines.reduce((s, l) => s + (l.valueUsd ?? 0), 0);
  for (const l of lines) l.weightPct = l.valueUsd == null || equityUsd <= 0 ? null : (l.valueUsd / equityUsd) * 100;
  lines.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  const unrealizedUsd = lines.reduce((s, l) => s + (l.unrealizedUsd ?? 0), 0);
  const pnlUsd = equityUsd - wallet.startUsd;
  return {
    equityUsd, startUsd: wallet.startUsd, pnlUsd,
    returnPct: wallet.startUsd > 0 ? (pnlUsd / wallet.startUsd) * 100 : 0,
    realizedUsd: wallet.realizedUsd, unrealizedUsd, feesUsd: wallet.feesUsd,
    tradeCount: wallet.tradeCount, volumeUsd: wallet.volumeUsd,
    unpriced: lines.filter((l) => l.priceUsd == null).map((l) => l.token),
    lines,
  };
}

// ── Policy ───────────────────────────────────────────────────────────────

/**
 * What an org owner lets one agent do. Applies to paper trades and to
 * anything the agent's wallet signs (transfers, sends, deploys). `null`
 * limits mean "no limit"; empty lists mean "anything".
 */
export interface AgentPolicy {
  /** Stops every trade and every signature until lifted. */
  paused: boolean;
  maxTradeUsd: number | null;
  maxDailyVolumeUsd: number | null;
  /** Tokens the agent may trade (lowercase addresses). Empty = any. */
  allowedTokens: string[];
  /** Addresses the agent may send ETH or tokens to (lowercase). Empty = any. */
  transferAllowlist: string[];
  /** Largest ETH value in a single transfer or transaction. */
  maxTransferEth: number | null;
}

export const DEFAULT_POLICY: AgentPolicy = {
  paused: false,
  maxTradeUsd: 2_500,
  maxDailyVolumeUsd: 25_000,
  allowedTokens: [],
  transferAllowlist: [],
  maxTransferEth: 1,
};

/** Validates an owner's edit and fills the rest from `base`. Addresses are stored lowercase. */
export function normalizePolicy(input: Record<string, unknown>, base: AgentPolicy = DEFAULT_POLICY): AgentPolicy {
  const out: AgentPolicy = { ...base };
  const limit = (k: "maxTradeUsd" | "maxDailyVolumeUsd" | "maxTransferEth") => {
    if (!(k in input)) return;
    const v = input[k];
    if (v === null || v === "") { out[k] = null; return; }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new PaperTradeError(`${k} must be a positive number or null`);
    out[k] = n;
  };
  limit("maxTradeUsd");
  limit("maxDailyVolumeUsd");
  limit("maxTransferEth");
  if ("paused" in input) out.paused = input.paused === true;
  const list = (k: "allowedTokens" | "transferAllowlist") => {
    if (!(k in input)) return;
    const v = input[k];
    if (!Array.isArray(v) || v.length > 50) throw new PaperTradeError(`${k} must be a list of up to 50 addresses`);
    const items = [...new Set(v.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
    const bad = items.find((x) => !isAddress(x, { strict: false }));
    if (bad) throw new PaperTradeError(`${k}: "${bad}" is not a valid address`);
    out[k] = items;
  };
  list("allowedTokens");
  list("transferAllowlist");
  return out;
}

/** Why a trade breaks the policy, or null when it's allowed. */
export function tradePolicyViolation(policy: AgentPolicy, trade: { inputToken: string; outputToken: string; usdValue: number }, volumeTodayUsd: number): string | null {
  if (policy.paused) return "Trading is paused for this agent by its org owner";
  if (policy.allowedTokens.length) {
    const blocked = [trade.inputToken, trade.outputToken].map(key).find((t) => t !== USDC_KEY && !policy.allowedTokens.includes(t));
    if (blocked) return `Token ${blocked} isn't on this agent's allowed list`;
  }
  if (policy.maxTradeUsd != null && trade.usdValue > policy.maxTradeUsd) {
    return `Trade of $${trade.usdValue.toFixed(2)} is over this agent's $${policy.maxTradeUsd} per-trade limit`;
  }
  if (policy.maxDailyVolumeUsd != null && volumeTodayUsd + trade.usdValue > policy.maxDailyVolumeUsd) {
    return `Trade would take today's volume to $${(volumeTodayUsd + trade.usdValue).toFixed(2)}, over the $${policy.maxDailyVolumeUsd} daily limit`;
  }
  return null;
}

/**
 * Why something the agent's wallet would sign breaks the policy, or null.
 * `to` is where value goes (the transfer recipient, or a tx's `to` when it
 * carries ETH); `eth` is the ETH value moved, if any.
 */
export function transferPolicyViolation(policy: AgentPolicy, transfer: { to: string | null; eth: number | null }): string | null {
  if (policy.paused) return "Signing is paused for this agent by its org owner";
  if (transfer.to && policy.transferAllowlist.length && !policy.transferAllowlist.includes(key(transfer.to))) {
    return `${transfer.to} isn't on this agent's transfer allowlist`;
  }
  if (transfer.eth != null && policy.maxTransferEth != null && transfer.eth > policy.maxTransferEth) {
    return `${transfer.eth} ETH is over this agent's ${policy.maxTransferEth} ETH transfer limit`;
  }
  return null;
}
