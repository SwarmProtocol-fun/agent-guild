/**
 * Read & debug tools for EVM chains: transactions with decoded calldata,
 * logs and revert reasons, addresses (balance, code, proxy, ERC-20
 * metadata, ENS), gas, contract reads, and selector/revert decoding.
 * Everything takes a viem PublicClient, so the server picks the RPC.
 */
import {
  decodeAbiParameters, decodeErrorResult, decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi,
  formatEther, formatGwei, formatUnits, getAddress, isAddress, isHex, parseAbiItem, parseEther, toFunctionSelector,
  type Abi, type AbiFunction, type Hex, type PublicClient,
} from "viem";
import { normalize } from "viem/ens";
import { KNOWN_TOKENS, type EthNetwork } from "./networks";

/** Bad input from the caller (→ 400). Anything else thrown is an RPC/upstream failure (→ 502). */
export class DevtoolsInputError extends Error {}
/** A feature that needs server config the operator hasn't set (→ 503). */
export class ConfigError extends Error {}

const SIGNATURE_DB = process.env.SIGNATURE_DB_URL || "https://api.openchain.xyz/signature-database/v1/lookup";
const TIMEOUT_MS = 10_000;

// ── Parsing ──────────────────────────────────────────────────────────────

export function parseAddress(value: unknown, label = "address"): `0x${string}` {
  if (typeof value !== "string" || !isAddress(value.trim(), { strict: false })) throw new DevtoolsInputError(`${label} must be a 0x… address`);
  return getAddress(value.trim());
}

export function parseHash(value: unknown, label = "hash"): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.trim())) throw new DevtoolsInputError(`${label} must be a 0x… 32-byte hash`);
  return value.trim().toLowerCase() as Hex;
}

export function parseHexData(value: unknown, label = "data"): Hex {
  if (value == null || value === "") return "0x";
  if (typeof value !== "string" || !isHex(value.trim()) || value.trim().length % 2 !== 0) throw new DevtoolsInputError(`${label} must be 0x-prefixed hex`);
  return value.trim().toLowerCase() as Hex;
}

/** "1.5" ETH → wei. Accepts numbers too; rejects negatives and junk. */
export function parseEthAmount(value: unknown, label = "value"): bigint {
  if (value == null || value === "") return 0n;
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new DevtoolsInputError(`${label} must be a non-negative decimal amount of ETH`);
  try {
    return parseEther(s);
  } catch {
    throw new DevtoolsInputError(`${label} has more than 18 decimals`);
  }
}

/** Decimal string → base units without float rounding. */
export function toRaw(ui: string | number, decimals: number, label = "amount"): bigint {
  const m = String(ui).trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new DevtoolsInputError(`${label} must be a positive decimal number`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new DevtoolsInputError(`${label} has more than ${decimals} decimals`);
  const raw = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (raw <= 0n) throw new DevtoolsInputError(`${label} must be greater than 0`);
  return raw;
}

/** Base units → decimal string without float rounding. */
export const toUi = (raw: bigint | string, decimals: number) => formatUnits(BigInt(raw), decimals);

/**
 * A human function signature → viem ABI item. Accepts "transfer(address,uint256)",
 * "function balanceOf(address) view returns (uint256)", or with param names.
 */
export function parseFunctionSignature(signature: unknown): AbiFunction {
  if (typeof signature !== "string" || !signature.trim()) throw new DevtoolsInputError("signature is required, e.g. \"balanceOf(address) view returns (uint256)\"");
  const s = signature.trim().replace(/^function\s+/, "");
  try {
    const item = parseAbiItem(`function ${s}`) as AbiFunction;
    if (item.type !== "function") throw new Error("not a function");
    return item;
  } catch (err) {
    throw new DevtoolsInputError(`Can't parse signature "${signature}": ${(err as Error).message.split("\n")[0]}`);
  }
}

/** JSON args → viem args: numbers/strings for ints become bigint, nested arrays/tuples recurse. */
export function coerceArgs(fn: { inputs: readonly { type: string; components?: readonly unknown[] }[] }, args: unknown): unknown[] {
  const list = args == null ? [] : Array.isArray(args) ? args : [args];
  if (list.length !== fn.inputs.length) throw new DevtoolsInputError(`Expected ${fn.inputs.length} argument(s), got ${list.length}`);
  return fn.inputs.map((input, i) => coerce(input.type, list[i], input.components as never));
}

function coerce(type: string, value: unknown, components?: readonly { type: string; name?: string; components?: readonly unknown[] }[]): unknown {
  if (type.endsWith("]")) {
    if (!Array.isArray(value)) throw new DevtoolsInputError(`Expected an array for ${type}`);
    const inner = type.slice(0, type.lastIndexOf("["));
    return value.map((v) => coerce(inner, v, components));
  }
  if (/^u?int\d*$/.test(type)) {
    if (typeof value === "bigint") return value;
    if ((typeof value === "number" && Number.isInteger(value)) || (typeof value === "string" && /^-?(\d+|0x[0-9a-f]+)$/i.test(value.trim()))) return BigInt(value as string | number);
    throw new DevtoolsInputError(`Expected an integer for ${type}, got ${JSON.stringify(value)}`);
  }
  if (type === "address") return parseAddress(value, "address argument");
  if (type === "bool") return value === true || value === "true";
  if (type === "tuple" && components) {
    if (Array.isArray(value)) return value.map((v, i) => coerce(components[i].type, v, components[i].components as never));
    if (value && typeof value === "object") return Object.fromEntries(components.map((c) => [c.name, coerce(c.type, (value as Record<string, unknown>)[c.name ?? ""], c.components as never)]));
  }
  return value;
}

/** bigint → string, recursively, so results survive JSON. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  return value;
}

// ── Selector lookup ──────────────────────────────────────────────────────

const selectorCache = new Map<string, string[]>();

/** 4-byte selector → candidate text signatures (openchain database; cached per process). */
export async function lookupSelectors(selectors: string[], fetchImpl: typeof fetch = fetch): Promise<Record<string, string[]>> {
  const want = [...new Set(selectors.map((s) => s.toLowerCase()))].filter((s) => /^0x[0-9a-f]{8}$/.test(s));
  const missing = want.filter((s) => !selectorCache.has(s));
  if (missing.length) {
    try {
      const res = await fetchImpl(`${SIGNATURE_DB}?function=${missing.join(",")}&filter=true`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const data = (await res.json()) as { result?: { function?: Record<string, { name: string }[] | null> } };
      for (const s of missing) selectorCache.set(s, (data.result?.function?.[s] ?? []).map((r) => r.name));
    } catch {
      // Lookup is best-effort: an unknown selector is still shown raw.
    }
  }
  return Object.fromEntries(want.map((s) => [s, selectorCache.get(s) ?? []]));
}

// ── Decoding ─────────────────────────────────────────────────────────────

/** Solidity panic codes (Panic(uint256)). */
export const PANIC_CODES: Record<number, string> = {
  0x00: "generic compiler panic",
  0x01: "assert(false)",
  0x11: "arithmetic overflow or underflow",
  0x12: "division or modulo by zero",
  0x21: "invalid enum value",
  0x22: "corrupt storage byte array",
  0x31: "pop() on an empty array",
  0x32: "array index out of bounds",
  0x41: "out of memory / array too large",
  0x51: "call to an uninitialized function pointer",
};

export interface DecodedRevert {
  kind: "empty" | "error-string" | "panic" | "custom" | "unknown";
  selector: string | null;
  /** Human-readable reason. */
  message: string;
  signature?: string;
  args?: unknown[];
  raw: Hex;
}

/** Revert data → Error(string), Panic(uint256), a custom error (via the ABI or signature DB), or raw. */
export async function decodeRevert(data: Hex, abi?: Abi, fetchImpl?: typeof fetch): Promise<DecodedRevert> {
  if (!data || data === "0x") return { kind: "empty", selector: null, message: "Reverted without a reason (require() with no message, or out of gas)", raw: "0x" };
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === "0x08c379a0") {
    const [reason] = decodeAbiParameters([{ type: "string" }], `0x${data.slice(10)}`);
    return { kind: "error-string", selector, message: reason, signature: "Error(string)", args: [reason], raw: data };
  }
  if (selector === "0x4e487b71") {
    const [code] = decodeAbiParameters([{ type: "uint256" }], `0x${data.slice(10)}`);
    const n = Number(code);
    return { kind: "panic", selector, message: `Panic 0x${n.toString(16).padStart(2, "0")}: ${PANIC_CODES[n] ?? "unknown panic code"}`, signature: "Panic(uint256)", args: [code.toString()], raw: data };
  }
  if (abi) {
    try {
      const out = decodeErrorResult({ abi, data });
      return { kind: "custom", selector, message: `${out.errorName}(${(out.args ?? []).map((a) => String(a)).join(", ")})`, signature: out.errorName, args: jsonSafe(out.args ?? []) as unknown[], raw: data };
    } catch { /* fall through to the signature DB */ }
  }
  const candidates = (await lookupSelectors([selector], fetchImpl))[selector] ?? [];
  for (const sig of candidates) {
    try {
      const item = parseAbiItem(`error ${sig}`);
      const out = decodeErrorResult({ abi: [item], data });
      const args = jsonSafe(out.args ?? []) as unknown[];
      return { kind: "custom", selector, message: `${sig.split("(")[0]}(${args.map(String).join(", ")})`, signature: sig, args, raw: data };
    } catch { /* try the next candidate */ }
  }
  return { kind: "unknown", selector, message: `Custom error ${selector} (not in the signature database — pass the contract ABI to decode it)`, raw: data };
}

export interface DecodedCall {
  selector: string;
  signature: string | null;
  functionName: string | null;
  args: unknown[] | null;
  /** Other signatures sharing the selector (collisions are common). */
  candidates: string[];
}

/** Calldata → function + args, from the given signature/ABI or the signature DB. */
export async function decodeCalldata(data: Hex, opts: { signature?: string; abi?: Abi } = {}, fetchImpl?: typeof fetch): Promise<DecodedCall> {
  if (data.length < 10) throw new DevtoolsInputError("Calldata must be at least a 4-byte selector");
  const selector = data.slice(0, 10).toLowerCase();
  const abis: { sig: string | null; abi: Abi }[] = [];
  if (opts.abi) abis.push({ sig: null, abi: opts.abi });
  if (opts.signature) abis.push({ sig: opts.signature, abi: [parseFunctionSignature(opts.signature)] });
  const candidates = opts.abi || opts.signature ? [] : (await lookupSelectors([selector], fetchImpl))[selector] ?? [];
  for (const sig of candidates) {
    try { abis.push({ sig, abi: [parseAbiItem(`function ${sig}`)] as Abi }); } catch { /* unparseable entry */ }
  }
  for (const { sig, abi } of abis) {
    try {
      const out = decodeFunctionData({ abi, data });
      const fn = abi.find((i) => i.type === "function" && i.name === out.functionName) as AbiFunction | undefined;
      const signature = sig ?? (fn ? `${fn.name}(${fn.inputs.map((i) => i.type).join(",")})` : out.functionName);
      return { selector, signature, functionName: out.functionName, args: jsonSafe(out.args ?? []) as unknown[], candidates };
    } catch { /* wrong candidate */ }
  }
  return { selector, signature: null, functionName: null, args: null, candidates };
}

/** The error and its `cause` chain. Duck-typed rather than `instanceof BaseError`, so a second copy of viem can't hide it. */
function causeChain(err: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let e = err as Record<string, unknown> | undefined; e && typeof e === "object" && out.length < 10; e = e.cause as Record<string, unknown> | undefined) out.push(e);
  return out;
}

/** Pulls revert data out of a viem error (CallExecutionError → … → RpcRequestError.data). */
export function revertDataOf(err: unknown): Hex | null {
  for (const e of causeChain(err)) {
    const d = e.data;
    // "0x" is a real answer: the call reverted with no reason (bare require/revert()).
    if (typeof d === "string" && isHex(d) && (d.length >= 10 || d === "0x")) return d as Hex;
    if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string" && isHex((d as { data: string }).data)) return (d as { data: Hex }).data;
  }
  return null;
}

const errorText = (e: Record<string, unknown>) => `${String(e.name ?? "")} ${String(e.shortMessage ?? "")} ${String(e.details ?? "")} ${String(e.message ?? "")}`;

/**
 * True when a node refused a call/tx because the sender can't cover value +
 * gas. Clients word it differently (geth "insufficient funds", "exceeds the
 * balance of the account", reth "OutOfFunds"), and public RPCs load-balance
 * across clients, so match all of them.
 */
export function isInsufficientFunds(err: unknown): boolean {
  return causeChain(err).some((e) => e.name === "InsufficientFundsError" || /insufficient funds|exceeds the balance|OutOfFunds|InsufficientFunds/i.test(errorText(e)));
}

/** True when the call reverted, even if the node returned no revert data with it. */
export function isRevert(err: unknown): boolean {
  return causeChain(err).some((e) => e.name === "ExecutionRevertedError" || e.name === "ContractFunctionRevertedError" || /execution reverted/i.test(errorText(e)));
}

/** Revert data, "0x" for a revert that came back without any, or null when the failure wasn't a revert. */
export function revertOutcome(err: unknown): Hex | null {
  if (isInsufficientFunds(err)) return null;
  return revertDataOf(err) ?? (isRevert(err) ? "0x" : null);
}

/** Short message from a viem error, without the multi-line docs footer. */
export function shortError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string } | undefined;
  return (e?.shortMessage || e?.message?.split("\n")[0]) ?? String(err);
}

// ── Network & gas ────────────────────────────────────────────────────────

export interface NetworkStatus {
  chainId: number;
  blockNumber: string;
  blockTime: string;
  baseFeeGwei: string | null;
  gasPriceGwei: string;
}

export async function networkStatus(client: PublicClient): Promise<NetworkStatus> {
  const [chainId, block, gasPrice] = await Promise.all([client.getChainId(), client.getBlock(), client.getGasPrice()]);
  return {
    chainId,
    blockNumber: block.number!.toString(),
    blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    baseFeeGwei: block.baseFeePerGas != null ? formatGwei(block.baseFeePerGas) : null,
    gasPriceGwei: formatGwei(gasPrice),
  };
}

export interface GasTier { maxPriorityFeeGwei: string; maxFeeGwei: string }
export interface GasOracle {
  baseFeeGwei: string;
  tiers: { slow: GasTier; standard: GasTier; fast: GasTier };
  /** Cost of common actions at the standard tier, in ETH. */
  costs: { label: string; gas: number; eth: string }[];
}

export const GAS_ACTIONS = [
  { label: "ETH transfer", gas: 21_000 },
  { label: "ERC-20 transfer", gas: 65_000 },
  { label: "Uniswap swap", gas: 180_000 },
  { label: "Contract deploy (small)", gas: 1_000_000 },
];

/** EIP-1559 fee suggestions from the last 20 blocks' 10th/50th/90th percentile tips. */
export async function gasOracle(client: PublicClient): Promise<GasOracle> {
  const history = await client.getFeeHistory({ blockCount: 20, rewardPercentiles: [10, 50, 90] });
  const nextBase = history.baseFeePerGas.at(-1) ?? 0n;
  const median = (i: number) => {
    const xs = (history.reward ?? []).map((r) => r[i]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return xs.length ? xs[Math.floor(xs.length / 2)] : 0n;
  };
  // Headroom of 2× base fee so the tx survives a few full blocks.
  const tier = (i: number): GasTier => ({ maxPriorityFeeGwei: formatGwei(median(i)), maxFeeGwei: formatGwei(nextBase * 2n + median(i)) });
  const effective = nextBase + median(1);
  return {
    baseFeeGwei: formatGwei(nextBase),
    tiers: { slow: tier(0), standard: tier(1), fast: tier(2) },
    costs: GAS_ACTIONS.map((a) => ({ ...a, eth: formatEther(effective * BigInt(a.gas)) })),
  };
}

// ── Address ──────────────────────────────────────────────────────────────

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
/** Pre-1967 OpenZeppelin (ZeppelinOS) slots — USDC and other older proxies use these. */
const ZOS_IMPL = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const ZOS_ADMIN = "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b";

function slotAddress(slot: Hex | undefined): `0x${string}` | null {
  if (!slot || BigInt(slot) === 0n) return null;
  return getAddress(`0x${slot.slice(-40)}`);
}

export interface TokenInfo { name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null }

/** ERC-20 name/symbol/decimals/totalSupply; null when the contract isn't a token. */
export async function tokenInfo(client: PublicClient, address: `0x${string}`): Promise<TokenInfo | null> {
  const results = await client.multicall({
    allowFailure: true,
    contracts: (["name", "symbol", "decimals", "totalSupply"] as const).map((functionName) => ({ address, abi: erc20Abi, functionName })),
  }).catch(() => null);
  if (!results) return null;
  const [name, symbol, decimals, supply] = results.map((r) => (r.status === "success" ? r.result : null));
  if (decimals == null || symbol == null) return null;
  return {
    name: (name as string) ?? null, symbol: symbol as string, decimals: Number(decimals),
    totalSupply: supply != null ? toUi(supply as bigint, Number(decimals)) : null,
  };
}

export interface AddressInfo {
  address: `0x${string}`;
  balanceWei: string;
  balanceEth: string;
  nonce: number;
  isContract: boolean;
  codeSize: number;
  /** EIP-1967 (or older ZeppelinOS) proxy slots, when set. */
  proxy: { implementation: string | null; admin: string | null } | null;
  token: TokenInfo | null;
  ensName: string | null;
}

export async function inspectAddress(client: PublicClient, address: `0x${string}`, ensClient?: PublicClient): Promise<AddressInfo> {
  const [balance, nonce, code] = await Promise.all([client.getBalance({ address }), client.getTransactionCount({ address }), client.getCode({ address })]);
  const codeSize = code && code !== "0x" ? (code.length - 2) / 2 : 0;
  let proxy: AddressInfo["proxy"] = null;
  let token: TokenInfo | null = null;
  if (codeSize > 0) {
    const slot = (s: Hex) => client.getStorageAt({ address, slot: s }).catch(() => undefined);
    const [impl, admin, zosImpl, zosAdmin] = await Promise.all([slot(EIP1967_IMPL), slot(EIP1967_ADMIN), slot(ZOS_IMPL), slot(ZOS_ADMIN)]);
    const implementation = slotAddress(impl) ?? slotAddress(zosImpl);
    const proxyAdmin = slotAddress(admin) ?? slotAddress(zosAdmin);
    if (implementation || proxyAdmin) proxy = { implementation, admin: proxyAdmin };
    token = await tokenInfo(client, address);
  }
  const ensName = ensClient ? await ensClient.getEnsName({ address }).catch(() => null) : null;
  return { address, balanceWei: balance.toString(), balanceEth: formatEther(balance), nonce, isContract: codeSize > 0, codeSize, proxy, token, ensName };
}

/** name.eth → address (mainnet ENS). */
export async function resolveEns(ensClient: PublicClient, name: string): Promise<`0x${string}`> {
  let normalized: string;
  try { normalized = normalize(name.trim()); } catch { throw new DevtoolsInputError(`"${name}" isn't a valid ENS name`); }
  const address = await ensClient.getEnsAddress({ name: normalized });
  if (!address) throw new DevtoolsInputError(`${normalized} doesn't resolve to an address`);
  return address;
}

export interface Holding { symbol: string; token: `0x${string}` | null; raw: string; amount: string; decimals: number }

/** Native ETH plus every non-zero balance among the network's well-known tokens (and any `extra` tokens). */
export async function holdings(client: PublicClient, network: EthNetwork, address: `0x${string}`, extra: `0x${string}`[] = []): Promise<{ address: string; eth: string; tokens: Holding[] }> {
  const known = KNOWN_TOKENS[network];
  const extras = extra.filter((t) => !known.some((k) => k.address.toLowerCase() === t.toLowerCase())).slice(0, 20);
  const list = [...known.map((k) => ({ address: k.address, symbol: k.symbol as string | null })), ...extras.map((a) => ({ address: a, symbol: null }))];
  const [eth, results] = await Promise.all([
    client.getBalance({ address }),
    client.multicall({
      allowFailure: true,
      contracts: list.flatMap((t) => [
        { address: t.address, abi: erc20Abi, functionName: "balanceOf" as const, args: [address] as const },
        { address: t.address, abi: erc20Abi, functionName: "decimals" as const },
        { address: t.address, abi: erc20Abi, functionName: "symbol" as const },
      ]),
    }),
  ]);
  const tokens: Holding[] = [];
  list.forEach((t, i) => {
    const [bal, dec, sym] = results.slice(i * 3, i * 3 + 3);
    if (bal.status !== "success" || dec.status !== "success" || (bal.result as bigint) === 0n) return;
    const decimals = Number(dec.result);
    tokens.push({ symbol: t.symbol ?? (sym.status === "success" ? String(sym.result) : "?"), token: t.address, raw: String(bal.result), amount: toUi(bal.result as bigint, decimals), decimals });
  });
  return { address, eth: formatEther(eth), tokens };
}

// ── Transactions ─────────────────────────────────────────────────────────

const TRANSFER_ABI = [parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"), parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)")];

export interface DecodedLog {
  index: number;
  address: string;
  event: string | null;
  args: Record<string, unknown> | null;
  /** For ERC-20 Transfer/Approval: the amount in token units. */
  amount?: string;
  symbol?: string | null;
  topics: string[];
}

export interface TxInspection {
  hash: string;
  status: "success" | "reverted" | "pending";
  blockNumber: string | null;
  timestamp: string | null;
  from: string;
  to: string | null;
  contractAddress: string | null;
  valueEth: string;
  nonce: number;
  gasLimit: string;
  gasUsed: string | null;
  effectiveGasPriceGwei: string | null;
  feeEth: string | null;
  type: string;
  call: DecodedCall | null;
  revert: DecodedRevert | null;
  logs: DecodedLog[];
}

export async function inspectTransaction(client: PublicClient, hash: Hex, fetchImpl?: typeof fetch): Promise<TxInspection> {
  const tx = await client.getTransaction({ hash }).catch((err) => {
    if (/could not be found|not found/i.test(shortError(err))) throw new DevtoolsInputError("Transaction not found on this network — wrong network?");
    throw err;
  });
  const receipt = tx.blockNumber != null ? await client.getTransactionReceipt({ hash }).catch(() => null) : null;
  const block = tx.blockNumber != null ? await client.getBlock({ blockNumber: tx.blockNumber }).catch(() => null) : null;

  const call = tx.input && tx.input.length >= 10 && tx.to ? await decodeCalldata(tx.input, {}, fetchImpl).catch(() => null) : null;

  // A reverted receipt carries no reason. Replaying the call at the same
  // block on the parent state reproduces it in the common case.
  let revert: DecodedRevert | null = null;
  if (receipt?.status === "reverted") {
    try {
      await client.call({ account: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value, gas: tx.gas, blockNumber: tx.blockNumber! - 1n });
      revert = { kind: "unknown", selector: null, message: "Replay succeeded at the previous block — it reverted because of something earlier in the same block (front-run, price moved, nonce/state race)", raw: "0x" };
    } catch (err) {
      const data = revertOutcome(err);
      revert = data != null ? await decodeRevert(data, undefined, fetchImpl) : { kind: "unknown", selector: null, message: shortError(err), raw: "0x" };
    }
  }

  // Decode ERC-20 Transfer/Approval; other events show their topics.
  const tokenAddrs = [...new Set((receipt?.logs ?? []).map((l) => l.address))].slice(0, 20) as `0x${string}`[];
  const meta = new Map<string, TokenInfo | null>();
  await Promise.all(tokenAddrs.map(async (a) => meta.set(a.toLowerCase(), await tokenInfo(client, a).catch(() => null))));
  const logs: DecodedLog[] = (receipt?.logs ?? []).map((log) => {
    const base: DecodedLog = { index: log.logIndex ?? 0, address: getAddress(log.address), event: null, args: null, topics: log.topics };
    try {
      const d = decodeEventLog({ abi: TRANSFER_ABI, data: log.data, topics: log.topics });
      const info = meta.get(log.address.toLowerCase());
      const value = (d.args as { value: bigint }).value;
      return { ...base, event: d.eventName, args: jsonSafe(d.args) as Record<string, unknown>, symbol: info?.symbol ?? null, ...(info?.decimals != null ? { amount: toUi(value, info.decimals) } : {}) };
    } catch {
      return base;
    }
  });

  const gasUsed = receipt?.gasUsed ?? null;
  const price = receipt?.effectiveGasPrice ?? null;
  return {
    hash,
    status: !receipt ? "pending" : receipt.status === "success" ? "success" : "reverted",
    blockNumber: tx.blockNumber?.toString() ?? null,
    timestamp: block ? new Date(Number(block.timestamp) * 1000).toISOString() : null,
    from: getAddress(tx.from), to: tx.to ? getAddress(tx.to) : null, contractAddress: receipt?.contractAddress ? getAddress(receipt.contractAddress) : null,
    valueEth: formatEther(tx.value), nonce: tx.nonce, gasLimit: tx.gas.toString(),
    gasUsed: gasUsed?.toString() ?? null,
    effectiveGasPriceGwei: price != null ? formatGwei(price) : null,
    feeEth: gasUsed != null && price != null ? formatEther(gasUsed * price) : null,
    type: tx.type,
    call, revert, logs,
  };
}

// ── Contracts ────────────────────────────────────────────────────────────

export interface CallSpec {
  to?: string;
  /** ETH, as a decimal string. */
  value?: string | number;
  /** Raw calldata; or signature + args to encode it. */
  data?: string;
  signature?: string;
  args?: unknown;
  /** Contract creation: bytecode, optionally with constructorSignature + args. */
  bytecode?: string;
  constructorSignature?: string;
}

export interface BuiltCall { to: `0x${string}` | undefined; value: bigint; data: Hex; fn: AbiFunction | null }

/** Spec → { to, value, data }. Validates everything; never touches the network. */
export function buildCall(spec: CallSpec): BuiltCall {
  const value = parseEthAmount(spec.value);
  if (spec.bytecode != null) {
    if (spec.to) throw new DevtoolsInputError("A deployment has no `to` — pass either bytecode or to");
    let data = parseHexData(spec.bytecode, "bytecode");
    if (data === "0x") throw new DevtoolsInputError("bytecode is empty");
    if (spec.constructorSignature) {
      const ctor = parseFunctionSignature(spec.constructorSignature.replace(/^constructor/, "ctor"));
      const encoded = encodeFunctionData({ abi: [ctor], functionName: ctor.name, args: coerceArgs(ctor, spec.args) as never });
      data = `${data}${encoded.slice(10)}` as Hex;
    }
    return { to: undefined, value, data, fn: null };
  }
  const to = parseAddress(spec.to, "to");
  if (spec.signature) {
    if (spec.data) throw new DevtoolsInputError("Pass either data or signature + args, not both");
    const fn = parseFunctionSignature(spec.signature);
    const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: coerceArgs(fn, spec.args) as never });
    return { to, value, data, fn };
  }
  return { to, value, data: parseHexData(spec.data), fn: null };
}

/** eth_call a view function by its signature and decode the result. */
export async function readContract(client: PublicClient, address: `0x${string}`, signature: string, args?: unknown, blockNumber?: bigint) {
  const fn = parseFunctionSignature(signature);
  const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: coerceArgs(fn, args) as never });
  try {
    const { data: ret } = await client.call({ to: address, data, blockNumber });
    if (!fn.outputs.length || !ret) return { signature: `${fn.name}(${fn.inputs.map((i) => i.type).join(",")})`, raw: ret ?? "0x", result: null };
    const decoded = decodeAbiParameters(fn.outputs, ret);
    return { signature: `${fn.name}(${fn.inputs.map((i) => i.type).join(",")})`, raw: ret, result: jsonSafe(decoded.length === 1 ? decoded[0] : decoded) };
  } catch (err) {
    const revertData = revertOutcome(err);
    if (revertData != null) throw new DevtoolsInputError(`Call reverted: ${(await decodeRevert(revertData)).message}`);
    throw err;
  }
}

export interface Simulation {
  success: boolean;
  from: string;
  to: string | null;
  valueEth: string;
  data: Hex;
  returnData: Hex | null;
  /** Decoded return value when a signature with outputs was given. */
  result: unknown;
  gasEstimate: string | null;
  feeEstimateEth: string | null;
  revert: DecodedRevert | null;
  error: string | null;
  /** The sender's ETH balance, and whether it covers value + max gas cost. eth_call doesn't check this. */
  fromBalanceEth: string | null;
  canAfford: boolean | null;
}

/** Dry-runs a call/deploy from `from` with eth_call + estimateGas. Nothing is signed. */
export async function simulateCall(client: PublicClient, from: `0x${string}`, built: BuiltCall): Promise<Simulation> {
  const base = { from, to: built.to ?? null, valueEth: formatEther(built.value), data: built.data };
  try {
    const { data: ret } = await client.call({ account: from, to: built.to, data: built.data, value: built.value });
    const [gas, fees] = await Promise.all([
      client.estimateGas({ account: from, to: built.to, data: built.data, value: built.value }).catch(() => null),
      client.estimateFeesPerGas().catch(() => null),
    ]);
    let result: unknown = null;
    if (built.fn?.outputs.length && ret) {
      try { const d = decodeAbiParameters(built.fn.outputs, ret); result = jsonSafe(d.length === 1 ? d[0] : d); } catch { /* leave raw */ }
    }
    const perGas = fees?.maxFeePerGas ?? fees?.gasPrice ?? null;
    const balance = await client.getBalance({ address: from }).catch(() => null);
    const cost = gas != null && perGas != null ? gas * perGas : null;
    return {
      ...base, success: true, returnData: ret ?? "0x", result,
      gasEstimate: gas?.toString() ?? null,
      feeEstimateEth: cost != null ? formatEther(cost) : null,
      revert: null, error: null,
      fromBalanceEth: balance != null ? formatEther(balance) : null,
      canAfford: balance != null && cost != null ? balance >= built.value + cost : null,
    };
  } catch (err) {
    const data = revertOutcome(err);
    const revert = data != null ? await decodeRevert(data) : null;
    // Some nodes check the sender's balance in eth_call; that's "can't pay", not a revert.
    const unaffordable = !revert && isInsufficientFunds(err);
    return { ...base, success: false, returnData: null, result: null, gasEstimate: null, feeEstimateEth: null, revert, error: revert?.message ?? shortError(err), fromBalanceEth: null, canAfford: unaffordable ? false : null };
  }
}

/** Selector of a signature, for the decode tool. */
export function selectorOf(signature: string): string {
  return toFunctionSelector(parseFunctionSignature(signature));
}

// ── History (Etherscan v2, optional) ─────────────────────────────────────

export interface HistoryRow { hash: string; block: string; at: string; from: string; to: string | null; valueEth: string; method: string | null; failed: boolean; feeEth: string }

/** Recent transactions for an address. Needs ETHERSCAN_API_KEY — plain RPC can't list an address's history. */
export async function addressHistory(chainId: number, address: string, opts: { limit?: number; page?: number } = {}, fetchImpl: typeof fetch = fetch): Promise<HistoryRow[]> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new ConfigError("Address history needs ETHERSCAN_API_KEY set on the server (a free Etherscan v2 key covers every network here)");
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const qs = new URLSearchParams({ chainid: String(chainId), module: "account", action: "txlist", address, sort: "desc", page: String(opts.page ?? 1), offset: String(limit), apikey: key });
  const res = await fetchImpl(`https://api.etherscan.io/v2/api?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const data = (await res.json()) as { status: string; message: string; result: unknown };
  if (data.status !== "1") {
    if (/no transactions/i.test(data.message)) return [];
    throw new Error(`Etherscan: ${typeof data.result === "string" ? data.result : data.message}`);
  }
  return (data.result as Record<string, string>[]).map((r) => ({
    hash: r.hash, block: r.blockNumber, at: new Date(Number(r.timeStamp) * 1000).toISOString(),
    from: r.from, to: r.to || null, valueEth: formatEther(BigInt(r.value)),
    method: r.functionName ? r.functionName.split("(")[0] : r.methodId && r.methodId !== "0x" ? r.methodId : null,
    failed: r.isError === "1", feeEth: formatEther(BigInt(r.gasUsed) * BigInt(r.gasPrice)),
  }));
}
