/**
 * POST /api/agents/[id]/pause
 *
 * Pause an agent (prevents message processing).
 * Body: { orgId, pausedBy, reason? }
 *
 * Auth: org membership or platform admin.
 */

import { NextRequest } from "next/server";
import { pauseAgent } from "@/lib/heartbeat";
import { requirePlatformAdminOrOrgMember, forbidden } from "@/lib/auth-guard";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { orgId, pausedBy, reason } = body;

  if (!orgId || !pausedBy) {
    return Response.json(
      { error: "orgId and pausedBy are required" },
      { status: 400 }
    );
  }

  const auth = await requirePlatformAdminOrOrgMember(request, orgId as string);
  if (!auth.ok) {
    return forbidden(auth.error);
  }

  try {
    await pauseAgent(
      orgId as string,
      id,
      pausedBy as string,
      reason as string | undefined
    );

    return Response.json({
      ok: true,
      message: `Agent ${id} has been paused`,
    });
  } catch (err) {
    console.error("Pause agent error:", err);
    return Response.json(
      { error: "Failed to pause agent" },
      { status: 500 }
    );
  }
}
