/**
 * POST /api/cron/[id]/test
 *
 * Dry-run execution of a cron job (simulates execution without actually running).
 * Returns what would happen if the job were to execute now.
 */

import { NextRequest } from "next/server";
import { getCronJob, getAgent } from "@/lib/firestore-admin";
import { recordCronExecution, type AgentExecutionResult } from "@/lib/cron-history";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const wallet = getWalletAddress(request);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const job = await getCronJob(id);
    if (!job) {
      return Response.json({ error: "Cron job not found" }, { status: 404 });
    }

    const auth = await requireOrgMember(request, job.orgId);
    if (!auth.ok) {
      return Response.json({ error: auth.error }, { status: auth.status });
    }

    // Simulate execution
    const startTime = new Date();
    const agentResults: AgentExecutionResult[] = [];

    if (job.agentIds && job.agentIds.length > 0) {
      for (const agentId of job.agentIds) {
        try {
          const agent = await getAgent(agentId);
          if (!agent) {
            agentResults.push({
              agentId,
              agentName: agentId,
              success: false,
              error: "Agent not found",
              executedAt: Date.now(),
            });
            continue;
          }

          // Check if agent is online or available
          const available = agent.status === "online";
          agentResults.push({
            agentId,
            agentName: agent.name,
            success: available,
            error: available ? undefined : `Agent is ${agent.status}`,
            responsePreview: available
              ? `Would send: "${job.message.substring(0, 100)}${job.message.length > 100 ? "..." : ""}"`
              : undefined,
            executedAt: Date.now(),
          });
        } catch (err) {
          agentResults.push({
            agentId,
            agentName: agentId,
            success: false,
            error: err instanceof Error ? err.message : "Failed to check agent",
            executedAt: Date.now(),
          });
        }
      }
    } else {
      // No agents assigned
      agentResults.push({
        agentId: "none",
        agentName: "No agents assigned",
        success: false,
        error: "No agents configured for this job",
        executedAt: Date.now(),
      });
    }

    const endTime = new Date();
    const overallSuccess = agentResults.every((r) => r.success);

    // Record test run in history
    await recordCronExecution(
      id,
      job.name,
      job.orgId,
      startTime,
      endTime,
      overallSuccess,
      agentResults,
      overallSuccess ? undefined : "Test run - some agents unavailable",
      true // testRun = true
    );

    return Response.json({
      ok: true,
      testRun: true,
      job: {
        id: job.id,
        name: job.name,
        message: job.message,
        schedule: job.schedule,
        enabled: job.enabled,
        paused: job.paused,
      },
      simulation: {
        startTime,
        endTime,
        durationMs: endTime.getTime() - startTime.getTime(),
        overallSuccess,
        agentResults,
      },
    });
  } catch (err) {
    console.error("Test cron job error:", err);
    return Response.json(
      { error: "Failed to test cron job" },
      { status: 500 }
    );
  }
}
