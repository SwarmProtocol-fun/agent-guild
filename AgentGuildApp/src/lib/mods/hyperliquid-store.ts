/**
 * Hyperliquid Mod — Firestore persistence.
 *
 * Collections:
 *   hyperliquidRiskConfig — per-agent leverage/position/loss limits
 *   hyperliquidTrades     — trade log used for history + PnL stats
 *   hyperliquidStrategies — DCA/grid/signal strategy definitions
 *   hyperliquidWallets    — per-agent encrypted Hyperliquid private key
 *
 * Server-only (Firebase Admin SDK) — mirrors the pattern in
 * `@/lib/gateway/store.ts`. Only import from the mod's server.ts / API routes.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

const RISK_CONFIG = "hyperliquidRiskConfig";
const TRADES = "hyperliquidTrades";
const STRATEGIES = "hyperliquidStrategies";
const WALLETS = "hyperliquidWallets";

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

export interface AgentWallet {
  agentId: string;
  orgId: string;
  encryptedValue: string;
  iv: string;
  network: "testnet" | "mainnet";
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
    updatedAt: data.updatedAt?.toDate() ?? null,
  };
}

export async function setAgentWallet(
  agentId: string,
  data: { orgId: string; encryptedValue: string; iv: string; network: "testnet" | "mainnet" },
): Promise<void> {
  await db().collection(WALLETS).doc(agentId).set({
    ...data,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function deleteAgentWallet(agentId: string): Promise<void> {
  await db().collection(WALLETS).doc(agentId).delete();
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

export type StrategyType = "dca" | "grid" | "signal";

export interface DcaParams { intervalMs: number }
export interface GridParams { lowerPrice: number; upperPrice: number; levels: number; visitedLevels?: number[] }
export interface SignalParams { direction?: "buy" | "sell" }

export interface Strategy {
  id: string;
  orgId: string;
  agentId: string;
  wallet: string;
  type: StrategyType;
  coin: string;
  sizeUsd: number;
  enabled: boolean;
  params: DcaParams | GridParams | SignalParams | Record<string, unknown>;
  lastRunAt: Date | null;
  createdAt: Date | null;
  /** Set by the tick evaluator when a dca/grid trigger condition is met — the
   *  agent still has to call POST /strategy/:id/execute-pending with its own
   *  passphrase to actually place the trade (see the wallet note above). */
  pendingSignal: boolean;
  pendingSince: Date | null;
  /** Snapshot of whatever the tick evaluator needs at execute time (e.g. the
   *  grid level reached), captured when pendingSignal was set so execution
   *  doesn't re-derive it from a price that's since moved. */
  pendingContext: Record<string, unknown> | null;
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
  };
}

export async function createStrategy(
  data: Omit<Strategy, "id" | "lastRunAt" | "createdAt" | "pendingSignal" | "pendingSince" | "pendingContext">,
): Promise<string> {
  const ref = await db().collection(STRATEGIES).add({
    ...data,
    lastRunAt: null,
    createdAt: FieldValue.serverTimestamp(),
    pendingSignal: false,
    pendingSince: null,
    pendingContext: null,
  });
  return ref.id;
}

export async function toggleStrategy(id: string, enabled: boolean): Promise<void> {
  await db().collection(STRATEGIES).doc(id).update({ enabled });
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
