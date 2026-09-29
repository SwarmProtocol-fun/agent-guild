/**
 * PATCH /api/v1/assignments/:id/complete - Mark assignment as completed
 *
 * Authentication: Ed25519 signature required
 */

import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { completeAssignment, getAgentWorkMode } from "@/lib/assignments";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const assignmentId = id;
    const url = request.nextUrl;

    // Extract Ed25519 auth params
    const agentParam = url.searchParams.get("agent");
    const sig = url.searchParams.get("sig");
    const ts = url.searchParams.get("ts");

    if (!agentParam || !sig || !ts) {
      return Response.json(
        { error: "Missing required parameters: agent, sig, ts" },
        { status: 400 }
      );
    }

    // Verify timestamp freshness
    const tsNum = parseInt(ts, 10);
    if (!isTimestampFresh(tsNum)) {
      return Response.json({ error: "Stale timestamp" }, { status: 401 });
    }

    // Verify Ed25519 signature
    const message = `PATCH:/v1/assignments/${assignmentId}/complete:${ts}`;
    const verified = await verifyAgentRequest(agentParam, message, sig);
    if (!verified) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Rate limiting (60 requests/minute)
    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    // Parse request body (optional completion notes)
    const body = await request.json().catch(() => ({}));
    const { completionNotes } = body;

    // Complete assignment
    await completeAssignment(assignmentId, verified.agentId, completionNotes);

    // Get updated work mode
    const workMode = await getAgentWorkMode(verified.agentId);

    return Response.json({
      assignmentId,
      status: "completed",
      completedAt: Date.now(),
      currentLoad: workMode?.currentLoad || 0,
      capacity: workMode?.capacity || 3,
    });
  } catch (err: any) {
    console.error("Complete assignment error:", err);

    // Handle specific errors
    if (err.message?.includes("not found")) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err.message?.includes("not the recipient") || err.message?.includes("not in progress")) {
      return Response.json({ error: err.message }, { status: 403 });
    }

    return Response.json(
      { error: err.message || "Internal error" },
      { status: 500 }
    );
  }
}
