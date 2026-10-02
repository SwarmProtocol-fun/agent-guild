/**
 * dimos-bench — Firestore persistence.
 *
 * Collection:
 *   dimosBenchRuns — one document per submitted dimos eval run, per-case
 *                    results inline (capped at MAX_CASES, text truncated,
 *                    so a document stays well under Firestore's 1 MiB).
 *
 * Queries use single-field filters and sort in memory, so no composite
 * index is needed. Server-only (Firebase Admin SDK).
 */
import type { Query } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import type { BenchRun, RunSubmission } from "./bench";

const RUNS = "dimosBenchRuns";
const SCAN_LIMIT = 500;

function db() {
  return adminDb();
}

export async function saveRun(
  run: RunSubmission,
  who: { agentId: string; agentName: string; orgId: string },
): Promise<BenchRun> {
  const ref = db().collection(RUNS).doc();
  const doc: BenchRun = { ...run, ...who, id: ref.id, createdAt: new Date().toISOString() };
  await ref.set(doc);
  return doc;
}

export async function getRun(id: string): Promise<BenchRun | null> {
  const snap = await db().collection(RUNS).doc(id).get();
  return snap.exists ? (snap.data() as BenchRun) : null;
}

/** Newest first. Filter by suite or agent (one at a time keeps it index-free). */
export async function listRuns(filter: { suite?: string; agentId?: string } = {}): Promise<BenchRun[]> {
  let query: Query = db().collection(RUNS);
  if (filter.suite) query = query.where("suite", "==", filter.suite);
  else if (filter.agentId) query = query.where("agentId", "==", filter.agentId);
  else query = query.orderBy("createdAt", "desc");
  const snap = await query.limit(SCAN_LIMIT).get();
  return snap.docs
    .map((d) => d.data() as BenchRun)
    .filter((r) => !filter.agentId || r.agentId === filter.agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
