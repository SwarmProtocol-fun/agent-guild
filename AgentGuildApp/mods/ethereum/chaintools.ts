/**
 * The exact-math half of the Ethereum mod: hashing, ABI encoding, address
 * derivation and storage-slot arithmetic that a language model gets wrong
 * when it does them in its head (it can't compute keccak256), plus the
 * chain reads that need an RPC: event logs, raw storage, batched calls.
 * Pure functions take explicit input; chain reads take a PublicClient so the
 * server picks the RPC.
 */
import {
  concat, decodeAbiParameters, decodeEventLog, encodeAbiParameters, encodePacked, formatUnits, getAddress, getContractAddress,
  hashMessage, hashTypedData, isHex, keccak256, pad, parseAbiItem, parseAbiParameters, parseUnits, stringToHex, toEventSelector,
  toFunctionSelector, toHex, type Abi, type AbiEvent, type AbiParameter, type Hex, type PublicClient,
} from "viem";
import { DevtoolsInputError, coerceArgs, jsonSafe, parseAddress, parseFunctionSignature, parseHexData, revertOutcome, decodeRevert } from "./devtools";

// ── Utilities (no network) ───────────────────────────────────────────────

export const UTIL_OPS = [
  "keccak256", "selector", "encode", "encode_packed", "decode", "to_units", "from_units", "checksum",
  "create_address", "create2_address", "mapping_slot", "hash_message", "hash_typed_data",
] as const;
export type UtilOp = (typeof UTIL_OPS)[number];

function params(types: unknown, label = "types"): readonly AbiParameter[] {
  if (Array.isArray(types)) return parseAbiParameters(types.map(String).join(", ")) as readonly AbiParameter[];
  if (typeof types === "string" && types.trim()) return parseAbiParameters(types) as readonly AbiParameter[];
  throw new DevtoolsInputError(`${label} is required, e.g. "address, uint256" or ["address","uint256"]`);
}

function values(ps: readonly AbiParameter[], vals: unknown): unknown[] {
  return coerceArgs({ inputs: ps as never }, vals);
}

function bigintOf(v: unknown, label: string): bigint {
  if (typeof v === "bigint") return v;
  if ((typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^(\d+|0x[0-9a-f]+)$/i.test(v.trim()))) return BigInt(v as string | number);
  throw new DevtoolsInputError(`${label} must be a non-negative integer`);
}

/** keccak256 of a mapping entry's slot: mapping(K => V) at `slot`, key `key`. */
export function mappingSlot(keyType: string, key: unknown, slot: unknown): Hex {
  const base = pad(toHex(bigintOf(slot, "slot")), { size: 32 });
  if (keyType === "string") return keccak256(concat([stringToHex(String(key)), base]));
  if (keyType === "bytes") return keccak256(concat([parseHexData(key, "key"), base]));
  const [p] = params(keyType, "keyType");
  const [k] = values([p], [key]);
  return keccak256(encodeAbiParameters([p, { type: "uint256" }], [k, BigInt(base)]));
}

/**
 * One utility op. `input` fields per op:
 * keccak256 {text|hex} · selector {signature} (function, event, or error) ·
 * encode/encode_packed {types, values} · decode {types, data} ·
 * to_units/from_units {amount, decimals=18} · checksum {address} ·
 * create_address {from, nonce} · create2_address {from, salt, bytecode|bytecodeHash} ·
 * mapping_slot {slot, keys: [{type, value}, ...]} (nested mappings in order) ·
 * hash_message {message} · hash_typed_data {domain, types, primaryType, message}
 */
export function ethUtil(op: unknown, input: Record<string, unknown>): Record<string, unknown> {
  switch (op as UtilOp) {
    case "keccak256": {
      if (typeof input.hex === "string") return { hash: keccak256(parseHexData(input.hex, "hex")) };
      if (typeof input.text === "string") return { hash: keccak256(stringToHex(input.text)) };
      throw new DevtoolsInputError("keccak256 needs `text` (UTF-8) or `hex`");
    }
    case "selector": {
      const sig = String(input.signature ?? "").trim();
      if (!sig) throw new DevtoolsInputError("selector needs `signature`");
      if (/^event\s/.test(sig)) return { kind: "event", topic0: toEventSelector(sig.replace(/^event\s+/, "")) };
      if (/^error\s/.test(sig)) return { kind: "error", selector: toFunctionSelector(sig.replace(/^error\s+/, "")) };
      const fn = parseFunctionSignature(sig);
      return { kind: "function", selector: toFunctionSelector(fn), canonical: `${fn.name}(${fn.inputs.map((i) => i.type).join(",")})` };
    }
    case "encode": {
      const ps = params(input.types);
      return { data: encodeAbiParameters(ps, values(ps, input.values) as never) };
    }
    case "encode_packed": {
      const types = (Array.isArray(input.types) ? input.types.map(String) : String(input.types ?? "").split(",").map((t) => t.trim())).filter(Boolean);
      const ps = types.map((type) => ({ type }));
      return { data: encodePacked(types, values(ps, input.values) as never) };
    }
    case "decode": {
      const ps = params(input.types);
      return { values: jsonSafe(decodeAbiParameters(ps, parseHexData(input.data))) };
    }
    case "to_units": {
      const decimals = Number(input.decimals ?? 18);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) throw new DevtoolsInputError("decimals must be 0–77");
      if (!/^\d+(\.\d+)?$/.test(String(input.amount ?? "").trim())) throw new DevtoolsInputError("amount must be a decimal string");
      return { raw: parseUnits(String(input.amount).trim(), decimals).toString(), decimals };
    }
    case "from_units": {
      const decimals = Number(input.decimals ?? 18);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) throw new DevtoolsInputError("decimals must be 0–77");
      return { amount: formatUnits(bigintOf(input.raw ?? input.amount, "raw"), decimals), decimals };
    }
    case "checksum":
      return { address: parseAddress(input.address) };
    case "create_address":
      return { address: getContractAddress({ opcode: "CREATE", from: parseAddress(input.from, "from"), nonce: bigintOf(input.nonce, "nonce") }) };
    case "create2_address": {
      const from = parseAddress(input.from, "from");
      const salt = typeof input.salt === "string" && isHex(input.salt) ? pad(input.salt as Hex, { size: 32 }) : pad(toHex(bigintOf(input.salt, "salt")), { size: 32 });
      if (typeof input.bytecodeHash === "string") return { address: getContractAddress({ opcode: "CREATE2", from, salt, bytecodeHash: parseHexData(input.bytecodeHash, "bytecodeHash") }) };
      return { address: getContractAddress({ opcode: "CREATE2", from, salt, bytecode: parseHexData(input.bytecode, "bytecode") }) };
    }
    case "mapping_slot": {
      const keys = Array.isArray(input.keys) ? input.keys : input.keyType ? [{ type: input.keyType, value: input.key }] : [];
      if (!keys.length) throw new DevtoolsInputError("mapping_slot needs `slot` and `keys: [{ type, value }]` (outermost mapping first)");
      let slot: unknown = input.slot;
      for (const k of keys as { type: string; value: unknown }[]) slot = mappingSlot(String(k.type), k.value, slot);
      return { slot };
    }
    case "hash_message": {
      if (typeof input.message !== "string") throw new DevtoolsInputError("hash_message needs `message`");
      return { hash: hashMessage(input.message) };
    }
    case "hash_typed_data":
      return { hash: hashTypedData(typedData(input)) };
    default:
      throw new DevtoolsInputError(`op must be one of ${UTIL_OPS.join(", ")}`);
  }
}

/** EIP-712 input → viem typed data, with the domain checked. */
export function typedData(input: Record<string, unknown>) {
  const { domain, types, primaryType, message } = input;
  if (!domain || typeof domain !== "object" || !types || typeof types !== "object" || typeof primaryType !== "string" || !message || typeof message !== "object") {
    throw new DevtoolsInputError("Typed data needs domain, types, primaryType and message");
  }
  const { EIP712Domain: _drop, ...rest } = types as Record<string, unknown>;
  return { domain: domain as Record<string, unknown>, types: rest as Record<string, { name: string; type: string }[]>, primaryType, message: message as Record<string, unknown> } as never;
}

// ── Chain reads ──────────────────────────────────────────────────────────

export const MAX_LOG_RANGE = 5_000n;
export const MAX_LOGS = 200;

export interface LogQuery {
  address?: unknown;
  /** "Transfer(address indexed from, address indexed to, uint256 value)", "event " prefix optional. */
  event?: unknown;
  /** Indexed-arg filter by name, e.g. { to: "0x…" }. */
  args?: unknown;
  fromBlock?: unknown;
  toBlock?: unknown;
  limit?: unknown;
}

function blockArg(v: unknown, label: string): bigint | null {
  if (v == null || v === "" || v === "latest") return null;
  if (typeof v === "string" && /^-\d+$/.test(v.trim())) return BigInt(v.trim()); // relative, resolved later
  return bigintOf(v, label);
}

/** Event logs, decoded by the given event signature. Default window: the last 1,000 blocks. */
export async function getLogs(client: PublicClient, q: LogQuery) {
  const address = q.address ? parseAddress(q.address, "address") : undefined;
  let event: AbiEvent | undefined;
  if (q.event) {
    try { event = parseAbiItem(`event ${String(q.event).trim().replace(/^event\s+/, "")}`) as AbiEvent; } catch (err) {
      throw new DevtoolsInputError(`Can't parse event "${q.event}": ${(err as Error).message.split("\n")[0]}`);
    }
  }
  if (!address && !event) throw new DevtoolsInputError("Pass an `address`, an `event` signature, or both");
  const latest = await client.getBlockNumber();
  const rel = (b: bigint | null, dflt: bigint) => (b == null ? dflt : b < 0n ? latest + b : b);
  const toBlock = rel(blockArg(q.toBlock, "toBlock"), latest);
  const fromBlock = rel(blockArg(q.fromBlock, "fromBlock"), toBlock > 1000n ? toBlock - 1000n : 0n);
  if (fromBlock > toBlock) throw new DevtoolsInputError("fromBlock is after toBlock");
  if (toBlock - fromBlock > MAX_LOG_RANGE) throw new DevtoolsInputError(`Block range is ${toBlock - fromBlock}; the limit is ${MAX_LOG_RANGE}. Page through it`);
  const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), MAX_LOGS);

  let args: Record<string, unknown> | undefined;
  if (q.args && typeof q.args === "object" && event) {
    args = {};
    for (const [name, value] of Object.entries(q.args as Record<string, unknown>)) {
      const input = event.inputs.find((i) => i.name === name);
      if (!input?.indexed) throw new DevtoolsInputError(`"${name}" isn't an indexed parameter of ${event.name}; only indexed args can be filtered`);
      args[name] = coerceArgs({ inputs: [input] as never }, [value])[0];
    }
  }

  const logs = await client.getLogs({ address, event, args: args as never, fromBlock, toBlock } as never);
  const rows = (logs as { address: string; blockNumber: bigint; transactionHash: string; logIndex: number; topics: Hex[]; data: Hex }[]).slice(-limit).reverse().map((l) => {
    let decoded: { event: string; args: unknown } | null = null;
    if (event) {
      try { const d = decodeEventLog({ abi: [event], data: l.data, topics: l.topics as never }); decoded = { event: d.eventName, args: jsonSafe(d.args) }; } catch { /* topic collision */ }
    }
    return { block: l.blockNumber.toString(), tx: l.transactionHash, index: l.logIndex, address: getAddress(l.address), ...(decoded ?? { event: null, args: null, topics: l.topics, data: l.data }) };
  });
  return { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), total: logs.length, truncated: logs.length > limit, logs: rows };
}

/** Raw storage slots, each also shown as uint and address. */
export async function readStorage(client: PublicClient, address: `0x${string}`, slots: unknown, blockNumber?: bigint) {
  const list = (Array.isArray(slots) ? slots : [slots]).slice(0, 20);
  if (!list.length || list[0] == null) throw new DevtoolsInputError("Pass `slot` (number or 0x hash) or `slots`");
  const hexSlots = list.map((s) => (typeof s === "string" && /^0x[0-9a-f]{1,64}$/i.test(s) ? pad(s as Hex, { size: 32 }) : pad(toHex(bigintOf(s, "slot")), { size: 32 })));
  const values = await Promise.all(hexSlots.map((slot) => client.getStorageAt({ address, slot, blockNumber })));
  return hexSlots.map((slot, i) => {
    const v = values[i] ?? "0x";
    const n = v === "0x" ? 0n : BigInt(v);
    return { slot, raw: v === "0x" ? pad("0x0", { size: 32 }) : v, uint: n.toString(), address: n < 2n ** 160n && n > 0n ? getAddress(pad(toHex(n), { size: 20 })) : null };
  });
}

export const MAX_MULTICALL = 50;

/** Up to 50 view calls in one round trip; each succeeds or fails on its own. */
export async function multiRead(client: PublicClient, calls: unknown, blockNumber?: bigint) {
  if (!Array.isArray(calls) || !calls.length) throw new DevtoolsInputError("calls must be a non-empty array of { address, signature, args? }");
  if (calls.length > MAX_MULTICALL) throw new DevtoolsInputError(`At most ${MAX_MULTICALL} calls`);
  const built = calls.map((c, i) => {
    const call = c as { address?: unknown; signature?: unknown; args?: unknown };
    const fn = parseFunctionSignature(call.signature);
    return { address: parseAddress(call.address, `calls[${i}].address`), abi: [fn] as Abi, functionName: fn.name, args: coerceArgs(fn, call.args), fn };
  });
  const results = (await client.multicall({ allowFailure: true, blockNumber, contracts: built.map(({ fn: _f, ...c }) => c) as never })) as
    ({ status: "success"; result: unknown } | { status: "failure"; error: unknown })[];
  return Promise.all(results.map(async (r, i) => {
    const sig = `${built[i].fn.name}(${built[i].fn.inputs.map((p) => p.type).join(",")})`;
    if (r.status === "success") return { address: built[i].address, signature: sig, ok: true, result: jsonSafe(r.result) };
    const data = revertOutcome(r.error);
    return { address: built[i].address, signature: sig, ok: false, error: data != null ? (await decodeRevert(data)).message : (r.error as Error)?.message?.split("\n")[0] ?? "failed" };
  }));
}

// ── State overrides (for simulate) ───────────────────────────────────────

export interface OverrideInput { balance?: unknown; nonce?: unknown; code?: unknown; stateDiff?: unknown }

/**
 * { "0xAddr": { balance: "100" (ETH), nonce?, code?, stateDiff?: { slot: value } } }
 * → viem's StateOverride. Lets a simulation answer "what if this wallet
 * held 100 ETH / this token balance / this code" without touching a chain.
 */
export function parseStateOverride(input: unknown) {
  if (input == null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) throw new DevtoolsInputError("stateOverride must be { \"0xAddress\": { balance?, nonce?, code?, stateDiff? } }");
  const entries = Object.entries(input as Record<string, OverrideInput>);
  if (entries.length > 10) throw new DevtoolsInputError("At most 10 overridden accounts");
  return entries.map(([addr, o]) => {
    const out: { address: `0x${string}`; balance?: bigint; nonce?: number; code?: Hex; stateDiff?: { slot: Hex; value: Hex }[] } = { address: parseAddress(addr, "stateOverride address") };
    if (o.balance != null) {
      if (!/^\d+(\.\d+)?$/.test(String(o.balance).trim())) throw new DevtoolsInputError("stateOverride balance is ETH as a decimal string");
      out.balance = parseUnits(String(o.balance).trim(), 18);
    }
    if (o.nonce != null) out.nonce = Number(bigintOf(o.nonce, "nonce"));
    if (o.code != null) out.code = parseHexData(o.code, "code");
    if (o.stateDiff != null) {
      if (typeof o.stateDiff !== "object") throw new DevtoolsInputError("stateDiff must be { slot: value }");
      const asWord = (v: unknown, label: string) => (typeof v === "string" && /^0x[0-9a-f]{1,64}$/i.test(v) ? pad(v as Hex, { size: 32 }) : pad(toHex(bigintOf(v, label)), { size: 32 }));
      out.stateDiff = Object.entries(o.stateDiff as Record<string, unknown>).slice(0, 50).map(([slot, value]) => ({ slot: asWord(slot, "slot"), value: asWord(value, "value") }));
    }
    return out;
  });
}
