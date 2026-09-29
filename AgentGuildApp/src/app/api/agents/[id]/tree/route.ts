/**
 * GET /api/agents/:id/tree
 *
 * Get the hierarchical tree structure for an agent and its descendants.
 * Query: ?orgId=xxx
 */

import { NextRequest } from "next/server";
import { getAgentTree } from "@/lib/agent-hierarchy";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: agentId } = await params;
  const { searchParams } = new URL(request.url);
  const orgId = searchParams.get("orgId");

  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  try {
    const tree = await getAgentTree(orgId, agentId);

    return Response.json({
      ok: true,
      tree,
    });
  } catch (err) {
    console.error("Get agent tree error:", err);
    return Response.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to get agent tree",
      },
      { status: 500 }
    );
  }
}
