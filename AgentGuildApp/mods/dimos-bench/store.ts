/**
 * dimos-bench — Firestore persistence.
 *
 * Collection:
 *   dimosBenchRuns — one document per submitted dimos eval run, per-case
 *                    results inline (capped at MAX_CASES, text truncated,
 *                    so a document stays well under Firestore's 1 MiB).
 *   dimosBenchReplays — one document per (run, case): the robot's path,
 *                    camera keyframes and the agent's actions, uploaded
 *                    after the run. Kept apart so run documents stay small.
 *   dimosBenchJobs   — benchmarks queued from the panel, claimed and run by
 *                    an `agentguild-dimos worker` in the same org.
 *   dimosBenchWorkers — one heartbeat document per worker agent.
 *
 * Queries use single-field filters and sort in memory, so no composite
 * index is needed. Server-only (Firebase Admin SDK).
 */
import type { Query } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { replayBrief, type BenchJob, type BenchRun, type ReplayBrief, type RobotReplay, type RunSubmission } from "./bench";

const RUNS = "dimosBenchRuns";
const REPLAYS = "dimosBenchReplays";
const JOBS = "dimosBenchJobs";
const WORKERS = "dimosBenchWorkers";
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
  who: { agentId: string; agentName: string; orgId: string; ranBy?: string | null; jobId?: string | null },
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

const replayDocId = (runId: string, caseId: string) => `${runId}__${encodeURIComponent(caseId)}`;

export async function saveReplay(replay: RobotReplay): Promise<void> {
  // The brief rides along so listing a run's replays never reads the keyframes.
  await db().collection(REPLAYS).doc(replayDocId(replay.runId, replay.caseId)).set({ ...replay, brief: replayBrief(replay) });
}

export async function getReplay(runId: string, caseId: string): Promise<RobotReplay | null> {
  const snap = await db().collection(REPLAYS).doc(replayDocId(runId, caseId)).get();
  if (!snap.exists) return null;
  const replay = snap.data() as RobotReplay & { brief?: ReplayBrief };
  delete replay.brief;
  return replay;
}

/** Which cases of a run have a replay, without the keyframes. */
export async function listReplays(runId: string): Promise<ReplayBrief[]> {
  const snap = await db().collection(REPLAYS).where("runId", "==", runId).select("brief").get();
  return snap.docs.map((d) => d.get("brief") as ReplayBrief);
}

// ── Jobs ─────────────────────────────────────────────────────────────────

export async function createJob(job: Omit<BenchJob, "id">): Promise<BenchJob> {
  const ref = db().collection(JOBS).doc();
  const doc: BenchJob = { ...job, id: ref.id };
  await ref.set(doc);
  return doc;
}

export async function getJob(id: string): Promise<BenchJob | null> {
  const snap = await db().collection(JOBS).doc(id).get();
  return snap.exists ? (snap.data() as BenchJob) : null;
}

export async function updateJob(id: string, patch: Partial<BenchJob>): Promise<void> {
  await db().collection(JOBS).doc(id).update(patch);
}

/** Newest first, across the given orgs. */
export async function listJobs(orgIds: string[], max = 25): Promise<BenchJob[]> {
  if (!orgIds.length) return [];
  const snaps = await Promise.all(
    orgIds.slice(0, 10).map((orgId) => db().collection(JOBS).where("orgId", "==", orgId).limit(SCAN_LIMIT).get()),
  );
  return snaps
    .flatMap((s) => s.docs.map((d) => d.data() as BenchJob))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, max);
}

/**
 * Hand the org's oldest queued job to this worker, atomically: two workers
 * polling at once can't both get it. Equality-only filters, so no composite index.
 */
export async function claimJob(orgId: string, worker: { agentId: string; name: string }): Promise<BenchJob | null> {
  const queued = await db().collection(JOBS).where("orgId", "==", orgId).where("status", "==", "queued").limit(50).get();
  const candidates = queued.docs.map((d) => d.data() as BenchJob).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const candidate of candidates) {
    const ref = db().collection(JOBS).doc(candidate.id);
    const claimed = await db().runTransaction(async (tx) => {
      const fresh = (await tx.get(ref)).data() as BenchJob | undefined;
      if (!fresh || fresh.status !== "queued") return null;
      const patch = { status: "running" as const, workerAgentId: worker.agentId, workerName: worker.name, startedAt: new Date().toISOString() };
      tx.update(ref, patch);
      return { ...fresh, ...patch };
    });
    if (claimed) return claimed;
  }
  return null;
}

// ── Workers ──────────────────────────────────────────────────────────────

export interface WorkerBeat {
  agentId: string;
  name: string;
  orgId: string;
  lastSeen: string;
  busyJobId: string | null;
}

export async function heartbeat(beat: WorkerBeat): Promise<void> {
  await db().collection(WORKERS).doc(beat.agentId).set(beat);
}

export async function listWorkers(orgIds: string[]): Promise<WorkerBeat[]> {
  if (!orgIds.length) return [];
  const snaps = await Promise.all(
    orgIds.slice(0, 10).map((orgId) => db().collection(WORKERS).where("orgId", "==", orgId).get()),
  );
  return snaps.flatMap((s) => s.docs.map((d) => d.data() as WorkerBeat));
}
