/**
 * Transaction builder + simulator, shared by the panel and the agent routes.
 *
 * Agents describe instructions as plain JSON (`InstructionSpec`) — an Anchor
 * call by name with JSON args, a raw instruction, or a SOL transfer — and
 * this turns them into real instructions: args are coerced to the types the
 * program's IDL declares (u64 → BN, pubkey → PublicKey, enums, structs, …),
 * so an LLM never has to know about BN or borsh. Nothing here holds a
 * long-lived key: `new:<label>` placeholders get a fresh throwaway Keypair
 * for accounts that must sign their own creation (a new mint, a new data
 * account), and the caller decides who pays and signs.
 */
import { Buffer } from "buffer";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { BN, Program, type Idl, type Provider } from "@coral-xyz/anchor";
import { DevtoolsInputError, decodeProgramError, fetchIdl, parsePubkey, type DecodedError } from "./devtools";

// ── Spec shapes ──────────────────────────────────────────────────────────

export interface AccountMetaSpec { pubkey: string; isSigner?: boolean; isWritable?: boolean }

export interface AnchorInstructionSpec {
  kind?: "anchor";
  programId: string;
  /** Instruction name from the IDL (snake_case or camelCase). */
  instruction: string;
  /** By arg name (snake or camel), or positional. */
  args?: Record<string, unknown> | unknown[];
  /** Account name → address. Anchor resolves PDAs/known addresses it can on its own. */
  accounts?: Record<string, string>;
  remainingAccounts?: AccountMetaSpec[];
  /** Inline IDL for programs that haven't published one on-chain. */
  idl?: Idl;
}

export interface RawInstructionSpec {
  kind: "raw";
  programId: string;
  keys: AccountMetaSpec[];
  dataHex?: string;
  dataBase64?: string;
}

export interface TransferSpec { kind: "transfer"; to: string; sol: number }

export type InstructionSpec = AnchorInstructionSpec | RawInstructionSpec | TransferSpec;

export interface BuildOptions {
  computeUnitLimit?: number;
  /** µ-lamports per CU. */
  priorityFee?: number;
}

/** Placeholders accepted anywhere an address is: "payer"/"self" and "new:<label>". */
export interface AddressContext {
  payer: PublicKey;
  newSigners: Map<string, Keypair>;
}

export function resolveAddress(value: string, ctx: AddressContext, label = "address"): PublicKey {
  const v = String(value ?? "").trim();
  if (v === "payer" || v === "self") return ctx.payer;
  if (v.startsWith("new:")) {
    const key = v.slice(4) || "default";
    if (!ctx.newSigners.has(key)) ctx.newSigners.set(key, Keypair.generate());
    return ctx.newSigners.get(key)!.publicKey;
  }
  return parsePubkey(v, label);
}

// ── IDL arg coercion ─────────────────────────────────────────────────────

export const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

type IdlTypeLike = string | { [k: string]: unknown };
interface TypeDefLike { name: string; type: { kind: string; fields?: unknown[]; variants?: { name: string; fields?: unknown[] }[] } }

const BIG_INTS = new Set(["u64", "i64", "u128", "i128", "u256", "i256"]);
const SMALL_INTS = new Set(["u8", "i8", "u16", "i16", "u32", "i32", "f32", "f64"]);

function bytesFrom(v: unknown, what: string): Buffer {
  if (Array.isArray(v)) return Buffer.from(v as number[]);
  if (typeof v === "string") {
    if (/^0x[0-9a-f]*$/i.test(v)) return Buffer.from(v.slice(2), "hex");
    return Buffer.from(v, "base64");
  }
  throw new DevtoolsInputError(`${what}: expected hex ("0x…"), base64, or a byte array`);
}

/** Picks a field from user input by its IDL name, accepting snake_case or camelCase keys. */
function pick(obj: Record<string, unknown>, name: string): unknown {
  return obj[name] ?? obj[camel(name)];
}

export function coerceArg(type: IdlTypeLike, value: unknown, types: TypeDefLike[], path: string, ctx: AddressContext): unknown {
  if (typeof type === "string") {
    if (type === "bool") return value === true || value === "true";
    if (SMALL_INTS.has(type)) {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new DevtoolsInputError(`${path}: expected a number for ${type}`);
      return n;
    }
    if (BIG_INTS.has(type)) {
      try {
        return new BN(String(value));
      } catch {
        throw new DevtoolsInputError(`${path}: expected an integer for ${type}`);
      }
    }
    if (type === "string") return String(value);
    if (type === "pubkey" || type === "publicKey") return resolveAddress(String(value), ctx, path);
    if (type === "bytes") return bytesFrom(value, path);
    return value;
  }

  if ("option" in type || "coption" in type) {
    return value == null ? null : coerceArg((type.option ?? type.coption) as IdlTypeLike, value, types, path, ctx);
  }
  if ("vec" in type) {
    if (type.vec === "u8" && !Array.isArray(value)) return bytesFrom(value, path);
    if (!Array.isArray(value)) throw new DevtoolsInputError(`${path}: expected an array`);
    return value.map((v, i) => coerceArg(type.vec as IdlTypeLike, v, types, `${path}[${i}]`, ctx));
  }
  if ("array" in type) {
    const [inner, len] = type.array as [IdlTypeLike, number];
    const arr = inner === "u8" && !Array.isArray(value) ? Array.from(bytesFrom(value, path)) : value;
    if (!Array.isArray(arr) || arr.length !== len) throw new DevtoolsInputError(`${path}: expected an array of length ${len}`);
    return arr.map((v, i) => coerceArg(inner, v, types, `${path}[${i}]`, ctx));
  }
  if ("defined" in type) {
    const name = typeof type.defined === "string" ? type.defined : (type.defined as { name: string }).name;
    const def = types.find((t) => t.name === name);
    if (!def) return value;
    return coerceDefined(def, value, types, path, ctx);
  }
  return value;
}

function coerceFields(fields: unknown[], value: unknown, types: TypeDefLike[], path: string, ctx: AddressContext): unknown {
  const named = fields.length > 0 && typeof fields[0] === "object" && fields[0] !== null && "name" in (fields[0] as object);
  if (named) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DevtoolsInputError(`${path}: expected an object`);
    return Object.fromEntries((fields as { name: string; type: IdlTypeLike }[]).map((f) => [
      camel(f.name),
      coerceArg(f.type, pick(value as Record<string, unknown>, f.name), types, `${path}.${f.name}`, ctx),
    ]));
  }
  if (!Array.isArray(value)) throw new DevtoolsInputError(`${path}: expected a tuple array`);
  return (fields as IdlTypeLike[]).map((t, i) => coerceArg(t, value[i], types, `${path}[${i}]`, ctx));
}

function coerceDefined(def: TypeDefLike, value: unknown, types: TypeDefLike[], path: string, ctx: AddressContext): unknown {
  if (def.type.kind === "struct") return coerceFields(def.type.fields ?? [], value, types, path, ctx);
  if (def.type.kind === "enum") {
    // Accept "Variant" or { Variant: {...fields} }; Anchor wants { variant: {...} }.
    const [variantName, inner] = typeof value === "string" ? [value, {}] : Object.entries((value ?? {}) as Record<string, unknown>)[0] ?? [];
    const variant = def.type.variants?.find((v) => v.name === variantName || camel(v.name) === camel(String(variantName)));
    if (!variant) {
      throw new DevtoolsInputError(`${path}: unknown ${def.name} variant ${JSON.stringify(variantName)} — one of ${def.type.variants?.map((v) => v.name).join(", ")}`);
    }
    const fields = variant.fields?.length ? coerceFields(variant.fields, inner, types, `${path}.${variant.name}`, ctx) : {};
    return { [camel(variant.name)]: fields };
  }
  return value;
}

// ── Building ─────────────────────────────────────────────────────────────

export interface BuiltInstructions {
  instructions: TransactionInstruction[];
  /** IDLs used, by program id — reused to decode a failing custom error. */
  idls: Map<string, Idl>;
  newSigners: Map<string, Keypair>;
}

const MAX_INSTRUCTIONS = 12;

export async function buildInstructions(conn: Connection, payer: PublicKey, specs: InstructionSpec[]): Promise<BuiltInstructions> {
  if (!Array.isArray(specs) || specs.length === 0) throw new DevtoolsInputError("instructions[] is required");
  if (specs.length > MAX_INSTRUCTIONS) throw new DevtoolsInputError(`At most ${MAX_INSTRUCTIONS} instructions per transaction`);

  const ctx: AddressContext = { payer, newSigners: new Map() };
  const idls = new Map<string, Idl>();
  const instructions: TransactionInstruction[] = [];

  for (const [i, spec] of specs.entries()) {
    const at = `instructions[${i}]`;
    if (spec.kind === "transfer") {
      if (!(spec.sol > 0)) throw new DevtoolsInputError(`${at}.sol must be > 0`);
      instructions.push(SystemProgram.transfer({
        fromPubkey: payer, toPubkey: resolveAddress(spec.to, ctx, `${at}.to`), lamports: Math.round(spec.sol * LAMPORTS_PER_SOL),
      }));
      continue;
    }

    const programId = parsePubkey(spec.programId, `${at}.programId`);
    const metas = (list: AccountMetaSpec[] = [], where: string) => list.map((k, j) => ({
      pubkey: resolveAddress(k.pubkey, ctx, `${where}[${j}]`), isSigner: !!k.isSigner, isWritable: !!k.isWritable,
    }));

    if (spec.kind === "raw") {
      const data = spec.dataHex != null ? bytesFrom(spec.dataHex.startsWith("0x") ? spec.dataHex : `0x${spec.dataHex}`, `${at}.dataHex`)
        : spec.dataBase64 != null ? Buffer.from(spec.dataBase64, "base64") : Buffer.alloc(0);
      instructions.push(new TransactionInstruction({ programId, keys: metas(spec.keys, `${at}.keys`), data }));
      continue;
    }

    // Anchor
    const key = programId.toBase58();
    let idl = spec.idl ?? idls.get(key) ?? (await fetchIdl(conn, key));
    if (!idl) throw new DevtoolsInputError(`${at}: no on-chain IDL for ${key} — pass it inline as "idl"`);
    if (!("address" in idl) || !idl.address || !idl.metadata) {
      if (!idl.metadata) throw new DevtoolsInputError(`${at}: IDL is in the pre-0.30 format — convert it with \`anchor idl convert\``);
      idl = { ...idl, address: key };
    }
    idls.set(key, idl);

    const ixDef = idl.instructions.find((x) => x.name === spec.instruction || camel(x.name) === camel(spec.instruction));
    if (!ixDef) {
      throw new DevtoolsInputError(`${at}: ${spec.instruction} is not in the IDL — one of ${idl.instructions.map((x) => x.name).join(", ")}`);
    }
    const types = (idl.types ?? []) as unknown as TypeDefLike[];
    const rawArgs = spec.args ?? {};
    const args = ixDef.args.map((a, j) => coerceArg(
      a.type as IdlTypeLike,
      Array.isArray(rawArgs) ? rawArgs[j] : pick(rawArgs, a.name),
      types, `${at}.args.${a.name}`, ctx,
    ));
    const accounts = Object.fromEntries(Object.entries(spec.accounts ?? {}).map(([name, v]) => [camel(name), resolveAddress(v, ctx, `${at}.accounts.${name}`)]));

    // fetchIdl / method building only touch provider.connection + publicKey; no wallet signs here.
    const provider = { connection: conn, publicKey: payer, wallet: { publicKey: payer } } as unknown as Provider;
    const program = new Program(idl, provider);
    const method = program.methods[camel(ixDef.name)];
    try {
      instructions.push(await method(...args).accountsPartial(accounts).remainingAccounts(metas(spec.remainingAccounts, `${at}.remainingAccounts`)).instruction());
    } catch (err) {
      // Most often a missing account Anchor couldn't resolve on its own.
      throw new DevtoolsInputError(`${at} (${ixDef.name}): ${(err as Error).message}`);
    }
  }
  return { instructions, idls, newSigners: ctx.newSigners };
}

export function computeBudgetInstructions(opts: BuildOptions): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];
  if (opts.computeUnitLimit) out.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, Math.ceil(opts.computeUnitLimit)) }));
  if (opts.priorityFee) out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.ceil(opts.priorityFee) }));
  return out;
}

export async function compileTransaction(conn: Connection, payer: PublicKey, instructions: TransactionInstruction[]): Promise<{ tx: VersionedTransaction; blockhash: string; lastValidBlockHeight: number }> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message();
  return { tx: new VersionedTransaction(message), blockhash, lastValidBlockHeight };
}

// ── Simulation ───────────────────────────────────────────────────────────

export interface SimulationReport {
  success: boolean;
  err: unknown;
  error: (DecodedError & { instructionIndex: number; programId: string }) | null;
  unitsConsumed: number | null;
  /** Consumed + 10% headroom — what to pass as computeUnitLimit when sending. */
  recommendedComputeUnitLimit: number | null;
  logs: string[];
  instructionCount: number;
  sizeBytes: number;
  /** Throwaway signer pubkeys generated for `new:<label>` placeholders. */
  newAccounts: Record<string, string>;
  /** Unsigned v0 transaction (base64) — sign it with the payer and any new: signers to send it yourself. */
  transactionBase64: string;
}

/** Maps a simulation/transaction error to a decoded program error, accounting for prepended compute-budget ixs. */
export function decodeTxError(err: unknown, instructions: TransactionInstruction[], idls: Map<string, Idl>, offset = 0): SimulationReport["error"] {
  const ixErr = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  if (!ixErr) return null;
  const [index, detail] = ixErr;
  const programId = instructions[index]?.programId.toBase58() ?? "";
  const custom = (detail as { Custom?: number } | null)?.Custom;
  const base = typeof custom === "number"
    ? decodeProgramError(custom, programId, idls.get(programId) ?? null)
    : { code: -1, hex: "", name: typeof detail === "string" ? detail : JSON.stringify(detail), message: null, source: "unknown" as const };
  return { ...base, instructionIndex: index - offset, programId };
}

export async function simulate(conn: Connection, payer: PublicKey, specs: InstructionSpec[], opts: BuildOptions = {}): Promise<SimulationReport> {
  const built = await buildInstructions(conn, payer, specs);
  const budget = computeBudgetInstructions(opts);
  const all = [...budget, ...built.instructions];
  const { tx } = await compileTransaction(conn, payer, all);
  // sigVerify off + replaceRecentBlockhash: simulate without anyone signing,
  // which is what lets an agent (or a human) test a tx for any payer.
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  const units = sim.value.unitsConsumed ?? null;
  return {
    success: !sim.value.err,
    err: sim.value.err ?? null,
    error: decodeTxError(sim.value.err, all, built.idls, budget.length),
    unitsConsumed: units,
    recommendedComputeUnitLimit: units ? Math.ceil(units * 1.1) + 1000 : null,
    logs: sim.value.logs ?? [],
    instructionCount: all.length,
    sizeBytes: tx.serialize().length,
    newAccounts: Object.fromEntries([...built.newSigners].map(([k, kp]) => [k, kp.publicKey.toBase58()])),
    transactionBase64: Buffer.from(tx.serialize()).toString("base64"),
  };
}
