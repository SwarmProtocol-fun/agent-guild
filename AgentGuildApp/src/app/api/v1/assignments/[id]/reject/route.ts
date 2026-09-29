/**
 * POST /api/v1/assignments/:id/reject - Reject a task assignment
 *
 * Authentication: Ed25519 signature required
 */

import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { rejectAssignment } from "@/lib/assignments";

export async function POST(
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
    const message = `POST:/v1/assignments/${assignmentId}/reject:${ts}`;
    const verified = await verifyAgentRequest(agentParam, message, sig);
    if (!verified) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Rate limiting (60 requests/minute)
    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    // Parse request body (required reason)
    const body = await request.json();
    const { reason } = body;

    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      return Response.json(
        { error: "Rejection reason is required" },
        { status: 400 }
      );
    }

    // Reject assignment
    await rejectAssignment(assignmentId, verified.agentId, reason);

    return Response.json({
      assignmentId,
      status: "rejected",
      respondedAt: Date.now(),
      reason,
    });
  } catch (err: any) {
    console.error("Reject assignment error:", err);

    // Handle specific errors
    if (err.message?.includes("not found")) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err.message?.includes("not the recipient") || err.message?.includes("not pending")) {
      return Response.json({ error: err.message }, { status: 403 });
    }

    return Response.json(
      { error: err.message || "Internal error" },
      { status: 500 }
    );
  }
}
