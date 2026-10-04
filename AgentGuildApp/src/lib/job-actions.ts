/**
 * Who may claim or deliver a job — the checks shared by the signed REST
 * routes (/api/v1/jobs/:jobId/claim|deliver) and the MCP server's tools, so
 * both enforce the same rules. Server-only (Admin SDK).
 */
import { getJob } from "@/lib/jobs-admin";
import { getAgent } from "@/lib/firestore-admin";
import type { Job } from "@/lib/firestore";

export class JobActionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface ActingAgent {
  agentId: string;
  orgId: string;
}

/** An open, instant-hiring job in the agent's org whose requirements the agent meets. */
export async function checkClaimable(agent: ActingAgent, jobId: string): Promise<Job> {
  const job = await getJob(jobId);
  if (!job) throw new JobActionError("Job not found", 404);
  if (job.orgId !== agent.orgId) throw new JobActionError("Job not found in your organization", 403);
  if (job.status !== "open") throw new JobActionError(`Job is not open (status: ${job.status})`, 409);
  if (job.hiringMode === "applications") {
    throw new JobActionError("This job requires an application — use POST /v1/jobs/:jobId/apply", 409);
  }
  if (job.minCompletedJobs != null || job.minTrustScore != null) {
    const profile = await getAgent(agent.agentId);
    const tasksCompleted = profile?.tasksCompleted ?? 0;
    const trustScore = profile?.trustScore ?? 0;
    if (job.minCompletedJobs != null && tasksCompleted < job.minCompletedJobs) {
      throw new JobActionError(`Job requires ${job.minCompletedJobs}+ completed jobs (you have ${tasksCompleted})`, 403);
    }
    if (job.minTrustScore != null && trustScore < job.minTrustScore) {
      throw new JobActionError(`Job requires ${job.minTrustScore}+ trust score (you have ${trustScore})`, 403);
    }
  }
  return job;
}

/** A job this agent holds and is still working on. */
export async function checkDeliverable(agent: ActingAgent, jobId: string): Promise<Job> {
  const job = await getJob(jobId);
  if (!job) throw new JobActionError("Job not found", 404);
  // A gig order's delivering agent belongs to job.sellerOrgId, not job.orgId
  // (the buyer's org) — only non-gig jobs are scoped to a single org.
  const callerOrgMatches = job.gigId ? job.sellerOrgId === agent.orgId : job.orgId === agent.orgId;
  if (!callerOrgMatches) throw new JobActionError("Job not found in your organization", 403);
  if (job.takenByAgentId !== agent.agentId) throw new JobActionError("You are not assigned to this job", 403);
  if (job.status !== "in_progress") throw new JobActionError(`Job is not in progress (status: ${job.status})`, 409);
  return job;
}

/** claimJob() throws plain Errors for credit-policy rejections — those are 403s, not 500s. */
export function isPolicyRejection(message: string): boolean {
  return message.startsWith("Policy violation") || message.includes("requires manual approval");
}
