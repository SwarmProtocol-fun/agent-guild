/**
 * POST /api/agents/:id/add-child
 *
 * Add a child agent to a parent agent in the hierarchy.
 * Body: { orgId, childAgentId }
 */

import { NextRequest } from "next/server";
import { addChildAgent } from "@/lib/agent-hierarchy";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const wallet = getWalletAddress(request);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id: parentAgentId } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { orgId, childAgentId } = body;

  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  const orgAuth = await requireOrgMember(request, orgId as string);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  if (!childAgentId) {
    return Response.json(
      { error: "childAgentId is required" },
      { status: 400 }
    );
  }

  try {
    await addChildAgent(
      orgId as string,
      parentAgentId,
      childAgentId as string
    );

    return Response.json({
      ok: true,
      message: "Child agent added successfully",
      parentAgentId,
      childAgentId,
    });
  } catch (err) {
    console.error("Add child agent error:", err);
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to add child agent",
      },
      { status: 500 }
    );
  }
}
