/**
 * Dashboard-side calls for the job lifecycle. Each wraps a /api/jobs route
 * (wallet session auth via the session cookie), so every posting, edit,
 * assignment, delivery and review goes through server-side validation and
 * lands in the job's audit trail. Browser-only.
 */
import type { Job } from "./firestore";
import type { JobEvent, JobInput } from "./job-lifecycle";

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

const jobPath = (jobId: string, rest = "") => `/api/jobs/${encodeURIComponent(jobId)}${rest}`;

export async function postJob(orgId: string, input: Partial<JobInput>): Promise<string> {
  const { id } = await call<{ id: string }>("/api/jobs", "POST", { ...input, orgId });
  return id;
}

/** Send null to clear reward / minCompletedJobs / minTrustScore. */
export async function editJob(jobId: string, patch: Record<string, unknown>): Promise<Job> {
  return (await call<{ job: Job }>(jobPath(jobId), "PATCH", patch)).job;
}

export async function cancelJobPosting(jobId: string, reason: string): Promise<void> {
  await call(jobPath(jobId, "/cancel"), "POST", { reason });
}

export async function assignJob(jobId: string, agentId: string): Promise<string> {
  return (await call<{ taskId: string }>(jobPath(jobId, "/assign"), "POST", { agentId })).taskId;
}

export async function applyWithAgent(jobId: string, data: { agentId: string; quote?: string; message?: string }): Promise<string> {
  return (await call<{ applicationId: string }>(jobPath(jobId, "/applications"), "POST", data)).applicationId;
}

export async function reviseApplication(jobId: string, applicationId: string, data: { quote: string; message: string }): Promise<void> {
  await call(jobPath(jobId, `/applications/${encodeURIComponent(applicationId)}`), "PATCH", data);
}

export async function hireApplication(jobId: string, applicationId: string): Promise<void> {
  await call(jobPath(jobId, "/hire"), "POST", { applicationId });
}

export async function deliverJob(jobId: string, data: { deliveryNotes: string; deliveryFiles: string[] }): Promise<Job> {
  return (await call<{ job: Job }>(jobPath(jobId, "/deliver"), "POST", data)).job;
}

export async function reviewJob(
  jobId: string,
  data: { decision: "approve" | "reject"; notes: string; releaseTxSig?: string },
): Promise<Job> {
  return (await call<{ job: Job }>(jobPath(jobId, "/review"), "POST", data)).job;
}

/** Post a job and assign a team: agentIds[0] leads and delivers, the rest collaborate. */
export async function dispatchJob(data: {
  orgId: string;
  prompt: string;
  agentIds: string[];
  priority: Job["priority"];
  reward?: string;
  projectId?: string;
}): Promise<{ jobId: string; taskIds: string[] }> {
  return call("/api/jobs/dispatch", "POST", data);
}

/** Unassign an in-progress job and put it back on the board. */
export async function reopenJob(jobId: string, reason = ""): Promise<void> {
  await call(jobPath(jobId, "/reopen"), "POST", { reason });
}

export async function getJobAuditTrail(jobId: string): Promise<JobEvent[]> {
  return (await call<{ events: JobEvent[] }>(jobPath(jobId, "/events"), "GET")).events;
}
