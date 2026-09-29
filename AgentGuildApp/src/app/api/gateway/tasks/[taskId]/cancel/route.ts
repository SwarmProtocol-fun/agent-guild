/**
 * POST /api/gateway/tasks/:taskId/cancel — Cancel a gateway task
 *
 * Auth: org member (wallet session) OR internal service
 *
 * Behaviour by task status:
 *   - queued / claimed  → mark as "cancelled" directly in Firestore
 *   - running           → publish cancel message via Redis to the worker,
 *                          then mark as "cancelled"
 *   - completed / failed / timeout / cancelled → no-op (already terminal)
 */

import { NextRequest } from "next/server";
import {
  getWalletAddress,
  requireOrgMember,
  requireInternalService,
} from "@/lib/auth-guard";
import { getTask, updateTask } from "@/lib/gateway/store";
import { getRedis } from "@/lib/redis";

interface RouteContext {
  params: Promise<{ taskId: string }>;
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const { taskId } = await ctx.params;

  // Retrieve the task first so we can check orgId for auth
  const task = await getTask(taskId);
  if (!task) {
    return Response.json({ error: "Task not found" }, { status: 404 });
  }

  // Auth: internal service OR org member
  const serviceAuth = requireInternalService(req);
  if (!serviceAuth.ok) {
    const wallet = getWalletAddress(req);
    if (!wallet) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const orgAuth = await requireOrgMember(req, task.orgId);
    if (!orgAuth.ok) {
      return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
    }
  }

  // Determine actor for audit trail
  const actor =
    getWalletAddress(req) || (serviceAuth.ok ? "internal-service" : "unknown");

  // Terminal statuses — nothing to cancel
  const terminalStatuses = new Set(["completed", "failed", "timeout", "cancelled"]);
  if (terminalStatuses.has(task.status)) {
    return Response.json({
      ok: false,
      error: `Task is already in terminal status: ${task.status}`,
    }, { status: 409 });
  }

  try {
    if (task.status === "running") {
      // Task is actively running on a worker — publish cancel via Redis
      // so the connected gateway receives it in real-time
      const redis = getRedis();
      if (redis && task.claimedBy) {
        try {
          await redis.publish(
            `gateway:cancel:${task.claimedBy}`,
            JSON.stringify({ type: "job:cancel", taskId, ts: Date.now() }),
          );
        } catch {
          // Redis publish failure is non-fatal — we still mark cancelled
        }
      }
    }

    // Mark the task as cancelled
    await updateTask(taskId, {
      status: "cancelled",
      error: `Cancelled by ${actor}`,
      completedAt: Date.now(),
    });

    // Release claim lock in Redis
    const redis = getRedis();
    if (redis) {
      try {
        await redis.del(`gateway:claim:${taskId}`);
      } catch {
        // non-fatal
      }
    }

    return Response.json({ ok: true, taskId, previousStatus: task.status });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to cancel task" },
      { status: 500 },
    );
  }
}
