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

/** Reserve a run id up front: a run that starts a lineage names it after itself. */
export function newRunId(): string {
  return db().collection(RUNS).doc().id;
}

export async function saveRun(
  id: string,
  run: RunSubmission,
  who: { agentId: string; agentName: string; orgId: string },
  lineage: { lineageId: string; parentRunId: string | null; generation: number },
): Promise<BenchRun> {
  const doc: BenchRun = { ...run, ...who, ...lineage, id, createdAt: new Date().toISOString() };
  await db().collection(RUNS).doc(id).set(doc);
  return doc;
}

export async function getRun(id: string): Promise<BenchRun | null> {
  const snap = await db().collection(RUNS).doc(id).get();
  return snap.exists ? (snap.data() as BenchRun) : null;
}

/** Newest first. Filter by lineage, suite or agent (one at a time keeps it index-free). */
export async function listRuns(
  filter: { lineageId?: string; suite?: string; agentId?: string } = {},
): Promise<BenchRun[]> {
  let query: Query = db().collection(RUNS);
  if (filter.lineageId) query = query.where("lineageId", "==", filter.lineageId);
  else if (filter.suite) query = query.where("suite", "==", filter.suite);
  else if (filter.agentId) query = query.where("agentId", "==", filter.agentId);
  else query = query.orderBy("createdAt", "desc");
  const snap = await query.limit(SCAN_LIMIT).get();
  return snap.docs
    .map((d) => d.data() as BenchRun)
    .filter((r) => !filter.agentId || r.agentId === filter.agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function lineageExists(lineageId: string): Promise<boolean> {
  const snap = await db().collection(RUNS).where("lineageId", "==", lineageId).limit(1).get();
  return !snap.empty;
}

/** A run's ancestors via parentRunId, nearest first, at most `max` deep. */
export async function getAncestors(run: BenchRun, max = 100): Promise<BenchRun[]> {
  const chain: BenchRun[] = [];
  let parentId = run.parentRunId;
  while (parentId && chain.length < max) {
    const parent = await getRun(parentId);
    if (!parent) break;
    chain.push(parent);
    parentId = parent.parentRunId;
  }
  return chain;
}
