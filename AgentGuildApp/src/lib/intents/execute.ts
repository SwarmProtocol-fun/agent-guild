/**
 * Intent execution: check → reserve daily allowance → simulate → sign → send.
 *
 *   intentPolicies/{walletId}                              IntentPolicy
 *   intentUsage/{walletId}_{network}_{asset}_{yyyy-mm-dd}  { units: string }  (base units, bigint as string)
 *   intents/{id}                                           every submitted intent and its outcome
 *
 * The allowance is reserved in a transaction *before* signing (so two
 * concurrent intents can't both squeeze under the daily limit) and refunded
 * if anything fails before the transaction is broadcast. Once broadcast it
 * stays counted, even if the chain later reverts it.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { adminDb } from "@/lib/firebase-admin";
import { getChain, USDC_DECIMALS } from "@/lib/chains";
import { getAgentWalletKeypair, getAgentWalletEvmPrivateKey } from "@/lib/agent-wallets";
import { usdcMintAddress } from "@/lib/solana/lending-verify";
import { auditQuietly } from "@/lib/vault/store";
import {
  checkIntent, DEFAULT_INTENT_POLICY, toBaseUnits, type Asset, type CheckedIntent, type IntentPolicy,
} from "./policy";

export class IntentError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const db = () => adminDb();
const today = () => new Date().toISOString().slice(0, 10);
const usageId = (walletId: string, network: string, asset: Asset) => `${walletId}_${network}_${asset}_${today()}`;

export async function getIntentPolicy(walletId: string): Promise<IntentPolicy> {
  const snap = await db().collection("intentPolicies").doc(walletId).get();
  return { ...DEFAULT_INTENT_POLICY, ...(snap.data() as Partial<IntentPolicy> | undefined) };
}

export async function saveIntentPolicy(walletId: string, orgId: string, policy: IntentPolicy, by: string) {
  await db().collection("intentPolicies").doc(walletId).set({ ...policy, orgId, updatedBy: by, updatedAt: FieldValue.serverTimestamp() });
}

async function spent(walletId: string, network: string, asset: Asset): Promise<bigint> {
  const snap = await db().collection("intentUsage").doc(usageId(walletId, network, asset)).get();
  return snap.exists ? BigInt(snap.data()!.units || "0") : 0n;
}

/** Atomically add `units` to today's usage if it stays within `maxPerDay`. */
async function reserve(walletId: string, checked: CheckedIntent, policy: IntentPolicy): Promise<boolean> {
  if (checked.units === 0n) return true;
  const ref = db().collection("intentUsage").doc(usageId(walletId, checked.chainKey, checked.asset));
  const cap = toBaseUnits(policy.limits[checked.asset]?.maxPerDay ?? "0", checked.decimals) ?? 0n;
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = snap.exists ? BigInt(snap.data()!.units || "0") : 0n;
    if (used + checked.units > cap) return false;
    tx.set(ref, { units: (used + checked.units).toString(), walletId, expiresAt: Timestamp.fromMillis(Date.now() + 3 * 86_400_000) }, { merge: true });
    return true;
  });
}

async function refund(walletId: string, checked: CheckedIntent): Promise<void> {
  if (checked.units === 0n) return;
  const ref = db().collection("intentUsage").doc(usageId(walletId, checked.chainKey, checked.asset));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = snap.exists ? BigInt(snap.data()!.units || "0") : 0n;
    tx.set(ref, { units: (used > checked.units ? used - checked.units : 0n).toString() }, { merge: true });
  });
}

export interface IntentResult {
  intentId: string;
  /** "submitted" = broadcast but not confirmed within 45s; check the explorer. */
  status: "submitted" | "confirmed" | "reverted";
  txHash: string;
  explorerUrl: string;
}

export async function submitIntent(
  agent: { agentId: string; orgId: string },
  walletId: string,
  raw: Record<string, unknown>,
): Promise<IntentResult> {
  const walletSnap = await db().collection("agentWallets").doc(walletId).get();
  const wallet = walletSnap.data();
  if (!wallet || wallet.agentId !== agent.agentId || wallet.orgId !== agent.orgId) {
    throw new IntentError("Wallet not found for this agent", 404);
  }
  const walletChain: "solana" | "evm" = wallet.chain === "evm" ? "evm" : "solana";
  const policy = await getIntentPolicy(walletId);

  const network = String(raw.network || "");
  const [nativeSpent, usdcSpent] = getChain(network)
    ? await Promise.all([spent(walletId, network, "native"), spent(walletId, network, "usdc")])
    : [0n, 0n];
  const checked = checkIntent(raw, walletChain, policy, (asset) => (asset === "usdc" ? usdcSpent : nativeSpent));

  const intentRef = db().collection("intents").doc();
  const base = { orgId: agent.orgId, agentId: agent.agentId, walletId, createdAt: FieldValue.serverTimestamp() };

  if (!checked.ok) {
    await intentRef.set({ ...base, request: sanitizeRaw(raw), status: "rejected", error: checked.error });
    auditQuietly({ orgId: agent.orgId, action: "intent.rejected", actorType: "agent", actorId: agent.agentId, target: walletId, detail: { reason: checked.error.slice(0, 200) } });
    throw new IntentError(checked.error, 403);
  }
  const c = checked.value;

  if (!(await reserve(walletId, c, policy))) {
    throw new IntentError("Daily limit reached (another intent used the remaining allowance)", 429);
  }
  await intentRef.set({ ...base, request: c.intent, status: "simulating" });

  let sent: Broadcast;
  try {
    sent = walletChain === "solana"
      ? await sendSolana(agent, walletId, c)
      : await sendEvm(agent, walletId, c);
  } catch (err) {
    // Nothing was broadcast, so nothing moved: give the allowance back.
    await refund(walletId, c);
    const message = err instanceof Error ? err.message : String(err);
    const stage = message.startsWith("Simulation failed") ? "simulation_failed" : "failed";
    await intentRef.update({ status: stage, error: message.slice(0, 500) });
    auditQuietly({ orgId: agent.orgId, action: "intent.failed", actorType: "agent", actorId: agent.agentId, target: walletId, detail: { stage, error: message.slice(0, 200) } });
    throw new IntentError(message.slice(0, 500), 422);
  }

  // Broadcast happened: from here on the allowance stays spent, whatever the chain says.
  const txHash = sent.txHash;
  const chain = getChain(c.chainKey)!;
  const explorerUrl = chain.explorer.txUrl(txHash);
  await intentRef.update({ status: "submitted", txHash, explorerUrl, submittedAt: FieldValue.serverTimestamp() });
  const outcome = await Promise.race([
    sent.confirm().catch(() => "submitted" as const),
    new Promise<"submitted">((r) => setTimeout(() => r("submitted"), 45_000)),
  ]);
  if (outcome !== "submitted") await intentRef.update({ status: outcome });
  auditQuietly({
    orgId: agent.orgId, action: "intent.executed", actorType: "agent", actorId: agent.agentId, target: walletId,
    detail: { network: c.chainKey, type: c.intent.type, asset: c.asset, amount: c.intent.type === "transfer" ? c.intent.amount : (c.intent.value ?? "0"), to: c.intent.to, txHash },
  });
  return { intentId: intentRef.id, status: outcome, txHash, explorerUrl };
}

/** A broadcast transaction and a way to learn how it ended. */
interface Broadcast {
  txHash: string;
  confirm: () => Promise<"confirmed" | "reverted">;
}

/** What gets stored for a rejected request: known fields only, truncated. */
function sanitizeRaw(raw: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const k of ["type", "network", "asset", "to", "amount", "value", "memo"]) if (raw[k] != null) out[k] = String(raw[k]).slice(0, 120);
  if (raw.data) out.data = `${String(raw.data).slice(0, 10)}…`;
  return out;
}

// ─── Solana ────────────────────────────────────────────────────

async function sendSolana(agent: { agentId: string; orgId: string }, walletId: string, c: CheckedIntent): Promise<Broadcast> {
  if (c.intent.type !== "transfer") throw new Error("Only transfers are supported on Solana");
  const chain = getChain("solana")!;
  const connection = new Connection(chain.rpc, "confirmed");
  const keypair = await getAgentWalletKeypair(walletId, agent.orgId, agent.agentId);
  const to = new PublicKey(c.intent.to);

  const tx = new Transaction();
  if (c.asset === "native") {
    tx.add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: to, lamports: c.units }));
  } else {
    const mint = new PublicKey(usdcMintAddress());
    const fromAta = getAssociatedTokenAddressSync(mint, keypair.publicKey);
    const toAta = getAssociatedTokenAddressSync(mint, to, true);
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, toAta, to, mint),
      createTransferCheckedInstruction(fromAta, mint, toAta, keypair.publicKey, c.units, USDC_DECIMALS),
    );
  }
  if (c.intent.memo) {
    tx.add({ keys: [], programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), data: Buffer.from(c.intent.memo) });
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = keypair.publicKey;
  tx.sign(keypair);

  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}${sim.value.logs?.length ? ` — ${sim.value.logs.slice(-2).join(" | ")}` : ""}`);
  }
  const signature = await connection.sendRawTransaction(tx.serialize());
  return {
    txHash: signature,
    confirm: async () => {
      const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      return res.value.err ? "reverted" : "confirmed";
    },
  };
}

// ─── EVM ───────────────────────────────────────────────────────

async function sendEvm(agent: { agentId: string; orgId: string }, walletId: string, c: CheckedIntent): Promise<Broadcast> {
  const cfg = getChain(c.chainKey)!;
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.name,
    nativeCurrency: cfg.nativeCurrency,
    rpcUrls: { default: { http: [cfg.rpc] } },
  });
  const account = privateKeyToAccount(await getAgentWalletEvmPrivateKey(walletId, agent.orgId, agent.agentId));
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpc) });
  const walletClient = createWalletClient({ chain, account, transport: http(cfg.rpc) });

  let to: Hex;
  let data: Hex | undefined;
  let value = 0n;
  if (c.intent.type === "transfer" && c.asset === "native") {
    to = c.intent.to as Hex;
    value = c.units;
  } else if (c.intent.type === "transfer") {
    to = cfg.contracts.usdc as Hex;
    data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [c.intent.to as Hex, c.units] });
  } else {
    to = c.intent.to as Hex;
    data = c.intent.data as Hex;
    value = c.units;
  }

  try {
    await publicClient.call({ account, to, data, value });
  } catch (err) {
    throw new Error(`Simulation failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  const gas = await publicClient.estimateGas({ account, to, data, value });
  const hash = await walletClient.sendTransaction({ to, data, value, gas: (gas * 12n) / 10n });
  return {
    txHash: hash,
    confirm: async () => ((await publicClient.waitForTransactionReceipt({ hash, timeout: 45_000 })).status === "success" ? "confirmed" : "reverted"),
  };
}
