/**
 * GET  /api/workflows/triggers?orgId=...  — List trigger policies
 * POST /api/workflows/triggers            — Create a trigger policy
 *
 * Auth: org member (wallet session)
 */

import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import {
  createTriggerPolicy,
  getOrgTriggerPolicies,
} from "@/lib/workflow/triggers";
import type { TriggerType, TriggerConfig } from "@/lib/workflow/triggers";
import { getWorkflowDefinition } from "@/lib/workflow/store";

const VALID_TRIGGER_TYPES = new Set<TriggerType>(["cron", "event", "alert", "webhook", "manual"]);

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
    const policies = await getOrgTriggerPolicies(orgId);
    return Response.json({ ok: true, policies });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to list triggers" },
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
    workflowId: string;
    triggerType: TriggerType;
    config: TriggerConfig;
    staticInput?: Record<string, unknown>;
    maxConcurrentRuns?: number;
    cooldownMs?: number;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.orgId || !body.name || !body.workflowId || !body.triggerType) {
    return Response.json(
      { error: "orgId, name, workflowId, and triggerType are required" },
      { status: 400 },
    );
  }

  if (!VALID_TRIGGER_TYPES.has(body.triggerType)) {
    return Response.json(
      { error: `triggerType must be one of: ${[...VALID_TRIGGER_TYPES].join(", ")}` },
      { status: 400 },
    );
  }

  const orgAuth = await requireOrgMember(req, body.orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  // Verify workflow exists and belongs to org
  const workflow = await getWorkflowDefinition(body.workflowId);
  if (!workflow || workflow.orgId !== body.orgId) {
    return Response.json({ error: "Workflow not found" }, { status: 404 });
  }

  try {
    const id = await createTriggerPolicy({
      orgId: body.orgId,
      name: body.name,
      description: body.description,
      workflowId: body.workflowId,
      triggerType: body.triggerType,
      config: body.config || {},
      staticInput: body.staticInput,
      enabled: true,
      maxConcurrentRuns: body.maxConcurrentRuns || 0,
      cooldownMs: body.cooldownMs || 0,
      createdBy: wallet,
    });

    return Response.json({ ok: true, id });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to create trigger" },
      { status: 500 },
    );
  }
}
