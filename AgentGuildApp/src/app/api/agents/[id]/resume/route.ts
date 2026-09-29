/**
 * POST /api/agents/[id]/resume
 *
 * Resume a paused agent.
 * Body: { orgId }
 */

import { NextRequest } from "next/server";
import { resumeAgent } from "@/lib/heartbeat";
import { requireOrgMember, getWalletAddress, unauthorized, forbidden } from "@/lib/auth-guard";
import { rateLimit } from "@/app/api/v1/rate-limit";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ip = request.headers.get("x-forwarded-for") || "unknown";
  const limited = await rateLimit(`resume:${ip}`);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { orgId } = body;

  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  // Auth: caller must be a member of the org
  const auth = await requireOrgMember(request, orgId as string);
  if (!auth.ok) {
    return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);
  }

  try {
    await resumeAgent(orgId as string, id);

    return Response.json({
      ok: true,
      message: `Agent ${id} has been resumed`,
    });
  } catch (err) {
    console.error("Resume agent error:", err);
    return Response.json(
      { error: "Failed to resume agent" },
      { status: 500 }
    );
  }
}
