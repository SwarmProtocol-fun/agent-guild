/**
 * Pull-Based Gateway Runtime — Task scheduling and worker matching.
 *
 * Workers pull tasks by calling `pullTasks(workerId)`.
 * The runtime matches tasks to workers based on:
 *   1. Task type compatibility (worker.capabilities.taskTypes)
 *   2. Resource availability (worker has enough CPU/memory headroom)
 *   3. Tag requirements (worker has all required tags)
 *   4. Priority ordering (critical > high > normal > low)
 *
 * Task lifecycle:
 *   queued → claimed → running → completed/failed/timeout
 *
 * Claims are atomic: only one worker can claim a task.
 * Timeout detection: stale claimed tasks are re-queued.
 */

import { getRedis } from "@/lib/redis";
import {
  getWorker,
  getTask,
  updateTask,
  updateWorker,
  heartbeatWorker,
  getQueuedTasks,
  getWorkerTasks,
} from "./store";
import type {
  GatewayWorker,
  QueuedTask,
  TaskResourceRequirements,
  WorkerResources,
} from "./types";

// ── Resource matching ────────────────────────────────────────────────────────

/** Check if a worker can handle a task's resource requirements */
function workerMatchesTask(
  worker: GatewayWorker,
  task: QueuedTask,
): boolean {
  const req = task.resources;
  const res = worker.resources;

  // Check concurrent task limit
  if (res.activeTasks >= res.maxConcurrent) return false;

  // Check CPU
  if (req.minCpuCores && req.minCpuCores > res.maxCpuCores) return false;

  // Check memory
  if (req.minMemoryMb && req.minMemoryMb > res.maxMemoryMb) return false;

  // Check runtime
  if (req.runtime && !worker.capabilities.runtimes.includes(req.runtime)) return false;

  // Check required tags
  if (req.requiredTags) {
    const workerTags = new Set(worker.capabilities.tags);
    if (!req.requiredTags.every((t) => workerTags.has(t))) return false;
  }

  // Check task type
  if (!worker.capabilities.taskTypes.includes(task.taskType)) return false;

  return true;
}

// ── Atomic claim ─────────────────────────────────────────────────────────────

/**
 * Atomically claim a task for a worker using Redis SET NX.
 * Returns true if claim succeeded, false if another worker claimed it first.
 */
async function atomicClaim(taskId: string, workerId: string): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    const key = `gateway:claim:${taskId}`;
    try {
      const result = await redis.set(key, workerId, { nx: true, ex: 300 }); // 5 min lock
      return result !== null; // null = already claimed
    } catch {
      // Redis down — fall through to Firestore-only
    }
  }

  // Fallback: check Firestore status (not truly atomic but acceptable)
  const task = await getTask(taskId);
  return task?.status === "queued";
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Worker pulls tasks from the queue.
 *
 * 1. Fetches queued tasks matching worker capabilities
 * 2. Filters by resource requirements
 * 3. Atomically claims the first matching task
 * 4. Updates worker heartbeat + active task count
 *
 * Returns the claimed task or null if no tasks available.
 */
export async function pullTask(workerId: string): Promise<QueuedTask | null> {
  const worker = await getWorker(workerId);
  if (!worker) throw new Error("Worker not found");
  if (worker.status === "offline" || worker.status === "draining") {
    return null; // Worker is not accepting tasks
  }

  // Get queued tasks for this org matching worker's task types
  const candidates = await getQueuedTasks(
    worker.orgId,
    worker.capabilities.taskTypes,
    20,
  );

  // Find first matching task
  for (const task of candidates) {
    if (!workerMatchesTask(worker, task)) continue;

    // Attempt atomic claim
    if (await atomicClaim(task.id, workerId)) {
      // Claim succeeded — update task and worker
      await updateTask(task.id, {
        status: "claimed",
        claimedBy: workerId,
        claimedAt: Date.now(),
      });

      await heartbeatWorker(workerId, {
        activeTasks: worker.resources.activeTasks + 1,
      });

      // Return the claimed task
      return { ...task, status: "claimed", claimedBy: workerId };
    }
    // Claim failed — another worker got it, try next
  }

  return null; // No tasks available
}

/**
 * Worker reports task as started (running).
 */
export async function reportTaskRunning(
  workerId: string,
  taskId: string,
): Promise<void> {
  const task = await getTask(taskId);
  if (!task) throw new Error("Task not found");
  if (task.claimedBy !== workerId) throw new Error("Task not claimed by this worker");

  await updateTask(taskId, { status: "running" });
}

/**
 * Worker reports task completion with result.
 */
export async function reportTaskComplete(
  workerId: string,
  taskId: string,
  result: unknown,
): Promise<void> {
  const task = await getTask(taskId);
  if (!task) throw new Error("Task not found");
  if (task.claimedBy !== workerId) throw new Error("Task not claimed by this worker");

  await updateTask(taskId, {
    status: "completed",
    result,
    completedAt: Date.now(),
  });

  // Decrement worker active tasks
  const worker = await getWorker(workerId);
  if (worker) {
    await heartbeatWorker(workerId, {
      activeTasks: Math.max(0, worker.resources.activeTasks - 1),
    });
  }

  // Release Redis claim lock
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(`gateway:claim:${taskId}`);
    } catch {
      // ignore
    }
  }

  // Fire callback if configured
  if (task.callbackUrl) {
    try {
      await fetch(task.callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          status: "completed",
          result,
          completedAt: Date.now(),
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Callback failure is non-fatal
    }
  }
}

/**
 * Worker reports task failure.
 */
export async function reportTaskFailed(
  workerId: string,
  taskId: string,
  error: string,
): Promise<void> {
  const task = await getTask(taskId);
  if (!task) throw new Error("Task not found");
  if (task.claimedBy !== workerId) throw new Error("Task not claimed by this worker");

  // Check if we should retry
  if (task.retriesUsed < task.maxRetries) {
    // Re-queue for retry
    await updateTask(taskId, {
      status: "queued" as const,
      claimedBy: undefined,
      error,
      retriesUsed: task.retriesUsed + 1,
    });
  } else {
    // Max retries exhausted
    await updateTask(taskId, {
      status: "failed",
      error,
      completedAt: Date.now(),
    });

    // Move to dead letter queue for later inspection / retry
    try {
      await moveToDeadLetter(task, error);
    } catch {
      // DLQ write failure is non-fatal — the task is already marked failed
    }
  }

  // Decrement worker active tasks
  const worker = await getWorker(workerId);
  if (worker) {
    await heartbeatWorker(workerId, {
      activeTasks: Math.max(0, worker.resources.activeTasks - 1),
    });
  }

  // Release claim lock
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(`gateway:claim:${taskId}`);
    } catch {
      // ignore
    }
  }

  // Fire callback if configured and this was the final failure
  if (task.callbackUrl && task.retriesUsed >= task.maxRetries) {
    try {
      await fetch(task.callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          status: "failed",
          error,
          completedAt: Date.now(),
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // non-fatal
    }
  }
}

/**
 * Detect timed-out tasks and re-queue them.
 * Should be called periodically (e.g., every 60s by a cron job).
 */
export async function reapTimedOutTasks(orgId: string): Promise<number> {
  // This is a simplified version — in production, use a Firestore query
  // with a composite index on status + claimedAt
  const { adminDb } = await import("@/lib/firebase-admin");

  const snap = await adminDb()
    .collection("gatewayTaskQueue")
    .where("orgId", "==", orgId)
    .where("status", "in", ["claimed", "running"])
    .get();
  const now = Date.now();
  let reaped = 0;

  for (const d of snap.docs) {
    const task = { id: d.id, ...d.data() } as QueuedTask;
    const claimedAt = typeof task.claimedAt === "number"
      ? task.claimedAt
      : (task.claimedAt as { toMillis?: () => number })?.toMillis?.() || 0;

    if (claimedAt && now - claimedAt > task.timeoutMs) {
      if (task.retriesUsed < task.maxRetries) {
        await updateTask(task.id, {
          status: "queued" as const,
          claimedBy: undefined,
          error: "Execution timed out",
          retriesUsed: task.retriesUsed + 1,
        });
      } else {
        await updateTask(task.id, {
          status: "timeout",
          error: "Execution timed out (max retries exhausted)",
          completedAt: now,
        });
      }
      reaped++;
    }
  }

  return reaped;
}

// ── Dead Letter Queue ──────────────────────────────────────────────────────

const DLQ_COLLECTION = "gatewayDeadLetterQueue";

/**
 * Move a permanently failed task to the dead letter queue.
 * Called when a task exhausts max retries.
 */
export async function moveToDeadLetter(
  task: QueuedTask,
  reason: string,
): Promise<string> {
  const { adminDb } = await import("@/lib/firebase-admin");
  const { FieldValue } = await import("firebase-admin/firestore");

  const entry = {
    taskId: task.id,
    orgId: task.orgId,
    taskType: task.taskType,
    payload: task.payload,
    error: reason,
    retriesUsed: task.retriesUsed || 0,
    maxRetries: task.maxRetries || 0,
    originalCreatedAt: task.createdAt,
    movedAt: FieldValue.serverTimestamp(),
  };
  const ref = await adminDb().collection(DLQ_COLLECTION).add(entry);
  return ref.id;
}

// ── Stale Worker Detection ─────────────────────────────────────────────────

/**
 * Detect stale workers and mark them offline.
 * Reassigns their claimed/running tasks back to the queue.
 *
 * A worker is considered stale when its lastHeartbeat is older than
 * the threshold (default 3 minutes = 3x the 60s heartbeat interval).
 *
 * Should be called periodically (e.g., every 60s by a cron job).
 */
export async function reapStaleWorkers(
  orgId: string,
  heartbeatThresholdMs = 180_000, // 3 minutes (3x default 60s heartbeat)
): Promise<{ markedOffline: number; tasksReassigned: number }> {
  const { adminDb } = await import("@/lib/firebase-admin");

  // 1. Query workers that should be alive (idle or busy) for this org
  const snap = await adminDb()
    .collection("gatewayWorkers")
    .where("orgId", "==", orgId)
    .where("status", "in", ["idle", "busy"])
    .get();
  const now = Date.now();
  let markedOffline = 0;
  let tasksReassigned = 0;

  for (const d of snap.docs) {
    const worker = { id: d.id, ...d.data() } as GatewayWorker;

    // Resolve lastHeartbeat to milliseconds (Firestore Timestamp or number)
    const hb = typeof worker.lastHeartbeat === "number"
      ? worker.lastHeartbeat
      : (worker.lastHeartbeat as { toMillis?: () => number })?.toMillis?.() || 0;

    // Skip workers whose heartbeat is fresh
    if (hb && now - hb <= heartbeatThresholdMs) continue;

    // 2a. Mark worker offline
    await updateWorker(worker.id, { status: "offline" });
    markedOffline++;

    // 2b. Get their claimed/running tasks
    const staleTasks = await getWorkerTasks(worker.id);

    // 2c. Re-queue those tasks
    for (const task of staleTasks) {
      if (task.retriesUsed < task.maxRetries) {
        await updateTask(task.id, {
          status: "queued" as const,
          claimedBy: undefined,
          error: `Worker ${worker.id} went offline (stale heartbeat)`,
          retriesUsed: task.retriesUsed + 1,
        });
      } else {
        // Max retries exhausted — mark failed and move to DLQ
        await updateTask(task.id, {
          status: "failed",
          error: `Worker ${worker.id} went offline (stale heartbeat, max retries exhausted)`,
          completedAt: now,
        });
        try {
          await moveToDeadLetter(
            task,
            `Worker ${worker.id} went offline (stale heartbeat, max retries exhausted)`,
          );
        } catch {
          // DLQ write failure is non-fatal
        }
      }
      tasksReassigned++;

      // Release claim lock in Redis
      const redis = getRedis();
      if (redis) {
        try {
          await redis.del(`gateway:claim:${task.id}`);
        } catch {
          // ignore
        }
      }
    }
  }

  return { markedOffline, tasksReassigned };
}
