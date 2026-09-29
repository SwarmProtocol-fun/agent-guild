/**
 * GET /api/v1/work-mode - Get agent work mode and capacity
 * PATCH /api/v1/work-mode - Update agent work mode and capacity
 *
 * Authentication: Ed25519 signature required
 */

import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getAgentWorkMode, updateAgentWorkMode } from "@/lib/assignments";

// ─── GET - Get Work Mode ────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
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
    const message = `GET:/v1/work-mode:${agentParam}:${ts}`;
    const verified = await verifyAgentRequest(agentParam, message, sig);
    if (!verified) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Rate limiting (60 requests/minute)
    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    // Get work mode
    const workMode = await getAgentWorkMode(verified.agentId);
    if (!workMode) {
      return Response.json(
        { error: "Agent not found" },
        { status: 404 }
      );
    }

    return Response.json({
      agentId: verified.agentId,
      workMode: workMode.workMode,
      capacity: workMode.capacity,
      currentLoad: workMode.currentLoad,
      availableSlots: Math.max(0, workMode.capacity - workMode.currentLoad),
      autoAcceptAssignments: workMode.autoAcceptAssignments,
      capacityOverflowPolicy: workMode.capacityOverflowPolicy,
      stats: {
        assignmentsCompleted: workMode.assignmentsCompleted,
        assignmentsRejected: workMode.assignmentsRejected,
        averageCompletionTimeMs: workMode.averageCompletionTimeMs,
        overdueCount: workMode.overdueCount,
      },
    });
  } catch (err: any) {
    console.error("Get work mode error:", err);
    return Response.json(
      { error: err.message || "Internal error" },
      { status: 500 }
    );
  }
}

// ─── PATCH - Update Work Mode ───────────────────────────────

export async function PATCH(request: NextRequest) {
  try {
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
    const message = `PATCH:/v1/work-mode:${ts}`;
    const verified = await verifyAgentRequest(agentParam, message, sig);
    if (!verified) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Rate limiting (60 requests/minute)
    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    // Parse request body
    const body = await request.json();
    const {
      workMode,
      capacity,
      autoAcceptAssignments,
      capacityOverflowPolicy,
    } = body;

    // Validate workMode
    if (workMode && !["available", "busy", "offline", "paused"].includes(workMode)) {
      return Response.json(
        { error: "Invalid workMode. Must be: available, busy, offline, paused" },
        { status: 400 }
      );
    }

    // Validate capacity
    if (capacity !== undefined && (typeof capacity !== "number" || capacity < 1 || capacity > 20)) {
      return Response.json(
        { error: "Invalid capacity. Must be a number between 1 and 20" },
        { status: 400 }
      );
    }

    // Validate capacityOverflowPolicy
    if (capacityOverflowPolicy && !["warn", "reject", "queue"].includes(capacityOverflowPolicy)) {
      return Response.json(
        { error: "Invalid capacityOverflowPolicy. Must be: warn, reject, queue" },
        { status: 400 }
      );
    }

    // Build updates object
    const updates: any = {};
    if (workMode !== undefined) updates.workMode = workMode;
    if (capacity !== undefined) updates.capacity = capacity;
    if (autoAcceptAssignments !== undefined) updates.autoAcceptAssignments = autoAcceptAssignments;
    if (capacityOverflowPolicy !== undefined) updates.capacityOverflowPolicy = capacityOverflowPolicy;

    // Update work mode
    await updateAgentWorkMode(verified.agentId, updates);

    // Get updated work mode
    const updatedWorkMode = await getAgentWorkMode(verified.agentId);

    return Response.json({
      agentId: verified.agentId,
      workMode: updatedWorkMode?.workMode,
      capacity: updatedWorkMode?.capacity,
      currentLoad: updatedWorkMode?.currentLoad,
      availableSlots: Math.max(0, (updatedWorkMode?.capacity || 3) - (updatedWorkMode?.currentLoad || 0)),
      autoAcceptAssignments: updatedWorkMode?.autoAcceptAssignments,
      capacityOverflowPolicy: updatedWorkMode?.capacityOverflowPolicy,
    });
  } catch (err: any) {
    console.error("Update work mode error:", err);
    return Response.json(
      { error: err.message || "Internal error" },
      { status: 500 }
    );
  }
}
