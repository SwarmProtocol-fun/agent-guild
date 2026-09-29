/**
 * GET  /api/workflows?orgId=...       — List workflow definitions for org
 * POST /api/workflows                 — Create a new workflow definition
 *
 * Auth: org member (wallet session)
 */

import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import {
  createWorkflowDefinition,
  getOrgWorkflows,
} from "@/lib/workflow/store";
import { validateWorkflow } from "@/lib/workflow/executor";

export async function GET(req: NextRequest) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const orgId = req.nextUrl.searchParams.get("orgId");
  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  const orgAuth = await requireOrgMember(req, orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  try {
    const workflows = await getOrgWorkflows(orgId);
    return Response.json({ ok: true, workflows });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to list workflows" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  let body: {
    orgId: string;
    name: string;
    description?: string;
    nodes: unknown[];
    edges: unknown[];
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.orgId || !body.name || !body.nodes) {
    return Response.json({ error: "orgId, name, and nodes are required" }, { status: 400 });
  }

  const orgAuth = await requireOrgMember(req, body.orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  // Validate the DAG
  const errors = validateWorkflow({
    nodes: body.nodes as Parameters<typeof validateWorkflow>[0]["nodes"],
    edges: (body.edges || []) as Parameters<typeof validateWorkflow>[0]["edges"],
  });

  if (errors.length > 0) {
    return Response.json({ error: "Invalid workflow", details: errors }, { status: 400 });
  }

  try {
    const id = await createWorkflowDefinition({
      name: body.name,
      description: body.description,
      orgId: body.orgId,
      nodes: body.nodes as Parameters<typeof createWorkflowDefinition>[0]["nodes"],
      edges: (body.edges || []) as Parameters<typeof createWorkflowDefinition>[0]["edges"],
      createdBy: wallet,
      enabled: true,
    });

    return Response.json({ ok: true, id });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to create workflow" },
      { status: 500 },
    );
  }
}
