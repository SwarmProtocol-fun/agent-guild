/**
 * Paying an agent for an approved job — the core flow behind the job page's
 * "Pay agent" card. Three ways to pay, all ending in the same record
 * (job.payment + jobPayments/{jobId} + a "paid" audit event):
 *
 *   base-usdc    — the poster sends USDC on Base from their own wallet; we
 *                  find the Transfer log (sender → one of the agent's EVM
 *                  wallets, full amount) before recording it.
 *   solana-usdc  — the same on Solana, checked with the lending verifier
 *                  (recipient received it, sender's balance dropped).
 *   offplatform  — bank, PayPal, cash…: the poster records how and a
 *                  reference. Nothing to verify; it's on the audit trail.
 *
 * The server never holds or signs with the money, and never creates an
 * agent wallet — it pays into wallets the agent already has. A transfer can
 * back only one credit anywhere in the app (shared lendingOnChainTxs claim),
 * and a job can be paid once: here, or by the tempo/solana settlement mods,
 * which skip any job with a payment (isPayable) and vice versa.
 *
 *   JOB_PAYOUT_EVM_CHAIN    — "base" or "baseSepolia" (default)
 *   JOB_PAYOUT_EVM_RPC_URL  — optional; else the chain's public RPC
 *   Solana uses the lending cluster: SOLANA_CLUSTER / SOLANA_USDC_MINT / SOLANA_RPC_URL.
 *
 * Server-only.
 */
import { PublicKey } from "@solana/web3.js";
import { createPublicClient, erc20Abi, http, isAddress, isHash, parseEventLogs, parseUnits, formatUnits, type Hash } from "viem";
import { adminDb } from "@/lib/firebase-admin";
import { getChain, USDC_DECIMALS } from "@/lib/chains";
import { getAgent } from "@/lib/firestore-admin";
import { listAgentWallets } from "@/lib/agent-wallets";
import { isPayable, parseUsdReward } from "@/lib/job-payouts";
import { recordJobEvent } from "@/lib/job-audit";
import { JobActionError, type JobActor } from "@/lib/job-lifecycle";
import { getPayout } from "@/lib/mods/tempo-payouts-store";
import { hasSolanaSettlementClaim } from "@/lib/mods/solana-settlement-store";
import {
  claimUsdcTransferInTxn, explorerTxUrl as solanaExplorerTxUrl, lendingCluster, usdcMintAddress, verifyUsdcTransfer,
} from "@/lib/solana/lending-verify";
import type { Agent, Job, JobPayment, JobPaymentMethod } from "@/lib/firestore";

const PAYMENTS = "jobPayments";
/** Replay guard shared with lending: one on-chain transfer, one credit. */
const ONCHAIN_TX_COLLECTION = "lendingOnChainTxs";
/** Base blocks are ~2s; 10 confirmations is ~20s and well past reorg depth in practice. */
export const MIN_EVM_CONFIRMATIONS = 10;

export const METHOD_LABELS: Record<JobPaymentMethod, string> = {
  "base-usdc": "USDC on Base",
  "solana-usdc": "USDC on Solana",
  offplatform: "Off-platform",
};

export const OFFPLATFORM_CHANNELS = ["bank", "paypal", "card", "cash", "crypto", "other"] as const;
export type OffPlatformChannel = (typeof OFFPLATFORM_CHANNELS)[number];

// ── Chain config ─────────────────────────────────────────────────────────

type EvmPayoutChain = "base" | "baseSepolia";

export function jobPayoutEvmChain(): EvmPayoutChain {
  const raw = (process.env.JOB_PAYOUT_EVM_CHAIN || "baseSepolia").trim();
  if (raw !== "base" && raw !== "baseSepolia") throw new Error(`JOB_PAYOUT_EVM_CHAIN must be "base" or "baseSepolia" (got "${raw}")`);
  return raw;
}

function evmChain() {
  const key = jobPayoutEvmChain();
  const chain = getChain(key);
  const usdc = chain?.contracts.usdc;
  if (!chain || !usdc) throw new Error(`No USDC configured for ${key}`);
  return { key, chain, usdc: usdc.toLowerCase() as `0x${string}`, rpc: process.env.JOB_PAYOUT_EVM_RPC_URL || chain.rpc };
}

/** What the browser needs to send each on-chain payment. */
export function paymentRails() {
  const { chain, usdc, key } = evmChain();
  return {
    base: {
      chainKey: key,
      chainId: chain.chainId,
      name: chain.name,
      rpcUrl: chain.rpc,
      nativeCurrency: chain.nativeCurrency,
      explorerUrl: chain.explorer.baseUrl,
      usdc,
    },
    solana: { cluster: lendingCluster(), usdcMint: usdcMintAddress() },
  };
}

// ── Who can be paid, and where ───────────────────────────────────────────

export interface PayoutWallet { address: string; label: string }

function isSolanaAddress(a: string): boolean {
  try { new PublicKey(a); return true; } catch { return false; }
}

/** The agent's own wallets per chain: custodial wallets in this org, then the addresses on its profile. */
export async function agentPayoutWallets(agent: Agent, orgId: string): Promise<{ evm: PayoutWallet[]; solana: PayoutWallet[] }> {
  const custodial = (await listAgentWallets(agent.id)).filter((w) => w.orgId === orgId);
  const evm = new Map<string, PayoutWallet>();
  const solana = new Map<string, PayoutWallet>();
  for (const w of custodial) {
    if (w.chain === "evm") evm.set(w.publicKey.toLowerCase(), { address: w.publicKey, label: w.label || "Agent wallet" });
    else solana.set(w.publicKey, { address: w.publicKey, label: w.label || (w.payout ? "Payout wallet" : "Agent wallet") });
  }
  for (const a of [agent.ethAddress, agent.walletAddress]) {
    if (a && isAddress(a, { strict: false }) && !evm.has(a.toLowerCase())) evm.set(a.toLowerCase(), { address: a, label: "Profile address" });
  }
  if (agent.solanaAddress && isSolanaAddress(agent.solanaAddress) && !solana.has(agent.solanaAddress)) {
    solana.set(agent.solanaAddress, { address: agent.solanaAddress, label: "Identity address" });
  }
  return { evm: [...evm.values()], solana: [...solana.values()] };
}

/** Why this job can't be paid here, or null when it can. */
export async function unpayableReason(job: Job): Promise<string | null> {
  if (job.payment) return "This job is already paid";
  if (!job.takenByAgentId) return "No agent did this job";
  if (job.status !== "completed" || job.reviewStatus !== "approved") return "Approve the delivery before paying";
  if (!isPayable(job)) return "This job was paid through escrow or upfront";
  const [tempo, solana] = await Promise.all([
    getPayout({ kind: "job", jobId: job.id }),
    hasSolanaSettlementClaim(job.takenByAgentId, job.id),
  ]);
  if (tempo) return tempo.status === "paid" ? "Already paid with Tempo Payouts" : "A Tempo payment for this job is in progress";
  if (solana) return "Already paid (or being paid) by the Solana settlement mod";
  return null;
}

export async function paymentOptions(job: Job) {
  const reason = await unpayableReason(job);
  const agent = job.takenByAgentId ? await getAgent(job.takenByAgentId) : null;
  return {
    payable: reason === null,
    reason,
    payment: job.payment ?? null,
    suggestedUsdc: parseUsdReward(job.reward),
    agent: agent ? { id: agent.id, name: agent.name } : null,
    wallets: agent && reason === null ? await agentPayoutWallets(agent, job.orgId) : { evm: [], solana: [] },
    rails: paymentRails(),
    offplatformChannels: OFFPLATFORM_CHANNELS,
  };
}

// ── Verifying an on-chain payment ────────────────────────────────────────

export function checkAmount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new JobActionError("Amount must be a positive number", 400);
  if (Math.round(n * 1_000_000) / 1_000_000 !== n) throw new JobActionError("Amount has more than 6 decimals", 400);
  if (n > 1_000_000) throw new JobActionError("Amount is too large", 400);
  return n;
}

/** USDC on Base: a successful tx with Transfer log(s) from `from` to `to` totalling >= amount. Read-only. */
export async function verifyBaseUsdcTransfer(input: { txHash: string; from: string; to: string; amountUsdc: number }) {
  const hash = input.txHash.trim().toLowerCase();
  if (!isHash(hash)) throw new JobActionError("That doesn't look like a transaction hash (0x + 64 hex characters)", 400);
  if (!isAddress(input.from, { strict: false })) throw new JobActionError("Sender must be an EVM address", 400);
  const { chain, usdc, rpc } = evmChain();

  const claimed = await adminDb().collection(ONCHAIN_TX_COLLECTION).doc(hash).get();
  if (claimed.exists) throw new JobActionError("This transaction has already been used for another payment", 409);

  const client = createPublicClient({ transport: http(rpc) });
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: hash as Hash });
  } catch {
    throw new JobActionError("Transaction not found yet — wait a few seconds and retry", 409);
  }
  if (receipt.status !== "success") throw new JobActionError("Transaction reverted on-chain", 422);
  const latest = await client.getBlockNumber();
  if (latest - receipt.blockNumber + BigInt(1) < BigInt(MIN_EVM_CONFIRMATIONS)) {
    throw new JobActionError(`Waiting for ${MIN_EVM_CONFIRMATIONS} confirmations — retry in a few seconds`, 409);
  }

  const from = input.from.toLowerCase();
  const to = input.to.toLowerCase();
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })
    .filter((l) => l.address.toLowerCase() === usdc && l.args.from.toLowerCase() === from && l.args.to.toLowerCase() === to);
  const received = transfers.reduce((sum, l) => sum + l.args.value, BigInt(0));
  const required = parseUnits(String(input.amountUsdc), USDC_DECIMALS);
  if (received < required) {
    throw new JobActionError(
      transfers.length
        ? `Expected ${input.amountUsdc} USDC, the transaction sent ${formatUnits(received, USDC_DECIMALS)}`
        : `No USDC transfer from ${input.from} to ${input.to} in that transaction on ${chain.name}`,
      422,
    );
  }
  return { txSig: hash, explorerUrl: chain.explorer.txUrl(hash), received: Number(formatUnits(received, USDC_DECIMALS)) };
}

// ── Recording ────────────────────────────────────────────────────────────

type Claim = { kind: "solana"; txSig: string; from: string; to: string; amount: number } | { kind: "evm"; txSig: string; from: string; to: string; amount: number };

async function recordPayment(job: Job, payment: JobPayment, actor: JobActor, claim?: Claim): Promise<JobPayment> {
  const db = adminDb();
  const jobRef = db.collection("jobs").doc(job.id);
  await db.runTransaction(async (txn) => {
    const fresh = await txn.get(jobRef);
    if (!fresh.exists) throw new JobActionError("Job not found", 404);
    if ((fresh.data() as Job).payment) throw new JobActionError("This job is already paid", 409);
    if (claim?.kind === "solana") {
      claimUsdcTransferInTxn(txn, {
        txSig: claim.txSig, expectedFromWallet: claim.from, expectedToWallet: claim.to, expectedAmount: claim.amount,
        purpose: "job-payout", refId: job.id,
      });
    } else if (claim?.kind === "evm") {
      txn.create(db.collection(ONCHAIN_TX_COLLECTION).doc(claim.txSig), {
        purpose: "job-payout", refId: job.id, fromWallet: claim.from.toLowerCase(), toWallet: claim.to.toLowerCase(),
        amount: claim.amount, asset: "usdc", chain: jobPayoutEvmChain(), claimedAt: Date.now(),
      });
    }
    txn.create(db.collection(PAYMENTS).doc(job.id), { ...payment, jobId: job.id, orgId: job.orgId, agentId: job.takenByAgentId });
    txn.update(jobRef, { payment, updatedAt: Date.now() });
  });
  await recordJobEvent(job, "paid", actor, {
    details: {
      method: payment.method, methodLabel: payment.channel ? `${METHOD_LABELS.offplatform} (${payment.channel})` : METHOD_LABELS[payment.method],
      amountUsdc: payment.amountUsdc, to: payment.to, txSig: payment.txSig, reference: payment.reference,
    },
  });
  return payment;
}

async function assertPayable(job: Job): Promise<Agent> {
  const reason = await unpayableReason(job);
  if (reason) throw new JobActionError(reason, 409);
  const agent = await getAgent(job.takenByAgentId!);
  if (!agent) throw new JobActionError("The agent on this job no longer exists", 404);
  return agent;
}

/** Record a payment the poster already sent from their own wallet, after checking it on-chain. */
export async function payJobOnChain(
  job: Job,
  input: { method: "base-usdc" | "solana-usdc"; txSig: string; from: string; to: string; amountUsdc: unknown },
  actor: JobActor,
): Promise<JobPayment> {
  const agent = await assertPayable(job);
  const amount = checkAmount(input.amountUsdc);
  const wallets = await agentPayoutWallets(agent, job.orgId);
  const txSig = String(input.txSig ?? "").trim();
  const from = String(input.from ?? "").trim();
  const to = String(input.to ?? "").trim();
  if (!txSig) throw new JobActionError("Transaction is required", 400);
  if (!from) throw new JobActionError("Sender wallet is required", 400);

  if (input.method === "base-usdc") {
    if (!wallets.evm.some((w) => w.address.toLowerCase() === to.toLowerCase())) throw new JobActionError("Pay to one of the agent's own EVM wallets", 400);
    const v = await verifyBaseUsdcTransfer({ txHash: txSig, from, to, amountUsdc: amount });
    return recordPayment(job, {
      method: "base-usdc", amountUsdc: v.received, to, from, txSig: v.txSig, explorerUrl: v.explorerUrl, paidBy: actor.id, paidAt: Date.now(),
    }, actor, { kind: "evm", txSig: v.txSig, from, to, amount });
  }

  if (!wallets.solana.some((w) => w.address === to)) throw new JobActionError("Pay to one of the agent's own Solana wallets", 400);
  let received: number;
  try {
    ({ received } = await verifyUsdcTransfer({
      txSig, expectedFromWallet: from, expectedToWallet: to, expectedAmount: amount, purpose: "job-payout", refId: job.id,
    }));
  } catch (err) {
    throw new JobActionError((err as Error).message, 422);
  }
  return recordPayment(job, {
    method: "solana-usdc", amountUsdc: received, to, from, txSig, explorerUrl: solanaExplorerTxUrl(txSig), paidBy: actor.id, paidAt: Date.now(),
  }, actor, { kind: "solana", txSig, from, to, amount });
}

/** Record a payment made outside the platform (bank, PayPal, …). */
export async function markJobPaidOffPlatform(
  job: Job,
  input: { channel: unknown; reference?: unknown; note?: unknown; amountUsdc: unknown },
  actor: JobActor,
): Promise<JobPayment> {
  await assertPayable(job);
  const channel = String(input.channel ?? "") as OffPlatformChannel;
  if (!OFFPLATFORM_CHANNELS.includes(channel)) throw new JobActionError(`How it was paid must be one of: ${OFFPLATFORM_CHANNELS.join(", ")}`, 400);
  const reference = String(input.reference ?? "").trim().slice(0, 200);
  const note = String(input.note ?? "").trim().slice(0, 1000);
  return recordPayment(job, {
    method: "offplatform", amountUsdc: checkAmount(input.amountUsdc), channel,
    ...(reference ? { reference } : {}), ...(note ? { note } : {}),
    paidBy: actor.id, paidAt: Date.now(),
  }, actor);
}
