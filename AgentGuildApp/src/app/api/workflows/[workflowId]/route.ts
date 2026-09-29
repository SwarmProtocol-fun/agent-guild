/**
 * GET    /api/workflows/:workflowId?orgId=...  — Get workflow definition
 * PATCH  /api/workflows/:workflowId            — Update workflow definition
 * DELETE /api/workflows/:workflowId?orgId=...  — Delete workflow definition
 *
 * Auth: org member (wallet session)
 */

import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import {
  getWorkflowDefinition,
  updateWorkflowDefinition,
  deleteWorkflowDefinition,
} from "@/lib/workflow/store";
import { validateWorkflow } from "@/lib/workflow/executor";

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

  return Response.json({ ok: true, workflow: def });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> },
) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { workflowId } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orgId = body.orgId as string;
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

  // Validate if nodes/edges are being updated
  if (body.nodes || body.edges) {
    const errors = validateWorkflow({
      nodes: (body.nodes || def.nodes) as Parameters<typeof validateWorkflow>[0]["nodes"],
      edges: (body.edges || def.edges) as Parameters<typeof validateWorkflow>[0]["edges"],
    });
    if (errors.length > 0) {
      return Response.json({ error: "Invalid workflow", details: errors }, { status: 400 });
    }
  }

  try {
    const update: Parameters<typeof updateWorkflowDefinition>[1] = {};
    if (body.name !== undefined) update.name = body.name as string;
    if (body.description !== undefined) update.description = body.description as string;
    if (body.nodes !== undefined) update.nodes = body.nodes as typeof def.nodes;
    if (body.edges !== undefined) update.edges = body.edges as typeof def.edges;
    if (body.enabled !== undefined) update.enabled = body.enabled as boolean;

    await updateWorkflowDefinition(workflowId, update);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to update workflow" },
      { status: 500 },
    );
  }
}

export async function DELETE(
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
    await deleteWorkflowDefinition(workflowId);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to delete workflow" },
      { status: 500 },
    );
  }
}
