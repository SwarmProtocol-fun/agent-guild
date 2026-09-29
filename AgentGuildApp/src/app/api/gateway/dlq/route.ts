/**
 * Gateway Dead Letter Queue API
 *
 * GET  /api/gateway/dlq?orgId=...         — List DLQ entries
 * POST /api/gateway/dlq  { dlqId, orgId } — Retry a DLQ entry (re-enqueue the task)
 *
 * Auth: org member (wallet session) OR internal service
 */

import { NextRequest } from "next/server";
import {
  getWalletAddress,
  requireOrgMember,
  requireInternalService,
} from "@/lib/auth-guard";
import { adminDb } from "@/lib/firebase-admin";
import { enqueueTask } from "@/lib/gateway/store";

const DLQ_COLLECTION = "gatewayDeadLetterQueue";

// ── Shared auth helper ───────────────────────────────────────────────────────

async function authorise(req: NextRequest, orgId: string): Promise<Response | null> {
  const serviceAuth = requireInternalService(req);
  if (serviceAuth.ok) return null; // authorized

  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const orgAuth = await requireOrgMember(req, orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  return null; // authorized
}

// ── GET: List DLQ entries ────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId");
  if (!orgId) {
    return Response.json({ error: "orgId query param is required" }, { status: 400 });
  }

  const authErr = await authorise(req, orgId);
  if (authErr) return authErr;

  const max = Math.min(
    parseInt(req.nextUrl.searchParams.get("limit") || "50", 10),
    200,
  );

  try {
    const snap = await adminDb().collection(DLQ_COLLECTION)
      .where("orgId", "==", orgId)
      .orderBy("movedAt", "desc")
      .limit(max)
      .get();
    const entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    return Response.json({ ok: true, entries, count: entries.length });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to list DLQ entries" },
      { status: 500 },
    );
  }
}

// ── POST: Retry a DLQ entry (re-enqueue then remove from DLQ) ───────────────

export async function POST(req: NextRequest) {
  let body: { dlqId: string; orgId: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.dlqId || !body.orgId) {
    return Response.json(
      { error: "dlqId and orgId are required" },
      { status: 400 },
    );
  }

  const authErr = await authorise(req, body.orgId);
  if (authErr) return authErr;

  try {
    // 1. Load the DLQ entry
    const dlqRef = adminDb().collection(DLQ_COLLECTION).doc(body.dlqId);
    const dlqSnap = await dlqRef.get();
    if (!dlqSnap.exists) {
      return Response.json({ error: "DLQ entry not found" }, { status: 404 });
    }

    const entry = dlqSnap.data() as {
      taskId: string;
      orgId: string;
      taskType: string;
      payload: Record<string, unknown>;
      maxRetries: number;
      error: string;
    };

    // Verify org ownership
    if (entry.orgId !== body.orgId) {
      return Response.json({ error: "DLQ entry does not belong to this org" }, { status: 403 });
    }

    // 2. Re-enqueue the task with fresh retries
    const newTaskId = await enqueueTask({
      orgId: entry.orgId,
      taskType: entry.taskType,
      payload: entry.payload,
      priority: "normal",
      resources: {},
      timeoutMs: 60_000,
      maxRetries: entry.maxRetries || 2,
      sourceRef: `dlq-retry:${body.dlqId}:original:${entry.taskId}`,
    });

    // 3. Remove from DLQ
    await dlqRef.delete();

    return Response.json({
      ok: true,
      newTaskId,
      removedDlqId: body.dlqId,
      originalTaskId: entry.taskId,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to retry DLQ entry" },
      { status: 500 },
    );
  }
}
