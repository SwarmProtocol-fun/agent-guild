/**
 * Paper spot trading on Solana: swaps filled at the real Jupiter quote for
 * the exact amount (route, DEX fees and price impact included), against a
 * virtual wallet, with average-cost P&L per token. Pure functions only —
 * persistence is in paper-store.ts and quotes come from market.ts.
 *
 * Balances are kept in base units (strings of integers) so a paper wallet
 * never drifts from what a real one would hold.
 */
import { SYMBOL_MINTS } from "./market";

/** Virtual USDC a new paper wallet starts with. */
export const PAPER_START_USDC = 10_000;
export const USDC_MINT = SYMBOL_MINTS.USDC;
export const USDC_DECIMALS = 6;
/** Solana base fee + a typical priority fee for a Jupiter swap, charged in SOL value. */
export const PAPER_NETWORK_FEE_USD = 0.002;

export interface PaperHolding {
  /** Base units. */
  raw: string;
  decimals: number;
  /** Average USD cost per whole token. */
  avgCostUsd: number;
}

export interface PaperWallet {
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
    holdings: { [USDC_MINT]: { raw, decimals: USDC_DECIMALS, avgCostUsd: 1 } },
    realizedUsd: 0, feesUsd: 0, startUsd: startUsdc, tradeCount: 0, volumeUsd: 0,
  };
}

export class PaperTradeError extends Error {}

export interface PaperFill {
  inputMint: string;
  outputMint: string;
  inRaw: bigint;
  outRaw: bigint;
  inDecimals: number;
  outDecimals: number;
  /** USD value of the swap (Jupiter's swapUsdValue, or priced locally). */
  usdValue: number;
}

export interface PaperTradeResult {
  wallet: PaperWallet;
  /** Output credited after the network fee, base units. */
  netOutRaw: bigint;
  /** P&L realized by disposing of the input token, net of the network fee. */
  realizedUsd: number;
}

const toWhole = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

/**
 * Applies one swap. Disposing of the input realizes (value − its average
 * cost); the output joins its holding at a size-weighted average cost.
 * Throws PaperTradeError when the wallet can't cover the input.
 */
export function applyPaperSwap(wallet: PaperWallet, fill: PaperFill): PaperTradeResult {
  if (fill.inputMint === fill.outputMint) throw new PaperTradeError("Input and output are the same token");
  if (fill.inRaw <= 0n || fill.outRaw <= 0n) throw new PaperTradeError("Swap amounts must be positive");
  if (!(fill.usdValue >= 0)) throw new PaperTradeError("Swap has no USD value");

  const holdings = { ...wallet.holdings };
  const src = holdings[fill.inputMint];
  const have = src ? BigInt(src.raw) : 0n;
  if (have < fill.inRaw) {
    throw new PaperTradeError(`Paper wallet holds ${src ? toWhole(have, src.decimals) : 0} of the input token — not enough to swap ${toWhole(fill.inRaw, fill.inDecimals)}`);
  }

  const costOfSold = toWhole(fill.inRaw, fill.inDecimals) * (src?.avgCostUsd ?? 0);
  const realized = fill.usdValue - costOfSold - PAPER_NETWORK_FEE_USD;
  const left = have - fill.inRaw;
  if (left === 0n) delete holdings[fill.inputMint];
  else holdings[fill.inputMint] = { ...src!, raw: left.toString() };

  // The network fee comes out of what's received, so equity = start + realized + unrealized holds.
  const feeShare = fill.usdValue > 0 ? Math.min(PAPER_NETWORK_FEE_USD / fill.usdValue, 1) : 0;
  const netOut = fill.outRaw - BigInt(Math.ceil(Number(fill.outRaw) * feeShare));
  const netValue = Math.max(fill.usdValue - PAPER_NETWORK_FEE_USD, 0);

  const dst = holdings[fill.outputMint];
  const dstHave = dst ? BigInt(dst.raw) : 0n;
  const dstCost = dst ? toWhole(dstHave, dst.decimals) * dst.avgCostUsd : 0;
  const newRaw = dstHave + netOut;
  const newWhole = toWhole(newRaw, fill.outDecimals);
  holdings[fill.outputMint] = {
    raw: newRaw.toString(),
    decimals: fill.outDecimals,
    avgCostUsd: newWhole > 0 ? (dstCost + netValue) / newWhole : 0,
  };

  return {
    realizedUsd: realized,
    netOutRaw: netOut,
    wallet: {
      ...wallet,
      holdings,
      realizedUsd: wallet.realizedUsd + realized,
      feesUsd: wallet.feesUsd + PAPER_NETWORK_FEE_USD,
      tradeCount: wallet.tradeCount + 1,
      volumeUsd: wallet.volumeUsd + fill.usdValue,
    },
  };
}

export interface PortfolioLine {
  mint: string;
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
  /** Holdings Jupiter couldn't price — left out of equity. */
  unpriced: string[];
  lines: PortfolioLine[];
}

/** Marks a wallet to market. `prices` maps mint → USD (missing = unpriced). */
export function valuePortfolio(wallet: PaperWallet, prices: Record<string, number | null>, symbols: Record<string, string | null> = {}): PortfolioSummary {
  const lines: PortfolioLine[] = Object.entries(wallet.holdings).map(([mint, h]) => {
    const amount = toWhole(BigInt(h.raw), h.decimals);
    const priceUsd = prices[mint] ?? null;
    const valueUsd = priceUsd == null ? null : amount * priceUsd;
    return {
      mint, symbol: symbols[mint] ?? null, amount, priceUsd, valueUsd, avgCostUsd: h.avgCostUsd,
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
    unpriced: lines.filter((l) => l.priceUsd == null).map((l) => l.mint),
    lines,
  };
}

// ── Policy ───────────────────────────────────────────────────────────────

/**
 * What an org owner lets one agent do. Applies to paper trades now and to
 * anything the agent's wallet signs (transfers, sends, deploys). `null`
 * limits mean "no limit"; empty lists mean "anything".
 */
export interface AgentPolicy {
  /** Stops every trade and every signature until lifted. */
  paused: boolean;
  maxTradeUsd: number | null;
  maxDailyVolumeUsd: number | null;
  /** Tokens the agent may trade (mints). Empty = any. */
  allowedMints: string[];
  /** Addresses solana_transfer may send to. Empty = any. */
  transferAllowlist: string[];
  /** Largest single SOL transfer. */
  maxTransferSol: number | null;
}

export const DEFAULT_POLICY: AgentPolicy = {
  paused: false,
  maxTradeUsd: 2_500,
  maxDailyVolumeUsd: 25_000,
  allowedMints: [],
  transferAllowlist: [],
  maxTransferSol: 5,
};

/** Validates an owner's edit and fills the rest from `base`. */
export function normalizePolicy(input: Record<string, unknown>, base: AgentPolicy = DEFAULT_POLICY, isAddress: (s: string) => boolean = () => true): AgentPolicy {
  const out: AgentPolicy = { ...base };
  const limit = (key: "maxTradeUsd" | "maxDailyVolumeUsd" | "maxTransferSol") => {
    if (!(key in input)) return;
    const v = input[key];
    if (v === null || v === "") { out[key] = null; return; }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new PaperTradeError(`${key} must be a positive number or null`);
    out[key] = n;
  };
  limit("maxTradeUsd");
  limit("maxDailyVolumeUsd");
  limit("maxTransferSol");
  if ("paused" in input) out.paused = input.paused === true;
  const list = (key: "allowedMints" | "transferAllowlist") => {
    if (!(key in input)) return;
    const v = input[key];
    if (!Array.isArray(v) || v.length > 50) throw new PaperTradeError(`${key} must be a list of up to 50 addresses`);
    const items = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
    const bad = items.find((x) => !isAddress(x));
    if (bad) throw new PaperTradeError(`${key}: "${bad}" is not a valid address`);
    out[key] = items;
  };
  list("allowedMints");
  list("transferAllowlist");
  return out;
}

/** Why a trade breaks the policy, or null when it's allowed. */
export function tradePolicyViolation(policy: AgentPolicy, trade: { inputMint: string; outputMint: string; usdValue: number }, volumeTodayUsd: number): string | null {
  if (policy.paused) return "Trading is paused for this agent by its org owner";
  if (policy.allowedMints.length) {
    const blocked = [trade.inputMint, trade.outputMint].find((m) => m !== USDC_MINT && !policy.allowedMints.includes(m));
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

/** Why a transfer breaks the policy, or null. */
export function transferPolicyViolation(policy: AgentPolicy, transfer: { to: string; sol: number | null }): string | null {
  if (policy.paused) return "Signing is paused for this agent by its org owner";
  if (policy.transferAllowlist.length && !policy.transferAllowlist.includes(transfer.to)) {
    return `${transfer.to} isn't on this agent's transfer allowlist`;
  }
  if (transfer.sol != null && policy.maxTransferSol != null && transfer.sol > policy.maxTransferSol) {
    return `${transfer.sol} SOL is over this agent's ${policy.maxTransferSol} SOL transfer limit`;
  }
  return null;
}
