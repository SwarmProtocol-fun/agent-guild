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
 *   dimosBenchEpisodes — DimSim training attempts (human demos and agent
 *                    runs), with per-step camera frames in a subcollection.
 *   dimosBenchDrive  — one relay document per attempt an agent drives with
 *                    its own model: the latest camera view and its next move.
 *
 * Queries use single-field filters and sort in memory, so no composite
 * index is needed. Server-only (Firebase Admin SDK).
 */
import type { Query } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import type { DriveRelay, Episode, EpisodeStep } from "./training";
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

// ── DimSim training episodes ─────────────────────────────────────────────
// dimosBenchEpisodes/{id} holds the episode; its steps (each with a camera
// frame) live in the `steps` subcollection so the episode document stays small.

const EPISODES = "dimosBenchEpisodes";

export async function createEpisode(ep: Omit<Episode, "id">): Promise<Episode> {
  const ref = db().collection(EPISODES).doc();
  const doc: Episode = { ...ep, id: ref.id };
  await ref.set(doc);
  return doc;
}

export async function getEpisode(id: string): Promise<Episode | null> {
  const snap = await db().collection(EPISODES).doc(id).get();
  return snap.exists ? (snap.data() as Episode) : null;
}

export async function updateEpisode(id: string, patch: Partial<Episode>): Promise<void> {
  await db().collection(EPISODES).doc(id).update(patch);
}

export async function addSteps(episodeId: string, steps: EpisodeStep[]): Promise<void> {
  const batch = db().batch();
  const col = db().collection(EPISODES).doc(episodeId).collection("steps");
  for (const s of steps) batch.set(col.doc(String(s.i).padStart(3, "0")), s);
  await batch.commit();
}

export async function getSteps(episodeId: string, withImages = true): Promise<EpisodeStep[]> {
  let q: Query = db().collection(EPISODES).doc(episodeId).collection("steps").orderBy("i");
  if (!withImages) q = q.select("i", "pose", "action", "distance", "blocked", "thought", "look");
  const snap = await q.get();
  return snap.docs.map((d) => {
    const step = d.data() as Partial<EpisodeStep>;
    return { ...step, jpeg: step.jpeg ?? "" } as EpisodeStep;
  });
}

/** The camera frames before the last `n` moves (look-around steps skipped), oldest first. */
export async function getRecentFrames(episodeId: string, n: number): Promise<string[]> {
  const snap = await db().collection(EPISODES).doc(episodeId).collection("steps").orderBy("i", "desc").limit(n + 4).get();
  return snap.docs
    .map((d) => d.data() as Partial<EpisodeStep>)
    .filter((s) => !s.look && s.jpeg)
    .slice(0, n)
    .map((s) => s.jpeg!)
    .reverse();
}

/** An agent's episodes, newest first. */
export async function listEpisodes(agentId: string, max = 200): Promise<Episode[]> {
  const snap = await db().collection(EPISODES).where("agentId", "==", agentId).limit(SCAN_LIMIT).get();
  return snap.docs
    .map((d) => d.data() as Episode)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, max);
}

// ── Drive relay (an agent driving with its own model) ────────────────────
// The panel runs the sim and posts what the robot sees; the agent reads it
// and posts a move; the panel runs the move. Both sides long-poll the one
// relay document (waitForRelay) instead of polling on a timer.

const DRIVE = "dimosBenchDrive";

export async function setRelay(relay: DriveRelay): Promise<void> {
  await db().collection(DRIVE).doc(relay.episodeId).set(relay);
}

export async function getRelay(episodeId: string): Promise<DriveRelay | null> {
  const snap = await db().collection(DRIVE).doc(episodeId).get();
  return snap.exists ? (snap.data() as DriveRelay) : null;
}

export async function updateRelay(episodeId: string, patch: Partial<DriveRelay>): Promise<void> {
  await db().collection(DRIVE).doc(episodeId).update({ ...patch, updatedAt: new Date().toISOString() });
}

/**
 * Atomically set the agent's move, if the relay is still waiting for a move
 * on observation `seq` (so a retried or stale request can't move twice).
 */
export async function claimMove(episodeId: string, move: DriveRelay["move"] & object): Promise<"ok" | "stale" | "ended"> {
  const ref = db().collection(DRIVE).doc(episodeId);
  return db().runTransaction(async (tx) => {
    const r = (await tx.get(ref)).data() as DriveRelay | undefined;
    if (!r || r.ended) return "ended";
    if (r.move || r.obs?.seq !== move.seq) return "stale";
    tx.update(ref, { move, updatedAt: new Date().toISOString() });
    return "ok";
  });
}

/** The running relay an agent is driving, newest first (null when none). */
export async function activeRelay(agentId: string): Promise<DriveRelay | null> {
  const snap = await db().collection(DRIVE).where("agentId", "==", agentId).limit(SCAN_LIMIT).get();
  return (
    snap.docs
      .map((d) => d.data() as DriveRelay)
      .filter((r) => !r.ended)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
  );
}

/** Resolve with the relay as soon as `ready(relay)` holds, or with the latest state after `ms`. */
export function waitForRelay(episodeId: string, ready: (r: DriveRelay) => boolean, ms: number): Promise<DriveRelay | null> {
  return new Promise((resolve) => {
    let last: DriveRelay | null = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(last);
    };
    const timer = setTimeout(done, ms);
    const unsubscribe = db()
      .collection(DRIVE)
      .doc(episodeId)
      .onSnapshot(
        (snap) => {
          last = snap.exists ? (snap.data() as DriveRelay) : null;
          if (!last || ready(last)) done();
        },
        () => done(),
      );
  });
}
