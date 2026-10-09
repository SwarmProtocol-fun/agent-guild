/**
 * Tempo payouts — Firestore, not the server process.
 *
 *   tempoPayouts/{sha256(unit)}   one doc per thing that gets paid
 *
 * A "unit" is an approved job ("job:<jobId>"). Older docs may also be
 * agent-settled tasks ("task:<agentId>:<taskId>") from before payouts moved
 * to the owner's own wallet; they're kept for history only.
 *
 * The doc is created as `pending` when the org owner starts a payment —
 * that reserves the job, so a second tab or a double click can't pay it
 * twice. The owner's wallet then sends the transfer itself; the server finds
 * it on-chain by its memo and flips the doc to `paid` with the tx hash. A
 * pending doc is only deleted (cancelled) after the chain shows no transfer.
 *
 * Lookups are single-field equality on `orgId`; sorting happens here so
 * this does not need a composite index. Admin SDK only.
 */

import { createHash } from "crypto";
import { adminDb } from "@/lib/firebase-admin";

const PAYOUTS = "tempoPayouts";

export type PayoutUnit = { kind: "job"; jobId: string } | { kind: "task"; agentId: string; taskId: string };

export interface TempoPayout {
  orgId: string;
  kind: PayoutUnit["kind"];
  /** The job paid for (kind "job"). */
  jobId?: string;
  jobTitle?: string;
  /** The agent's own task id (kind "task"). */
  taskId?: string;
  agentId: string;
  agentName?: string;
  /** Recipient wallet. */
  to: string;
  amountUsdc: number;
  /** amountUsdc in the token's base units — what the on-chain transfer must carry. */
  amountBase?: string;
  /** Carried in the TIP-20 transfer memo (as 0x…); /verify re-reads it from the chain. */
  resultHash: string;
  /** `pending` = reserved, waiting for the owner's wallet to send it; `paid` = found on-chain. */
  status: "pending" | "paid";
  txSig?: string;
  explorerUrl?: string;
  /** The wallet that pays: the org owner's own wallet (older docs: "agent:<id>" or the platform). */
  paidBy: string;
  /** Tempo block when the payment was started — the on-chain search for the memo starts here. */
  fromBlock?: string;
  createdAt: string;
  paidAt?: string;
}

export type PayoutClaim =
  | { state: "claimed" }
  | { state: "paid"; payout: TempoPayout }
  | { state: "pending" }
  | { state: "conflict" };

export function unitKey(unit: PayoutUnit): string {
  const raw = unit.kind === "job" ? `job:${unit.jobId}` : `task:${unit.agentId}\0${unit.taskId}`;
  return createHash("sha256").update(raw).digest("hex");
}

function alreadyExists(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return e.code === 6 || e.code === "already-exists" || /already exists/i.test(e.message || "");
}

const col = () => adminDb().collection(PAYOUTS);

/** Take the one slot for this unit. The winner pays. */
export async function claimPayout(unit: PayoutUnit, payout: TempoPayout): Promise<PayoutClaim> {
  const ref = col().doc(unitKey(unit));
  try {
    // Firestore isn't configured with ignoreUndefinedProperties — omit, don't write undefined.
    await ref.create(Object.fromEntries(Object.entries(payout).filter(([, v]) => v !== undefined)));
    return { state: "claimed" };
  } catch (err) {
    if (!alreadyExists(err)) throw err;
  }
  const existing = (await ref.get()).data() as TempoPayout | undefined;
  if (!existing) return { state: "pending" };
  if (existing.orgId !== payout.orgId) return { state: "conflict" };
  if (existing.status === "paid") return { state: "paid", payout: existing };
  return { state: "pending" };
}

export async function getPayout(unit: PayoutUnit): Promise<TempoPayout | null> {
  const snap = await col().doc(unitKey(unit)).get();
  return snap.exists ? (snap.data() as TempoPayout) : null;
}

/** Drop reservations — only once the chain shows nothing was sent for them. */
export async function releasePayouts(units: PayoutUnit[]): Promise<void> {
  const batch = adminDb().batch();
  for (const unit of units) batch.delete(col().doc(unitKey(unit)));
  await batch.commit();
}

/**
 * The transfer was found on-chain — record the tx hash. Retried once: if both
 * writes fail the docs stay `pending`, which still blocks a second payment,
 * and the next confirm finds the same transfer again.
 */
export async function markPayoutsPaid(units: PayoutUnit[], tx: { txSig: string; explorerUrl: string; paidBy?: string }): Promise<boolean> {
  const paidAt = new Date().toISOString();
  const update = { status: "paid", txSig: tx.txSig, explorerUrl: tx.explorerUrl, paidAt, ...(tx.paidBy ? { paidBy: tx.paidBy } : {}) };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const batch = adminDb().batch();
      for (const unit of units) {
        batch.update(col().doc(unitKey(unit)), update);
      }
      await batch.commit();
      return true;
    } catch {
      // fall through to the retry
    }
  }
  return false;
}

/** Every payout (paid or in flight) for these orgs, newest first. */
export async function listPayouts(orgIds: string[], limit = 200): Promise<TempoPayout[]> {
  const ids = [...new Set(orgIds.filter(Boolean))].slice(0, 30);
  if (ids.length === 0) return [];
  const snaps = await Promise.all(ids.map((orgId) => col().where("orgId", "==", orgId).get()));
  return snaps
    .flatMap((snap) => snap.docs.map((doc) => doc.data() as TempoPayout))
    .sort((a, b) => ((a.paidAt ?? a.createdAt) < (b.paidAt ?? b.createdAt) ? 1 : -1))
    .slice(0, limit);
}

export async function getPayoutsByTx(txSig: string): Promise<TempoPayout[]> {
  const snap = await col().where("txSig", "==", txSig).get();
  return snap.docs.map((doc) => doc.data() as TempoPayout);
}
