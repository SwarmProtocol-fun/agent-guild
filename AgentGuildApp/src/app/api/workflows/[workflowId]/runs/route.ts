/**
 * GET  /api/workflows/:workflowId/runs?orgId=...  — List runs for a workflow
 * POST /api/workflows/:workflowId/runs            — Start a new run
 *
 * Auth: org member (wallet session)
 */

import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { getWorkflowDefinition, getWorkflowRuns } from "@/lib/workflow/store";
import { startRun } from "@/lib/workflow/executor";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> },
) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { workflowId } = await params;
  const orgId = req.nextUrl.searchParams.get("orgId");
  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  const orgAuth = await requireOrgMember(req, orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  const def = await getWorkflowDefinition(workflowId);
  if (!def || def.orgId !== orgId) {
    return Response.json({ error: "Workflow not found" }, { status: 404 });
  }

  try {
    const runs = await getWorkflowRuns(workflowId);
    return Response.json({ ok: true, runs });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to list runs" },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> },
) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { workflowId } = await params;
  let body: { orgId: string; triggerInput?: Record<string, unknown> };

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

  const def = await getWorkflowDefinition(workflowId);
  if (!def || def.orgId !== body.orgId) {
    return Response.json({ error: "Workflow not found" }, { status: 404 });
  }

  try {
    const runId = await startRun(workflowId, wallet, body.triggerInput);
    return Response.json({ ok: true, runId });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to start run" },
      { status: 500 },
    );
  }
}
