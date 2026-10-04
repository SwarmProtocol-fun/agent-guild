/**
 * Solana job receipts — Firestore, not the server process.
 *
 * A Netlify isolate dies on the next cold start, and the old module-level
 * array died with it. The World's Fair demo re-reads these rows after a
 * refresh, then checks the memo on chain. Admin SDK only.
 *
 *   solanaSettlements/{txSig}          the receipt
 *   solanaSettlementKeys/{sha256}      agentId + taskId → txSig
 *
 * The key doc is created before the transfer. A retry finds it and returns
 * the first receipt instead of paying again. Lookups are single-field
 * equality (`orgId` or `agentId`). Sorting happens here so this does not
 * need a composite index.
 */

import { createHash } from "crypto";
import { adminDb } from "@/lib/firebase-admin";

const SETTLEMENTS = "solanaSettlements";
const KEYS = "solanaSettlementKeys";

export interface SolanaSettlementRecord {
  orgId: string;
  agentId: string;
  taskId: string;
  txSig: string;
  explorerUrl: string;
  amountUsdc: number;
  resultHash: string;
  reputationUpdated: boolean;
  at: string;
}

export type SettlementClaim =
  | { state: "claimed" }
  | { state: "done"; record: SolanaSettlementRecord }
  | { state: "pending" }
  | { state: "conflict" };

function taskKey(agentId: string, taskId: string): string {
  return createHash("sha256").update(`${agentId}\0${taskId}`).digest("hex");
}

function alreadyExists(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return e.code === 6 || e.code === "already-exists" || /already exists/i.test(e.message || "");
}

export async function getSolanaSettlement(txSig: string): Promise<SolanaSettlementRecord | null> {
  const snap = await adminDb().collection(SETTLEMENTS).doc(txSig).get();
  if (!snap.exists) return null;
  return snap.data() as SolanaSettlementRecord;
}

/**
 * Take the one slot for this agent+task. The winner pays. Everyone else
 * either gets the finished receipt or is told the payment is in flight.
 */
export async function claimSolanaSettlement(agentId: string, taskId: string, orgId: string): Promise<SettlementClaim> {
  const ref = adminDb().collection(KEYS).doc(taskKey(agentId, taskId));
  try {
    await ref.create({ orgId, agentId, taskId, status: "pending", at: new Date().toISOString() });
    return { state: "claimed" };
  } catch (err) {
    if (!alreadyExists(err)) throw err;
  }

  const snap = await ref.get();
  const data = snap.data();
  if (!data) return { state: "pending" };
  if (data.orgId !== orgId) return { state: "conflict" };
  if ((data.status === "done" || data.status === "paid") && typeof data.txSig === "string") {
    const record = await getSolanaSettlement(data.txSig);
    if (record) return { state: "done", record };
    // The transfer landed and the key recorded the sig, but the receipt
    // doc did not. Rebuild it from the key so a retry still does not pay.
    if (data.status === "paid") {
      return {
        state: "done",
        record: {
          orgId: String(data.orgId),
          agentId: String(data.agentId),
          taskId: String(data.taskId),
          txSig: data.txSig,
          explorerUrl: String(data.explorerUrl || ""),
          amountUsdc: Number(data.amountUsdc),
          resultHash: String(data.resultHash || ""),
          reputationUpdated: Boolean(data.reputationUpdated),
          at: String(data.at || ""),
        },
      };
    }
  }
  return { state: "pending" };
}

/** Drop a claim when the chain call failed before any transfer. */
export async function releaseSolanaSettlementClaim(agentId: string, taskId: string): Promise<void> {
  await adminDb().collection(KEYS).doc(taskKey(agentId, taskId)).delete();
}

export async function saveSolanaSettlement(record: SolanaSettlementRecord): Promise<void> {
  const db = adminDb();
  const batch = db.batch();
  batch.set(db.collection(SETTLEMENTS).doc(record.txSig), record);
  batch.set(db.collection(KEYS).doc(taskKey(record.agentId, record.taskId)), {
    orgId: record.orgId,
    agentId: record.agentId,
    taskId: record.taskId,
    status: "done",
    txSig: record.txSig,
    explorerUrl: record.explorerUrl,
    amountUsdc: record.amountUsdc,
    resultHash: record.resultHash,
    reputationUpdated: record.reputationUpdated,
    at: record.at,
  });
  await batch.commit();
}

/**
 * The transfer already happened and the receipt doc failed to commit.
 * Pin the sig on the claim so the next call returns it instead of paying.
 */
export async function markSolanaSettlementPaid(record: SolanaSettlementRecord): Promise<void> {
  await adminDb().collection(KEYS).doc(taskKey(record.agentId, record.taskId)).set({
    orgId: record.orgId,
    agentId: record.agentId,
    taskId: record.taskId,
    status: "paid",
    txSig: record.txSig,
    explorerUrl: record.explorerUrl,
    amountUsdc: record.amountUsdc,
    resultHash: record.resultHash,
    reputationUpdated: record.reputationUpdated,
    at: record.at,
  });
}

/** Newest first. One query per org, capped, so a wallet in several orgs still works. */
export async function listSolanaSettlements(orgIds: string[], limit = 20): Promise<SolanaSettlementRecord[]> {
  const ids = [...new Set(orgIds.filter(Boolean))].slice(0, 30);
  if (ids.length === 0) return [];
  const snaps = await Promise.all(
    ids.map((orgId) => adminDb().collection(SETTLEMENTS).where("orgId", "==", orgId).get()),
  );
  return snaps
    .flatMap((snap) => snap.docs.map((doc) => doc.data() as SolanaSettlementRecord))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);
}

export async function solanaSettlementTotal(
  orgId: string,
  agentId: string,
): Promise<{ totalUsdc: number; settlementCount: number }> {
  const snap = await adminDb().collection(SETTLEMENTS).where("agentId", "==", agentId).get();
  const rows = snap.docs
    .map((doc) => doc.data() as SolanaSettlementRecord)
    .filter((row) => row.orgId === orgId);
  return {
    totalUsdc: rows.reduce((sum, row) => sum + row.amountUsdc, 0),
    settlementCount: rows.length,
  };
}
