/**
 * Pull-Based Gateway — Firestore persistence.
 *
 * Collections:
 *   gatewayWorkers — registered workers with heartbeat
 *   gatewayTaskQueue — task queue (pull-based)
 *
 * Server-only (Firebase Admin SDK) — verified no client-side importers
 * before converting from the client SDK.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, type Query } from "firebase-admin/firestore";
import type {
  GatewayWorker,
  QueuedTask,
  QueuedTaskStatus,
  WorkerStatus,
  TaskPriority,
  JobLogEntry,
} from "./types";

const WORKERS = "gatewayWorkers";
const QUEUE = "gatewayTaskQueue";
const JOB_LOGS = "gatewayJobLogs";

function db() {
  return adminDb();
}

// ── Workers ──────────────────────────────────────────────────────────────────

export async function registerWorker(
  data: Omit<GatewayWorker, "id" | "registeredAt" | "updatedAt" | "lastHeartbeat">,
): Promise<string> {
  const ref = await db().collection(WORKERS).add({
    ...data,
    lastHeartbeat: FieldValue.serverTimestamp(),
    registeredAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getWorker(id: string): Promise<GatewayWorker | null> {
  const snap = await db().collection(WORKERS).doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as GatewayWorker;
}

export async function updateWorker(
  id: string,
  data: Partial<Pick<GatewayWorker, "status" | "resources" | "capabilities" | "region">>,
): Promise<void> {
  await db().collection(WORKERS).doc(id).update({
    ...data,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function heartbeatWorker(
  id: string,
  resources?: Partial<GatewayWorker["resources"]>,
): Promise<void> {
  const update: Record<string, unknown> = {
    lastHeartbeat: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (resources) update.resources = resources;
  await db().collection(WORKERS).doc(id).update(update);
}

export async function deregisterWorker(id: string): Promise<void> {
  await db().collection(WORKERS).doc(id).delete();
}

export async function getOrgWorkers(
  orgId: string,
  status?: WorkerStatus,
): Promise<GatewayWorker[]> {
  let q: Query = db().collection(WORKERS).where("orgId", "==", orgId);
  if (status) q = q.where("status", "==", status);
  q = q.orderBy("lastHeartbeat", "desc").limit(100);
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as GatewayWorker);
}

export async function getAvailableWorkers(
  orgId: string,
): Promise<GatewayWorker[]> {
  const snap = await db().collection(WORKERS)
    .where("orgId", "==", orgId)
    .where("status", "in", ["idle", "busy"])
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as GatewayWorker);
}

// ── Task Queue ───────────────────────────────────────────────────────────────

export async function enqueueTask(
  data: Omit<QueuedTask, "id" | "createdAt" | "updatedAt" | "retriesUsed" | "status">,
): Promise<string> {
  const ref = await db().collection(QUEUE).add({
    ...data,
    status: "queued",
    retriesUsed: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getTask(id: string): Promise<QueuedTask | null> {
  const snap = await db().collection(QUEUE).doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as QueuedTask;
}

export async function updateTask(
  id: string,
  data: Partial<
    Pick<QueuedTask, "status" | "claimedBy" | "claimedAt" | "result" | "error" | "retriesUsed" | "completedAt">
  >,
): Promise<void> {
  await db().collection(QUEUE).doc(id).update({
    ...data,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Get queued tasks for a specific org, ordered by priority then age.
 * Workers call this to find tasks to claim.
 */
export async function getQueuedTasks(
  orgId: string,
  taskTypes: string[],
  max = 10,
): Promise<QueuedTask[]> {
  // Query for queued tasks matching the worker's supported types
  const snap = await db().collection(QUEUE)
    .where("orgId", "==", orgId)
    .where("status", "==", "queued")
    .where("taskType", "in", taskTypes.slice(0, 10)) // Firestore 'in' max 10
    .orderBy("createdAt", "asc")
    .limit(max)
    .get();
  const tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as QueuedTask);

  // Sort by priority (highest first) then by creation time (oldest first)
  const priorityOrder: Record<TaskPriority, number> = {
    critical: 0, high: 1, normal: 2, low: 3,
  };
  tasks.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 2;
    const pb = priorityOrder[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    return 0; // Already ordered by createdAt from Firestore
  });

  return tasks;
}

/**
 * Get tasks claimed by a specific worker (for status reporting).
 */
export async function getWorkerTasks(
  workerId: string,
): Promise<QueuedTask[]> {
  const snap = await db().collection(QUEUE)
    .where("claimedBy", "==", workerId)
    .where("status", "in", ["claimed", "running"])
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as QueuedTask);
}

/**
 * Get org task queue summary.
 */
export async function getQueueStats(orgId: string): Promise<{
  queued: number;
  running: number;
  completed: number;
  failed: number;
}> {
  const statuses: QueuedTaskStatus[] = ["queued", "claimed", "running", "completed", "failed"];
  const counts: Record<string, number> = {};

  for (const status of statuses) {
    const snap = await db().collection(QUEUE)
      .where("orgId", "==", orgId)
      .where("status", "==", status)
      .get();
    counts[status] = snap.size;
  }

  return {
    queued: counts.queued || 0,
    running: (counts.claimed || 0) + (counts.running || 0),
    completed: counts.completed || 0,
    failed: counts.failed || 0,
  };
}

// ── Job Logs ─────────────────────────────────────────────────────────────────

export async function appendJobLogs(
  taskId: string,
  workerId: string,
  orgId: string,
  lines: string[],
): Promise<string> {
  const ref = await db().collection(JOB_LOGS).add({
    taskId,
    workerId,
    orgId,
    lines,
    timestamp: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getJobLogs(
  taskId: string,
  since?: number,
): Promise<JobLogEntry[]> {
  const snap = await db().collection(JOB_LOGS)
    .where("taskId", "==", taskId)
    .orderBy("timestamp", "asc")
    .limit(500)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as JobLogEntry);
}

/**
 * Get tasks for a specific org with optional status filter and pagination.
 */
export async function getOrgTasks(
  orgId: string,
  status?: QueuedTaskStatus,
  max = 50,
  offsetCount = 0,
): Promise<QueuedTask[]> {
  let q: Query = db().collection(QUEUE).where("orgId", "==", orgId);
  if (status) q = q.where("status", "==", status);
  q = q.orderBy("createdAt", "desc").limit(max + offsetCount);
  const snap = await q.get();
  const tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as QueuedTask);
  return tasks.slice(offsetCount);
}
