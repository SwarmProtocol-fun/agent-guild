/**
 * POST /api/workflows/runs/:runId/rerun
 *
 * Create a new run that replays from a specific failed step.
 * Preserves completed upstream state, resets the target + downstream nodes.
 *
 * Body: { orgId: string; fromNodeId: string }
 * Auth: org member (wallet session)
 */

import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { getWorkflowRun } from "@/lib/workflow/store";
import { rerunFromStep } from "@/lib/workflow/executor";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { runId } = await params;
  let body: { orgId: string; fromNodeId: string };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.orgId || !body.fromNodeId) {
    return Response.json({ error: "orgId and fromNodeId are required" }, { status: 400 });
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
    const newRunId = await rerunFromStep(runId, body.fromNodeId, wallet);
    return Response.json({ ok: true, newRunId });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to rerun" },
      { status: 500 },
    );
  }
}
