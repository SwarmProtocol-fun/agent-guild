/**
 * Solana developer toolkit — RPC-agnostic helpers shared by the panel
 * (browser, any cluster incl. localnet) and the server routes (agents,
 * public clusters only). Everything takes a Connection so the caller
 * decides which RPC it talks to; nothing here holds or signs with a key.
 */
// Explicit import: these modules also run in the browser, where Buffer isn't a global.
import { Buffer } from "buffer";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder, LangErrorCode, LangErrorMessage, Program, type Idl, type Provider } from "@coral-xyz/anchor";

// ── Clusters ─────────────────────────────────────────────────────────────

export type Cluster = "devnet" | "testnet" | "mainnet-beta" | "localnet" | "custom";

export const PUBLIC_RPC: Record<Exclude<Cluster, "custom">, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export function explorerUrl(kind: "tx" | "address", id: string, cluster: Cluster, customUrl?: string): string {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  if (cluster === "mainnet-beta") return base;
  if (cluster === "localnet") return `${base}?cluster=custom&customUrl=${encodeURIComponent(PUBLIC_RPC.localnet)}`;
  if (cluster === "custom") return `${base}?cluster=custom&customUrl=${encodeURIComponent(customUrl ?? "")}`;
  return `${base}?cluster=${cluster}`;
}

/** Bad user input (→ 400), as opposed to an RPC failure (→ 502). */
export class DevtoolsInputError extends Error {}

export function parsePubkey(value: string, label = "address"): PublicKey {
  try {
    return new PublicKey(value.trim());
  } catch {
    throw new DevtoolsInputError(`Invalid ${label}: ${value}`);
  }
}

// ── Known programs ───────────────────────────────────────────────────────

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const BPF_UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

export const KNOWN_PROGRAMS: Record<string, string> = {
  [SYSTEM_PROGRAM]: "System Program",
  [TOKEN_PROGRAM]: "SPL Token",
  [TOKEN_2022_PROGRAM]: "SPL Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo v2",
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "Memo v1",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  [BPF_UPGRADEABLE_LOADER]: "BPF Upgradeable Loader",
  BPFLoader2111111111111111111111111111111111: "BPF Loader 2",
  AddressLookupTab1e1111111111111111111111111: "Address Lookup Table",
  Stake11111111111111111111111111111111111111: "Stake Program",
  Vote111111111111111111111111111111111111111: "Vote Program",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Token Metadata",
  Ed25519SigVerify111111111111111111111111111: "Ed25519 SigVerify",
  KeccakSecp256k11111111111111111111111111111: "Secp256k1 SigVerify",
};

export function programName(programId: string): string | null {
  return KNOWN_PROGRAMS[programId] ?? null;
}

// ── JSON-safe output ─────────────────────────────────────────────────────

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Anchor-decoded data holds PublicKey/BN/bigint/bytes — flatten to plain JSON. */
export function toPlainJson(value: unknown): unknown {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (value instanceof Uint8Array) return `0x${toHex(value)}`;
  if (Array.isArray(value)) return value.map(toPlainJson);
  if (typeof value === "object") {
    // BN — duck-typed so we don't care which bn.js copy produced it.
    const maybeBn = value as { toArrayLike?: unknown; toString(base?: number): string };
    if (typeof maybeBn.toArrayLike === "function") return maybeBn.toString(10);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toPlainJson(v)]));
  }
  return String(value);
}

// ── PDA derivation (pure, no RPC) ────────────────────────────────────────

export type SeedType = "string" | "pubkey" | "u8" | "u16" | "u32" | "u64" | "i64" | "hex";
export interface SeedSpec { type: SeedType; value: string }

export const SEED_TYPES: SeedType[] = ["string", "pubkey", "u8", "u16", "u32", "u64", "i64", "hex"];

const INT_BYTES: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8, i64: 8 };

export function seedToBytes(seed: SeedSpec): Uint8Array {
  const { type, value } = seed;
  switch (type) {
    case "string":
      return new TextEncoder().encode(value);
    case "pubkey":
      return parsePubkey(value, "pubkey seed").toBytes();
    case "hex": {
      const clean = value.trim().replace(/^0x/i, "");
      if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new DevtoolsInputError(`Invalid hex seed: ${value}`);
      return Uint8Array.from(clean.match(/../g) ?? [], (h) => parseInt(h, 16));
    }
    default: {
      let n: bigint;
      try {
        n = BigInt(value.trim());
      } catch {
        throw new DevtoolsInputError(`Invalid ${type} seed: ${value}`);
      }
      const size = INT_BYTES[type];
      const signed = type === "i64";
      const min = signed ? -(1n << 63n) : 0n;
      const max = signed ? (1n << 63n) - 1n : (1n << BigInt(size * 8)) - 1n;
      if (n < min || n > max) throw new DevtoolsInputError(`${type} seed out of range: ${value}`);
      const view = new DataView(new ArrayBuffer(size));
      if (type === "u8") view.setUint8(0, Number(n));
      else if (type === "u16") view.setUint16(0, Number(n), true);
      else if (type === "u32") view.setUint32(0, Number(n), true);
      else if (type === "u64") view.setBigUint64(0, n, true);
      else view.setBigInt64(0, n, true);
      return new Uint8Array(view.buffer);
    }
  }
}

export function derivePda(programId: string, seeds: SeedSpec[]): { address: string; bump: number; seedsHex: string[] } {
  const program = parsePubkey(programId, "program id");
  if (seeds.length > 15) throw new DevtoolsInputError("At most 15 seeds (the bump is the 16th)");
  const bytes = seeds.map(seedToBytes);
  const tooLong = bytes.findIndex((b) => b.length > 32);
  if (tooLong >= 0) throw new DevtoolsInputError(`Seed ${tooLong + 1} is ${bytes[tooLong].length} bytes — max 32`);
  const [address, bump] = PublicKey.findProgramAddressSync(bytes, program);
  return { address: address.toBase58(), bump, seedsHex: bytes.map(toHex) };
}

/** TypeScript snippet reproducing a derivation — pasted straight into a client/test. */
export function pdaSnippet(programId: string, seeds: SeedSpec[]): string {
  const expr = (s: SeedSpec) => {
    switch (s.type) {
      case "string": return `Buffer.from(${JSON.stringify(s.value)})`;
      case "pubkey": return `new PublicKey(${JSON.stringify(s.value)}).toBuffer()`;
      case "hex": return `Buffer.from(${JSON.stringify(s.value.replace(/^0x/i, ""))}, "hex")`;
      case "u8": return `Buffer.from([${s.value}])`;
      case "i64": return `new BN(${JSON.stringify(s.value)}).toTwos(64).toArrayLike(Buffer, "le", 8)`;
      default: return `new BN(${JSON.stringify(s.value)}).toArrayLike(Buffer, "le", ${INT_BYTES[s.type]})`;
    }
  };
  const lines = seeds.map((s) => `    ${expr(s)},`).join("\n");
  return `const [pda, bump] = PublicKey.findProgramAddressSync(\n  [\n${lines}\n  ],\n  new PublicKey(${JSON.stringify(programId)}),\n);`;
}

// ── Error decoding ───────────────────────────────────────────────────────

const SYSTEM_ERRORS = [
  "AccountAlreadyInUse: an account with the same address already exists",
  "ResultWithNegativeLamports: account does not have enough SOL to perform the operation",
  "InvalidProgramId: cannot assign account to this program id",
  "InvalidAccountDataLength: cannot allocate account data of this length",
  "MaxSeedLengthExceeded: length of requested seed is too long",
  "AddressWithSeedMismatch: provided address does not match addressed derived from seed",
  "NonceNoRecentBlockhashes: advancing stored nonce requires a populated RecentBlockhashes sysvar",
  "NonceBlockhashNotExpired: stored nonce is still in recent_blockhashes",
  "NonceUnexpectedBlockhashValue: specified nonce does not match stored nonce",
];

const TOKEN_ERRORS = [
  "NotRentExempt: lamport balance below rent-exempt threshold",
  "InsufficientFunds: insufficient funds",
  "InvalidMint: invalid mint",
  "MintMismatch: account not associated with this mint",
  "OwnerMismatch: owner does not match",
  "FixedSupply: fixed supply — mint authority is unset",
  "AlreadyInUse: account already in use",
  "InvalidNumberOfProvidedSigners: invalid number of provided signers",
  "InvalidNumberOfRequiredSigners: invalid number of required signers",
  "UninitializedState: state is uninitialized",
  "NativeNotSupported: instruction does not support native tokens",
  "NonNativeHasBalance: non-native account can only be closed if its balance is zero",
  "InvalidInstruction: invalid instruction",
  "InvalidState: state is invalid for requested operation",
  "Overflow: operation overflowed",
  "AuthorityTypeNotSupported: account does not support specified authority type",
  "MintCannotFreeze: this token mint cannot freeze accounts",
  "AccountFrozen: account is frozen",
  "MintDecimalsMismatch: the provided decimals value differs from the mint decimals",
  "NonNativeNotSupported: instruction does not support non-native tokens",
];

const LANG_ERROR_NAMES = new Map<number, string>(Object.entries(LangErrorCode).map(([name, code]) => [code as number, name]));

export interface DecodedError {
  code: number;
  hex: string;
  name: string | null;
  message: string | null;
  source: "system" | "spl-token" | "anchor-framework" | "program-idl" | "unknown";
}

/** Accepts "6001", "0x1771", or a raw log line like "custom program error: 0x1771". */
export function parseErrorCode(input: string): number {
  const m = input.trim().match(/(0x[0-9a-f]+|\d+)\s*$/i);
  if (!m) throw new DevtoolsInputError(`No error code found in: ${input}`);
  const n = m[1].toLowerCase().startsWith("0x") ? parseInt(m[1], 16) : parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) throw new DevtoolsInputError(`Error code out of range: ${input}`);
  return n;
}

type IdlErrorEntry = { code: number; name: string; msg?: string };

export function decodeProgramError(code: number, programId?: string | null, idl?: Idl | null): DecodedError {
  const base = { code, hex: `0x${code.toString(16)}` };
  const split = (s: string) => {
    const i = s.indexOf(": ");
    return { name: s.slice(0, i), message: s.slice(i + 2) };
  };
  if (programId === SYSTEM_PROGRAM && SYSTEM_ERRORS[code]) return { ...base, ...split(SYSTEM_ERRORS[code]), source: "system" };
  if ((programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) && TOKEN_ERRORS[code]) {
    return { ...base, ...split(TOKEN_ERRORS[code]), source: "spl-token" };
  }
  const idlError = ((idl as { errors?: IdlErrorEntry[] } | null)?.errors ?? []).find((e) => e.code === code);
  if (idlError) return { ...base, name: idlError.name, message: idlError.msg ?? null, source: "program-idl" };
  const langMessage = LangErrorMessage.get(code);
  if (langMessage) return { ...base, name: LANG_ERROR_NAMES.get(code) ?? null, message: langMessage, source: "anchor-framework" };
  return {
    ...base,
    name: null,
    message: code >= 6000 ? "Custom program error — publish the program's IDL (anchor idl init) to decode it" : null,
    source: "unknown",
  };
}

// ── Anchor IDL ───────────────────────────────────────────────────────────

export async function fetchIdl(conn: Connection, programId: string): Promise<Idl | null> {
  // fetchIdl only touches provider.connection, so no wallet is needed.
  return Program.fetchIdl(parsePubkey(programId, "program id"), { connection: conn } as Provider);
}

/** Anchor ≥0.30 IDLs carry account discriminators; older ones don't, so decoding is best-effort. */
export function decodeAnchorAccount(idl: Idl, data: Uint8Array): { accountType: string; decoded: unknown } | null {
  const disc = toHex(data.slice(0, 8));
  const match = (idl.accounts ?? []).find((a) => a.discriminator && toHex(Uint8Array.from(a.discriminator)) === disc);
  if (!match) return null;
  try {
    const decoded = new BorshAccountsCoder(idl).decode(match.name, Buffer.from(data));
    return { accountType: match.name, decoded: toPlainJson(decoded) };
  } catch {
    return { accountType: match.name, decoded: null };
  }
}

// ── Account inspector ────────────────────────────────────────────────────

export interface AccountReport {
  address: string;
  exists: boolean;
  lamports?: number;
  sol?: number;
  owner?: string;
  ownerName?: string | null;
  executable?: boolean;
  dataLength?: number;
  rentExemptMinimum?: number;
  rentExempt?: boolean;
  dataPreviewHex?: string;
  /** jsonParsed view for programs the RPC understands (tokens, stake, …). */
  parsed?: unknown;
  program?: { programDataAddress: string; upgradeAuthority: string | null; lastDeploySlot: number } | null;
  anchor?: { accountType: string; decoded: unknown } | null;
}

export async function inspectAccount(conn: Connection, address: string, opts: { decodeAnchor?: boolean } = {}): Promise<AccountReport> {
  const pk = parsePubkey(address);
  const [raw, parsed] = await Promise.all([conn.getAccountInfo(pk), conn.getParsedAccountInfo(pk)]);
  if (!raw) return { address: pk.toBase58(), exists: false };

  const owner = raw.owner.toBase58();
  const rentExemptMinimum = await conn.getMinimumBalanceForRentExemption(raw.data.length);
  const report: AccountReport = {
    address: pk.toBase58(),
    exists: true,
    lamports: raw.lamports,
    sol: raw.lamports / LAMPORTS_PER_SOL,
    owner,
    ownerName: programName(owner),
    executable: raw.executable,
    dataLength: raw.data.length,
    rentExemptMinimum,
    rentExempt: raw.lamports >= rentExemptMinimum,
    dataPreviewHex: toHex(raw.data.subarray(0, 64)),
  };

  const parsedData = parsed.value?.data;
  if (parsedData && !(parsedData instanceof Uint8Array) && "parsed" in parsedData) {
    report.parsed = { program: parsedData.program, ...parsedData.parsed };
  }

  // Upgradeable program: account = u32 tag(2) + programdata pubkey; programdata
  // header = u32 tag(3) + u64 slot + Option<Pubkey>. Read only the 45-byte
  // header so we never pull a multi-MB program binary over RPC.
  if (raw.executable && owner === BPF_UPGRADEABLE_LOADER && raw.data.length >= 36) {
    const programData = new PublicKey(raw.data.subarray(4, 36));
    const header = await conn.getAccountInfo(programData, { dataSlice: { offset: 0, length: 45 } });
    if (header && header.data.length >= 13) {
      const view = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength);
      report.program = {
        programDataAddress: programData.toBase58(),
        lastDeploySlot: Number(view.getBigUint64(4, true)),
        upgradeAuthority: header.data[12] === 1 ? new PublicKey(header.data.subarray(13, 45)).toBase58() : null,
      };
    }
  }

  if (opts.decodeAnchor && !raw.executable && !programName(owner) && raw.data.length >= 8) {
    const idl = await fetchIdl(conn, owner).catch(() => null);
    report.anchor = idl ? decodeAnchorAccount(idl, raw.data) : null;
  }
  return report;
}

// ── Transaction inspector ────────────────────────────────────────────────

export interface TxReport {
  signature: string;
  found: boolean;
  slot?: number;
  blockTime?: number | null;
  version?: string | number;
  success?: boolean;
  err?: unknown;
  error?: (DecodedError & { instructionIndex: number; programId: string }) | null;
  feeLamports?: number;
  computeUnitsConsumed?: number | null;
  signers?: string[];
  instructions?: { index: number; programId: string; programName: string | null; type: string | null; innerCount: number }[];
  balanceChanges?: { account: string; deltaLamports: number }[];
  tokenBalanceChanges?: { account: string; mint: string; owner: string | null; delta: string }[];
  logs?: string[];
}

const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

export async function inspectTransaction(conn: Connection, signature: string, opts: { decodeWithIdl?: boolean } = { decodeWithIdl: true }): Promise<TxReport> {
  const sig = signature.trim();
  if (!SIGNATURE_RE.test(sig)) throw new DevtoolsInputError(`Not a transaction signature: ${signature}`);
  const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) return { signature: sig, found: false };

  const meta = tx.meta;
  const keys = tx.transaction.message.accountKeys;
  const inner = new Map((meta?.innerInstructions ?? []).map((i) => [i.index, i.instructions.length]));
  const instructions = tx.transaction.message.instructions.map((ix, index) => {
    const programId = ix.programId.toBase58();
    const type = "parsed" in ix && ix.parsed && typeof ix.parsed === "object" ? String((ix.parsed as { type?: string }).type ?? "") || null : null;
    return { index, programId, programName: programName(programId), type, innerCount: inner.get(index) ?? 0 };
  });

  let error: TxReport["error"] = null;
  const instructionError = (meta?.err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  if (instructionError) {
    const [ixIndex, detail] = instructionError;
    const custom = (detail as { Custom?: number } | null)?.Custom;
    const programId = instructions[ixIndex]?.programId ?? "";
    if (typeof custom === "number") {
      const idl = opts.decodeWithIdl && custom >= 6000 && programId ? await fetchIdl(conn, programId).catch(() => null) : null;
      error = { ...decodeProgramError(custom, programId, idl), instructionIndex: ixIndex, programId };
    } else {
      const name = typeof detail === "string" ? detail : JSON.stringify(detail);
      error = { code: -1, hex: "", name, message: null, source: "unknown", instructionIndex: ixIndex, programId };
    }
  }

  const balanceChanges = (meta?.preBalances ?? [])
    .map((pre, i) => ({ account: keys[i]?.pubkey.toBase58() ?? `#${i}`, deltaLamports: (meta?.postBalances[i] ?? pre) - pre }))
    .filter((c) => c.deltaLamports !== 0);

  const tokenKey = (b: { accountIndex: number; mint: string }) => `${b.accountIndex}:${b.mint}`;
  const preTokens = new Map((meta?.preTokenBalances ?? []).map((b) => [tokenKey(b), b]));
  const tokenBalanceChanges = (meta?.postTokenBalances ?? []).flatMap((post) => {
    const pre = preTokens.get(tokenKey(post));
    const decimals = post.uiTokenAmount.decimals;
    const delta = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? "0");
    if (delta === 0n) return [];
    return [{
      account: keys[post.accountIndex]?.pubkey.toBase58() ?? `#${post.accountIndex}`,
      mint: post.mint,
      owner: post.owner ?? null,
      delta: formatUnits(delta, decimals),
    }];
  });

  return {
    signature: sig,
    found: true,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    version: tx.version ?? "legacy",
    success: !meta?.err,
    err: meta?.err ?? null,
    error,
    feeLamports: meta?.fee,
    computeUnitsConsumed: meta?.computeUnitsConsumed ?? null,
    signers: keys.filter((k) => k.signer).map((k) => k.pubkey.toBase58()),
    instructions,
    balanceChanges,
    tokenBalanceChanges,
    logs: meta?.logMessages ?? [],
  };
}

function formatUnits(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : "+"}${whole}${frac ? `.${frac}` : ""}`;
}

// ── Network ──────────────────────────────────────────────────────────────

export interface ClusterStatus {
  version: string;
  slot: number;
  blockHeight: number;
  epoch: number;
  epochProgressPct: number;
  tps: number | null;
  nonVoteTps: number | null;
}

export async function clusterStatus(conn: Connection): Promise<ClusterStatus> {
  const [version, epoch, rawSamples] = await Promise.all([
    conn.getVersion(),
    conn.getEpochInfo(),
    conn.getRecentPerformanceSamples(5).catch(() => []),
  ]);
  // RPC nodes ≥1.15 return numNonVoteTransactions; web3.js's PerfSample type predates it.
  const samples = rawSamples as (typeof rawSamples[number] & { numNonVoteTransactions?: number })[];
  const secs = samples.reduce((s, x) => s + x.samplePeriodSecs, 0);
  const txs = samples.reduce((s, x) => s + x.numTransactions, 0);
  const nonVote = samples.every((x) => x.numNonVoteTransactions != null)
    ? samples.reduce((s, x) => s + (x.numNonVoteTransactions ?? 0), 0)
    : null;
  return {
    version: version["solana-core"],
    slot: epoch.absoluteSlot,
    blockHeight: epoch.blockHeight ?? 0,
    epoch: epoch.epoch,
    epochProgressPct: Math.round((epoch.slotIndex / epoch.slotsInEpoch) * 1000) / 10,
    tps: secs ? Math.round(txs / secs) : null,
    nonVoteTps: secs && nonVote != null ? Math.round(nonVote / secs) : null,
  };
}

export interface PriorityFeeReport {
  slots: number;
  zeroFeeShare: number;
  /** micro-lamports per compute unit */
  min: number; p50: number; p75: number; p90: number; max: number;
}

export async function priorityFees(conn: Connection, writableAccounts: string[] = []): Promise<PriorityFeeReport> {
  if (writableAccounts.length > 128) throw new DevtoolsInputError("At most 128 accounts");
  const lockedWritableAccounts = writableAccounts.map((a) => parsePubkey(a, "writable account"));
  const fees = (await conn.getRecentPrioritizationFees({ lockedWritableAccounts })).map((f) => f.prioritizationFee).sort((a, b) => a - b);
  const pct = (p: number) => (fees.length ? fees[Math.min(fees.length - 1, Math.floor((p / 100) * fees.length))] : 0);
  return {
    slots: fees.length,
    zeroFeeShare: fees.length ? Math.round((fees.filter((f) => f === 0).length / fees.length) * 100) / 100 : 0,
    min: fees[0] ?? 0, p50: pct(50), p75: pct(75), p90: pct(90), max: fees[fees.length - 1] ?? 0,
  };
}

/** Upgradeable programs store the binary in a ProgramData account with a 45-byte header. */
export const PROGRAM_DATA_HEADER = 45;

export async function rentExempt(conn: Connection, bytes: number): Promise<{ bytes: number; lamports: number; sol: number }> {
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > 10 * 1024 * 1024) {
    throw new DevtoolsInputError("bytes must be an integer between 0 and 10 MiB");
  }
  const lamports = await conn.getMinimumBalanceForRentExemption(bytes);
  return { bytes, lamports, sol: lamports / LAMPORTS_PER_SOL };
}

/** Classifies whatever a developer pasted: tx signature, address, or error code. */
export function detectInput(input: string): "tx" | "address" | "error" | null {
  const v = input.trim();
  if (!v) return null;
  if (SIGNATURE_RE.test(v)) return "tx";
  try {
    new PublicKey(v);
    if (v.length >= 32) return "address";
  } catch { /* fall through */ }
  return /(0x[0-9a-f]+|\d+)\s*$/i.test(v) ? "error" : null;
}
