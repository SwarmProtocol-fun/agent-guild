/**
 * Intent guardrails — pure functions, no I/O.
 *
 * An org owner attaches a policy to one of an agent's custodial wallets
 * (lib/agent-wallets.ts). Agents then submit *intents* ("send 5 USDC to X")
 * instead of signing anything themselves; the server checks the intent
 * against the policy, simulates it, and only then signs with the wallet key
 * it already holds.
 *
 * Amounts are handled as integer base units (bigint) throughout — no floats
 * anywhere near money.
 */

import { getChain, USDC_DECIMALS, type ChainConfig } from "@/lib/chains";

export type Asset = "native" | "usdc";

export interface TransferIntent {
  type: "transfer";
  network: string; // chain key from lib/chains.ts
  asset: Asset;
  to: string;
  amount: string; // decimal string in whole units, e.g. "1.5"
  memo?: string;
}

export interface EvmCallIntent {
  type: "evm_call";
  network: string;
  to: string; // contract
  data: string; // 0x calldata
  value?: string; // native amount, decimal string
  memo?: string;
}

export type Intent = TransferIntent | EvmCallIntent;

export interface AssetLimits {
  /** Max per transaction, decimal string in whole units. "0" = asset not allowed. */
  maxPerTx: string;
  /** Max per UTC day across all intents from this wallet. */
  maxPerDay: string;
}

export interface IntentPolicy {
  enabled: boolean;
  /** Chain keys this wallet may use. */
  networks: string[];
  /** Mainnet networks additionally need INTENTS_ALLOW_MAINNET=1 on the server. */
  allowMainnet: boolean;
  limits: Partial<Record<Asset, AssetLimits>>;
  /** Empty = any recipient. Lower-cased for EVM comparisons. */
  recipientAllowlist: string[];
  /** EVM contracts that evm_call intents may target. Empty = no contract calls. */
  contractAllowlist: string[];
}

export const DEFAULT_INTENT_POLICY: IntentPolicy = {
  enabled: false,
  networks: [],
  allowMainnet: false,
  limits: {},
  recipientAllowlist: [],
  contractAllowlist: [],
};

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

// ─── networks ──────────────────────────────────────────────────

const TESTNET_KEYS = new Set(["sepolia", "baseSepolia", "tempo", "hyperliquid"]);

export function isEvm(chain: ChainConfig): boolean {
  return chain.key !== "solana";
}

/** Solana's key says devnet, but SOLANA_RPC_URL can point it anywhere — trust the RPC host. */
export function isTestnet(chainKey: string): boolean {
  const chain = getChain(chainKey);
  if (!chain) return false;
  if (chainKey === "solana") return /devnet|testnet|localhost|127\.0\.0\.1/i.test(chain.rpc);
  return TESTNET_KEYS.has(chainKey);
}

export function mainnetAllowedOnServer(): boolean {
  return process.env.INTENTS_ALLOW_MAINNET === "1";
}

// ─── amounts ───────────────────────────────────────────────────

export function decimalsFor(chainKey: string, asset: Asset): number {
  if (asset === "usdc") return USDC_DECIMALS;
  return getChain(chainKey)?.nativeCurrency.decimals ?? 18;
}

/** "1.5" with 6 decimals → 1500000n. Rejects negatives, exponents, and too many decimal places. */
export function toBaseUnits(amount: string, decimals: number): bigint | null {
  const s = String(amount).trim();
  const m = s.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const frac = m[2] || "";
  if (frac.length > decimals) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function fromBaseUnits(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

// ─── addresses ─────────────────────────────────────────────────

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function normalizeAddress(chainKey: string, addr: string): string | null {
  const a = String(addr || "").trim();
  if (chainKey === "solana") return SOL_ADDR.test(a) ? a : null;
  return EVM_ADDR.test(a) ? a.toLowerCase() : null;
}

// ─── policy validation ─────────────────────────────────────────

export function validatePolicy(raw: Record<string, unknown>): Result<IntentPolicy> {
  const networks = (Array.isArray(raw.networks) ? raw.networks : []).map(String);
  const unknown = networks.filter((n) => !getChain(n));
  if (unknown.length) return fail(`Unknown network(s): ${unknown.join(", ")}`);

  const limits: IntentPolicy["limits"] = {};
  const rawLimits = (raw.limits || {}) as Record<string, Record<string, unknown>>;
  for (const asset of ["native", "usdc"] as Asset[]) {
    const l = rawLimits[asset];
    if (!l) continue;
    const perTx = String(l.maxPerTx ?? "0");
    const perDay = String(l.maxPerDay ?? "0");
    if (toBaseUnits(perTx, 18) === null || toBaseUnits(perDay, 18) === null) return fail(`${asset} limits must be non-negative decimal amounts`);
    if (Number(perDay) < Number(perTx)) return fail(`${asset}: daily limit can't be lower than the per-transaction limit`);
    limits[asset] = { maxPerTx: perTx, maxPerDay: perDay };
  }

  const list = (v: unknown) => (Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
  const recipients = list(raw.recipientAllowlist);
  const contracts = list(raw.contractAllowlist);
  const badRecipient = recipients.find((r) => !EVM_ADDR.test(r) && !SOL_ADDR.test(r));
  if (badRecipient) return fail(`Not a valid address: ${badRecipient}`);
  const badContract = contracts.find((c) => !EVM_ADDR.test(c));
  if (badContract) return fail(`Not a valid EVM contract address: ${badContract}`);

  return {
    ok: true,
    value: {
      enabled: Boolean(raw.enabled),
      networks: [...new Set(networks)],
      allowMainnet: Boolean(raw.allowMainnet),
      limits,
      recipientAllowlist: [...new Set(recipients.map((r) => (EVM_ADDR.test(r) ? r.toLowerCase() : r)))],
      contractAllowlist: [...new Set(contracts.map((c) => c.toLowerCase()))],
    },
  };
}

// ─── intent checks ─────────────────────────────────────────────

export interface CheckedIntent {
  intent: Intent;
  chainKey: string;
  asset: Asset;
  /** Amount counted against the asset's limits, in base units. */
  units: bigint;
  decimals: number;
}

/**
 * Validate an agent's intent against the wallet's chain and policy.
 * `spentToday` is base units already used today for the intent's asset.
 */
export function checkIntent(
  raw: Record<string, unknown>,
  walletChain: "solana" | "evm",
  policy: IntentPolicy,
  spentToday: (asset: Asset) => bigint,
): Result<CheckedIntent> {
  if (!policy.enabled) return fail("Signing is turned off for this wallet");

  const network = String(raw.network || "");
  const chain = getChain(network);
  if (!chain) return fail(`Unknown network ${network}`);
  if ((walletChain === "solana") !== (network === "solana")) return fail(`This ${walletChain} wallet can't sign on ${network}`);
  if (!policy.networks.includes(network)) return fail(`Network ${network} isn't allowed for this wallet (allowed: ${policy.networks.join(", ") || "none"})`);
  if (!isTestnet(network) && !(policy.allowMainnet && mainnetAllowedOnServer())) {
    return fail(`${chain.name} is a mainnet; mainnet signing is disabled`);
  }

  const type = raw.type;
  if (type === "transfer") {
    const asset: Asset = raw.asset === "usdc" ? "usdc" : "native";
    if (asset === "usdc" && !chain.contracts.usdc && network !== "solana") return fail(`No USDC contract is configured for ${network}`);
    const to = normalizeAddress(network, String(raw.to || ""));
    if (!to) return fail("`to` is not a valid address for this network");
    const decimals = decimalsFor(network, asset);
    const units = toBaseUnits(String(raw.amount ?? ""), decimals);
    if (units === null || units <= 0n) return fail(`amount must be a positive number with at most ${decimals} decimal places`);
    if (policy.recipientAllowlist.length && !policy.recipientAllowlist.includes(to)) return fail(`Recipient ${to} is not on this wallet's allowlist`);
    const limit = checkLimits(policy, asset, network, units, spentToday(asset));
    if (!limit.ok) return limit;
    return {
      ok: true,
      value: { intent: { type, network, asset, to, amount: fromBaseUnits(units, decimals), ...(raw.memo ? { memo: String(raw.memo).slice(0, 200) } : {}) }, chainKey: network, asset, units, decimals },
    };
  }

  if (type === "evm_call") {
    if (network === "solana") return fail("evm_call is only for EVM networks");
    const to = normalizeAddress(network, String(raw.to || ""));
    if (!to) return fail("`to` must be a contract address");
    if (!policy.contractAllowlist.includes(to)) return fail(`Contract ${to} is not on this wallet's contract allowlist`);
    const data = String(raw.data || "0x");
    if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) return fail("`data` must be 0x-prefixed hex calldata");
    const decimals = decimalsFor(network, "native");
    const units = raw.value ? toBaseUnits(String(raw.value), decimals) : 0n;
    if (units === null || units < 0n) return fail("`value` must be a non-negative amount");
    if (units > 0n) {
      const limit = checkLimits(policy, "native", network, units, spentToday("native"));
      if (!limit.ok) return limit;
    }
    return {
      ok: true,
      value: { intent: { type, network, to, data, value: fromBaseUnits(units, decimals), ...(raw.memo ? { memo: String(raw.memo).slice(0, 200) } : {}) }, chainKey: network, asset: "native", units, decimals },
    };
  }

  return fail("type must be transfer or evm_call");
}

function checkLimits(policy: IntentPolicy, asset: Asset, network: string, units: bigint, spent: bigint): Result<true> {
  const limits = policy.limits[asset];
  if (!limits) return fail(`${asset === "usdc" ? "USDC" : "Native"} transfers aren't allowed for this wallet`);
  const decimals = decimalsFor(network, asset);
  const perTx = toBaseUnits(limits.maxPerTx, decimals) ?? 0n;
  const perDay = toBaseUnits(limits.maxPerDay, decimals) ?? 0n;
  if (units > perTx) return fail(`Amount is over the per-transaction limit of ${limits.maxPerTx}`);
  if (spent + units > perDay) {
    return fail(`Amount would exceed the daily limit of ${limits.maxPerDay} (${fromBaseUnits(spent, decimals)} already used today)`);
  }
  return { ok: true, value: true };
}
