/**
 * Jobs — Admin SDK versions of the job helpers the agent jobs API uses
 * (server-only).
 *
 * The /api/v1/jobs/* routes used to call the client-SDK helpers in
 * firestore.ts. On the server that SDK has no signed-in user, so under
 * firestore.rules every read/write was denied and the agent jobs API
 * (list, claim, apply, hire, deliver, escrow) could not work. These mirror
 * those helpers one-for-one on the Admin SDK. The dashboard keeps using the
 * client versions in firestore.ts.
 *
 * claimJob's credit-policy enforcement is the same sequence as
 * firestore.ts::claimJob — keep the two in step. The decision itself
 * (canClaimJob / resolveAgentPolicy) is shared, not duplicated.
 *
 * Server-only — never import from client-facing code. Routes must enforce
 * org/ownership checks themselves: the Admin SDK bypasses firestore.rules.
 */
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { resolveAgentPolicy } from "./agent-policy";
import { canClaimJob } from "./credit-policy";
import {
  adminPolicyLoaders,
  getCreditPolicyConfig,
  recordPolicyEvent,
} from "./credit-policy-settings-admin";
import type { GigEscrow, Job, JobApplication, JobReviewEvent } from "./firestore";
import { recordJobEvent, agentActor } from "./job-audit";
import {
  JobActionError,
  canCancel,
  canEdit,
  diffJobFields,
  isAwaitingReview,
  nextRevision,
  type JobActor,
  type JobInput,
  type ReviewInput,
} from "./job-lifecycle";

export { getJobsByOrg } from "./firestore-admin";

const jobs = () => adminDb().collection("jobs");
const applications = () => adminDb().collection("jobApplications");

export async function getJob(jobId: string): Promise<Job | null> {
  const snap = await jobs().doc(jobId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as Job;
}

/**
 * One page of an org's jobs in a single status, oldest first — what agents
 * poll to find work. Filtered and limited in the query (index: orgId,
 * status, createdAt), so the cost of a poll is the page size, not the org's
 * whole job history. `cursor` is the last job id of the previous page.
 */
export async function listOrgJobsByStatus(
  orgId: string,
  status: Job["status"],
  opts: { limit: number; cursor?: string | null },
): Promise<{ jobs: Job[]; nextCursor: string | null }> {
  let q = jobs()
    .where("orgId", "==", orgId)
    .where("status", "==", status)
    .orderBy("createdAt", "asc")
    .limit(opts.limit + 1);
  if (opts.cursor) {
    const after = await jobs().doc(opts.cursor).get();
    if (!after.exists || after.data()?.orgId !== orgId) throw new JobActionError("Invalid cursor", 400);
    q = q.startAfter(after);
  }
  const snap = await q.get();
  const page = snap.docs.slice(0, opts.limit).map((d) => ({ id: d.id, ...d.data() } as Job));
  return { jobs: page, nextCursor: snap.docs.length > opts.limit ? page[page.length - 1].id : null };
}

/**
 * Jobs currently or previously held by `agentId`, newest first (index:
 * takenByAgentId, createdAt desc). Covers both jobs `orgId` posted and gig
 * orders placed against its agents by other orgs (sellerOrgId === orgId).
 */
export async function getJobsAssignedToAgent(agentId: string, orgId: string, limit: number): Promise<Job[]> {
  const snap = await jobs()
    .where("takenByAgentId", "==", agentId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as Job))
    .filter((j) => j.orgId === orgId || j.sellerOrgId === orgId);
}

/** Jobs assigned to `sellerOrgId`'s agents via gig orders — see firestore.ts::getIncomingGigOrders. */
export async function getIncomingGigOrders(sellerOrgId: string): Promise<Job[]> {
  const snap = await jobs().where("sellerOrgId", "==", sellerOrgId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Job));
}

/**
 * Assign an open job to `agentId` and create the agent's task. The status
 * flip is a transaction on status === "open", so two agents racing for the
 * same job can't both win — the loser gets a 409 JobActionError.
 * `actor` is who made the assignment, for the audit trail (defaults to the
 * agent itself, i.e. a self-claim).
 */
export async function claimJob(
  jobId: string,
  agentId: string,
  orgId: string,
  projectId: string,
  agentName?: string,
  actor?: JobActor,
): Promise<string> {
  // ── Credit Policy Enforcement (mirrors firestore.ts::claimJob) ─────
  const config = await getCreditPolicyConfig();
  const policyResult = await resolveAgentPolicy(agentId, adminPolicyLoaders);

  if (config.enforcementEnabled && config.enforceJobClaims && policyResult.ok && policyResult.policy) {
    const jobCheck = await getJob(jobId);
    if (!jobCheck) throw new Error("Job not found");

    const activeSnap = await adminDb()
      .collection("tasks")
      .where("assigneeAgentId", "==", agentId)
      .where("status", "in", ["todo", "in_progress"])
      .get();
    const activeCount = activeSnap.size;

    const eligibility = canClaimJob(policyResult.policy, {
      reward: jobCheck.reward,
      priority: jobCheck.priority,
      minPolicyTier: jobCheck.minPolicyTier,
    }, activeCount);

    if (!eligibility.allowed) {
      await recordPolicyEvent({
        agentId,
        orgId,
        action: "job_claim_blocked",
        tier: policyResult.tier!,
        details: { jobId, reason: eligibility.reason, activeCount },
      });
      throw new Error(`Policy violation: ${eligibility.reason}`);
    }

    if (policyResult.policy.requiresManualReview) {
      await adminDb().collection("approvals").add({
        orgId,
        type: "job_dispatch",
        title: `Job claim requires review: ${jobCheck.title}`,
        description: `Agent ${agentId} (tier: ${policyResult.policy.label}) requesting to claim job ${jobId}`,
        requestedBy: agentId,
        payload: { jobId, agentId, tier: policyResult.tier },
        priority: "medium",
        status: "pending",
        createdAt: FieldValue.serverTimestamp(),
        reviewedAt: null,
      });
      await recordPolicyEvent({
        agentId,
        orgId,
        action: "manual_review_required",
        tier: policyResult.tier!,
        details: { jobId },
      });
      throw new Error("Job claim requires manual approval for your current policy tier");
    }

    await recordPolicyEvent({
      agentId,
      orgId,
      action: "job_claim_allowed",
      tier: policyResult.tier!,
      details: { jobId, activeCount },
    });
  }

  // ── Claim + auto-create the agent's task ───────────────────────────
  const jobRef = jobs().doc(jobId);
  const jobData = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) throw new JobActionError("Job not found", 404);
    const data = snap.data() as Omit<Job, "id">;
    if (data.status !== "open") throw new JobActionError(`Job is no longer open (status: ${data.status})`, 409);
    tx.update(jobRef, {
      status: "in_progress",
      takenByAgentId: agentId,
      updatedAt: FieldValue.serverTimestamp(),
      ...(agentName ? { claimedAt: FieldValue.serverTimestamp(), claimedByAgentName: agentName } : {}),
    });
    return data;
  });
  const taskRef = await adminDb().collection("tasks").add({
    orgId,
    projectId,
    title: jobData?.title || "Job task",
    description: `From job: ${jobData?.description || ""}`,
    assigneeAgentId: agentId,
    status: "todo",
    priority: jobData?.priority || "medium",
    createdAt: FieldValue.serverTimestamp(),
    jobId,
  });
  // Linked so approval/cancellation can close the task (see reviewDelivery, cancelJob).
  await jobRef.update({ taskId: taskRef.id });
  await recordJobEvent(
    { id: jobId, orgId: jobData.orgId, sellerOrgId: jobData.sellerOrgId },
    actor ? "hired" : "claimed",
    actor ?? agentActor({ agentId, agentName }),
    { status: "in_progress", details: { agentId, agentName, taskId: taskRef.id } },
  );
  return taskRef.id;
}

/**
 * Hand in work for review. `actor` defaults to an agent named
 * completedByAgentName — pass it explicitly when a person delivers on an
 * agent's behalf from the dashboard.
 */
export async function submitJobDelivery(jobId: string, data: {
  deliveryNotes: string;
  deliveryFiles?: string[];
  completedByAgentName: string;
}, actor?: JobActor): Promise<void> {
  const before = await getJob(jobId);
  if (!before) throw new JobActionError("Job not found", 404);
  await jobs().doc(jobId).update({
    status: "completed",
    deliveryNotes: data.deliveryNotes,
    deliveryFiles: data.deliveryFiles ?? [],
    completedByAgentName: data.completedByAgentName,
    completedAt: FieldValue.serverTimestamp(),
    reviewStatus: "pending",
    deliveryHistory: FieldValue.arrayUnion({ notes: data.deliveryNotes, files: data.deliveryFiles ?? [], at: Date.now() }),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await recordJobEvent(before, "delivered", actor ?? agentActor({ agentId: before.takenByAgentId ?? "unknown", agentName: data.completedByAgentName }), {
    status: "completed",
    details: { revision: nextRevision(before), fileCount: data.deliveryFiles?.length ?? 0 },
  });
}

// ─── Posting, editing, cancelling, reviewing ─────────────

/** Post a new open job. Input must already be validated (job-lifecycle.ts::validateJobInput). */
export async function createJob(
  input: JobInput,
  meta: { orgId: string; postedByAddress: string; postedByAgentId?: string },
  actor: JobActor,
): Promise<string> {
  const doc = stripUndefined({
    ...input,
    orgId: meta.orgId,
    postedByAddress: meta.postedByAddress,
    postedByAgentId: meta.postedByAgentId,
    status: "open" as const,
    applicationCount: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const ref = await jobs().add(doc);
  await recordJobEvent({ id: ref.id, orgId: meta.orgId }, "created", actor, {
    status: "open",
    details: { title: input.title, reward: input.reward, hiringMode: input.hiringMode },
  });
  return ref.id;
}

/** Change posting details. Only while the job is still open — after that the agent is working from them. */
export async function updateOpenJob(jobId: string, patch: Partial<JobInput>, actor: JobActor): Promise<Job> {
  const ref = jobs().doc(jobId);
  const { before, changes } = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new JobActionError("Job not found", 404);
    const before = { id: snap.id, ...snap.data() } as Job;
    if (!canEdit(before)) throw new JobActionError(`Only open jobs can be edited (status: ${before.status})`, 409);
    const changes = diffJobFields(before, patch);
    if (Object.keys(changes).length) {
      const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
      for (const k of Object.keys(changes)) {
        const v = (patch as Record<string, unknown>)[k];
        update[k] = v === undefined ? FieldValue.delete() : v;
      }
      tx.update(ref, update);
    }
    return { before, changes };
  });
  if (Object.keys(changes).length) {
    await recordJobEvent(before, "edited", actor, { status: before.status, details: { changes } });
  }
  return (await getJob(jobId))!;
}

/**
 * Withdraw a job: status "closed", pending applications rejected, and the
 * assigned agent's task closed so it stops counting toward their active load.
 */
export async function cancelJob(jobId: string, reason: string, actor: JobActor): Promise<void> {
  const ref = jobs().doc(jobId);
  const before = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new JobActionError("Job not found", 404);
    const job = { id: snap.id, ...snap.data() } as Job;
    const check = canCancel(job);
    if (!check.ok) throw new JobActionError(check.error, 409);
    tx.update(ref, stripUndefined({
      status: "closed",
      cancelledAt: FieldValue.serverTimestamp(),
      cancelledBy: actor.id,
      cancelReason: reason || undefined,
      updatedAt: FieldValue.serverTimestamp(),
    }));
    return job;
  });

  const pending = (await getJobApplications(jobId)).filter((a) => a.status === "pending");
  if (pending.length) {
    const batch = adminDb().batch();
    for (const a of pending) batch.update(applications().doc(a.id), { status: "rejected" });
    await batch.commit();
  }
  await closeJobTasks(before, { cancelled: true });
  await recordJobEvent(before, "cancelled", actor, {
    status: "closed",
    details: { reason: reason || null, previousStatus: before.status, assignedAgentId: before.takenByAgentId ?? null },
  });
}

/**
 * The buyer's verdict on a pending delivery. Approve completes the job,
 * credits the agent's completed-job count (what minCompletedJobs gates on)
 * and closes their task; reject sends it back to in_progress for a revision.
 * Transactional on the delivery still being pending, so two reviewers
 * clicking at once can't both act.
 */
export async function reviewDelivery(jobId: string, decision: ReviewInput, actor: JobActor): Promise<Job> {
  const ref = jobs().doc(jobId);
  const status = decision.approve ? "approved" : "rejected";
  const before = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new JobActionError("Job not found", 404);
    const job = { id: snap.id, ...snap.data() } as Job;
    if (!isAwaitingReview(job)) throw new JobActionError("This job has no delivery awaiting review", 409);
    const event: JobReviewEvent = { status, at: Date.now(), by: actor.id, ...(decision.notes ? { notes: decision.notes } : {}) };
    tx.update(ref, {
      reviewStatus: status,
      reviewNotes: decision.notes || FieldValue.delete(),
      reviewedBy: actor.id,
      reviewedAt: FieldValue.serverTimestamp(),
      status: decision.approve ? "completed" : "in_progress",
      reviewHistory: FieldValue.arrayUnion(event),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (decision.approve && job.takenByAgentId) {
      tx.update(adminDb().collection("agents").doc(job.takenByAgentId), { tasksCompleted: FieldValue.increment(1) });
    }
    return job;
  });

  if (decision.approve) await closeJobTasks(before);
  await recordJobEvent(before, decision.approve ? "approved" : "revision_requested", actor, {
    status: decision.approve ? "completed" : "in_progress",
    details: {
      revision: before.deliveryHistory?.length ?? 1,
      agentId: before.takenByAgentId ?? null,
      ...(decision.notes ? { notes: decision.notes } : {}),
    },
  });
  return (await getJob(jobId))!;
}

/**
 * Post a job and put a team on it in one step (the dashboard / agent-map
 * "dispatch" flow). The first agent is the lead: it holds the job, is
 * credit-policy checked like any claim, and delivers. The rest are
 * collaborators — each gets its own task linked to the job, and they're
 * listed in job.collaboratorAgentIds. Every agent must belong to the org.
 */
export async function dispatchJob(
  input: JobInput,
  meta: { orgId: string; postedByAddress: string },
  agentIds: string[],
  actor: JobActor,
): Promise<{ jobId: string; taskIds: string[] }> {
  const ids = Array.from(new Set(agentIds));
  if (ids.length === 0) throw new JobActionError("Pick at least one agent", 400);
  if (ids.length > 10) throw new JobActionError("At most 10 agents per dispatch", 400);
  const agents = await Promise.all(ids.map(async (id) => {
    const snap = await adminDb().collection("agents").doc(id).get();
    const data = snap.data() as { orgId?: string; name?: string } | undefined;
    if (!snap.exists || data?.orgId !== meta.orgId) throw new JobActionError(`Agent ${id} not found in this organization`, 404);
    return { id, name: data.name || id };
  }));

  const jobId = await createJob(input, meta, actor);
  const [lead, ...collaborators] = agents;
  const taskIds = [await claimJob(jobId, lead.id, meta.orgId, input.projectId, lead.name, actor)];

  if (collaborators.length) {
    for (const c of collaborators) {
      const ref = await adminDb().collection("tasks").add({
        orgId: meta.orgId,
        projectId: input.projectId,
        title: input.title,
        description: `From job (collaborating with ${lead.name}): ${input.description}`,
        assigneeAgentId: c.id,
        status: "todo",
        priority: input.priority,
        createdAt: FieldValue.serverTimestamp(),
        jobId,
      });
      taskIds.push(ref.id);
      await recordJobEvent({ id: jobId, orgId: meta.orgId }, "hired", actor, {
        details: { agentId: c.id, agentName: c.name, role: "collaborator", taskId: ref.id },
      });
    }
    await jobs().doc(jobId).update({ collaboratorAgentIds: collaborators.map((c) => c.id) });
  }
  return { jobId, taskIds };
}

/**
 * Take an in-progress job back from its agent(s) and put it on the board
 * again. Their tasks are closed; any earlier delivery and review history is
 * kept. Delivered or approved work can't be reopened — review it instead.
 */
export async function reopenJob(jobId: string, reason: string, actor: JobActor): Promise<void> {
  const ref = jobs().doc(jobId);
  const before = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new JobActionError("Job not found", 404);
    const job = { id: snap.id, ...snap.data() } as Job;
    if (job.status !== "in_progress") throw new JobActionError(`Only in-progress jobs can be reopened (status: ${job.status})`, 409);
    if (job.gigId) throw new JobActionError("Gig orders are tied to their seller — cancel or dispute instead", 409);
    tx.update(ref, {
      status: "open",
      takenByAgentId: FieldValue.delete(),
      claimedAt: FieldValue.delete(),
      claimedByAgentName: FieldValue.delete(),
      taskId: FieldValue.delete(),
      collaboratorAgentIds: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return job;
  });
  await closeJobTasks(before, { cancelled: true });
  await recordJobEvent(before, "unassigned", actor, {
    status: "open",
    details: { agentId: before.takenByAgentId ?? null, collaboratorAgentIds: before.collaboratorAgentIds ?? [], reason: reason || null },
  });
}

/**
 * Close every open task working on this job: the lead's (job.taskId — older
 * tasks predate the jobId link) and any collaborators' (tasks.jobId).
 * Best-effort: the job's own state is already settled when this runs.
 */
async function closeJobTasks(job: Pick<Job, "id" | "taskId">, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    const linked = await adminDb().collection("tasks").where("jobId", "==", job.id).get();
    const ids = new Set(linked.docs.filter((d) => d.data().status !== "done").map((d) => d.id));
    if (job.taskId) ids.add(job.taskId);
    if (!ids.size) return;
    const batch = adminDb().batch();
    for (const id of ids) {
      batch.update(adminDb().collection("tasks").doc(id), { status: "done", ...extra, updatedAt: FieldValue.serverTimestamp() });
    }
    await batch.commit();
  } catch (e) {
    console.error(`Failed to close tasks for job ${job.id}:`, e);
  }
}

/** Firestore rejects `undefined` field values; FieldValue sentinels must survive, so no JSON round-trip. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

// ─── Applications ────────────────────────────────────────

export async function getJobApplications(jobId: string): Promise<JobApplication[]> {
  const snap = await applications().where("jobId", "==", jobId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as JobApplication));
}

/**
 * One application per agent per job: the doc id is `${jobId}_${agentId}` and
 * create() fails if it exists, so two concurrent applies can't both land.
 */
export async function applyToJob(data: Omit<JobApplication, "id" | "status" | "createdAt">, actor?: JobActor): Promise<string> {
  const ref = applications().doc(`${data.jobId}_${data.agentId}`);
  try {
    await ref.create(stripUndefined({
      ...data,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    }));
  } catch (err) {
    const e = err as { code?: unknown; message?: string };
    if (e.code === 6 || /ALREADY_EXISTS/.test(e.message ?? "")) {
      throw new JobActionError("You have already applied to this job", 409);
    }
    throw err;
  }
  await jobs().doc(data.jobId).update({ applicationCount: FieldValue.increment(1) });
  const job = await getJob(data.jobId);
  if (job) {
    await recordJobEvent(job, "applied", actor ?? agentActor(data), {
      details: { applicationId: ref.id, agentId: data.agentId, agentName: data.agentName, quote: data.quote ?? null },
    });
  }
  return ref.id;
}

export async function updateJobApplication(
  applicationId: string,
  data: Partial<Pick<JobApplication, "quote" | "message">>,
  actor?: JobActor,
): Promise<void> {
  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  for (const [k, v] of Object.entries(data)) update[k] = v === undefined ? FieldValue.delete() : v;
  await applications().doc(applicationId).update(update);
  const app = (await applications().doc(applicationId).get()).data() as JobApplication | undefined;
  const job = app ? await getJob(app.jobId) : null;
  if (app && job) {
    await recordJobEvent(job, "application_revised", actor ?? agentActor(app), {
      details: { applicationId, quote: app.quote ?? null },
    });
  }
}

/** Accept one application, reject the rest, and assign the job to the hired agent. */
/** `actor` is whoever picked the winner — a person on the dashboard or the posting org's agent. */
export async function hireApplicant(
  jobId: string,
  application: JobApplication,
  orgId: string,
  projectId: string,
  actor?: JobActor,
): Promise<void> {
  await claimJob(jobId, application.agentId, orgId, projectId, application.agentName,
    actor ?? { type: "system", id: "hire" });

  const others = (await getJobApplications(jobId)).filter((a) => a.id !== application.id && a.status === "pending");
  const batch = adminDb().batch();
  batch.update(applications().doc(application.id), { status: "accepted" });
  for (const other of others) {
    batch.update(applications().doc(other.id), { status: "rejected" });
  }
  await batch.commit();
}

// ─── Escrow state (records on-chain tx results; see GigEscrow) ───────

async function updateJobEscrow(jobId: string, patch: Partial<GigEscrow>): Promise<Job> {
  const job = await getJob(jobId);
  if (!job?.escrow) throw new Error("Job has no escrow record");
  await jobs().doc(jobId).update({
    escrow: { ...job.escrow, ...patch },
    updatedAt: FieldValue.serverTimestamp(),
  });
  return job;
}

export async function recordEscrowClaimed(jobId: string, claimTxSig: string, actor?: JobActor): Promise<void> {
  const job = await updateJobEscrow(jobId, { claimTxSig, status: "claimed" });
  await recordJobEvent(job, "escrow_claimed", actor ?? { type: "system", id: "escrow" }, { details: { txSig: claimTxSig } });
}

export async function recordEscrowDelivered(jobId: string, deliveryTxSig: string, actor?: JobActor): Promise<void> {
  const job = await updateJobEscrow(jobId, { deliveryTxSig, status: "delivered" });
  await recordJobEvent(job, "escrow_delivered", actor ?? { type: "system", id: "escrow" }, { details: { txSig: deliveryTxSig } });
}

/** After resolveDispute() is verified on-chain — see /api/admin/jobs/:jobId/escrow-resolve. */
export async function recordEscrowResolved(jobId: string, resolveTxSig: string, resolvedAgentBps: number, actor: JobActor): Promise<void> {
  const job = await updateJobEscrow(jobId, { resolveTxSig, resolvedAgentBps, status: "resolved" });
  await recordJobEvent(job, "escrow_resolved", actor, { details: { txSig: resolveTxSig, agentBps: resolvedAgentBps } });
}

export async function recordEscrowDisputed(jobId: string, disputeTxSig: string): Promise<void> {
  await updateJobEscrow(jobId, { disputeTxSig, status: "disputed" });
}

export async function recordEscrowReleased(jobId: string, releaseTxSig: string, actor: JobActor): Promise<void> {
  const job = await updateJobEscrow(jobId, { releaseTxSig, status: "released" });
  await recordJobEvent(job, "escrow_released", actor, { details: { txSig: releaseTxSig } });
}
