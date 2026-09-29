/**
 * POST /api/v1/assignments - Create a new task assignment
 * GET /api/v1/assignments - List assignments for an agent
 *
 * Authentication: Ed25519 signature required
 */

import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import {
  createAssignment,
  listAssignments,
  getAssignmentStats,
} from "@/lib/assignments";
import { getAgent } from "@/lib/firestore-admin";

// ─── POST - Create Assignment ───────────────────────────────

export async function POST(request: NextRequest) {
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
    const message = `POST:/v1/assignments:${ts}`;
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
      toAgentId,
      title,
      description,
      priority = "medium",
      deadline,
      taskId,
      requiresAcceptance = true,
      channelId,
    } = body;

    // Validate required fields
    if (!toAgentId || !title || !description) {
      return Response.json(
        { error: "Missing required fields: toAgentId, title, description" },
        { status: 400 }
      );
    }

    // Validate priority
    if (!["low", "medium", "high", "urgent"].includes(priority)) {
      return Response.json(
        { error: "Invalid priority. Must be: low, medium, high, urgent" },
        { status: 400 }
      );
    }

    // Get target agent info
    const toAgent = await getAgent(toAgentId);
    if (!toAgent) {
      return Response.json(
        { error: `Agent ${toAgentId} not found` },
        { status: 404 }
      );
    }

    // SECURITY: Verify target agent belongs to same organization (prevent cross-org assignment)
    if (toAgent.orgId !== verified.orgId) {
      return Response.json(
        { error: `Agent ${toAgentId} not found in your organization` },
        { status: 403 }
      );
    }

    // Parse deadline
    let deadlineDate: Date | undefined;
    if (deadline) {
      deadlineDate = new Date(deadline);
      if (isNaN(deadlineDate.getTime())) {
        return Response.json(
          { error: "Invalid deadline format. Use ISO 8601 timestamp" },
          { status: 400 }
        );
      }
      // SECURITY: Prevent backdated deadlines
      if (deadlineDate < new Date()) {
        return Response.json(
          { error: "Deadline cannot be in the past" },
          { status: 400 }
        );
      }
    }

    // Create assignment
    const assignmentId = await createAssignment({
      orgId: verified.orgId,
      fromAgentId: verified.agentId,
      fromAgentName: verified.agentName,
      toAgentId,
      toAgentName: toAgent.name,
      title,
      description,
      priority,
      deadline: deadlineDate,
      taskId,
      requiresAcceptance,
      channelId,
    });

    return Response.json({
      assignmentId,
      status: "pending",
      toAgentId,
      deadline: deadlineDate?.toISOString() || null,
      notificationSent: true,
    });
  } catch (err: any) {
    console.error("Create assignment error:", err);

    // Handle specific errors
    if (err.message?.includes("at capacity")) {
      return Response.json({ error: err.message }, { status: 409 });
    }

    return Response.json(
      { error: err.message || "Internal error" },
      { status: 500 }
    );
  }
}

// ─── GET - List Assignments ─────────────────────────────────

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
    const message = `GET:/v1/assignments:${agentParam}:${ts}`;
    const verified = await verifyAgentRequest(agentParam, message, sig);
    if (!verified) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Rate limiting (60 requests/minute)
    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    // Get query params
    const status = url.searchParams.get("status") || undefined;
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 50;

    // List assignments
    const assignments = await listAssignments(verified.agentId, status, limit);

    // Get stats
    const stats = await getAssignmentStats(verified.agentId);

    // Format response
    const formattedAssignments = assignments.map((assignment) => ({
      id: assignment.id,
      from: assignment.fromAgentName || assignment.fromHumanName || "Unknown",
      fromId: assignment.fromAgentId || assignment.fromHumanId,
      title: assignment.title,
      description: assignment.description,
      status: assignment.status,
      priority: assignment.priority,
      deadline: assignment.deadline?.toDate().toISOString() || null,
      createdAt: assignment.createdAt.toMillis(),
      overdue: assignment.status === "overdue",
      taskId: assignment.taskId,
      channelId: assignment.channelId,
    }));

    return Response.json({
      assignments: formattedAssignments,
      stats: {
        pending: stats.pending,
        accepted: stats.accepted,
        in_progress: stats.in_progress,
        overdue: stats.overdue,
        completed: stats.completed,
        rejected: stats.rejected,
      },
    });
  } catch (err: any) {
    console.error("List assignments error:", err);
    return Response.json(
      { error: err.message || "Internal error" },
      { status: 500 }
    );
  }
}
