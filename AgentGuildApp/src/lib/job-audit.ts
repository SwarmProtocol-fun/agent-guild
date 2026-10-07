/**
 * Job audit trail — an append-only `jobEvents` collection recording who did
 * what to a job and when (posted, edited, applied, claimed, hired,
 * delivered, approved, sent back, cancelled, disputed, escrow steps).
 *
 * Written only from the server (Admin SDK); firestore.rules denies all
 * client access, so the trail can't be edited or forged from a browser.
 * Read it through GET /api/jobs/:jobId/events (dashboard) or
 * GET /api/v1/jobs/:jobId (agents).
 *
 * recordJobEvent never throws: the action it records has already happened,
 * and failing the request over a missed log line would be worse than the gap.
 */
import { adminDb } from "./firebase-admin";
import type { Job } from "./firestore";
import type { JobActor, JobEvent, JobEventType } from "./job-lifecycle";

const events = () => adminDb().collection("jobEvents");

export async function recordJobEvent(
  job: Pick<Job, "id" | "orgId" | "sellerOrgId">,
  type: JobEventType,
  actor: JobActor,
  extra: { status?: Job["status"]; details?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    const doc: Omit<JobEvent, "id"> = {
      jobId: job.id,
      orgId: job.orgId,
      ...(job.sellerOrgId ? { sellerOrgId: job.sellerOrgId } : {}),
      type,
      actor: stripUndefined(actor),
      ...(extra.status ? { status: extra.status } : {}),
      ...(extra.details ? { details: stripUndefined(extra.details) } : {}),
      at: Date.now(),
    };
    await events().add(doc);
  } catch (err) {
    console.error(`Failed to record job event ${type} for ${job.id}:`, err);
  }
}

export async function getJobEvents(jobId: string, limit = 200): Promise<JobEvent[]> {
  const snap = await events().where("jobId", "==", jobId).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as JobEvent))
    .sort((a, b) => a.at - b.at)
    .slice(-limit);
}

/** Firestore rejects `undefined` values anywhere in a document. */
function stripUndefined<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export const userActor = (wallet: string): JobActor => ({ type: "user", id: wallet });
export const agentActor = (agent: { agentId: string; agentName?: string }): JobActor => ({
  type: "agent",
  id: agent.agentId,
  ...(agent.agentName ? { name: agent.agentName } : {}),
});
