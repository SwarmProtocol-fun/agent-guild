/**
 * Polymarket Mod — Firestore persistence.
 *
 * Collections:
 *   polymarketAccounts        — per-agent mode (paper/live), paper cash, live wallet link, risk limits
 *   polymarketPaperPositions  — paper positions, one doc per agent × outcome token
 *   polymarketTrades          — every fill (paper and live), the source of PnL and the daily-loss check
 *   polymarketBots            — bot definitions and their running state
 *   polymarketBots/{id}/log   — what each bot did and why (entries, exits, skips, resolutions, errors)
 *   polymarketAiRequests      — AI Predictor questions waiting for the agent's own model
 *   polymarketPaperOrders     — resting paper limit orders (maker bots), filled from the real trade tape
 *   polymarketFeeds           — shared feed caches (whale universe) and the tick lock
 *
 * Server-only (Firebase Admin SDK). Only import from the mod's server.ts.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { applyBuy, applySell, makerFill, settle, type Fill } from "../../../mods/polymarket-trading/paper";
import type { BotType } from "../../../mods/polymarket-trading/strategies";
import type { PredictorDecision } from "../../../mods/polymarket-trading/ai-predictor-core";

const ACCOUNTS = "polymarketAccounts";
const PAPER_POSITIONS = "polymarketPaperPositions";
const TRADES = "polymarketTrades";
const BOTS = "polymarketBots";
const BOT_LOG = "log";
const AI_REQUESTS = "polymarketAiRequests";
const PAPER_ORDERS = "polymarketPaperOrders";
const FEEDS = "polymarketFeeds";

function db() {
  return adminDb();
}

function toDate(v: unknown): Date | null {
  return v && typeof (v as { toDate?: () => Date }).toDate === "function" ? (v as { toDate: () => Date }).toDate() : null;
}

// ── Account ─────────────────────────────────────────────────────────────────

export type TradingMode = "paper" | "live";

export interface PmRisk {
  /** Largest single order, USD. */
  maxOrderUsd: number;
  /** Largest total cost basis across open positions, USD. */
  maxExposureUsd: number;
  /** Trading stops for the day once realized PnL reaches −this. */
  maxDailyLossUsd: number;
}

export const DEFAULT_RISK: PmRisk = { maxOrderUsd: 25, maxExposureUsd: 100, maxDailyLossUsd: 50 };
export const PAPER_START_CASH = 1000;

export interface LiveLink {
  walletId: string;
  address: string;
  enabledBy: string;
}

export interface PmAccount {
  agentId: string;
  orgId: string;
  mode: TradingMode;
  paperCash: number;
  paperStartCash: number;
  live: LiveLink | null;
  risk: PmRisk;
}

function docToAccount(agentId: string, data: FirebaseFirestore.DocumentData): PmAccount {
  return {
    agentId,
    orgId: data.orgId,
    mode: data.mode === "live" ? "live" : "paper",
    paperCash: Number(data.paperCash ?? PAPER_START_CASH),
    paperStartCash: Number(data.paperStartCash ?? PAPER_START_CASH),
    live: data.live ?? null,
    risk: { ...DEFAULT_RISK, ...(data.risk ?? {}) },
  };
}

export async function getAccount(agentId: string): Promise<PmAccount | null> {
  const snap = await db().collection(ACCOUNTS).doc(agentId).get();
  return snap.exists ? docToAccount(agentId, snap.data()!) : null;
}

/** The agent's account, created as a fresh paper account on first use. */
export async function ensureAccount(agentId: string, orgId: string): Promise<PmAccount> {
  const ref = db().collection(ACCOUNTS).doc(agentId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return docToAccount(agentId, snap.data()!);
    const fresh = {
      orgId, mode: "paper", paperCash: PAPER_START_CASH, paperStartCash: PAPER_START_CASH, live: null, risk: DEFAULT_RISK,
      createdAt: FieldValue.serverTimestamp(),
    };
    tx.set(ref, fresh);
    return docToAccount(agentId, fresh);
  });
}

export async function updateAccount(agentId: string, patch: Partial<Pick<PmAccount, "mode" | "live" | "risk">>): Promise<void> {
  await db().collection(ACCOUNTS).doc(agentId).update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
}

/**
 * Adds paper money. The starting balance rises by the same amount, so the
 * account's PnL (equity − start) isn't inflated by the deposit.
 */
export async function addPaperFunds(agentId: string, amount: number): Promise<number> {
  const ref = db().collection(ACCOUNTS).doc(agentId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("No Polymarket account for this agent");
    const cash = Number(snap.data()!.paperCash ?? 0) + amount;
    tx.update(ref, { paperCash: cash, paperStartCash: Number(snap.data()!.paperStartCash ?? 0) + amount });
    return cash;
  });
}

/** Back to a clean paper account: fresh cash, paper positions closed out (trade history is kept). */
export async function resetPaper(agentId: string, startCash = PAPER_START_CASH): Promise<void> {
  const open = await db().collection(PAPER_POSITIONS).where("agentId", "==", agentId).get();
  const batch = db().batch();
  open.docs.forEach((d) => batch.delete(d.ref));
  batch.update(db().collection(ACCOUNTS).doc(agentId), { paperCash: startCash, paperStartCash: startCash });
  await batch.commit();
}

// ── Paper positions ─────────────────────────────────────────────────────────

export interface MarketRef {
  conditionId: string;
  question: string;
  slug: string;
  endDate: string | null;
  tokenId: string;
  outcomeIndex: number;
  outcome: string;
}

export interface PaperPositionDoc extends MarketRef {
  id: string;
  agentId: string;
  orgId: string;
  shares: number;
  avgPrice: number;
  realizedPnl: number;
  open: boolean;
  /** The bot whose buy last added to this position, so its resolution counts toward that bot's results. */
  strategyId: string | null;
}

function positionId(agentId: string, tokenId: string): string {
  return `${agentId}_${tokenId}`;
}

function docToPosition(d: FirebaseFirestore.DocumentSnapshot): PaperPositionDoc {
  const x = d.data() ?? {};
  return {
    id: d.id, agentId: x.agentId, orgId: x.orgId, conditionId: x.conditionId, question: x.question, slug: x.slug,
    endDate: x.endDate ?? null, tokenId: x.tokenId, outcomeIndex: x.outcomeIndex, outcome: x.outcome,
    shares: Number(x.shares ?? 0), avgPrice: Number(x.avgPrice ?? 0), realizedPnl: Number(x.realizedPnl ?? 0), open: x.open === true,
    strategyId: x.strategyId ?? null,
  };
}

export async function listPaperPositions(agentId: string): Promise<PaperPositionDoc[]> {
  const snap = await db().collection(PAPER_POSITIONS).where("agentId", "==", agentId).get();
  return snap.docs.map(docToPosition).filter((p) => p.open);
}

export async function getPaperPosition(agentId: string, tokenId: string): Promise<PaperPositionDoc | null> {
  const snap = await db().collection(PAPER_POSITIONS).doc(positionId(agentId, tokenId)).get();
  if (!snap.exists) return null;
  const p = docToPosition(snap);
  return p.open ? p : null;
}

/** Every open paper position across all agents — the resolution sweep's work list. */
export async function listAllOpenPaperPositions(): Promise<PaperPositionDoc[]> {
  const snap = await db().collection(PAPER_POSITIONS).where("open", "==", true).get();
  return snap.docs.map(docToPosition);
}

export class PaperError extends Error {}

/**
 * Books one paper fill: cash and the position move together in one
 * transaction, so two orders racing can't spend the same cash twice.
 * Returns the realized PnL of the fill (−fee for a buy).
 */
export async function applyPaperFill(
  agentId: string,
  orgId: string,
  market: MarketRef,
  side: "buy" | "sell",
  fill: Fill,
  strategyId: string | null = null,
): Promise<{ realized: number; cash: number }> {
  const accountRef = db().collection(ACCOUNTS).doc(agentId);
  const posRef = db().collection(PAPER_POSITIONS).doc(positionId(agentId, market.tokenId));
  return db().runTransaction(async (tx) => {
    const [accSnap, posSnap] = await Promise.all([tx.get(accountRef), tx.get(posRef)]);
    if (!accSnap.exists) throw new PaperError("No Polymarket account for this agent");
    const cash = Number(accSnap.data()!.paperCash ?? 0);
    const prev = posSnap.exists ? docToPosition(posSnap) : null;
    const prevPos = prev?.open ? { shares: prev.shares, avgPrice: prev.avgPrice, realizedPnl: prev.realizedPnl } : null;

    if (side === "buy") {
      const cost = fill.notional + fill.fee;
      if (cost > cash + 1e-9) throw new PaperError(`Not enough paper cash: need $${cost.toFixed(2)}, have $${cash.toFixed(2)}`);
      const next = applyBuy(prevPos, fill);
      tx.set(posRef, {
        agentId, orgId, ...market, ...next, open: true, strategyId: strategyId ?? (prev?.open ? prev.strategyId : null),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(accountRef, { paperCash: cash - cost });
      return { realized: -fill.fee, cash: cash - cost };
    }

    if (!prevPos || prevPos.shares + 1e-9 < fill.shares) throw new PaperError("Not enough shares to sell");
    const { position, realized } = applySell(prevPos, fill);
    tx.set(posRef, {
      agentId, orgId, ...market, ...position, open: position.shares > 0, strategyId: prev?.strategyId ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    const proceeds = fill.notional - fill.fee;
    tx.update(accountRef, { paperCash: cash + proceeds });
    return { realized, cash: cash + proceeds };
  });
}

/** Pays out (or zeroes) a resolved paper position. Idempotent: an already-closed position is left alone. */
export async function settlePaperPosition(id: string, won: boolean): Promise<{ payout: number; realized: number } | null> {
  const posRef = db().collection(PAPER_POSITIONS).doc(id);
  return db().runTransaction(async (tx) => {
    const posSnap = await tx.get(posRef);
    if (!posSnap.exists) return null;
    const pos = docToPosition(posSnap);
    if (!pos.open) return null;
    const accountRef = db().collection(ACCOUNTS).doc(pos.agentId);
    const accSnap = await tx.get(accountRef);
    const result = settle(pos, won);
    if (accSnap.exists) tx.update(accountRef, { paperCash: Number(accSnap.data()!.paperCash ?? 0) + result.payout });
    tx.update(posRef, { shares: 0, open: false, realizedPnl: pos.realizedPnl + result.realized, resolvedAt: FieldValue.serverTimestamp(), won });
    return result;
  });
}

// ── Trades ──────────────────────────────────────────────────────────────────

export interface PmTrade {
  id: string;
  agentId: string;
  orgId: string;
  mode: TradingMode;
  conditionId: string;
  question: string;
  tokenId: string;
  outcome: string;
  side: "buy" | "sell" | "resolve";
  shares: number;
  price: number;
  notional: number;
  fee: number;
  realizedPnl: number;
  strategyId: string | null;
  orderId: string | null;
  status: string;
  createdAt: Date | null;
}

/** UTC day key for the per-day PnL counter, e.g. "d20261009". */
export function dayKey(at = new Date()): string {
  return `d${at.toISOString().slice(0, 10).replace(/-/g, "")}`;
}

/**
 * Logs a fill and adds its realized PnL to the account's per-day counter
 * (pnlByDay.<day>.<mode>). The daily-loss check reads that counter, so it
 * needs no composite index.
 */
export async function recordTrade(data: Omit<PmTrade, "id" | "createdAt">): Promise<string> {
  const ref = await db().collection(TRADES).add({ ...data, createdAt: FieldValue.serverTimestamp() });
  if (data.realizedPnl) {
    await db().collection(ACCOUNTS).doc(data.agentId).set(
      { pnlByDay: { [dayKey()]: { [data.mode]: FieldValue.increment(data.realizedPnl) } } },
      { merge: true },
    );
  }
  if (data.strategyId) await bumpBotStats(data.strategyId, data);
  return ref.id;
}

/** Adds one fill to its bot's per-mode results. A deleted bot is simply skipped. */
async function bumpBotStats(botId: string, t: Omit<PmTrade, "id" | "createdAt">): Promise<void> {
  const inc = (n: number) => FieldValue.increment(n);
  const closing = t.side !== "buy";
  const prefix = `stats.${t.mode}`;
  try {
    await db().collection(BOTS).doc(botId).update({
      [`${prefix}.entries`]: inc(t.side === "buy" ? 1 : 0),
      [`${prefix}.wins`]: inc(closing && t.realizedPnl > 0 ? 1 : 0),
      [`${prefix}.losses`]: inc(closing && t.realizedPnl < 0 ? 1 : 0),
      [`${prefix}.realizedPnl`]: inc(t.realizedPnl),
      [`${prefix}.volumeUsd`]: inc(t.side === "resolve" ? 0 : t.notional),
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 5) throw err; // 5 = NOT_FOUND
  }
}

function docToTrade(d: FirebaseFirestore.QueryDocumentSnapshot): PmTrade {
  const x = d.data();
  return {
    id: d.id, agentId: x.agentId, orgId: x.orgId, mode: x.mode, conditionId: x.conditionId, question: x.question,
    tokenId: x.tokenId, outcome: x.outcome, side: x.side, shares: Number(x.shares ?? 0), price: Number(x.price ?? 0),
    notional: Number(x.notional ?? 0), fee: Number(x.fee ?? 0), realizedPnl: Number(x.realizedPnl ?? 0),
    strategyId: x.strategyId ?? null, orderId: x.orderId ?? null, status: x.status ?? "filled", createdAt: toDate(x.createdAt),
  };
}

/** Firestore's "this query needs an index" error. */
function isMissingIndex(err: unknown): boolean {
  return (err as { code?: number }).code === 9 || /requires an index/i.test(String((err as Error)?.message));
}

export async function listTrades(agentId: string, limit = 100): Promise<PmTrade[]> {
  const byAgent = db().collection(TRADES).where("agentId", "==", agentId);
  try {
    const snap = await byAgent.orderBy("createdAt", "desc").limit(limit).get();
    return snap.docs.map(docToTrade);
  } catch (err) {
    // Until the (agentId, createdAt) index is deployed: read without ordering and sort here.
    if (!isMissingIndex(err)) throw err;
    const snap = await byAgent.limit(500).get();
    return snap.docs.map(docToTrade)
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
      .slice(0, limit);
  }
}

/** Today's (UTC) realized PnL for one mode — what the daily-loss limit checks. */
export async function getDailyRealizedPnl(agentId: string, mode: TradingMode): Promise<number> {
  const snap = await db().collection(ACCOUNTS).doc(agentId).get();
  return Number(snap.data()?.pnlByDay?.[dayKey()]?.[mode] ?? 0);
}

// ── Bots ────────────────────────────────────────────────────────────────────

export interface BotMarket {
  conditionId: string;
  question: string;
  slug: string;
  outcomes: { name: string; tokenId: string }[];
}

export interface BotState {
  /** BTC bots: start (ms) of the window last evaluated / last entered. */
  window?: number | null;
  enteredWindow?: number | null;
  lastReason?: string | null;
  lastEvalAt?: number | null;
  /** AI Predictor: the round currently out with the agent. */
  openRequestId?: string | null;
  startEquity?: number | null;
  eliminated?: boolean;
  /** Fleet bots: per-window working state (box legs, resting quote id…). Reset each window. */
  fleet?: Record<string, unknown> | null;
}

/** A bot's results in one mode. realizedPnl includes buy fees and paper resolutions. */
export interface BotStats {
  entries: number;
  wins: number;
  losses: number;
  realizedPnl: number;
  volumeUsd: number;
}

export const EMPTY_BOT_STATS: BotStats = { entries: 0, wins: 0, losses: 0, realizedPnl: 0, volumeUsd: 0 };

function toStats(v: unknown): BotStats {
  const x = (v ?? {}) as Partial<Record<keyof BotStats, unknown>>;
  return {
    entries: Number(x.entries ?? 0), wins: Number(x.wins ?? 0), losses: Number(x.losses ?? 0),
    realizedPnl: Number(x.realizedPnl ?? 0), volumeUsd: Number(x.volumeUsd ?? 0),
  };
}

export interface PmBot {
  id: string;
  agentId: string;
  orgId: string;
  type: BotType;
  enabled: boolean;
  sizeUsd: number;
  /** Fixed-market bots (AI on a market, price trigger). BTC bots pick each window's market themselves. */
  market: BotMarket | null;
  params: Record<string, unknown>;
  /** Kill switch: the bot stops itself once its realized PnL in the current mode reaches −this. */
  maxLossUsd: number | null;
  stats: Record<TradingMode, BotStats>;
  state: BotState;
  lastRunAt: Date | null;
  createdAt: Date | null;
}

function docToBot(d: FirebaseFirestore.DocumentSnapshot): PmBot {
  const x = d.data() ?? {};
  return {
    id: d.id, agentId: x.agentId, orgId: x.orgId, type: x.type, enabled: x.enabled === true, sizeUsd: Number(x.sizeUsd ?? 0),
    market: x.market ?? null, params: x.params ?? {}, maxLossUsd: x.maxLossUsd == null ? null : Number(x.maxLossUsd),
    stats: { paper: toStats(x.stats?.paper), live: toStats(x.stats?.live) }, state: x.state ?? {}, lastRunAt: toDate(x.lastRunAt), createdAt: toDate(x.createdAt),
  };
}

export async function createBot(data: Pick<PmBot, "agentId" | "orgId" | "type" | "sizeUsd" | "market" | "params"> & { maxLossUsd?: number | null }): Promise<string> {
  const ref = await db().collection(BOTS).add({
    ...data, maxLossUsd: data.maxLossUsd ?? null, stats: { paper: EMPTY_BOT_STATS, live: EMPTY_BOT_STATS }, enabled: true, state: {}, lastRunAt: null, createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getBot(id: string): Promise<PmBot | null> {
  const snap = await db().collection(BOTS).doc(id).get();
  return snap.exists ? docToBot(snap) : null;
}

export async function listBots(agentId: string): Promise<PmBot[]> {
  const snap = await db().collection(BOTS).where("agentId", "==", agentId).get();
  return snap.docs.map(docToBot).sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
}

export async function listEnabledBots(): Promise<PmBot[]> {
  const snap = await db().collection(BOTS).where("enabled", "==", true).get();
  return snap.docs.map(docToBot);
}

export async function updateBot(
  id: string,
  patch: { enabled?: boolean; params?: Record<string, unknown>; sizeUsd?: number; maxLossUsd?: number | null; state?: BotState; touch?: boolean },
): Promise<void> {
  const { touch, state, ...rest } = patch;
  const update: Record<string, unknown> = { ...rest };
  // Merge state field-by-field so concurrent writers don't drop each other's keys.
  if (state) for (const [k, v] of Object.entries(state)) update[`state.${k}`] = v ?? null;
  if (touch) update.lastRunAt = FieldValue.serverTimestamp();
  await db().collection(BOTS).doc(id).update(update);
}

export async function deleteBot(id: string): Promise<void> {
  await db().collection(BOTS).doc(id).delete();
}

export type BotLogKind = "entry" | "exit" | "skip" | "resolve" | "decision" | "error";

export interface BotLogEntry {
  id: string;
  kind: BotLogKind;
  reason: string;
  decision: string | null;
  price: number | null;
  shares: number | null;
  usd: number | null;
  createdAt: Date | null;
}

export async function addBotLog(botId: string, entry: Partial<Omit<BotLogEntry, "id" | "createdAt">> & { kind: BotLogKind; reason: string }): Promise<void> {
  await db().collection(BOTS).doc(botId).collection(BOT_LOG).add({
    decision: null, price: null, shares: null, usd: null, ...entry, createdAt: FieldValue.serverTimestamp(),
  });
}

export async function listBotLog(botId: string, limit = 50): Promise<BotLogEntry[]> {
  const snap = await db().collection(BOTS).doc(botId).collection(BOT_LOG).orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id, kind: x.kind, reason: x.reason ?? "", decision: x.decision ?? null, price: x.price ?? null,
      shares: x.shares ?? null, usd: x.usd ?? null, createdAt: toDate(x.createdAt),
    };
  });
}

// ── AI Predictor requests ───────────────────────────────────────────────────

export interface PmAiRequest {
  id: string;
  agentId: string;
  orgId: string;
  botId: string;
  conditionId: string;
  question: string;
  system: string;
  prompt: string;
  /** Whether the agent held a position when asked (SELL means HOLD otherwise). */
  holding: boolean;
  status: "open" | "answered" | "expired";
  decision: PredictorDecision | null;
  reasoning: string | null;
  createdAt: Date | null;
  expiresAt: Date;
}

function docToAiRequest(d: FirebaseFirestore.DocumentSnapshot): PmAiRequest {
  const x = d.data() ?? {};
  return {
    id: d.id, agentId: x.agentId, orgId: x.orgId, botId: x.botId, conditionId: x.conditionId, question: x.question,
    system: x.system, prompt: x.prompt, holding: x.holding === true, status: x.status, decision: x.decision ?? null,
    reasoning: x.reasoning ?? null, createdAt: toDate(x.createdAt), expiresAt: toDate(x.expiresAt) ?? new Date(0),
  };
}

export async function createAiRequest(
  data: Pick<PmAiRequest, "agentId" | "orgId" | "botId" | "conditionId" | "question" | "system" | "prompt" | "holding" | "expiresAt">,
): Promise<string> {
  const ref = await db().collection(AI_REQUESTS).add({
    ...data, status: "open", decision: null, reasoning: null, createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getAiRequest(id: string): Promise<PmAiRequest | null> {
  const snap = await db().collection(AI_REQUESTS).doc(id).get();
  return snap.exists ? docToAiRequest(snap) : null;
}

export async function listOpenAiRequests(agentId: string): Promise<PmAiRequest[]> {
  const snap = await db().collection(AI_REQUESTS).where("agentId", "==", agentId).where("status", "==", "open").get();
  const now = Date.now();
  return snap.docs
    .map(docToAiRequest)
    .filter((r) => r.expiresAt.getTime() > now)
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
}

/** Records the answer once; null if already answered or past its deadline (a late answer never trades). */
export async function answerAiRequest(id: string, decision: PredictorDecision, reasoning: string): Promise<PmAiRequest | null> {
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

// ── Resting paper orders ────────────────────────────────────────────────────

export interface PaperOrder extends MarketRef {
  id: string;
  agentId: string;
  orgId: string;
  botId: string | null;
  side: "buy" | "sell";
  price: number;
  shares: number;
  filledShares: number;
  status: "open" | "filled" | "cancelled";
  /** Tape prints up to this time (ms) have already been matched. */
  checkedTo: number;
  /** The order is cancelled once the clock passes this (ms). */
  expiresAt: number;
  /** Free-form label the bot uses to find its own legs ("up", "down", "exit"…). */
  tag: string | null;
  cancelReason: string | null;
}

function docToOrder(d: FirebaseFirestore.DocumentSnapshot): PaperOrder {
  const x = d.data() ?? {};
  return {
    id: d.id, agentId: x.agentId, orgId: x.orgId, botId: x.botId ?? null,
    conditionId: x.conditionId, question: x.question, slug: x.slug, endDate: x.endDate ?? null,
    tokenId: x.tokenId, outcomeIndex: Number(x.outcomeIndex ?? 0), outcome: x.outcome,
    side: x.side === "sell" ? "sell" : "buy", price: Number(x.price), shares: Number(x.shares), filledShares: Number(x.filledShares ?? 0),
    status: x.status === "filled" || x.status === "cancelled" ? x.status : "open",
    checkedTo: Number(x.checkedTo ?? 0), expiresAt: Number(x.expiresAt ?? 0), tag: x.tag ?? null, cancelReason: x.cancelReason ?? null,
  };
}

export async function createPaperOrder(data: Omit<PaperOrder, "id" | "filledShares" | "status" | "cancelReason">): Promise<PaperOrder> {
  const ref = await db().collection(PAPER_ORDERS).add({
    ...data, filledShares: 0, status: "open", cancelReason: null, createdAt: FieldValue.serverTimestamp(),
  });
  return { ...data, id: ref.id, filledShares: 0, status: "open", cancelReason: null };
}

/** Every open resting order (one equality filter: no composite index needed). */
export async function listOpenPaperOrders(): Promise<PaperOrder[]> {
  const snap = await db().collection(PAPER_ORDERS).where("status", "==", "open").get();
  return snap.docs.map(docToOrder);
}

export async function listAgentPaperOrders(agentId: string, limit = 50): Promise<PaperOrder[]> {
  const snap = await db().collection(PAPER_ORDERS).where("agentId", "==", agentId).get();
  return snap.docs.map(docToOrder).sort((a, b) => b.expiresAt - a.expiresAt).slice(0, limit);
}

export async function updatePaperOrder(id: string, patch: Partial<Pick<PaperOrder, "price" | "checkedTo" | "expiresAt" | "status" | "cancelReason">>): Promise<void> {
  await db().collection(PAPER_ORDERS).doc(id).update(patch);
}

/**
 * Fills part of a resting order: the order, the cash and the position move in
 * one transaction, so a crash can't double-fill. Clamps to what's left on the
 * order, the cash on hand (buys) and the shares held (sells); returns what
 * actually filled (0 when nothing could) and the realized PnL.
 */
export async function applyRestingFill(orderId: string, shares: number, checkedTo: number): Promise<{ shares: number; realized: number; order: PaperOrder } | null> {
  const orderRef = db().collection(PAPER_ORDERS).doc(orderId);
  return db().runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return null;
    const order = docToOrder(orderSnap);
    if (order.status !== "open") return null;
    const accountRef = db().collection(ACCOUNTS).doc(order.agentId);
    const posRef = db().collection(PAPER_POSITIONS).doc(positionId(order.agentId, order.tokenId));
    const [accSnap, posSnap] = await Promise.all([tx.get(accountRef), tx.get(posRef)]);
    if (!accSnap.exists) return null;
    const cash = Number(accSnap.data()!.paperCash ?? 0);
    const prev = posSnap.exists ? docToPosition(posSnap) : null;
    const prevPos = prev?.open ? { shares: prev.shares, avgPrice: prev.avgPrice, realizedPnl: prev.realizedPnl } : null;
    const ref: MarketRef = {
      conditionId: order.conditionId, question: order.question, slug: order.slug, endDate: order.endDate,
      tokenId: order.tokenId, outcomeIndex: order.outcomeIndex, outcome: order.outcome,
    };

    let take = Math.min(shares, order.shares - order.filledShares);
    if (order.side === "buy") take = Math.min(take, cash / order.price);
    else take = Math.min(take, prevPos?.shares ?? 0);
    take = Math.floor(take * 100) / 100;

    const filledShares = order.filledShares + Math.max(0, take);
    const done = filledShares >= order.shares - 1e-9;
    const orderPatch: Record<string, unknown> = { checkedTo, filledShares, ...(done ? { status: "filled" } : {}) };
    if (!(take > 0)) {
      // Can't fill (no cash / no shares left to sell): close it rather than retry every tick.
      tx.update(orderRef, { checkedTo, status: "cancelled", cancelReason: order.side === "buy" ? "Not enough paper cash" : "No shares left to sell" });
      return { shares: 0, realized: 0, order: { ...order, status: "cancelled" } };
    }
    const fill = makerFill(take, order.price);
    let realized = 0;
    if (order.side === "buy") {
      const next = applyBuy(prevPos, fill);
      tx.set(posRef, { agentId: order.agentId, orgId: order.orgId, ...ref, ...next, open: true, strategyId: order.botId ?? (prev?.open ? prev.strategyId : null), updatedAt: FieldValue.serverTimestamp() });
      tx.update(accountRef, { paperCash: cash - fill.notional });
    } else {
      const res = applySell(prevPos!, fill);
      realized = res.realized;
      tx.set(posRef, { agentId: order.agentId, orgId: order.orgId, ...ref, ...res.position, open: res.position.shares > 0, strategyId: prev?.strategyId ?? null, updatedAt: FieldValue.serverTimestamp() });
      tx.update(accountRef, { paperCash: cash + fill.notional });
    }
    tx.update(orderRef, orderPatch);
    return { shares: take, realized, order: { ...order, filledShares, status: done ? "filled" : "open" } };
  });
}

// ── Shared feed cache and the tick lock ─────────────────────────────────────

export async function getWhaleUniverse(): Promise<{ addresses: string[]; refreshedAt: number }> {
  const snap = await db().collection(FEEDS).doc("hlWhales").get();
  const x = snap.data() ?? {};
  return { addresses: Array.isArray(x.addresses) ? x.addresses : [], refreshedAt: Number(x.refreshedAt ?? 0) };
}

export async function setWhaleUniverse(addresses: string[]): Promise<void> {
  await db().collection(FEEDS).doc("hlWhales").set({ addresses, refreshedAt: Date.now() });
}

/**
 * Takes the tick lock for `ttlMs`, or returns false when another tick holds it.
 * The scheduler and the hub can both call the tick; bots must not run twice in
 * the same minute or they'd double-enter.
 */
export async function acquireTickLock(holder: string, ttlMs = 50_000, now = Date.now()): Promise<boolean> {
  const ref = db().collection(FEEDS).doc("tickLock");
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const until = Number(snap.data()?.until ?? 0);
    if (until > now) return false;
    tx.set(ref, { holder, until: now + ttlMs });
    return true;
  });
}

export async function releaseTickLock(holder: string): Promise<void> {
  const ref = db().collection(FEEDS).doc("tickLock");
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.data()?.holder === holder) tx.set(ref, { holder: null, until: 0 });
  });
}
