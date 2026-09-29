/**
 * POST /api/gateway/tasks — Enqueue a new task
 *
 * Auth: org member (wallet session) OR internal service
 */

import { NextRequest } from "next/server";
import {
  getWalletAddress,
  requireOrgMember,
  requireInternalService,
} from "@/lib/auth-guard";
import { enqueueTask, getTask } from "@/lib/gateway/store";
import { getRedis } from "@/lib/redis";
import type { TaskPriority, TaskResourceRequirements } from "@/lib/gateway/types";
import { validateCallbackUrl } from "@/lib/url-validation";

interface EnqueueBody {
  orgId: string;
  taskType: string;
  payload: Record<string, unknown>;
  priority?: TaskPriority;
  resources?: TaskResourceRequirements;
  timeoutMs?: number;
  maxRetries?: number;
  idempotencyKey?: string;
  sourceRef?: string;
  callbackUrl?: string;
}

export async function POST(req: NextRequest) {
  // Parse body once — req.json() can only be called once
  let body: EnqueueBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  // Auth: internal service OR org member
  const serviceAuth = requireInternalService(req);
  if (!serviceAuth.ok) {
    const wallet = getWalletAddress(req);
    if (!wallet) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const orgAuth = await requireOrgMember(req, body.orgId);
    if (!orgAuth.ok) {
      return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
    }
  }

  // Validate required fields
  if (!body.taskType || !body.payload) {
    return Response.json(
      { error: "taskType and payload are required" },
      { status: 400 },
    );
  }

  // Validate callbackUrl if provided (SSRF protection)
  if (body.callbackUrl) {
    const cbCheck = validateCallbackUrl(body.callbackUrl);
    if (!cbCheck.ok) {
      return Response.json(
        { error: `Invalid callbackUrl: ${cbCheck.error}` },
        { status: 400 },
      );
    }
  }

  // Idempotency check
  if (body.idempotencyKey) {
    const redis = getRedis();
    if (redis) {
      try {
        const existing = await redis.get(`gateway:idemp:${body.idempotencyKey}`);
        if (existing) {
          const task = await getTask(existing as string);
          if (task) {
            return Response.json({ ok: true, taskId: task.id, deduplicated: true });
          }
        }
      } catch {
        // Redis down — skip idempotency check
      }
    }
  }

  try {
    const taskId = await enqueueTask({
      orgId: body.orgId,
      taskType: body.taskType,
      payload: body.payload,
      priority: body.priority || "normal",
      resources: body.resources || {},
      timeoutMs: Math.max(1_000, Math.min(body.timeoutMs || 60_000, 600_000)),
      maxRetries: Math.max(0, Math.min(body.maxRetries ?? 2, 10)),
      idempotencyKey: body.idempotencyKey,
      sourceRef: body.sourceRef,
      callbackUrl: body.callbackUrl,
    });

    // Store idempotency mapping + notify hub for WebSocket push
    const redis = getRedis();
    if (redis) {
      if (body.idempotencyKey) {
        try {
          await redis.set(`gateway:idemp:${body.idempotencyKey}`, taskId, { ex: 3600 });
        } catch {
          // non-fatal
        }
      }

      // Notify hub so connected gateways receive the job via WebSocket push
      try {
        await redis.publish(
          `gateway:new-task:${body.orgId}`,
          JSON.stringify({ taskId, taskType: body.taskType, ts: Date.now() }),
        );
      } catch {
        // non-fatal — gateways will still pick up via HTTP polling
      }
    }

    return Response.json({ ok: true, taskId });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to enqueue task" },
      { status: 500 },
    );
  }
}
