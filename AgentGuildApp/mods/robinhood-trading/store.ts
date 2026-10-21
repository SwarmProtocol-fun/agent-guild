/**
 * Robinhood mod — Firestore persistence (Admin SDK, server-only).
 *
 * Collections:
 *   robinhoodConnections  — {orgId}: the org owner's Robinhood grant, tokens AES-256-GCM encrypted
 *   robinhoodOAuthClients — {hash of redirect URI}: client_id from dynamic registration
 *   robinhoodOAuthStates  — {state}: PKCE verifier for a sign-in in progress (10 min)
 *   robinhoodPolicy       — {orgId}: the owner's trading limits
 *   robinhoodDaily        — {orgId}_{UTC date}: orders and dollars used today
 *   robinhoodOrders       — every order an agent asked for: queued, placed, refused, rejected
 *   robinhoodActivity     — newest-first log of everything agents did
 */
import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { decryptValue, encryptValue } from "@/lib/secrets";
import { DEFAULT_POLICY, normalizePolicy, type DailyUsage, type OrderFacts, type Policy } from "./policy";
import type { Tokens } from "./oauth";

const CONNECTIONS = "robinhoodConnections";
const CLIENTS = "robinhoodOAuthClients";
const STATES = "robinhoodOAuthStates";
const POLICY = "robinhoodPolicy";
const DAILY = "robinhoodDaily";
const ORDERS = "robinhoodOrders";
const ACTIVITY = "robinhoodActivity";

export class ConfigError extends Error {}

const db = () => adminDb();

// ── Token encryption ─────────────────────────────────────────────────────

/** A dedicated key when set, else the agent-wallet key every deployment already has. */
function masterKey(): string {
  const key = process.env.ROBINHOOD_TOKEN_ENCRYPTION_KEY || process.env.AGENT_WALLET_ENCRYPTION_KEY;
  if (!key) throw new ConfigError("Set ROBINHOOD_TOKEN_ENCRYPTION_KEY (or AGENT_WALLET_ENCRYPTION_KEY) to store Robinhood tokens");
  return key;
}
const salt = (orgId: string) => `robinhood:${orgId}`;

// ── OAuth client + sign-in state ─────────────────────────────────────────

export async function cachedClientId(redirectUri: string, register: () => Promise<string>): Promise<string> {
  const ref = db().collection(CLIENTS).doc(createHash("sha256").update(redirectUri).digest("hex").slice(0, 40));
  const snap = await ref.get();
  if (snap.exists && typeof snap.data()?.clientId === "string") return snap.data()!.clientId;
  const clientId = await register();
  await ref.set({ clientId, redirectUri, registeredAt: new Date().toISOString() });
  return clientId;
}

export interface OAuthState { orgId: string; address: string; verifier: string; clientId: string; redirectUri: string; createdAt: number }

const STATE_TTL_MS = 10 * 60_000;

export async function saveOAuthState(state: string, value: OAuthState): Promise<void> {
  await db().collection(STATES).doc(state).set(value);
}

/** Reads and deletes in one transaction, so a state is good for exactly one callback. */
export async function takeOAuthState(state: string): Promise<OAuthState | null> {
  const ref = db().collection(STATES).doc(state);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    tx.delete(ref);
    const value = snap.data() as OAuthState;
    return Date.now() - value.createdAt > STATE_TTL_MS ? null : value;
  });
}

// ── Connection ───────────────────────────────────────────────────────────

export interface Connection {
  orgId: string;
  connectedBy: string;
  connectedAt: string;
  clientId: string;
  /** "needs_reconnect" once Robinhood refuses the refresh token. */
  status: "connected" | "needs_reconnect";
  expiresAt: number;
  lastError?: string;
}

interface ConnectionDoc extends Connection { tokens: { encryptedValue: string; iv: string } }

export async function saveConnection(conn: Omit<Connection, "expiresAt" | "status">, tokens: Tokens): Promise<void> {
  const enc = encryptValue(JSON.stringify(tokens), salt(conn.orgId), masterKey());
  const doc: ConnectionDoc = { ...conn, status: "connected", expiresAt: tokens.expiresAt, tokens: enc };
  await db().collection(CONNECTIONS).doc(conn.orgId).set(doc);
}

export async function getConnection(orgId: string): Promise<(Connection & { tokens: Tokens }) | null> {
  const snap = await db().collection(CONNECTIONS).doc(orgId).get();
  if (!snap.exists) return null;
  const { tokens, ...rest } = snap.data() as ConnectionDoc;
  return { ...rest, tokens: JSON.parse(decryptValue(tokens.encryptedValue, tokens.iv, salt(orgId), masterKey())) as Tokens };
}

export async function updateTokens(orgId: string, tokens: Tokens): Promise<void> {
  const enc = encryptValue(JSON.stringify(tokens), salt(orgId), masterKey());
  await db().collection(CONNECTIONS).doc(orgId).update({ tokens: enc, expiresAt: tokens.expiresAt, status: "connected", lastError: FieldValue.delete() });
}

export async function markNeedsReconnect(orgId: string, error: string): Promise<void> {
  await db().collection(CONNECTIONS).doc(orgId).update({ status: "needs_reconnect", lastError: error.slice(0, 300) });
}

export async function deleteConnection(orgId: string): Promise<void> {
  await db().collection(CONNECTIONS).doc(orgId).delete();
}

// ── Policy ───────────────────────────────────────────────────────────────

export async function getPolicy(orgId: string): Promise<Policy> {
  const snap = await db().collection(POLICY).doc(orgId).get();
  // Stored fields go back through normalizePolicy so a policy saved by an older version still validates.
  return snap.exists ? normalizePolicy(snap.data() ?? {}, DEFAULT_POLICY) : { ...DEFAULT_POLICY };
}

export async function setPolicy(orgId: string, policy: Policy, by: string): Promise<void> {
  await db().collection(POLICY).doc(orgId).set({ ...policy, updatedBy: by, updatedAt: new Date().toISOString() });
}

// ── Daily usage ──────────────────────────────────────────────────────────

const dailyRef = (orgId: string, at = new Date()) => db().collection(DAILY).doc(`${orgId}_${at.toISOString().slice(0, 10)}`);

export async function getDailyUsage(orgId: string): Promise<DailyUsage> {
  const d = (await dailyRef(orgId).get()).data();
  return { orders: Number(d?.orders ?? 0), usd: Number(d?.usd ?? 0) };
}

/**
 * Counts an order against today's limits inside a transaction, so two agents
 * placing at once can't both slip under the cap. `check` sees the usage as it
 * stands and returns a refusal reason, or null to reserve.
 */
export async function reserveDaily(orgId: string, usd: number, check: (today: DailyUsage) => string | null): Promise<string | null> {
  const ref = dailyRef(orgId);
  return db().runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    const today = { orders: Number(d?.orders ?? 0), usd: Number(d?.usd ?? 0) };
    const refusal = check(today);
    if (refusal) return refusal;
    tx.set(ref, { orgId, orders: today.orders + 1, usd: Math.round((today.usd + usd) * 100) / 100 }, { merge: true });
    return null;
  });
}

/** Gives a reservation back when Robinhood didn't take the order. */
export async function releaseDaily(orgId: string, usd: number, at: Date): Promise<void> {
  await dailyRef(orgId, at).set({ orders: FieldValue.increment(-1), usd: FieldValue.increment(-usd) }, { merge: true });
}

// ── Orders ───────────────────────────────────────────────────────────────

/** "placing" = sent (or about to be) to Robinhood; it is never approvable, so an order can't be placed twice. */
export type OrderStatus = "pending_approval" | "placing" | "placed" | "denied" | "rejected" | "failed" | "expired";

export interface OrderRecord {
  id: string;
  orgId: string;
  agentId: string;
  tool: string;
  arguments: Record<string, unknown>;
  facts: OrderFacts;
  notionalUsd: number | null;
  /** The agent's own one-line reason for the trade, shown to the owner. */
  reason: string;
  status: OrderStatus;
  /** Policy reasons for a hold or refusal. */
  reasons: string[];
  /** Pre-trade warnings from Robinhood's review tool. */
  warnings: string[];
  review: unknown;
  result?: unknown;
  error?: string;
  idempotencyKey?: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

/** Orders waiting this long are dropped: the agent decided on prices that are long gone. */
export const APPROVAL_TTL_MS = 24 * 3600_000;

/**
 * Creates the order record. With an idempotency key the id is derived from
 * it, so an agent retrying the same order gets the first attempt back.
 */
export async function createOrder(record: Omit<OrderRecord, "id">): Promise<{ order: OrderRecord; duplicate: boolean }> {
  const col = db().collection(ORDERS);
  const ref = record.idempotencyKey
    ? col.doc(createHash("sha256").update(`${record.orgId}:${record.agentId}:${record.idempotencyKey}`).digest("hex").slice(0, 32))
    : col.doc();
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return { order: snap.data() as OrderRecord, duplicate: true };
    const order = { ...record, id: ref.id };
    tx.set(ref, JSON.parse(JSON.stringify(order)));
    return { order, duplicate: false };
  });
}

export async function getOrder(id: string): Promise<OrderRecord | null> {
  const snap = await db().collection(ORDERS).doc(id).get();
  return snap.exists ? (snap.data() as OrderRecord) : null;
}

export async function updateOrder(id: string, patch: Partial<OrderRecord>): Promise<void> {
  await db().collection(ORDERS).doc(id).update(JSON.parse(JSON.stringify(patch)));
}

/** Claims a pending order for a decision; false if someone else already decided it. */
export async function claimPending(id: string, patch: Partial<OrderRecord>): Promise<OrderRecord | null> {
  const ref = db().collection(ORDERS).doc(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const order = snap.data() as OrderRecord | undefined;
    if (!order || order.status !== "pending_approval") return null;
    tx.update(ref, JSON.parse(JSON.stringify(patch)));
    return { ...order, ...patch };
  });
}

export async function listOrders(orgId: string, opts: { agentId?: string; status?: OrderStatus; limit?: number } = {}): Promise<OrderRecord[]> {
  // Equality filters only, sorted here: no composite index to deploy.
  let q = db().collection(ORDERS).where("orgId", "==", orgId);
  if (opts.agentId) q = q.where("agentId", "==", opts.agentId);
  if (opts.status) q = q.where("status", "==", opts.status);
  const snap = await q.limit(200).get();
  return snap.docs.map((d) => d.data() as OrderRecord).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, opts.limit ?? 50);
}

// ── Activity ─────────────────────────────────────────────────────────────

export interface Activity {
  at: string;
  orgId: string;
  agentId: string | null;
  via: "agent" | "session";
  action: string;
  tool?: string;
  ok: boolean;
  summary: string;
  orderId?: string;
}

// Same newest-first doc ids as the Ethereum mod's log: one equality filter, ordered by id.
const ID_CEILING = 9_999_999_999_999;
const activityId = (at: number) => `${String(ID_CEILING - at).padStart(13, "0")}-${Math.random().toString(36).slice(2, 8)}`;

/** Fire-and-forget: a failed log write never fails the action it records. */
export function logActivity(entry: Omit<Activity, "at">): void {
  const now = Date.now();
  const row = Object.fromEntries(Object.entries({ at: new Date(now).toISOString(), ...entry }).filter(([, v]) => v !== undefined));
  void Promise.resolve()
    .then(() => db().collection(ACTIVITY).doc(activityId(now)).set(row))
    .catch((err) => console.warn("[robinhood-trading] activity log write failed:", (err as Error).message));
}

export async function activityFor(orgId: string, limit = 50): Promise<Activity[]> {
  const snap = await db().collection(ACTIVITY).where("orgId", "==", orgId).orderBy("__name__").limit(limit).get();
  return snap.docs.map((d) => d.data() as Activity);
}
