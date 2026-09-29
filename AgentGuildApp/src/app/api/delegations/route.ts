/**
 * GET /api/delegations
 *
 * Get delegation history for an organization or specific agent.
 * Query: ?orgId=xxx&agentId=xxx&status=pending|in_progress|completed|failed
 *
 * Auth: org membership or platform admin.
 */

import { NextRequest } from "next/server";
import { getDelegations } from "@/lib/agent-hierarchy";
import type { DelegationRecord } from "@/lib/agent-hierarchy";
import { requirePlatformAdminOrOrgMember, forbidden } from "@/lib/auth-guard";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const orgId = searchParams.get("orgId");
  const agentId = searchParams.get("agentId");
  const status = searchParams.get("status") as
    | DelegationRecord["status"]
    | null;

  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  const auth = await requirePlatformAdminOrOrgMember(request, orgId);
  if (!auth.ok) {
    return forbidden(auth.error);
  }

  try {
    const delegations = await getDelegations(
      orgId,
      agentId || undefined,
      status || undefined
    );

    return Response.json({
      ok: true,
      delegations,
      count: delegations.length,
    });
  } catch (err) {
    console.error("Get delegations error:", err);
    return Response.json(
      { error: "Failed to get delegations" },
      { status: 500 }
    );
  }
}
