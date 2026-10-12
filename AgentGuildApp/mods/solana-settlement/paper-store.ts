/**
 * Firestore persistence for Solana paper trading and agent policies. Admin
 * SDK only — the rules deny browsers every one of these collections.
 *
 *   solanaPaperWallets/{agentId}     balances, cost basis, P&L, today's volume
 *   solanaPaperTrades/{reverseTs-*}  fills, newest first by doc id
 *   solanaAgentPolicies/{agentId}    the owner's limits for this agent
 *
 * A trade re-reads the wallet and policy inside a transaction, so two
 * concurrent swaps can't spend the same balance or both squeeze under the
 * daily limit.
 */
import { adminDb } from "@/lib/firebase-admin";
import {
  DEFAULT_POLICY, PaperTradeError, applyPaperSwap, newPaperWallet, tradePolicyViolation,
  type AgentPolicy, type PaperFill, type PaperWallet,
} from "./paper";

const WALLETS = "solanaPaperWallets";
const TRADES = "solanaPaperTrades";
const POLICIES = "solanaAgentPolicies";
const ID_CEILING = 9_999_999_999_999;

interface WalletDoc extends PaperWallet {
  agentId: string;
  orgId: string;
  /** UTC day (YYYY-MM-DD) that volumeToday counts. */
  volumeDay: string;
  volumeToday: number;
  createdAt: string;
  resetAt?: string;
}

export interface PaperTradeRecord {
  id: string;
  agentId: string;
  orgId: string;
  at: string;
  inputMint: string;
  outputMint: string;
  inSymbol: string | null;
  outSymbol: string | null;
  inUi: string;
  outUi: string;
  usdValue: number;
  realizedUsd: number;
  priceImpactPct: number;
  route: string[];
  /** Why the agent made the trade, in its own words. */
  note: string | null;
}

const utcDay = (at = new Date()) => at.toISOString().slice(0, 10);
const tradeId = (at: number) => `${String(ID_CEILING - at).padStart(13, "0")}-${Math.random().toString(36).slice(2, 8)}`;

function freshWallet(agentId: string, orgId: string): WalletDoc {
  return { ...newPaperWallet(), agentId, orgId, volumeDay: utcDay(), volumeToday: 0, createdAt: new Date().toISOString() };
}

/** The agent's paper wallet; a new one (10k USDC) the first time it's read. */
export async function getPaperWallet(agentId: string, orgId: string): Promise<WalletDoc> {
  const ref = adminDb().collection(WALLETS).doc(agentId);
  const snap = await ref.get();
  const data = snap.data() as WalletDoc | undefined;
  if (data && data.orgId === orgId) return data;
  const wallet = freshWallet(agentId, orgId);
  await ref.set(wallet);
  return wallet;
}

export async function resetPaperWallet(agentId: string, orgId: string): Promise<WalletDoc> {
  const wallet = { ...freshWallet(agentId, orgId), resetAt: new Date().toISOString() };
  await adminDb().collection(WALLETS).doc(agentId).set(wallet);
  return wallet;
}

export async function listOrgPaperWallets(orgId: string): Promise<WalletDoc[]> {
  const snap = await adminDb().collection(WALLETS).where("orgId", "==", orgId).get();
  return snap.docs.map((d) => d.data() as WalletDoc);
}

export async function getPolicy(agentId: string, orgId: string): Promise<AgentPolicy> {
  const data = (await adminDb().collection(POLICIES).doc(agentId).get()).data() as (AgentPolicy & { orgId?: string }) | undefined;
  if (!data || data.orgId !== orgId) return { ...DEFAULT_POLICY };
  const { orgId: _o, updatedAt: _u, updatedBy: _b, ...policy } = data as AgentPolicy & Record<string, unknown>;
  return { ...DEFAULT_POLICY, ...policy } as AgentPolicy;
}

export async function setPolicy(agentId: string, orgId: string, policy: AgentPolicy, updatedBy: string): Promise<void> {
  await adminDb().collection(POLICIES).doc(agentId).set({ ...policy, orgId, updatedBy, updatedAt: new Date().toISOString() });
}

/**
 * Books one swap atomically: checks the owner's policy (with today's
 * volume) and the balance, then writes the wallet and the trade.
 */
export async function bookPaperTrade(
  agentId: string,
  orgId: string,
  fill: PaperFill,
  meta: Pick<PaperTradeRecord, "inSymbol" | "outSymbol" | "inUi" | "outUi" | "priceImpactPct" | "route" | "note">,
): Promise<{ trade: PaperTradeRecord; wallet: WalletDoc }> {
  const db = adminDb();
  const walletRef = db.collection(WALLETS).doc(agentId);
  const policyRef = db.collection(POLICIES).doc(agentId);
  const now = Date.now();
  const tradeRef = db.collection(TRADES).doc(tradeId(now));

  return db.runTransaction(async (tx) => {
    const [walletSnap, policySnap] = await Promise.all([tx.get(walletRef), tx.get(policyRef)]);
    const stored = walletSnap.data() as WalletDoc | undefined;
    const wallet = stored && stored.orgId === orgId ? stored : freshWallet(agentId, orgId);
    const rawPolicy = policySnap.data() as (AgentPolicy & { orgId?: string }) | undefined;
    const policy = rawPolicy && rawPolicy.orgId === orgId ? { ...DEFAULT_POLICY, ...rawPolicy } : DEFAULT_POLICY;

    const today = utcDay(new Date(now));
    const volumeToday = wallet.volumeDay === today ? wallet.volumeToday : 0;
    const violation = tradePolicyViolation(policy, { inputMint: fill.inputMint, outputMint: fill.outputMint, usdValue: fill.usdValue }, volumeToday);
    if (violation) throw new PaperTradeError(violation);

    const { wallet: next, realizedUsd } = applyPaperSwap(wallet, fill);
    const doc: WalletDoc = { ...wallet, ...next, volumeDay: today, volumeToday: volumeToday + fill.usdValue };
    const trade: PaperTradeRecord = {
      id: tradeRef.id, agentId, orgId, at: new Date(now).toISOString(),
      inputMint: fill.inputMint, outputMint: fill.outputMint, usdValue: fill.usdValue, realizedUsd, ...meta,
    };
    tx.set(walletRef, doc);
    tx.set(tradeRef, trade);
    return { trade, wallet: doc };
  });
}

export async function listPaperTrades(agentId: string, orgId: string, limit = 50): Promise<PaperTradeRecord[]> {
  const snap = await adminDb().collection(TRADES).where("agentId", "==", agentId).orderBy("__name__").limit(limit).get();
  return snap.docs.map((d) => d.data() as PaperTradeRecord).filter((t) => t.orgId === orgId);
}
