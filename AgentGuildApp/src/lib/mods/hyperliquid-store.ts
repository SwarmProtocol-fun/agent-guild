/**
 * Hyperliquid Mod — Firestore persistence.
 *
 * Collections:
 *   hyperliquidRiskConfig  — per-agent leverage/position/loss limits
 *   hyperliquidTrades      — trade log used for history + PnL stats
 *   hyperliquidStrategies  — DCA/grid/signal/sniper strategy definitions
 *   hyperliquidWallets     — per-agent encrypted Hyperliquid private key
 *   hyperliquidSniperState — per-network "known coins" baseline for new-listing sniping
 *   hyperliquidReferrals   — per-agent referral attribution + accrued reward
 *   hyperliquidInstant     — per-agent opt-in to passphrase-free (custodial) trading
 *   hyperliquidStrategies/{id}/decisions — AI Trader decision log (reasoning + action)
 *   hyperliquidAiRequests  — AI Trader decision requests waiting for the agent's own model to answer
 *   hyperliquidPaperAccounts  — per-agent paper balance (virtual USDC) and today's realized PnL
 *   hyperliquidPaperPositions — open paper positions, one doc per agent × coin
 *   hyperliquidPaperOrders    — resting paper limit orders, filled by the tick
 *   hyperliquidPaperTrades    — every paper fill, the paper trade history
 *
 * Server-only (Firebase Admin SDK) — mirrors the pattern in
 * `@/lib/gateway/store.ts`. Only import from the mod's server.ts / API routes.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import type { OpenPair, PairsParams } from "../../../mods/hyperliquid-trading/pairs";
import type { BreakoutParams } from "../../../mods/hyperliquid-trading/breakout";
import type { SmartDcaParams } from "../../../mods/hyperliquid-trading/smart-dca";
import type { BasisParams, OpenBasis } from "../../../mods/hyperliquid-trading/basis";
import {
  PAPER_START_BALANCE,
  bookOrder,
  bookSpot,
  spotValue,
  type SpotHolding,
  type SpotOrder,
  type BookedOrder,
  type CoinMeta,
  paperPerformance,
  type PaperOrder,
  type PaperPerformance,
  type PaperPosition,
} from "../../../mods/hyperliquid-trading/paper";

const RISK_CONFIG = "hyperliquidRiskConfig";
const TRADES = "hyperliquidTrades";
const STRATEGIES = "hyperliquidStrategies";
const WALLETS = "hyperliquidWallets";
const SNIPER_STATE = "hyperliquidSniperState";
const REFERRALS = "hyperliquidReferrals";
const INSTANT = "hyperliquidInstant";
const DECISIONS = "decisions"; // subcollection of each AI strategy
const AI_REQUESTS = "hyperliquidAiRequests";
const PAPER_ACCOUNTS = "hyperliquidPaperAccounts";
const PAPER_POSITIONS = "hyperliquidPaperPositions";
const PAPER_ORDERS = "hyperliquidPaperOrders";
const PAPER_TRADES = "hyperliquidPaperTrades";
const BOT_FILLS = "hyperliquidBotFills";

function db() {
  return adminDb();
}

// ── Wallet (per-agent, zero-knowledge) ──────────────────────────────────────
//
// Each agent brings its own Hyperliquid wallet — there is no shared
// platform-level trading key. The private key is encrypted with a passphrase
// only the agent holds (via @/lib/secrets' encryptValue/decryptValue); the
// passphrase itself is never stored, only supplied transiently on each call
// that needs to sign a trade. This means the server can decrypt a key only
// while handling a request that includes the passphrase — there is no path
// that lets the platform (or anyone else) trade on an agent's behalf without
// it, which is also why DCA/grid strategies can only ever reach a "pending"
// state automatically (see Strategy.pendingSignal below) — actually placing
// that trade still needs the agent to show up with its passphrase.
// The one exception is an agent its org owner has switched to instant
// trading (see InstantTrading below).

export interface AgentWallet {
  agentId: string;
  orgId: string;
  encryptedValue: string;
  iv: string;
  network: "testnet" | "mainnet";
  /** The wallet's 0x address, when known — never key material. Absent on wallets saved before it was recorded. */
  address?: string;
  updatedAt: Date | null;
}

export async function getAgentWallet(agentId: string): Promise<AgentWallet | null> {
  const snap = await db().collection(WALLETS).doc(agentId).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  return {
    agentId,
    orgId: data.orgId,
    encryptedValue: data.encryptedValue,
    iv: data.iv,
    network: data.network ?? "testnet",
    ...(data.address ? { address: data.address } : {}),
    updatedAt: data.updatedAt?.toDate() ?? null,
  };
}

export async function setAgentWallet(
  agentId: string,
  data: { orgId: string; encryptedValue: string; iv: string; network: "testnet" | "mainnet"; address?: string },
): Promise<void> {
  await db().collection(WALLETS).doc(agentId).set({
    ...data,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function deleteAgentWallet(agentId: string): Promise<void> {
  await db().collection(WALLETS).doc(agentId).delete();
}

// ── Instant trading (opt-in, custodial) ─────────────────────────────────────
//
// An org owner can opt an agent out of the passphrase model: trades are then
// signed with one of the agent's platform-held EVM wallets (lib/agent-wallets,
// encrypted under AGENT_WALLET_ENCRYPTION_KEY), so orders, the agent's own API
// calls, and DCA/grid/sniper strategies fire with no passphrase in the loop.
// This record holds only which wallet to use — never key material. Deleting
// it puts the agent straight back on the passphrase model.

export interface InstantTrading {
  agentId: string;
  orgId: string;
  /** agentWallets doc id of the EVM wallet trades are signed with. */
  walletId: string;
  address: string;
  network: "testnet" | "mainnet";
  enabledBy: string;
  enabledAt: Date | null;
}

export async function getInstantTrading(agentId: string): Promise<InstantTrading | null> {
  const snap = await db().collection(INSTANT).doc(agentId).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  return {
    agentId,
    orgId: data.orgId,
    walletId: data.walletId,
    address: data.address,
    network: data.network ?? "testnet",
    enabledBy: data.enabledBy,
    enabledAt: data.enabledAt?.toDate() ?? null,
  };
}

export async function setInstantTrading(
  agentId: string,
  data: { orgId: string; walletId: string; address: string; network: "testnet" | "mainnet"; enabledBy: string },
): Promise<void> {
  await db().collection(INSTANT).doc(agentId).set({ ...data, enabledAt: FieldValue.serverTimestamp() });
}

export async function deleteInstantTrading(agentId: string): Promise<void> {
  await db().collection(INSTANT).doc(agentId).delete();
}

// ── Risk config ──────────────────────────────────────────────────────────────

export interface RiskConfig {
  agentId: string;
  orgId: string;
  leverage: number;
  maxPositionUsd: number;
  maxDailyLossUsd: number;
  defaultStopLossPct?: number;
  defaultTakeProfitPct?: number;
  updatedAt: Date | null;
}

export async function getRiskConfig(agentId: string): Promise<RiskConfig | null> {
  const snap = await db().collection(RISK_CONFIG).doc(agentId).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  return {
    agentId,
    orgId: data.orgId,
    leverage: data.leverage,
    maxPositionUsd: data.maxPositionUsd,
    maxDailyLossUsd: data.maxDailyLossUsd,
    defaultStopLossPct: data.defaultStopLossPct,
    defaultTakeProfitPct: data.defaultTakeProfitPct,
    updatedAt: data.updatedAt?.toDate() ?? null,
  };
}

export async function setRiskConfig(
  agentId: string,
  data: Omit<RiskConfig, "agentId" | "updatedAt">,
): Promise<void> {
  await db().collection(RISK_CONFIG).doc(agentId).set({
    ...data,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

// ── Trade history ────────────────────────────────────────────────────────────

export type TradeStatus = "opened" | "closed";

export interface TradeRecord {
  id: string;
  orgId: string;
  agentId: string;
  taskId: string;
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  orderType: string;
  fillPrice?: number;
  realizedPnl?: number;
  status: TradeStatus;
  /** The bot that placed it; null for a manual trade. */
  strategyId?: string | null;
  createdAt: Date | null;
}

export async function recordTrade(
  data: Omit<TradeRecord, "id" | "createdAt">,
): Promise<string> {
  const ref = await db().collection(TRADES).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

function docToTrade(d: FirebaseFirestore.QueryDocumentSnapshot): TradeRecord {
  const data = d.data();
  return {
    id: d.id,
    orgId: data.orgId,
    agentId: data.agentId,
    taskId: data.taskId,
    coin: data.coin,
    isBuy: data.isBuy,
    sizeUsd: data.sizeUsd,
    orderType: data.orderType,
    fillPrice: data.fillPrice,
    realizedPnl: data.realizedPnl,
    status: data.status,
    strategyId: data.strategyId ?? null,
    createdAt: data.createdAt?.toDate() ?? null,
  };
}

export interface TradeHistory {
  trades: TradeRecord[];
  stats: { totalPnl: number; winRate: number; count: number };
}

export async function getTradeHistory(agentId: string, limit = 100): Promise<TradeHistory> {
  const snap = await db().collection(TRADES)
    .where("agentId", "==", agentId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  const trades = snap.docs.map(docToTrade);

  const closed = trades.filter((t) => t.status === "closed" && t.realizedPnl != null);
  const totalPnl = closed.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0);
  const wins = closed.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  const winRate = closed.length > 0 ? wins / closed.length : 0;

  return { trades, stats: { totalPnl, winRate, count: closed.length } };
}

/** Sum of today's realized PnL — used to enforce a daily-loss limit. */
export async function getDailyRealizedPnl(agentId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const snap = await db().collection(TRADES)
    .where("agentId", "==", agentId)
    .where("status", "==", "closed")
    .where("createdAt", ">=", startOfDay)
    .get();

  return snap.docs.reduce((sum, d) => sum + (d.data().realizedPnl ?? 0), 0);
}

// ── Strategies ───────────────────────────────────────────────────────────────

export type StrategyType = "dca" | "grid" | "signal" | "sniper" | "ai" | "pairs" | "breakout" | "basis";

/** Rule bots buy by default; "short" makes them sell where they would have bought. */
export type BotDirection = "long" | "short";

/**
 * Shared by the rule bots (dca/grid/sniper): which way they trade and the
 * stop loss / take profit every order they place carries.
 */
export interface RuleBotExtras { direction?: BotDirection; stopLossPct?: number; takeProfitPct?: number }

/** smart turns on accumulation acceleration (mods/hyperliquid-trading/smart-dca.ts). */
export interface DcaParams extends RuleBotExtras { intervalMs: number; smart?: SmartDcaParams | null }
export interface GridParams extends RuleBotExtras { lowerPrice: number; upperPrice: number; levels: number; visitedLevels?: number[] }
export interface SignalParams { direction?: "buy" | "sell" }
/**
 * "new-listing" watches for any coin that wasn't in Hyperliquid's tradeable
 * universe on the previous tick (coin="ANY") or a specific coin landing
 * (coin=<symbol>, firing only if that exact symbol is the new one).
 * "price-above"/"price-below" watches `coin`'s mid price against targetPrice.
 * Every mode auto-disarms (enabled:false) after firing once — a sniper is a
 * one-shot "wait for it, then buy" trigger, not a recurring strategy.
 */
export interface SniperParams extends RuleBotExtras { mode: "new-listing" | "price-above" | "price-below"; targetPrice?: number }
/**
 * "AI Trader": every intervalMs the hub posts a market snapshot as a
 * decision request (AiRequest) and the agent's *own* model — run by its
 * daemon on its own machine, never platform inference — answers
 * LONG/SHORT/CLOSE/NOTHING (mods/hyperliquid-trading/ai-trader-core.ts).
 * openRequestId is the round currently waiting on the agent.
 * startEquity is captured on the first round; once equity falls
 * maxDrawdownPct below it the bot is stopped for good (eliminated).
 * flipTo is set when a flip's close has been sent and the new side still
 * has to open — the tick opens it once the close has filled.
 * goal is the operator's training idea, quoted into every decision prompt.
 * A basket bot sets coins (a fixed watchlist) or scanTop (each round, the N
 * most-traded perps plus the coins it holds) instead of trading only
 * Strategy.coin, and can act on several coins per round — pair legs, funding
 * carry. Its live flips wait per coin in flips, like flipTo.
 */
export interface AiParams {
  intervalMs: number;
  openRequestId?: string | null;
  maxDrawdownPct: number;
  leverage?: number;
  startEquity?: number;
  eliminated?: boolean;
  flipTo?: "long" | "short" | null;
  goal?: string;
  coins?: string[];
  scanTop?: number;
  flips?: Record<string, "long" | "short">;
  /** The coins a scanTop bot holds positions in — kept when they drop out of the top N, never claimed by another bot. */
  owned?: string[];
}

/**
 * "pairs": rule-based statistical arbitrage (mods/hyperliquid-trading/pairs.ts).
 * open is the pair the bot holds; lastZ/lastNote are the latest evaluation,
 * shown in the panel without logging every quiet round.
 */
export type StoredPairsParams = PairsParams & { open?: OpenPair | null; lastZ?: number | null; lastNote?: string | null };

/** "breakout": squeeze breakout rules (mods/hyperliquid-trading/breakout.ts). lastNote is the latest evaluation. */
export type StoredBreakoutParams = BreakoutParams & { lastNote?: string | null };

/** "basis": spot-perp cash and carry (mods/hyperliquid-trading/basis.ts), paper only. open is the carry the bot holds. */
export type StoredBasisParams = BasisParams & { open?: OpenBasis | null; lastNote?: string | null; lastAprPct?: number | null };

export interface Strategy {
  id: string;
  orgId: string;
  agentId: string;
  wallet: string;
  type: StrategyType;
  coin: string;
  sizeUsd: number;
  enabled: boolean;
  params: DcaParams | GridParams | SignalParams | SniperParams | AiParams | StoredPairsParams | StoredBreakoutParams | StoredBasisParams | Record<string, unknown>;
  lastRunAt: Date | null;
  createdAt: Date | null;
  /** Set by the tick evaluator when a dca/grid/sniper trigger condition is
   *  met — the agent still has to call POST /strategy/:id/execute-pending
   *  with its own passphrase to actually place the trade (see the wallet
   *  note above). */
  pendingSignal: boolean;
  pendingSince: Date | null;
  /** Snapshot of whatever the tick evaluator needs at execute time (e.g. the
   *  grid level reached, or the coin a new-listing sniper actually caught),
   *  captured when pendingSignal was set so execution doesn't re-derive it
   *  from a price/universe that's since moved. */
  pendingContext: Record<string, unknown> | null;
  /**
   * Random token gating the public POST /webhook/:id route (e.g. a
   * TradingView alert) — only ever set on "signal" strategies. Unlike the
   * agent's wallet passphrase, this isn't secret-grade (it doesn't decrypt
   * anything) — it just scopes who can push this one strategy to "pending",
   * same trust level as a Stripe/GitHub webhook signing secret.
   */
  webhookToken: string | null;
  /** Trades the agent's paper account instead of its wallet — no signer needed, so it always runs itself. */
  paper: boolean;
}

function docToStrategy(d: FirebaseFirestore.QueryDocumentSnapshot): Strategy {
  const data = d.data();
  return {
    id: d.id,
    orgId: data.orgId,
    agentId: data.agentId,
    wallet: data.wallet,
    type: data.type,
    coin: data.coin,
    sizeUsd: data.sizeUsd,
    enabled: data.enabled,
    params: data.params ?? {},
    lastRunAt: data.lastRunAt?.toDate() ?? null,
    createdAt: data.createdAt?.toDate() ?? null,
    pendingSignal: data.pendingSignal ?? false,
    pendingSince: data.pendingSince?.toDate() ?? null,
    pendingContext: data.pendingContext ?? null,
    webhookToken: data.webhookToken ?? null,
    paper: data.paper === true,
  };
}

export async function createStrategy(
  data: Omit<Strategy, "id" | "lastRunAt" | "createdAt" | "pendingSignal" | "pendingSince" | "pendingContext" | "webhookToken">,
): Promise<string> {
  const ref = await db().collection(STRATEGIES).add({
    ...data,
    lastRunAt: null,
    createdAt: FieldValue.serverTimestamp(),
    pendingSignal: false,
    pendingSince: null,
    pendingContext: null,
    webhookToken: null,
  });
  return ref.id;
}

/** Issue (or rotate) the webhook token gating POST /webhook/:id for a "signal" strategy. */
export async function setStrategyWebhookToken(id: string, token: string | null): Promise<void> {
  await db().collection(STRATEGIES).doc(id).update({ webhookToken: token });
}

/** Looks up a strategy by its webhook token — used by the public POST /webhook/:id route. */
export async function getStrategyByWebhookToken(id: string, token: string): Promise<Strategy | null> {
  const strategy = await getStrategy(id);
  if (!strategy || !strategy.webhookToken || strategy.webhookToken !== token) return null;
  return strategy;
}

export async function toggleStrategy(id: string, enabled: boolean): Promise<void> {
  await db().collection(STRATEGIES).doc(id).update({ enabled });
}

/** An operator's edit: new settings (runtime state already merged in by the caller) and/or order size. */
export async function updateStrategy(id: string, patch: { sizeUsd?: number; params?: Strategy["params"] }): Promise<void> {
  await db().collection(STRATEGIES).doc(id).update({
    ...(patch.sizeUsd !== undefined ? { sizeUsd: patch.sizeUsd } : {}),
    ...(patch.params !== undefined ? { params: patch.params } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/** Deletes a bot and its AI decision log. Positions it opened are not touched. */
export async function deleteStrategy(id: string): Promise<void> {
  await db().recursiveDelete(db().collection(STRATEGIES).doc(id));
}

/**
 * Emergency stop: every listed bot off, any signal waiting to execute
 * dropped, in one batch so a tick between writes can't pick one back up.
 */
export async function stopStrategies(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 400) {
    const batch = db().batch();
    for (const id of ids.slice(i, i + 400)) {
      batch.update(db().collection(STRATEGIES).doc(id), {
        enabled: false, pendingSignal: false, pendingSince: null, pendingContext: null, stoppedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
}

export async function touchStrategyRun(id: string, params?: Strategy["params"]): Promise<void> {
  await db().collection(STRATEGIES).doc(id).update({
    lastRunAt: FieldValue.serverTimestamp(),
    ...(params ? { params } : {}),
  });
}

/** Tick evaluator: mark a dca/grid strategy as ready for the agent to execute. */
export async function markStrategyPending(id: string, context: Record<string, unknown>): Promise<void> {
  await db().collection(STRATEGIES).doc(id).update({
    pendingSignal: true,
    pendingSince: FieldValue.serverTimestamp(),
    pendingContext: context,
  });
}

/** Called after the agent executes (or explicitly dismisses) a pending signal. */
export async function clearStrategyPending(id: string, params?: Strategy["params"]): Promise<void> {
  await db().collection(STRATEGIES).doc(id).update({
    pendingSignal: false,
    pendingSince: null,
    pendingContext: null,
    lastRunAt: FieldValue.serverTimestamp(),
    ...(params ? { params } : {}),
  });
}

/** All of an agent's strategies that are ready for it to execute. */
export async function getPendingStrategies(agentId: string): Promise<Strategy[]> {
  const snap = await db().collection(STRATEGIES)
    .where("agentId", "==", agentId)
    .where("pendingSignal", "==", true)
    .get();
  return snap.docs.map(docToStrategy);
}

export async function getStrategy(id: string): Promise<Strategy | null> {
  const snap = await db().collection(STRATEGIES).doc(id).get();
  if (!snap.exists) return null;
  return docToStrategy(snap as unknown as FirebaseFirestore.QueryDocumentSnapshot);
}

export async function getStrategies(agentId: string): Promise<Strategy[]> {
  const snap = await db().collection(STRATEGIES).where("agentId", "==", agentId).get();
  return snap.docs.map(docToStrategy);
}

/** All enabled strategies across every org — used by the tick evaluator. */
export async function getEnabledStrategies(): Promise<Strategy[]> {
  const snap = await db().collection(STRATEGIES).where("enabled", "==", true).get();
  return snap.docs.map(docToStrategy);
}

// ── AI Trader decisions ──────────────────────────────────────────────────────

export interface AiDecisionRecord {
  id: string;
  /** The coin acted on — set by basket bots, whose rounds can touch several. */
  coin?: string | null;
  decision: "LONG" | "SHORT" | "CLOSE" | "NOTHING" | null;
  action: string;
  reasoning: string;
  model: string | null;
  price: number | null;
  equity: number | null;
  taskId: string | null;
  error: string | null;
  createdAt: Date | null;
}

export async function recordAiDecision(
  strategyId: string,
  data: Omit<AiDecisionRecord, "id" | "createdAt">,
): Promise<string> {
  const ref = await db().collection(STRATEGIES).doc(strategyId).collection(DECISIONS).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getAiDecisions(strategyId: string, limit = 50): Promise<AiDecisionRecord[]> {
  const snap = await db().collection(STRATEGIES).doc(strategyId).collection(DECISIONS)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      coin: data.coin ?? null,
      decision: data.decision ?? null,
      action: data.action,
      reasoning: data.reasoning ?? "",
      model: data.model ?? null,
      price: data.price ?? null,
      equity: data.equity ?? null,
      taskId: data.taskId ?? null,
      error: data.error ?? null,
      createdAt: data.createdAt?.toDate() ?? null,
    };
  });
}

export type AiDecisionWord = "LONG" | "SHORT" | "CLOSE" | "NOTHING";

/**
 * One question for an agent's own model: the system + user prompt built from
 * a market snapshot. "live" requests belong to an AI Trader bot and are
 * executed when answered; "backtest" requests come from the panel's
 * backtester and only report the answer back.
 */
export interface AiRequest {
  id: string;
  agentId: string;
  orgId: string;
  purpose: "live" | "backtest";
  strategyId: string | null;
  coin: string;
  /** A basket round's coins; null for a single-coin round. */
  coins: string[] | null;
  system: string;
  prompt: string;
  status: "open" | "answered" | "expired";
  decision: AiDecisionWord | null;
  reasoning: string | null;
  createdAt: Date | null;
  expiresAt: Date;
}

function docToAiRequest(d: FirebaseFirestore.DocumentSnapshot): AiRequest {
  const data = d.data() ?? {};
  return {
    id: d.id,
    agentId: data.agentId,
    orgId: data.orgId,
    purpose: data.purpose,
    strategyId: data.strategyId ?? null,
    coin: data.coin,
    coins: Array.isArray(data.coins) ? data.coins : null,
    system: data.system,
    prompt: data.prompt,
    status: data.status,
    decision: data.decision ?? null,
    reasoning: data.reasoning ?? null,
    createdAt: data.createdAt?.toDate() ?? null,
    expiresAt: data.expiresAt?.toDate() ?? new Date(0),
  };
}

export async function createAiRequest(
  data: Pick<AiRequest, "agentId" | "orgId" | "purpose" | "strategyId" | "coin" | "system" | "prompt" | "expiresAt"> & { coins?: string[] | null },
): Promise<string> {
  const ref = await db().collection(AI_REQUESTS).add({
    ...data,
    status: "open",
    decision: null,
    reasoning: null,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getAiRequest(id: string): Promise<AiRequest | null> {
  const snap = await db().collection(AI_REQUESTS).doc(id).get();
  return snap.exists ? docToAiRequest(snap) : null;
}

/** An agent's unanswered, unexpired requests, oldest first. */
export async function listOpenAiRequests(agentId: string): Promise<AiRequest[]> {
  const snap = await db().collection(AI_REQUESTS)
    .where("agentId", "==", agentId)
    .where("status", "==", "open")
    .get();
  const now = Date.now();
  return snap.docs
    .map(docToAiRequest)
    .filter((r) => r.expiresAt.getTime() > now)
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
}

/**
 * Records the agent's answer — once. Returns the request as it was when
 * answered, or null if it was already answered, expired, or past its deadline
 * (a late answer must never trade on a stale snapshot).
 */
export async function answerAiRequest(id: string, decision: AiDecisionWord, reasoning: string): Promise<AiRequest | null> {
  const ref = db().collection(AI_REQUESTS).doc(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const req = docToAiRequest(snap);
    if (req.status !== "open" || req.expiresAt.getTime() <= Date.now()) return null;
    tx.update(ref, { status: "answered", decision, reasoning, answeredAt: FieldValue.serverTimestamp() });
    return { ...req, status: "answered" as const, decision, reasoning };
  });
}

export async function expireAiRequest(id: string): Promise<void> {
  await db().collection(AI_REQUESTS).doc(id).update({ status: "expired" });
}

// ── Sniper state ─────────────────────────────────────────────────────────────
//
// One doc per network holding the last-seen set of tradeable coins, so the
// tick evaluator can tell a genuinely new listing apart from the entire
// existing universe (which would otherwise look "new" the first time any
// new-listing sniper ever runs).

export async function getKnownCoins(network: string): Promise<string[] | null> {
  const snap = await db().collection(SNIPER_STATE).doc(network).get();
  if (!snap.exists) return null;
  return (snap.data()!.coins as string[] | undefined) ?? [];
}

export async function setKnownCoins(network: string, coins: string[]): Promise<void> {
  await db().collection(SNIPER_STATE).doc(network).set({ coins, updatedAt: FieldValue.serverTimestamp() });
}

// ── Referrals ────────────────────────────────────────────────────────────────
//
// An agent's referral "code" is just its own agentId — no separate vanity
// code generation. Doc id == agentId. referredBy is set at most once per
// agent (first code applied wins); accrueReferralReward credits whoever
// referred `agentId` with a cut of `agentId`'s trading volume.

/** Reward credited to a referrer, in basis points of the referred agent's trade size. */
export const REFERRAL_REWARD_BPS = 5;

export interface Referral {
  agentId: string;
  orgId: string;
  referredBy: string | null;
  referredCount: number;
  totalVolumeUsd: number;
  rewardUsd: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

function docToReferral(agentId: string, data: FirebaseFirestore.DocumentData): Referral {
  return {
    agentId,
    orgId: data.orgId ?? "",
    referredBy: data.referredBy ?? null,
    referredCount: data.referredCount ?? 0,
    totalVolumeUsd: data.totalVolumeUsd ?? 0,
    rewardUsd: data.rewardUsd ?? 0,
    createdAt: data.createdAt?.toDate() ?? null,
    updatedAt: data.updatedAt?.toDate() ?? null,
  };
}

export async function getReferral(agentId: string): Promise<Referral | null> {
  const snap = await db().collection(REFERRALS).doc(agentId).get();
  if (!snap.exists) return null;
  return docToReferral(agentId, snap.data()!);
}

/** Creates an agent's referral doc if it doesn't exist yet — safe to call repeatedly. */
export async function ensureReferral(agentId: string, orgId: string): Promise<Referral> {
  const ref = db().collection(REFERRALS).doc(agentId);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      orgId, referredBy: null, referredCount: 0, totalVolumeUsd: 0, rewardUsd: 0,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    return (await ref.get()).data() as unknown as Referral;
  }
  return docToReferral(agentId, snap.data()!);
}

/**
 * Attributes `agentId` to `referralCode` (the referrer's agentId), one time
 * only. The referrer doesn't need a pre-existing referral doc — applying a
 * code lazily creates one for them via `set(..., {merge:true})`. The
 * check-then-write runs inside a transaction so two concurrent calls can't
 * both pass the "not already applied" check before either writes.
 */
export async function applyReferralCode(
  agentId: string, orgId: string, referralCode: string,
): Promise<{ ok: true } | { error: string }> {
  const referrerAgentId = referralCode.trim();
  if (!referrerAgentId) return { error: "referralCode is required" };
  if (referrerAgentId === agentId) return { error: "Cannot refer yourself" };

  await ensureReferral(agentId, orgId);
  const refDoc = db().collection(REFERRALS).doc(agentId);
  const referrerDoc = db().collection(REFERRALS).doc(referrerAgentId);

  return db().runTransaction(async (tx) => {
    const existing = (await tx.get(refDoc)).data();
    if (existing?.referredBy) return { error: "This agent has already applied a referral code" };

    tx.update(refDoc, { referredBy: referrerAgentId, updatedAt: FieldValue.serverTimestamp() });
    tx.set(
      referrerDoc,
      { referredCount: FieldValue.increment(1), totalVolumeUsd: FieldValue.increment(0), rewardUsd: FieldValue.increment(0), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { ok: true };
  });
}

/** Called from POST /settle-trade when a new position is opened — credits the referrer, if any. */
export async function accrueReferralReward(agentId: string, sizeUsd: number): Promise<void> {
  const snap = await db().collection(REFERRALS).doc(agentId).get();
  const referredBy = snap.exists ? (snap.data()!.referredBy as string | null) : null;
  if (!referredBy) return;

  await db().collection(REFERRALS).doc(referredBy).set(
    {
      totalVolumeUsd: FieldValue.increment(sizeUsd),
      rewardUsd: FieldValue.increment(sizeUsd * (REFERRAL_REWARD_BPS / 10000)),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

// ── Paper trading ───────────────────────────────────────────────────────────
//
// A virtual-USDC account per agent, filled against the real mainnet book (see
// mods/hyperliquid-trading/paper.ts). Separate collections from the live
// trade log, so paper results never count toward a live daily-loss limit.

export interface PaperAccount {
  agentId: string;
  orgId: string;
  balance: number;
  startBalance: number;
  /** Today's (UTC) realized PnL net of fees and funding — the paper daily-loss check. */
  dailyPnl: number;
  /** When the account was last reset; null if never. Performance stats start here. */
  resetAt?: Date | null;
  /** Spot holdings by token (the basis bot's long legs). */
  spot: Record<string, SpotHolding>;
}

function docToSpot(raw: unknown): Record<string, SpotHolding> {
  const out: Record<string, SpotHolding> = {};
  for (const [token, h] of Object.entries((raw ?? {}) as Record<string, Record<string, unknown>>)) {
    const sz = Number(h?.sz);
    if (sz > 0) out[token] = { pair: String(h.pair), token, sz, avgPx: Number(h.avgPx) };
  }
  return out;
}

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function docToPaperAccount(agentId: string, data: FirebaseFirestore.DocumentData): PaperAccount {
  return {
    agentId,
    orgId: data.orgId,
    balance: Number(data.balance ?? 0),
    startBalance: Number(data.startBalance ?? PAPER_START_BALANCE),
    dailyPnl: data.dailyPnlDay === utcDay() ? Number(data.dailyPnl ?? 0) : 0,
    resetAt: data.resetAt?.toDate?.() ?? null,
    spot: docToSpot(data.spot),
  };
}

/** The agent's paper account, opened with PAPER_START_BALANCE on first use. */
export async function getPaperAccount(agentId: string, orgId: string): Promise<PaperAccount> {
  const ref = db().collection(PAPER_ACCOUNTS).doc(agentId);
  const snap = await ref.get();
  if (snap.exists) return docToPaperAccount(agentId, snap.data()!);
  const fresh = { orgId, balance: PAPER_START_BALANCE, startBalance: PAPER_START_BALANCE, dailyPnl: 0, dailyPnlDay: utcDay(), createdAt: FieldValue.serverTimestamp() };
  await ref.set(fresh);
  return docToPaperAccount(agentId, fresh);
}

/** Back to a clean account: fresh balance, positions and resting orders gone (trade history is kept). */
export async function resetPaperAccount(agentId: string, orgId: string, startBalance = PAPER_START_BALANCE): Promise<void> {
  const [positions, orders] = await Promise.all([
    db().collection(PAPER_POSITIONS).where("agentId", "==", agentId).get(),
    db().collection(PAPER_ORDERS).where("agentId", "==", agentId).get(),
  ]);
  const batch = db().batch();
  positions.docs.forEach((d) => batch.delete(d.ref));
  orders.docs.forEach((d) => batch.delete(d.ref));
  batch.set(db().collection(PAPER_ACCOUNTS).doc(agentId), {
    orgId, balance: startBalance, startBalance, dailyPnl: 0, dailyPnlDay: utcDay(), resetAt: FieldValue.serverTimestamp(),
    spot: FieldValue.delete(),
  }, { merge: true });
  await batch.commit();
}

export interface PaperPositionDoc extends PaperPosition {
  id: string;
  agentId: string;
  orgId: string;
  fundingPaid: number;
  lastFundingAt: Date | null;
}

function paperPositionId(agentId: string, coin: string): string {
  return `${agentId}_${coin}`;
}

function docToPaperPosition(d: FirebaseFirestore.DocumentSnapshot): PaperPositionDoc {
  const x = d.data()!;
  return {
    id: d.id, agentId: x.agentId, orgId: x.orgId, coin: x.coin, szi: Number(x.szi), entryPx: Number(x.entryPx),
    leverage: Number(x.leverage ?? 1), slPx: x.slPx ?? null, tpPx: x.tpPx ?? null, trailPct: x.trailPct ?? null,
    fundingPaid: Number(x.fundingPaid ?? 0), lastFundingAt: x.lastFundingAt?.toDate?.() ?? null,
  };
}

export async function listPaperPositions(agentId: string): Promise<PaperPositionDoc[]> {
  const snap = await db().collection(PAPER_POSITIONS).where("agentId", "==", agentId).get();
  return snap.docs.map(docToPaperPosition);
}

/** Every open paper position across all agents — the tick's TP/SL, funding and liquidation work list. */
export async function listAllPaperPositions(): Promise<PaperPositionDoc[]> {
  const snap = await db().collection(PAPER_POSITIONS).get();
  return snap.docs.map(docToPaperPosition);
}

export interface PaperRestingOrder {
  id: string;
  agentId: string;
  orgId: string;
  coin: string;
  isBuy: boolean;
  sz: number;
  limitPx: number;
  leverage: number;
  reduceOnly: boolean;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  trailingStopPct?: number | null;
  strategyId: string | null;
  createdAt: Date | null;
}

function docToPaperOrder(d: FirebaseFirestore.DocumentSnapshot): PaperRestingOrder {
  const x = d.data()!;
  return {
    id: d.id, agentId: x.agentId, orgId: x.orgId, coin: x.coin, isBuy: x.isBuy, sz: Number(x.sz), limitPx: Number(x.limitPx),
    leverage: Number(x.leverage ?? 1), reduceOnly: !!x.reduceOnly, stopLossPct: x.stopLossPct ?? null, takeProfitPct: x.takeProfitPct ?? null,
    trailingStopPct: x.trailingStopPct ?? null, strategyId: x.strategyId ?? null, createdAt: x.createdAt?.toDate?.() ?? null,
  };
}

export async function createPaperOrder(data: Omit<PaperRestingOrder, "id" | "createdAt">): Promise<string> {
  const ref = await db().collection(PAPER_ORDERS).add({ ...data, createdAt: FieldValue.serverTimestamp() });
  return ref.id;
}

export async function getPaperOrder(id: string): Promise<PaperRestingOrder | null> {
  const snap = await db().collection(PAPER_ORDERS).doc(id).get();
  return snap.exists ? docToPaperOrder(snap) : null;
}

export async function listPaperOrders(agentId: string): Promise<PaperRestingOrder[]> {
  const snap = await db().collection(PAPER_ORDERS).where("agentId", "==", agentId).get();
  return snap.docs.map(docToPaperOrder).sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
}

export async function listAllPaperOrders(): Promise<PaperRestingOrder[]> {
  const snap = await db().collection(PAPER_ORDERS).get();
  return snap.docs.map(docToPaperOrder);
}

export async function deletePaperOrder(id: string): Promise<void> {
  await db().collection(PAPER_ORDERS).doc(id).delete();
}

export type PaperTradeReason = "manual" | "limit" | "sl" | "tp" | "liquidation" | "strategy";

export interface PaperTradeRecord {
  id: string;
  agentId: string;
  coin: string;
  isBuy: boolean;
  sz: number;
  px: number;
  sizeUsd: number;
  fee: number;
  realizedPnl: number;
  reduceOnly: boolean;
  reason: PaperTradeReason;
  strategyId: string | null;
  /** "spot" for a spot fill (coin is then the spot token, e.g. UBTC). */
  market: "perp" | "spot";
  createdAt: Date | null;
}

export interface PaperFillContext {
  orgId: string;
  reason: PaperTradeReason;
  strategyId?: string | null;
  /** A resting order being filled: claimed in the same transaction, so a fill can never happen twice. */
  restingOrderId?: string;
  /** Spot mids by pair, to value spot holdings in the margin check (cost basis when absent). */
  spotMids?: Record<string, number>;
}

/**
 * Books one paper fill: balance, position, today's PnL and the trade record
 * move together in one transaction that re-reads the account and every
 * position, so racing orders can't spend the same margin twice.
 */
export async function bookPaperFill(
  agentId: string,
  order: PaperOrder,
  marks: Record<string, number>,
  meta: Record<string, CoinMeta>,
  ctx: PaperFillContext,
): Promise<(BookedOrder & { tradeId: string }) | { error: string }> {
  const accountRef = db().collection(PAPER_ACCOUNTS).doc(agentId);
  const posRef = db().collection(PAPER_POSITIONS).doc(paperPositionId(agentId, order.coin));
  const restingRef = ctx.restingOrderId ? db().collection(PAPER_ORDERS).doc(ctx.restingOrderId) : null;
  const tradeRef = db().collection(PAPER_TRADES).doc();
  return db().runTransaction(async (tx) => {
    const [accSnap, posSnap, restingSnap] = await Promise.all([
      tx.get(accountRef),
      tx.get(db().collection(PAPER_POSITIONS).where("agentId", "==", agentId)),
      restingRef ? tx.get(restingRef) : Promise.resolve(null),
    ]);
    if (restingRef && !restingSnap?.exists) return { error: "Order is no longer open" };
    const account = accSnap.exists
      ? docToPaperAccount(agentId, accSnap.data()!)
      : { agentId, orgId: ctx.orgId, balance: PAPER_START_BALANCE, startBalance: PAPER_START_BALANCE, dailyPnl: 0, spot: {} };
    const positions = posSnap.docs.map(docToPaperPosition);
    const booked = bookOrder(account.balance, positions, order, marks, meta, spotValue(account.spot, ctx.spotMids ?? {}));
    if ("error" in booked) return booked;

    const prev = positions.find((p) => p.coin === order.coin);
    if (booked.position) {
      tx.set(posRef, {
        agentId, orgId: ctx.orgId, ...booked.position,
        fundingPaid: prev?.fundingPaid ?? 0,
        lastFundingAt: prev?.lastFundingAt ?? FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else if (prev) {
      tx.delete(posRef);
    }
    tx.set(accountRef, {
      orgId: account.orgId ?? ctx.orgId,
      balance: booked.balance,
      startBalance: account.startBalance,
      dailyPnl: account.dailyPnl + booked.realized - booked.fee,
      dailyPnlDay: utcDay(),
    }, { merge: true });
    tx.set(tradeRef, {
      agentId, orgId: ctx.orgId, coin: order.coin, isBuy: order.isBuy, sz: booked.sz, px: order.px,
      sizeUsd: booked.sz * order.px, fee: booked.fee, realizedPnl: booked.realized, reduceOnly: order.reduceOnly,
      reason: ctx.reason, strategyId: ctx.strategyId ?? null, market: "perp", createdAt: FieldValue.serverTimestamp(),
    });
    if (restingRef) tx.delete(restingRef);
    return { ...booked, tradeId: tradeRef.id };
  });
}

/**
 * Books one paper spot fill (buy with free cash, or sell from holdings) in a
 * transaction with the account, like bookPaperFill. Recorded in the paper
 * trade log as market "spot", coin = the spot token.
 */
export async function bookPaperSpotFill(
  agentId: string,
  order: SpotOrder,
  marks: Record<string, number>,
  meta: Record<string, CoinMeta>,
  ctx: PaperFillContext,
): Promise<{ balance: number; sz: number; fee: number; realized: number; tradeId: string } | { error: string }> {
  const accountRef = db().collection(PAPER_ACCOUNTS).doc(agentId);
  const tradeRef = db().collection(PAPER_TRADES).doc();
  return db().runTransaction(async (tx) => {
    const [accSnap, posSnap] = await Promise.all([
      tx.get(accountRef),
      tx.get(db().collection(PAPER_POSITIONS).where("agentId", "==", agentId)),
    ]);
    const account = accSnap.exists
      ? docToPaperAccount(agentId, accSnap.data()!)
      : { agentId, orgId: ctx.orgId, balance: PAPER_START_BALANCE, startBalance: PAPER_START_BALANCE, dailyPnl: 0, spot: {} as Record<string, SpotHolding> };
    const booked = bookSpot(account.balance, posSnap.docs.map(docToPaperPosition), account.spot, order, marks, meta);
    if ("error" in booked) return booked;
    const spot = { ...account.spot };
    if (booked.holding) spot[order.token] = booked.holding;
    else delete spot[order.token];
    tx.set(accountRef, {
      orgId: account.orgId ?? ctx.orgId,
      balance: booked.balance,
      startBalance: account.startBalance,
      dailyPnl: account.dailyPnl + booked.realized - booked.fee,
      dailyPnlDay: utcDay(),
      spot,
    }, { merge: true });
    tx.set(tradeRef, {
      agentId, orgId: ctx.orgId, coin: order.token, pair: order.pair, isBuy: order.isBuy, sz: booked.sz, px: order.px,
      sizeUsd: booked.sz * order.px, fee: booked.fee, realizedPnl: booked.realized, reduceOnly: !order.isBuy,
      reason: ctx.reason, strategyId: ctx.strategyId ?? null, market: "spot", createdAt: FieldValue.serverTimestamp(),
    });
    return { balance: booked.balance, sz: booked.sz, fee: booked.fee, realized: booked.realized, tradeId: tradeRef.id };
  });
}

/** Moves a trailing stop. Only ever tightens, re-checked in the transaction so a racing fill or a looser value can't undo it. */
export async function updatePaperTrailingStop(agentId: string, coin: string, slPx: number): Promise<void> {
  const posRef = db().collection(PAPER_POSITIONS).doc(paperPositionId(agentId, coin));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(posRef);
    if (!snap.exists) return;
    const x = snap.data()!;
    if (!x.trailPct) return;
    const isLong = Number(x.szi) > 0;
    if (x.slPx != null && (isLong ? slPx <= x.slPx : slPx >= x.slPx)) return;
    tx.update(posRef, { slPx, updatedAt: FieldValue.serverTimestamp() });
  });
}

/** Credits (or charges) accrued funding on one position and moves its funding clock forward. */
export async function applyPaperFunding(agentId: string, coin: string, amount: number, at: Date): Promise<void> {
  const accountRef = db().collection(PAPER_ACCOUNTS).doc(agentId);
  const posRef = db().collection(PAPER_POSITIONS).doc(paperPositionId(agentId, coin));
  await db().runTransaction(async (tx) => {
    const [accSnap, posSnap] = await Promise.all([tx.get(accountRef), tx.get(posRef)]);
    if (!accSnap.exists || !posSnap.exists) return;
    const account = docToPaperAccount(agentId, accSnap.data()!);
    tx.update(accountRef, { balance: account.balance + amount, dailyPnl: account.dailyPnl + amount, dailyPnlDay: utcDay() });
    tx.update(posRef, { fundingPaid: Number(posSnap.data()!.fundingPaid ?? 0) - amount, lastFundingAt: at });
  });
}

export interface PaperTradeHistory {
  trades: PaperTradeRecord[];
  stats: { totalPnl: number; fees: number; winRate: number; count: number };
  /** Since the last reset (or the first fill), over the fills returned. */
  performance: PaperPerformance;
}

/**
 * The agent's latest paper fills, newest first, with stats. `since` (the
 * account's last reset) bounds the stats so an old wiped run doesn't count;
 * the curve starts from `startBalance`.
 */
export async function getPaperTradeHistory(
  agentId: string,
  limit = 200,
  opts: { since?: Date | null; startBalance?: number } = {},
): Promise<PaperTradeHistory> {
  const snap = await db().collection(PAPER_TRADES)
    .where("agentId", "==", agentId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  const trades: PaperTradeRecord[] = snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id, agentId: x.agentId, coin: x.coin, isBuy: x.isBuy, sz: Number(x.sz), px: Number(x.px), sizeUsd: Number(x.sizeUsd),
      fee: Number(x.fee ?? 0), realizedPnl: Number(x.realizedPnl ?? 0), reduceOnly: !!x.reduceOnly, reason: x.reason ?? "manual",
      strategyId: x.strategyId ?? null, market: x.market === "spot" ? "spot" : "perp", createdAt: x.createdAt?.toDate?.() ?? null,
    };
  });
  const since = opts.since?.getTime() ?? 0;
  const run = trades.filter((t) => (t.createdAt?.getTime() ?? Date.now()) >= since);
  const performance = paperPerformance(
    run.map((t) => ({ realizedPnl: t.realizedPnl, fee: t.fee, at: t.createdAt?.getTime() ?? null })),
    opts.startBalance ?? PAPER_START_BALANCE,
  );
  return {
    trades,
    stats: { totalPnl: performance.netPnl, fees: performance.fees, winRate: performance.winRate, count: performance.closed },
    performance,
  };
}

// ── Leaderboard reads ───────────────────────────────────────────────────────

/** Every bot in an org, any agent, running or not. */
export async function listOrgStrategies(orgId: string): Promise<Strategy[]> {
  const snap = await db().collection(STRATEGIES).where("orgId", "==", orgId).get();
  return snap.docs.map(docToStrategy);
}

/** Every agent's paper account in an org, with its open positions. */
export async function listOrgPaperAccounts(orgId: string): Promise<{ accounts: PaperAccount[]; positions: PaperPositionDoc[] }> {
  const [accounts, positions] = await Promise.all([
    db().collection(PAPER_ACCOUNTS).where("orgId", "==", orgId).get(),
    db().collection(PAPER_POSITIONS).where("orgId", "==", orgId).get(),
  ]);
  return {
    accounts: accounts.docs.map((d) => docToPaperAccount(d.id, d.data())),
    positions: positions.docs.map(docToPaperPosition),
  };
}

/** The org's latest paper fills, newest first — the leaderboard's per-bot results. */
export async function listOrgPaperFills(orgId: string, limit = 2000): Promise<{ strategyId: string | null; realizedPnl: number; fee: number; at: number | null }[]> {
  const snap = await db().collection(PAPER_TRADES)
    .where("orgId", "==", orgId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => {
    const x = d.data();
    return { strategyId: x.strategyId ?? null, realizedPnl: Number(x.realizedPnl ?? 0), fee: Number(x.fee ?? 0), at: x.createdAt?.toDate?.().getTime() ?? null };
  });
}

// ── Live bot fills ──────────────────────────────────────────────────────────
//
// Every live order a bot places, with the bot's id — so the leaderboard can
// rank live bots by their own results, apart from their agent's manual
// trades. Logged "pending" when the order is sent; the strategy tick settles
// it from the finished gateway task (fill price, size, realized PnL). The fee
// is estimated at the taker rate, since a fill status doesn't carry it.

export interface BotFill {
  id: string;
  orgId: string;
  agentId: string;
  strategyId: string;
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  reduceOnly: boolean;
  network: string;
  taskId: string;
  status: "pending" | "filled" | "failed";
  sz: number;
  px: number;
  fee: number;
  realizedPnl: number;
  createdAt: Date | null;
}

export async function logBotOrder(order: Pick<BotFill, "orgId" | "agentId" | "strategyId" | "coin" | "isBuy" | "sizeUsd" | "reduceOnly" | "network" | "taskId">): Promise<void> {
  await db().collection(BOT_FILLS).add({ ...order, status: "pending", sz: 0, px: 0, fee: 0, realizedPnl: 0, createdAt: FieldValue.serverTimestamp() });
}

/** Bot orders still waiting on their task — the tick's settle list. */
export async function listPendingBotOrders(limit = 200): Promise<BotFill[]> {
  const snap = await db().collection(BOT_FILLS).where("status", "==", "pending").limit(limit).get();
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id, orgId: x.orgId, agentId: x.agentId, strategyId: x.strategyId, coin: x.coin, isBuy: !!x.isBuy, sizeUsd: Number(x.sizeUsd ?? 0),
      reduceOnly: !!x.reduceOnly, network: x.network, taskId: x.taskId, status: x.status, sz: Number(x.sz ?? 0), px: Number(x.px ?? 0),
      fee: Number(x.fee ?? 0), realizedPnl: Number(x.realizedPnl ?? 0), createdAt: x.createdAt?.toDate?.() ?? null,
    };
  });
}

export async function settleBotOrder(id: string, outcome: { status: "filled"; sz: number; px: number; fee: number; realizedPnl: number } | { status: "failed" }): Promise<void> {
  await db().collection(BOT_FILLS).doc(id).update({ ...outcome, settledAt: FieldValue.serverTimestamp() });
}

/** The org's latest settled live bot fills, newest first. */
export async function listOrgBotFills(orgId: string, limit = 2000): Promise<{ strategyId: string | null; realizedPnl: number; fee: number; at: number | null }[]> {
  const snap = await db().collection(BOT_FILLS)
    .where("orgId", "==", orgId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.filter((d) => d.data().status === "filled").map((d) => {
    const x = d.data();
    return { strategyId: x.strategyId ?? null, realizedPnl: Number(x.realizedPnl ?? 0), fee: Number(x.fee ?? 0), at: x.createdAt?.toDate?.().getTime() ?? null };
  });
}
