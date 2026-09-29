/**
 * POST /api/v1/credit-ops/disputes — File a dispute
 * GET /api/v1/credit-ops/disputes — List own disputes
 */

import { NextRequest } from "next/server";
import { requirePlatformAdminOrAgent } from "@/lib/auth-guard";
import { fileDispute, listDisputes } from "@/lib/credit-ops/disputes";
import type { DisputeType } from "@/lib/credit-ops/types";

export async function GET(req: NextRequest) {
  const auth = await requirePlatformAdminOrAgent(req);
  if (!auth.ok) return Response.json({ error: "Auth required" }, { status: 403 });

  try {
    const items = await listDisputes({ initiatorId: auth.agent?.agentId || undefined });
    return Response.json({ ok: true, count: items.length, items });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requirePlatformAdminOrAgent(req);
  if (!auth.ok) return Response.json({ error: "Auth required" }, { status: 403 });

  const body = await req.json();
  const { respondentType, respondentId, disputeType, subject, description, evidence, relatedAgentIds, relatedEventIds } = body;

  if (!respondentId || !disputeType || !subject || !description) {
    return Response.json({ error: "respondentId, disputeType, subject, and description required" }, { status: 400 });
  }

  try {
    const id = await fileDispute({
      initiatorType: "agent",
      initiatorId: auth.agent?.agentId || "platform-admin",
      respondentType: respondentType || "platform",
      respondentId,
      disputeType: disputeType as DisputeType,
      subject,
      description,
      evidence,
      relatedAgentIds: relatedAgentIds || [],
      relatedEventIds: relatedEventIds || [],
    });
    return Response.json({ ok: true, id });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
