/**
 * GET    /api/workflows/triggers/:triggerId?orgId=...  — Get trigger policy
 * PATCH  /api/workflows/triggers/:triggerId            — Update trigger policy
 * DELETE /api/workflows/triggers/:triggerId?orgId=...  — Delete trigger policy
 *
 * Auth: org member (wallet session)
 */

import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import {
  getTriggerPolicy,
  updateTriggerPolicy,
  deleteTriggerPolicy,
} from "@/lib/workflow/triggers";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ triggerId: string }> },
) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { triggerId } = await params;
  const orgId = req.nextUrl.searchParams.get("orgId");
  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  const orgAuth = await requireOrgMember(req, orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  const policy = await getTriggerPolicy(triggerId);
  if (!policy || policy.orgId !== orgId) {
    return Response.json({ error: "Trigger policy not found" }, { status: 404 });
  }

  return Response.json({ ok: true, policy });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ triggerId: string }> },
) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { triggerId } = await params;
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

  const policy = await getTriggerPolicy(triggerId);
  if (!policy || policy.orgId !== orgId) {
    return Response.json({ error: "Trigger policy not found" }, { status: 404 });
  }

  try {
    const update: Parameters<typeof updateTriggerPolicy>[1] = {};
    if (body.name !== undefined) update.name = body.name as string;
    if (body.description !== undefined) update.description = body.description as string;
    if (body.config !== undefined) update.config = body.config as typeof policy.config;
    if (body.enabled !== undefined) update.enabled = body.enabled as boolean;
    if (body.maxConcurrentRuns !== undefined) update.maxConcurrentRuns = body.maxConcurrentRuns as number;
    if (body.cooldownMs !== undefined) update.cooldownMs = body.cooldownMs as number;
    if (body.staticInput !== undefined) update.staticInput = body.staticInput as Record<string, unknown>;

    await updateTriggerPolicy(triggerId, update);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to update trigger" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ triggerId: string }> },
) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { triggerId } = await params;
  const orgId = req.nextUrl.searchParams.get("orgId");
  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  const orgAuth = await requireOrgMember(req, orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  const policy = await getTriggerPolicy(triggerId);
  if (!policy || policy.orgId !== orgId) {
    return Response.json({ error: "Trigger policy not found" }, { status: 404 });
  }

  try {
    await deleteTriggerPolicy(triggerId);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to delete trigger" },
      { status: 500 },
    );
  }
}
