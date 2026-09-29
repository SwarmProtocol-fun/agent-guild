/**
 * POST /api/v1/credit-ops/appeals — Submit an appeal (agent/org auth)
 * GET /api/v1/credit-ops/appeals — List own appeals
 */

import { NextRequest } from "next/server";
import { requirePlatformAdminOrAgent } from "@/lib/auth-guard";
import { submitAppeal, listAppeals } from "@/lib/credit-ops/appeals";
import type { AppealType } from "@/lib/credit-ops/types";

export async function GET(req: NextRequest) {
  const auth = await requirePlatformAdminOrAgent(req);
  if (!auth.ok) return Response.json({ error: auth.agent ? undefined : "Auth required" }, { status: 403 });

  try {
    const agentId = auth.agent?.agentId;
    const items = await listAppeals({ appellantId: agentId || undefined });
    return Response.json({ ok: true, count: items.length, items });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requirePlatformAdminOrAgent(req);
  if (!auth.ok) return Response.json({ error: "Auth required" }, { status: 403 });

  const body = await req.json();
  const { agentId, asn, orgId, appealType, subject, description, evidence, relatedEventId, requestedOutcome } = body;

  if (!agentId || !appealType || !subject || !description) {
    return Response.json({ error: "agentId, appealType, subject, and description required" }, { status: 400 });
  }

  try {
    const id = await submitAppeal({
      appellantType: auth.agent ? "agent" : "org_owner",
      appellantId: auth.agent?.agentId || "platform-admin",
      agentId,
      asn: asn || "",
      orgId: orgId || auth.agent?.orgId || "",
      appealType: appealType as AppealType,
      subject,
      description,
      evidence,
      relatedEventId,
      requestedOutcome,
    });
    return Response.json({ ok: true, id });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
