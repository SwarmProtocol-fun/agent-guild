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
  reviewDueAt,
  reviewSweepAction,
  type RatingInput,
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
  const now = Date.now();
  const dueAt = reviewDueAt(before, now);
  await jobs().doc(jobId).update({
    status: "completed",
    // Each delivery restarts the poster's review clock (see sweepReviews).
    reviewDueAt: dueAt,
    reviewReminderSentAt: FieldValue.delete(),
    reviewOverdueAt: FieldValue.delete(),
    deliveryNotes: data.deliveryNotes,
    deliveryFiles: data.deliveryFiles ?? [],
    completedByAgentName: data.completedByAgentName,
    completedAt: FieldValue.serverTimestamp(),
    reviewStatus: "pending",
    deliveryHistory: FieldValue.arrayUnion({ notes: data.deliveryNotes, files: data.deliveryFiles ?? [], at: now }),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await recordJobEvent(before, "delivered", actor ?? agentActor({ agentId: before.takenByAgentId ?? "unknown", agentName: data.completedByAgentName }), {
    status: "completed",
    details: { revision: nextRevision(before), fileCount: data.deliveryFiles?.length ?? 0, reviewDueAt: dueAt },
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
export async function reviewDelivery(
  jobId: string,
  decision: ReviewInput,
  actor: JobActor,
  opts: { auto?: boolean } = {},
): Promise<Job> {
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
      ...(opts.auto ? { autoApproved: true } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (decision.approve && job.takenByAgentId) {
      tx.update(adminDb().collection("agents").doc(job.takenByAgentId), { tasksCompleted: FieldValue.increment(1) });
    }
    return job;
  });

  if (decision.approve) await closeJobTasks(before);
  await recordJobEvent(before, opts.auto ? "auto_approved" : decision.approve ? "approved" : "revision_requested", actor, {
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
 * The poster's 1–5 star rating of approved work — once per job. Rolls into
 * the agent's average (agents.avgRating, shown to future posters when they
 * hire) and, for gig orders, into the gig listing's average via the same
 * gigReviews record the gig page reads. Averages are recomputed from stored
 * sums, never taken from the caller. Ratings on auto-approved jobs are
 * allowed: the poster may still weigh in after the deadline.
 */
export async function rateJob(jobId: string, input: RatingInput, actor: JobActor): Promise<Job> {
  const ref = jobs().doc(jobId);
  const peek = await getJob(jobId);
  if (!peek) throw new JobActionError("Job not found", 404);
  // Gig reviews written before this path existed have random ids — check by jobId.
  if (peek.gigId) {
    const legacy = await adminDb().collection("gigReviews").where("jobId", "==", jobId).limit(1).get();
    if (!legacy.empty) throw new JobActionError("This order has already been reviewed", 409);
  }

  const before = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new JobActionError("Job not found", 404);
    const job = { id: snap.id, ...snap.data() } as Job;
    if (job.reviewStatus !== "approved") throw new JobActionError("You can rate a job once its delivery is approved", 409);
    if (typeof job.rating === "number") throw new JobActionError("This job has already been rated", 409);

    // All reads before any write (Firestore transactions require it).
    const agentRef = job.takenByAgentId ? adminDb().collection("agents").doc(job.takenByAgentId) : null;
    const agentSnap = agentRef ? await tx.get(agentRef) : null;
    const gigRef = job.gigId ? adminDb().collection("gigs").doc(job.gigId) : null;
    const gigSnap = gigRef ? await tx.get(gigRef) : null;

    tx.update(ref, {
      rating: input.rating,
      ...(input.comment ? { ratingComment: input.comment } : {}),
      ratedBy: actor.id,
      ratedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (agentRef && agentSnap?.exists) {
      const a = agentSnap.data() as { ratingSum?: number; ratingCount?: number };
      const sum = (a.ratingSum ?? 0) + input.rating;
      const count = (a.ratingCount ?? 0) + 1;
      tx.update(agentRef, { ratingSum: sum, ratingCount: count, avgRating: Math.round((sum / count) * 100) / 100 });
    }
    if (gigRef && gigSnap?.exists) {
      const g = gigSnap.data() as { avgRating?: number; ratingCount?: number };
      const prevCount = g.ratingCount ?? 0;
      const nextCount = prevCount + 1;
      // create() fails if this order already has a review — the once-per-order guarantee.
      tx.create(adminDb().collection("gigReviews").doc(jobId), {
        gigId: job.gigId,
        jobId,
        orgId: job.orgId,
        authorAddress: actor.id,
        rating: input.rating,
        ...(input.comment ? { review: input.comment } : {}),
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.update(gigRef, { avgRating: ((g.avgRating ?? 0) * prevCount + input.rating) / nextCount, ratingCount: nextCount });
    }
    return job;
  }).catch((err) => {
    if ((err as { code?: number }).code === 6) throw new JobActionError("This order has already been reviewed", 409);
    throw err;
  });

  await recordJobEvent(before, "rated", actor, {
    details: { rating: input.rating, agentId: before.takenByAgentId ?? null, ...(input.comment ? { comment: input.comment } : {}) },
  });
  return (await getJob(jobId))!;
}

export interface ReviewSweepResult {
  checked: number;
  autoApproved: string[];
  reminded: string[];
  clockStarted: string[];
  flaggedOverdue: string[];
  errors: { jobId: string; error: string }[];
}

/**
 * Hourly (netlify/functions/job-review-sweep.mts → /api/cron/job-review-sweep).
 * For every delivery awaiting review: remind the poster a day before the
 * deadline, auto-approve once it passes — so an agent's finished work can't
 * sit in limbo because nobody looked — and flag escrowed orders that can't
 * be auto-released. Deliveries from before deadlines existed get a fresh
 * window from now instead of being approved the moment this first runs.
 */
export async function sweepReviews(now = Date.now()): Promise<ReviewSweepResult> {
  const result: ReviewSweepResult = { checked: 0, autoApproved: [], reminded: [], clockStarted: [], flaggedOverdue: [], errors: [] };
  // Single equality filter — served by the automatic index, no composite needed.
  const snap = await jobs().where("reviewStatus", "==", "pending").get();
  const system: JobActor = { type: "system", id: "review-deadline", name: "Review deadline" };

  for (const d of snap.docs) {
    const job = { id: d.id, ...d.data() } as Job;
    result.checked++;
    try {
      switch (reviewSweepAction(job, now)) {
        case "start_clock":
          await d.ref.update({ reviewDueAt: reviewDueAt(job, now) });
          result.clockStarted.push(job.id);
          break;
        case "remind":
          await d.ref.update({ reviewReminderSentAt: now });
          await recordJobEvent(job, "review_reminder", system, { details: { reviewDueAt: job.reviewDueAt } });
          await postProjectNotice(job, `⏰ **Review due soon**\n\nJob: "${job.title}" auto-approves ${new Date(job.reviewDueAt!).toUTCString()} unless it's reviewed first.`);
          result.reminded.push(job.id);
          break;
        case "flag_overdue":
          await d.ref.update({ reviewOverdueAt: now });
          await recordJobEvent(job, "review_overdue", system, {
            details: { reviewDueAt: job.reviewDueAt, reason: "Escrowed order — release needs the buyer's signature, so it can't auto-approve" },
          });
          result.flaggedOverdue.push(job.id);
          break;
        case "auto_approve":
          await reviewDelivery(job.id, {
            approve: true,
            notes: `Auto-approved: no review within ${job.reviewWindowDays ?? 7} days of delivery.`,
          }, system, { auto: true });
          await postProjectNotice(job, `✅ **Job auto-approved**\n\nJob: "${job.title}" wasn't reviewed before its deadline, so the delivery was approved.`);
          result.autoApproved.push(job.id);
          break;
        default:
          break;
      }
    } catch (err) {
      // 409 = someone reviewed it between the query and now — that's fine.
      if (err instanceof JobActionError && err.status === 409) continue;
      result.errors.push({ jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** Best-effort system message in the job's project channel, if it has one. */
async function postProjectNotice(job: Pick<Job, "orgId" | "projectId">, content: string): Promise<void> {
  if (!job.projectId) return;
  try {
    const channels = await adminDb().collection("channels")
      .where("orgId", "==", job.orgId).where("projectId", "==", job.projectId).limit(1).get();
    if (channels.empty) return;
    await adminDb().collection("messages").add({
      channelId: channels.docs[0].id,
      senderId: "system",
      senderName: "Agent Guild",
      senderType: "system",
      content,
      orgId: job.orgId,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("Failed to post project notice:", err);
  }
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
