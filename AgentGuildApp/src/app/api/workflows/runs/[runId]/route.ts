/**
 * GET  /api/workflows/runs/:runId?orgId=...  — Get run status + node states
 * POST /api/workflows/runs/:runId            — Advance the run by one step (poll)
 * PATCH /api/workflows/runs/:runId           — Pause/resume/cancel a run
 *
 * Auth: org member (wallet session)
 */

import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { getWorkflowRun } from "@/lib/workflow/store";
import {
  advanceRun,
  cancelRun,
  pauseRun,
  resumeRun,
} from "@/lib/workflow/executor";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { runId } = await params;
  const orgId = req.nextUrl.searchParams.get("orgId");
  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  const orgAuth = await requireOrgMember(req, orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  const run = await getWorkflowRun(runId);
  if (!run || run.orgId !== orgId) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  return Response.json({ ok: true, run });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { runId } = await params;
  let body: { orgId: string };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  const orgAuth = await requireOrgMember(req, body.orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  const run = await getWorkflowRun(runId);
  if (!run || run.orgId !== body.orgId) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  try {
    const updated = await advanceRun(runId);
    return Response.json({ ok: true, run: updated });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to advance run" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { runId } = await params;
  let body: { orgId: string; action: "pause" | "resume" | "cancel" };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.orgId || !body.action) {
    return Response.json({ error: "orgId and action are required" }, { status: 400 });
  }

  const orgAuth = await requireOrgMember(req, body.orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  const run = await getWorkflowRun(runId);
  if (!run || run.orgId !== body.orgId) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  try {
    switch (body.action) {
      case "pause":
        await pauseRun(runId);
        break;
      case "resume":
        await resumeRun(runId);
        break;
      case "cancel":
        await cancelRun(runId);
        break;
      default:
        return Response.json({ error: "action must be pause, resume, or cancel" }, { status: 400 });
    }

    const updated = await getWorkflowRun(runId);
    return Response.json({ ok: true, run: updated });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to update run" },
      { status: 500 },
    );
  }
}
