/**
 * Checks an agent can't make by reading text alone. Each one turns raw
 * chain state into a verdict it can act on:
 *
 *   - assessToken: is this mint a rug risk (live mint/freeze authority,
 *     Token-2022 traps, holder concentration, thin liquidity)?
 *   - findPayment: did this wallet really receive the money (by signature or
 *     Solana Pay reference), not just a screenshot of it?
 *   - previewExternalTx: what does a transaction a dApp handed over actually
 *     do to the agent's wallet before it signs it?
 *
 * The assess* / *Received / decode* functions are pure (tested without
 * RPC); the async wrappers do the reads.
 */
import { Buffer } from "buffer";
import {
  Connection, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction,
  type AddressLookupTableAccount, type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { DevtoolsInputError, KNOWN_PROGRAMS, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, parsePubkey, programName } from "./devtools";
import { toUi } from "./market";

export type Severity = "high" | "medium" | "info";
export interface Finding { severity: Severity; code: string; message: string }

const sortFindings = (f: Finding[]) => f.sort((a, b) => ["high", "medium", "info"].indexOf(a.severity) - ["high", "medium", "info"].indexOf(b.severity));

// ── Token safety ─────────────────────────────────────────────────────────

/** Token-2022 extensions that let someone other than the holder move, freeze, tax or trap tokens. */
const RISKY_EXTENSIONS: Record<string, { severity: Severity; message: string }> = {
  permanentDelegate: { severity: "high", message: "Permanent delegate: one address can transfer or burn anyone's tokens at any time" },
  transferHook: { severity: "high", message: "Transfer hook: every transfer runs a program the issuer controls, which can block sells" },
  nonTransferable: { severity: "high", message: "Non-transferable: holders can't send or sell it" },
  defaultAccountState: { severity: "medium", message: "Default account state: new token accounts may start frozen until the issuer thaws them" },
  pausableConfig: { severity: "high", message: "Pausable: the issuer can halt all transfers" },
  mintCloseAuthority: { severity: "medium", message: "Mint close authority: the mint can be closed once supply is zero" },
  confidentialTransferMint: { severity: "info", message: "Confidential transfers: balances can be hidden" },
};

export interface MintFacts {
  program: "spl-token" | "spl-token-2022";
  decimals: number;
  supplyRaw: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: { extension: string; state?: Record<string, unknown> }[];
}

export interface TokenSafetyInput {
  mint: string;
  facts: MintFacts;
  /** Raw amounts of the largest token accounts, largest first. */
  largestRaw: string[];
  info: { name: string | null; symbol: string | null; isVerified: boolean; holderCount: number | null; liquidityUsd: number | null; organicScoreLabel: string | null; topHoldersPct?: number | null } | null;
  priceUsd: number | null;
  /** Price impact (%) of selling ~$1,000 into USDC, null when there was no route. */
  sellImpactPct: number | null;
}

export interface TokenSafetyReport {
  mint: string;
  name: string | null;
  symbol: string | null;
  verdict: "high-risk" | "caution" | "no-red-flags";
  findings: Finding[];
  facts: MintFacts & { supplyUi: string; top10Pct: number | null; topHolderPct: number | null };
  market: { priceUsd: number | null; liquidityUsd: number | null; sellImpactPctFor1k: number | null; holderCount: number | null; verified: boolean; organicScore: string | null };
}

/** Well-known issuers keep freeze authority for compliance; say so instead of crying wolf. */
const REGULATED_STABLES = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"]);

export function assessToken(input: TokenSafetyInput): TokenSafetyReport {
  const { facts, mint } = input;
  const findings: Finding[] = [];
  const stable = REGULATED_STABLES.has(mint);

  if (facts.mintAuthority) {
    findings.push(stable
      ? { severity: "info", code: "mint-authority", message: `Issuer ${facts.mintAuthority} can mint more (normal for a regulated stablecoin)` }
      : { severity: "high", code: "mint-authority", message: `Mint authority ${facts.mintAuthority} is live: supply can be inflated at will` });
  }
  if (facts.freezeAuthority) {
    findings.push(stable
      ? { severity: "info", code: "freeze-authority", message: "The issuer can freeze accounts (normal for a regulated stablecoin)" }
      : { severity: "high", code: "freeze-authority", message: `Freeze authority ${facts.freezeAuthority} is live: your token account can be frozen so you can't sell` });
  }
  for (const ext of facts.extensions) {
    if (ext.extension === "transferFeeConfig") {
      const bps = Number((ext.state?.newerTransferFee as { transferFeeBasisPoints?: number } | undefined)?.transferFeeBasisPoints ?? 0);
      if (bps > 0) findings.push({ severity: bps >= 500 ? "high" : "medium", code: "transfer-fee", message: `Transfer fee of ${bps / 100}% on every transfer, including sells` });
      continue;
    }
    if (ext.extension === "defaultAccountState" && ext.state?.accountState !== "frozen") continue;
    const risky = RISKY_EXTENSIONS[ext.extension];
    if (risky) findings.push({ ...risky, code: ext.extension });
  }

  const supply = BigInt(facts.supplyRaw || "0");
  const share = (raw: bigint) => (supply > 0n ? Number((raw * 10_000n) / supply) / 100 : null);
  const largest = input.largestRaw.map((r) => BigInt(r));
  // Public RPCs often refuse getTokenLargestAccounts; Jupiter's top-holders share stands in.
  const top10Pct = largest.length ? share(largest.slice(0, 10).reduce((a, b) => a + b, 0n)) : input.info?.topHoldersPct != null ? Math.round(input.info.topHoldersPct * 100) / 100 : null;
  const topHolderPct = largest.length ? share(largest[0]) : null;
  if (topHolderPct != null && topHolderPct >= 30) {
    findings.push({ severity: "high", code: "whale", message: `One token account holds ${topHolderPct}% of supply (it may be a pool or exchange — inspect it)` });
  } else if (top10Pct != null && top10Pct >= 50) {
    findings.push({ severity: "medium", code: "concentration", message: `The 10 largest token accounts hold ${top10Pct}% of supply (pools and exchanges included)` });
  }

  if (input.priceUsd == null) {
    findings.push({ severity: "medium", code: "no-price", message: "Jupiter has no price for it: there may be no market to sell into" });
  } else if (input.sellImpactPct == null) {
    findings.push({ severity: "high", code: "no-route", message: "No Jupiter route to sell $1,000 of it into USDC" });
  } else if (input.sellImpactPct >= 10) {
    findings.push({ severity: "high", code: "illiquid", message: `Selling $1,000 moves the price ${input.sellImpactPct.toFixed(1)}%` });
  } else if (input.sellImpactPct >= 2) {
    findings.push({ severity: "medium", code: "thin", message: `Selling $1,000 moves the price ${input.sellImpactPct.toFixed(1)}%` });
  }
  if (input.info && !input.info.isVerified) findings.push({ severity: "info", code: "unverified", message: "Not on Jupiter's verified list" });
  if (!input.info) findings.push({ severity: "medium", code: "unlisted", message: "Not in Jupiter's token directory" });
  if (input.info?.organicScoreLabel === "low") findings.push({ severity: "medium", code: "inorganic", message: "Jupiter rates its trading activity as low-organic (likely wash or bot volume)" });

  const verdict = findings.some((f) => f.severity === "high") ? "high-risk" : findings.some((f) => f.severity === "medium") ? "caution" : "no-red-flags";
  return {
    mint,
    name: input.info?.name ?? null,
    symbol: input.info?.symbol ?? null,
    verdict,
    findings: sortFindings(findings),
    facts: { ...facts, supplyUi: toUi(facts.supplyRaw || "0", facts.decimals), top10Pct, topHolderPct },
    market: {
      priceUsd: input.priceUsd, liquidityUsd: input.info?.liquidityUsd ?? null, sellImpactPctFor1k: input.sellImpactPct,
      holderCount: input.info?.holderCount ?? null, verified: input.info?.isVerified ?? false, organicScore: input.info?.organicScoreLabel ?? null,
    },
  };
}

/** Reads the mint (jsonParsed) — throws an input error when the address isn't a token mint. */
export async function readMintFacts(conn: Connection, mint: string): Promise<MintFacts> {
  const res = await conn.getParsedAccountInfo(parsePubkey(mint, "mint"));
  const acct = res.value;
  const owner = acct?.owner.toBase58();
  const data = acct?.data as { parsed?: { type?: string; info?: Record<string, unknown> } } | undefined;
  if (!acct || (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022_PROGRAM) || data?.parsed?.type !== "mint") {
    throw new DevtoolsInputError(`${mint} is not a token mint on this cluster`);
  }
  const info = data.parsed.info ?? {};
  return {
    program: owner === TOKEN_PROGRAM ? "spl-token" : "spl-token-2022",
    decimals: Number(info.decimals ?? 0),
    supplyRaw: String(info.supply ?? "0"),
    mintAuthority: (info.mintAuthority as string | null) ?? null,
    freezeAuthority: (info.freezeAuthority as string | null) ?? null,
    extensions: Array.isArray(info.extensions) ? (info.extensions as MintFacts["extensions"]) : [],
  };
}

// ── Payment verification ─────────────────────────────────────────────────

export interface PaymentCheck {
  signature: string;
  ok: boolean;
  /** Net amount the recipient gained in this tx, base units. */
  receivedRaw: string;
  decimals: number;
  payer: string | null;
  memos: string[];
  blockTime: string | null;
}

/**
 * How much `recipient` gained in one transaction: lamports for SOL, or the
 * net change across every token account it owns for `mint`.
 */
export function paymentReceived(tx: ParsedTransactionWithMeta, recipient: string, mint: string | null): PaymentCheck {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const meta = tx.meta;
  let received = 0n;
  let decimals = 9;
  if (!mint) {
    const i = keys.indexOf(recipient);
    if (i >= 0 && meta) received = BigInt(meta.postBalances[i] ?? 0) - BigInt(meta.preBalances[i] ?? 0);
  } else {
    const sum = (rows: NonNullable<ParsedTransactionWithMeta["meta"]>["postTokenBalances"]) => {
      let total = 0n;
      for (const b of rows ?? []) {
        if (b.mint !== mint || b.owner !== recipient) continue;
        decimals = b.uiTokenAmount.decimals;
        total += BigInt(b.uiTokenAmount.amount);
      }
      return total;
    };
    received = sum(meta?.postTokenBalances) - sum(meta?.preTokenBalances);
  }
  const memos: string[] = [];
  for (const ix of tx.transaction.message.instructions) {
    if ("parsed" in ix && (ix.program === "spl-memo") && typeof ix.parsed === "string") memos.push(ix.parsed);
  }
  for (const line of meta?.logMessages ?? []) {
    const m = line.match(/^Program log: Memo \(len \d+\): "(.*)"$/);
    if (m && !memos.includes(m[1])) memos.push(m[1]);
  }
  return {
    signature: tx.transaction.signatures[0],
    ok: !meta?.err,
    receivedRaw: received.toString(),
    decimals,
    payer: keys[0] ?? null,
    memos,
    blockTime: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
  };
}

export interface PaymentVerdict {
  verified: boolean;
  /** Why not, when verified is false. */
  reason: string | null;
  signature: string | null;
  payer: string | null;
  received: string;
  expected: string | null;
  memoMatched: boolean | null;
  finalized: boolean;
  blockTime: string | null;
  checked: number;
}

/**
 * Looks for a payment to `recipient` in the given signature, or in recent
 * transactions that include `reference` (Solana Pay). Verified = succeeded,
 * paid at least `amount`, and carried `memo` when one was asked for.
 */
export async function findPayment(
  conn: Connection,
  params: { recipient: string; mint: string | null; amount?: string | null; signature?: string | null; reference?: string | null; memo?: string | null },
): Promise<PaymentVerdict> {
  const recipient = parsePubkey(params.recipient, "recipient").toBase58();
  const mint = params.mint ? parsePubkey(params.mint, "mint").toBase58() : null;
  if (!params.signature && !params.reference) throw new DevtoolsInputError("Pass a signature or a reference");

  let candidates: { signature: string; finalized: boolean }[];
  if (params.signature) {
    const [status] = (await conn.getSignatureStatuses([params.signature.trim()], { searchTransactionHistory: true })).value;
    candidates = [{ signature: params.signature.trim(), finalized: status?.confirmationStatus === "finalized" }];
  } else {
    const sigs = await conn.getSignaturesForAddress(parsePubkey(params.reference!, "reference"), { limit: 10 }, "confirmed");
    candidates = sigs.filter((s) => !s.err).map((s) => ({ signature: s.signature, finalized: s.confirmationStatus === "finalized" }));
  }

  let best: (PaymentCheck & { finalized: boolean }) | null = null;
  let decimals = mint ? 0 : 9;
  for (const c of candidates) {
    const tx = await conn.getParsedTransaction(c.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx) continue;
    const check = { ...paymentReceived(tx, recipient, mint), finalized: c.finalized };
    decimals = check.decimals;
    if (!check.ok) continue;
    if (!best || BigInt(check.receivedRaw) > BigInt(best.receivedRaw)) best = check;
  }

  // Token decimals for the expected amount when nothing was found to read them from.
  if (mint && !best) {
    const info = await conn.getParsedAccountInfo(new PublicKey(mint)).catch(() => null);
    decimals = Number((info?.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed?.info?.decimals ?? 0);
  }
  const expectedRaw = params.amount != null && params.amount !== "" ? toRawLoose(params.amount, decimals) : null;
  const receivedRaw = BigInt(best?.receivedRaw ?? "0");
  const memoMatched = params.memo ? !!best?.memos.some((m) => m.includes(params.memo!)) : null;

  let reason: string | null = null;
  if (!best) reason = candidates.length ? "No successful transaction paid this recipient" : params.signature ? "Transaction not found" : "No transactions carry this reference yet";
  else if (receivedRaw <= 0n) reason = `${recipient} received nothing in ${best.signature}`;
  else if (expectedRaw != null && receivedRaw < expectedRaw) reason = `Paid ${toUi(receivedRaw.toString(), decimals)}, short of ${toUi(expectedRaw.toString(), decimals)}`;
  else if (memoMatched === false) reason = `Memo "${params.memo}" not found`;

  return {
    verified: reason == null,
    reason,
    signature: best?.signature ?? null,
    payer: best?.payer ?? null,
    received: toUi(receivedRaw.toString(), decimals),
    expected: expectedRaw != null ? toUi(expectedRaw.toString(), decimals) : null,
    memoMatched,
    finalized: best?.finalized ?? false,
    blockTime: best?.blockTime ?? null,
    checked: candidates.length,
  };
}

function toRawLoose(ui: string, decimals: number): bigint {
  const m = String(ui).trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new DevtoolsInputError("amount must be a positive decimal number");
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").slice(0, decimals).padEnd(decimals, "0") || "0");
}

// ── External transaction preview ─────────────────────────────────────────

export interface DecodedIx {
  index: number;
  programId: string;
  programName: string | null;
  type: string | null;
  accounts: string[];
  /** Human summary for well-known instructions. */
  summary: string | null;
}

const u64 = (data: Uint8Array, offset: number) => (data.length >= offset + 8 ? Buffer.from(data).readBigUInt64LE(offset) : null);

/** Names System / Token / ATA / Compute Budget instructions; anything else is left for the IDL. */
export function decodeInstruction(index: number, programId: string, accounts: string[], data: Uint8Array): DecodedIx {
  const base = { index, programId, programName: programName(programId), accounts };
  const short = (a?: string) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "?");
  if (programId === SYSTEM_PROGRAM && data.length >= 4) {
    const kind = Buffer.from(data).readUInt32LE(0);
    const names: Record<number, string> = { 0: "createAccount", 1: "assign", 2: "transfer", 3: "createAccountWithSeed", 8: "allocate", 11: "transferWithSeed" };
    const type = names[kind] ?? `system#${kind}`;
    if (kind === 2) {
      const lamports = u64(data, 4) ?? 0n;
      return { ...base, type, summary: `send ${Number(lamports) / LAMPORTS_PER_SOL} SOL ${short(accounts[0])} → ${short(accounts[1])}` };
    }
    if (kind === 1) return { ...base, type, summary: `reassign ${short(accounts[0])} to another program` };
    return { ...base, type, summary: null };
  }
  if ((programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) && data.length >= 1) {
    const names: Record<number, string> = {
      1: "initializeAccount", 3: "transfer", 4: "approve", 5: "revoke", 6: "setAuthority", 7: "mintTo", 8: "burn",
      9: "closeAccount", 10: "freezeAccount", 11: "thawAccount", 12: "transferChecked", 13: "approveChecked", 18: "initializeAccount3",
    };
    const type = names[data[0]] ?? `token#${data[0]}`;
    const amount = u64(data, 1);
    const summaries: Record<string, string> = {
      transfer: `move ${amount} base units from ${short(accounts[0])} (owner ${short(accounts[2])})`,
      transferChecked: `move ${amount} base units of ${short(accounts[1])} from ${short(accounts[0])} (owner ${short(accounts[3])})`,
      approve: `let ${short(accounts[1])} spend ${amount} base units from ${short(accounts[0])}`,
      approveChecked: `let ${short(accounts[2])} spend ${amount} base units from ${short(accounts[0])}`,
      setAuthority: `change an authority on ${short(accounts[0])}`,
      closeAccount: `close token account ${short(accounts[0])}, rent to ${short(accounts[1])}`,
    };
    return { ...base, type, summary: summaries[type] ?? null };
  }
  if (programId === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL") {
    return { ...base, type: data[0] === 1 ? "createIdempotent" : "create", summary: `create token account for ${short(accounts[2])}` };
  }
  if (programId === "ComputeBudget111111111111111111111111111111") {
    const type = { 2: "setComputeUnitLimit", 3: "setComputeUnitPrice" }[data[0]] ?? null;
    return { ...base, type, summary: null };
  }
  return { ...base, type: null, summary: null };
}

/** What in these instructions could hurt `agent` beyond the balance changes simulation shows. */
export function riskFindings(ixs: DecodedIx[], agent: string, otherSigners: string[]): Finding[] {
  const out: Finding[] = [];
  for (const ix of ixs) {
    const a = ix.accounts;
    if (ix.type === "approve" && a[2] === agent) out.push({ severity: "high", code: "delegate", message: `Instruction ${ix.index} lets ${a[1]} spend your tokens later, after this transaction` });
    if (ix.type === "approveChecked" && a[3] === agent) out.push({ severity: "high", code: "delegate", message: `Instruction ${ix.index} lets ${a[2]} spend your tokens later, after this transaction` });
    if (ix.type === "setAuthority" && a[1] === agent) out.push({ severity: "high", code: "authority", message: `Instruction ${ix.index} hands an authority you hold on ${a[0]} to someone else` });
    if (ix.type === "assign" && a[0] === agent) out.push({ severity: "high", code: "assign", message: `Instruction ${ix.index} reassigns your wallet to another program — you'd lose control of it` });
    if (!KNOWN_PROGRAMS[ix.programId] && !ix.programName) out.push({ severity: "medium", code: "unknown-program", message: `Instruction ${ix.index} calls ${ix.programId}, which this preview can't decode — fetch its IDL (solana_fetch_idl)` });
  }
  if (otherSigners.length) out.push({ severity: "info", code: "co-signers", message: `Also needs signatures from ${otherSigners.join(", ")}` });
  // One finding per code+message.
  return sortFindings([...new Map(out.map((f) => [`${f.code}:${f.message}`, f])).values()]);
}

/** SPL token account layout: mint (32) · owner (32) · amount u64 (8). */
export function readTokenAccount(data: Uint8Array): { mint: string; owner: string; amount: bigint } | null {
  if (data.length < 72) return null;
  return { mint: new PublicKey(data.slice(0, 32)).toBase58(), owner: new PublicKey(data.slice(32, 64)).toBase58(), amount: Buffer.from(data).readBigUInt64LE(64) };
}

export function parseBase64Tx(base64: string): VersionedTransaction {
  const bytes = Buffer.from(String(base64 ?? "").trim(), "base64");
  if (bytes.length < 64 || bytes.length > 1232) throw new DevtoolsInputError("transaction must be a base64-encoded serialized transaction (≤1232 bytes)");
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch (err) {
    throw new DevtoolsInputError(`Couldn't decode the transaction: ${(err as Error).message}`);
  }
}

export interface TxPreview {
  version: "legacy" | 0;
  feePayer: string;
  requiredSigners: string[];
  agentMustSign: boolean;
  instructions: DecodedIx[];
  simulation: { success: boolean; err: unknown; unitsConsumed: number | null; logs: string[] };
  /** What this transaction does to the agent's wallet. */
  forAgent: { solDelta: number; tokens: { mint: string; tokenAccount: string; delta: string; decimals: number }[] };
  /** Every writable account whose SOL balance changes. */
  solChanges: { account: string; deltaSol: number }[];
  findings: Finding[];
  verdict: "high-risk" | "caution" | "no-red-flags";
}

/**
 * Decodes and simulates a serialized transaction as-is (no signing), then
 * reports what it does to `agent`: SOL and token balance changes, risky
 * instructions, and anything it couldn't decode.
 */
export async function previewExternalTx(conn: Connection, tx: VersionedTransaction, agent: string): Promise<TxPreview> {
  const msg = tx.message;
  const lookups: AddressLookupTableAccount[] = [];
  for (const l of msg.addressTableLookups) {
    const table = (await conn.getAddressLookupTable(l.accountKey)).value;
    if (!table) throw new DevtoolsInputError(`Address lookup table ${l.accountKey.toBase58()} not found on this cluster`);
    lookups.push(table);
  }
  const keys = msg.getAccountKeys({ addressLookupTableAccounts: lookups });
  const all = [...keys.staticAccountKeys, ...(keys.accountKeysFromLookups?.writable ?? []), ...(keys.accountKeysFromLookups?.readonly ?? [])].map((k) => k.toBase58());
  const required = all.slice(0, msg.header.numRequiredSignatures);
  const writable = all.filter((_, i) => msg.isAccountWritable(i)).slice(0, 40);

  const instructions = msg.compiledInstructions.map((ix, i) =>
    decodeInstruction(i, all[ix.programIdIndex], ix.accountKeyIndexes.map((k) => all[k]), ix.data));

  const pre = await conn.getMultipleAccountsInfo(writable.map((a) => new PublicKey(a)));
  const sim = await conn.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true,
    accounts: { encoding: "base64", addresses: writable },
  });

  const solChanges: TxPreview["solChanges"] = [];
  const tokens: TxPreview["forAgent"]["tokens"] = [];
  const mintsToRead = new Set<string>();
  const tokenMoves: { account: string; mint: string; delta: bigint }[] = [];
  writable.forEach((account, i) => {
    const before = pre[i];
    const after = sim.value.accounts?.[i];
    const deltaLamports = (after?.lamports ?? 0) - (before?.lamports ?? 0);
    if (sim.value.err == null && deltaLamports !== 0) solChanges.push({ account, deltaSol: deltaLamports / LAMPORTS_PER_SOL });
    const beforeTok = before ? readTokenAccount(before.data) : null;
    const afterTok = after ? readTokenAccount(Buffer.from(after.data[0], "base64")) : null;
    const owner = afterTok?.owner ?? beforeTok?.owner;
    const mint = afterTok?.mint ?? beforeTok?.mint;
    if (owner === agent && mint) {
      const delta = (afterTok?.amount ?? 0n) - (beforeTok?.amount ?? 0n);
      if (delta !== 0n) { tokenMoves.push({ account, mint, delta }); mintsToRead.add(mint); }
    }
  });
  if (tokenMoves.length) {
    const mints = [...mintsToRead];
    const infos = await conn.getMultipleParsedAccounts(mints.map((m) => new PublicKey(m)));
    const decimals = new Map(mints.map((m, i) => [m, Number((infos.value[i]?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed?.info?.decimals ?? 0)]));
    for (const t of tokenMoves) {
      const d = decimals.get(t.mint) ?? 0;
      tokens.push({ mint: t.mint, tokenAccount: t.account, delta: `${t.delta > 0n ? "+" : ""}${toUi(t.delta.toString(), d)}`, decimals: d });
    }
  }

  const agentMustSign = required.includes(agent);
  const findings = riskFindings(instructions, agent, required.filter((s) => s !== agent));
  if (sim.value.err) findings.unshift({ severity: "high", code: "sim-failed", message: `Simulation failed: ${JSON.stringify(sim.value.err)} — it would fail on-chain too` });
  if (!agentMustSign) findings.push({ severity: "info", code: "not-signer", message: "Your wallet isn't a required signer of this transaction" });
  const solOut = solChanges.find((c) => c.account === agent)?.deltaSol ?? 0;
  if (solOut < -0.5) findings.push({ severity: "medium", code: "sol-out", message: `Your wallet loses ${(-solOut).toFixed(4)} SOL` });
  sortFindings(findings);

  return {
    version: msg.version === 0 ? 0 : "legacy",
    feePayer: all[0],
    requiredSigners: required,
    agentMustSign,
    instructions,
    simulation: { success: !sim.value.err, err: sim.value.err ?? null, unitsConsumed: sim.value.unitsConsumed ?? null, logs: (sim.value.logs ?? []).slice(-60) },
    forAgent: { solDelta: solOut, tokens },
    solChanges,
    findings,
    verdict: findings.some((f) => f.severity === "high") ? "high-risk" : findings.some((f) => f.severity === "medium") ? "caution" : "no-red-flags",
  };
}

/**
 * Why the agent must not sign this previewed transaction, or null. Never
 * signs one that fails or hands over the wallet; other high-risk findings
 * need an explicit acceptRisks; SOL out is capped by the owner's limit.
 */
export function externalSignRefusal(preview: TxPreview, maxTransferSol: number | null, acceptRisks: boolean): string | null {
  if (!preview.agentMustSign) return "The agent's dev wallet isn't a required signer of this transaction";
  const hard = preview.findings.find((f) => f.code === "sim-failed" || f.code === "assign");
  if (hard) return hard.message;
  const high = preview.findings.filter((f) => f.severity === "high");
  if (high.length && !acceptRisks) return `High-risk transaction: ${high.map((f) => f.message).join("; ")}. Pass acceptRisks: true only if you meant this.`;
  const out = -preview.forAgent.solDelta;
  if (maxTransferSol != null && out > maxTransferSol) return `It takes ${out} SOL from the wallet, over the owner's ${maxTransferSol} SOL limit`;
  return null;
}
