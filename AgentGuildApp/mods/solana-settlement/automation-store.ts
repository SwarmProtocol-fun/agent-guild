/**
 * Firestore persistence for what the hub runs on an agent's behalf. Admin
 * SDK only — the rules deny browsers all of these collections.
 *
 *   solanaStandingOrders/{id}     paper orders waiting on a price trigger
 *   solanaWatches/{id}            price / address-activity watches
 *   solanaPaymentRequests/{id}    Solana Pay requests the tick checks for payment
 *   solanaAlerts/{reverseTs-*}    what fired, newest first by doc id
 *   solanaTick/lock               one tick at a time
 *
 * Queries are single-field equalities (agentId, or status for the tick),
 * so none of them need a composite index.
 */
import { adminDb } from "@/lib/firebase-admin";
import {
  MAX_ACTIVE_WATCHES, MAX_OPEN_ORDERS, MAX_OPEN_PAYMENT_REQUESTS,
  type Alert, type NewRow, type PaymentRequest, type StandingOrder, type Watch,
} from "./automation";
import { PaperTradeError } from "./paper";

const ORDERS = "solanaStandingOrders";
const WATCHES = "solanaWatches";
const PAYMENTS = "solanaPaymentRequests";
const ALERTS = "solanaAlerts";
const TICK = "solanaTick";
const ID_CEILING = 9_999_999_999_999;

const db = () => adminDb();
const reverseId = (at: number) => `${String(ID_CEILING - at).padStart(13, "0")}-${Math.random().toString(36).slice(2, 8)}`;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** Firestore rejects undefined fields. */
const clean = <T extends object>(row: T) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as T;
const newestFirst = <T extends { createdAt: string }>(rows: T[]) => rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

async function forAgent<T extends { orgId: string }>(col: string, agentId: string, orgId: string): Promise<T[]> {
  const snap = await db().collection(col).where("agentId", "==", agentId).get();
  return snap.docs.map((d) => d.data() as T).filter((r) => r.orgId === orgId);
}

async function byStatus<T>(col: string, status: string, limit: number): Promise<T[]> {
  const snap = await db().collection(col).where("status", "==", status).limit(limit).get();
  return snap.docs.map((d) => d.data() as T);
}

async function ownDoc<T extends { agentId: string; orgId: string }>(col: string, id: string, agentId: string, orgId: string): Promise<T | null> {
  const row = (await db().collection(col).doc(id).get()).data() as T | undefined;
  return row && row.agentId === agentId && row.orgId === orgId ? row : null;
}

// ── Standing orders ──────────────────────────────────────────────────────

export async function createOrder(order: Omit<StandingOrder, "id">): Promise<StandingOrder> {
  const open = (await forAgent<StandingOrder>(ORDERS, order.agentId, order.orgId)).filter((o) => o.status === "open");
  if (open.length >= MAX_OPEN_ORDERS) throw new PaperTradeError(`This agent already has ${MAX_OPEN_ORDERS} open orders — cancel one first`);
  const row = { ...order, id: newId("ord") };
  await db().collection(ORDERS).doc(row.id).set(clean(row));
  return row;
}

export async function listOrders(agentId: string, orgId: string): Promise<StandingOrder[]> {
  return newestFirst(await forAgent<StandingOrder>(ORDERS, agentId, orgId));
}

export const openOrders = (limit = 200) => byStatus<StandingOrder>(ORDERS, "open", limit);

export async function cancelOrder(id: string, agentId: string, orgId: string): Promise<StandingOrder | null> {
  const ref = db().collection(ORDERS).doc(id);
  return db().runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data() as StandingOrder | undefined;
    if (!row || row.agentId !== agentId || row.orgId !== orgId) return null;
    if (row.status !== "open") throw new PaperTradeError(`Order ${id} is already ${row.status}`);
    const next = { ...row, status: "cancelled" as const, closedAt: new Date().toISOString() };
    tx.set(ref, next);
    return next;
  });
}

/**
 * Moves an open order to "filling" so two overlapping ticks can't both fill
 * it. False when another tick (or a cancel) got there first.
 */
export async function claimOrder(id: string): Promise<boolean> {
  const ref = db().collection(ORDERS).doc(id);
  return db().runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data() as StandingOrder | undefined;
    if (!row || row.status !== "open") return false;
    tx.set(ref, { ...row, status: "filling" });
    return true;
  });
}

export async function updateOrder(id: string, patch: Partial<StandingOrder>): Promise<void> {
  await db().collection(ORDERS).doc(id).set(clean(patch), { merge: true });
}

// ── Watches ──────────────────────────────────────────────────────────────

export async function createWatch(watch: NewRow<Watch>): Promise<Watch> {
  const active = (await forAgent<Watch>(WATCHES, watch.agentId, watch.orgId)).filter((w) => w.status === "active");
  if (active.length >= MAX_ACTIVE_WATCHES) throw new PaperTradeError(`This agent already has ${MAX_ACTIVE_WATCHES} active watches — cancel one first`);
  const row = { ...watch, id: newId("wch") } as Watch;
  await db().collection(WATCHES).doc(row.id).set(clean(row));
  return row;
}

export async function listWatches(agentId: string, orgId: string): Promise<Watch[]> {
  return newestFirst(await forAgent<Watch>(WATCHES, agentId, orgId));
}

export const activeWatches = (limit = 300) => byStatus<Watch>(WATCHES, "active", limit);

export async function cancelWatch(id: string, agentId: string, orgId: string): Promise<Watch | null> {
  const row = await ownDoc<Watch>(WATCHES, id, agentId, orgId);
  if (!row) return null;
  if (row.status !== "active") throw new PaperTradeError(`Watch ${id} is already ${row.status}`);
  await updateWatch(id, { status: "cancelled" });
  return { ...row, status: "cancelled" };
}

export async function updateWatch(id: string, patch: Partial<Watch>): Promise<void> {
  await db().collection(WATCHES).doc(id).set(clean(patch), { merge: true });
}

// ── Payment requests ─────────────────────────────────────────────────────

export async function createPaymentRequest(req: Omit<PaymentRequest, "id">): Promise<PaymentRequest> {
  const open = (await forAgent<PaymentRequest>(PAYMENTS, req.agentId, req.orgId)).filter((r) => r.status === "pending");
  if (open.length >= MAX_OPEN_PAYMENT_REQUESTS) throw new PaperTradeError(`This agent already has ${MAX_OPEN_PAYMENT_REQUESTS} pending payment requests — cancel one first`);
  const row = { ...req, id: newId("pay") };
  await db().collection(PAYMENTS).doc(row.id).set(clean(row));
  return row;
}

export async function listPaymentRequests(agentId: string, orgId: string): Promise<PaymentRequest[]> {
  return newestFirst(await forAgent<PaymentRequest>(PAYMENTS, agentId, orgId));
}

export async function getPaymentRequest(id: string, agentId: string, orgId: string): Promise<PaymentRequest | null> {
  return ownDoc<PaymentRequest>(PAYMENTS, id, agentId, orgId);
}

export const pendingPaymentRequests = (limit = 200) => byStatus<PaymentRequest>(PAYMENTS, "pending", limit);

export async function updatePaymentRequest(id: string, patch: Partial<PaymentRequest>): Promise<void> {
  await db().collection(PAYMENTS).doc(id).set(clean(patch), { merge: true });
}

// ── Alerts ───────────────────────────────────────────────────────────────

export async function pushAlert(alert: Omit<Alert, "id" | "at" | "read">): Promise<Alert> {
  const now = Date.now();
  const row: Alert = { ...alert, id: reverseId(now), at: new Date(now).toISOString(), read: false };
  await db().collection(ALERTS).doc(row.id).set(clean(row));
  return row;
}

/** Newest first. Doc ids sort newest-first, so this needs no index. */
export async function listAlerts(agentId: string, orgId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Alert[]> {
  const snap = await db().collection(ALERTS).where("agentId", "==", agentId).orderBy("__name__").limit(Math.min(opts.limit ?? 50, 200)).get();
  return snap.docs.map((d) => d.data() as Alert).filter((a) => a.orgId === orgId && (!opts.unreadOnly || !a.read));
}

export async function markAlertsRead(agentId: string, orgId: string, ids: string[]): Promise<number> {
  let n = 0;
  for (const id of ids.slice(0, 200)) {
    const ref = db().collection(ALERTS).doc(id);
    const row = (await ref.get()).data() as Alert | undefined;
    if (!row || row.agentId !== agentId || row.orgId !== orgId || row.read) continue;
    await ref.set({ read: true }, { merge: true });
    n++;
  }
  return n;
}

// ── Tick lock ────────────────────────────────────────────────────────────

export async function acquireSolanaTickLock(holder: string, ttlMs = 50_000, now = Date.now()): Promise<boolean> {
  const ref = db().collection(TICK).doc("lock");
  return db().runTransaction(async (tx) => {
    const until = Number(((await tx.get(ref)).data() as { until?: number } | undefined)?.until ?? 0);
    if (until > now) return false;
    tx.set(ref, { holder, until: now + ttlMs });
    return true;
  });
}

export async function releaseSolanaTickLock(holder: string): Promise<void> {
  const ref = db().collection(TICK).doc("lock");
  await db().runTransaction(async (tx) => {
    if (((await tx.get(ref)).data() as { holder?: string } | undefined)?.holder === holder) tx.set(ref, { holder: null, until: 0 });
  });
}
