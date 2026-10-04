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
import type { GigEscrow, Job, JobApplication } from "./firestore";

export { getJobsByOrg } from "./firestore-admin";

const jobs = () => adminDb().collection("jobs");
const applications = () => adminDb().collection("jobApplications");

export async function getJob(jobId: string): Promise<Job | null> {
  const snap = await jobs().doc(jobId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as Job;
}

/** Jobs assigned to `sellerOrgId`'s agents via gig orders — see firestore.ts::getIncomingGigOrders. */
export async function getIncomingGigOrders(sellerOrgId: string): Promise<Job[]> {
  const snap = await jobs().where("sellerOrgId", "==", sellerOrgId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Job));
}

export async function claimJob(
  jobId: string,
  agentId: string,
  orgId: string,
  projectId: string,
  agentName?: string,
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
  await jobs().doc(jobId).update({
    status: "in_progress",
    takenByAgentId: agentId,
    updatedAt: FieldValue.serverTimestamp(),
    ...(agentName ? { claimedAt: FieldValue.serverTimestamp(), claimedByAgentName: agentName } : {}),
  });
  const jobData = (await jobs().doc(jobId).get()).data();
  const taskRef = await adminDb().collection("tasks").add({
    orgId,
    projectId,
    title: jobData?.title || "Job task",
    description: `From job: ${jobData?.description || ""}`,
    assigneeAgentId: agentId,
    status: "todo",
    priority: jobData?.priority || "medium",
    createdAt: FieldValue.serverTimestamp(),
  });
  return taskRef.id;
}

export async function submitJobDelivery(jobId: string, data: {
  deliveryNotes: string;
  deliveryFiles?: string[];
  completedByAgentName: string;
}): Promise<void> {
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
}

// ─── Applications ────────────────────────────────────────

export async function getJobApplications(jobId: string): Promise<JobApplication[]> {
  const snap = await applications().where("jobId", "==", jobId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as JobApplication));
}

export async function applyToJob(data: Omit<JobApplication, "id" | "status" | "createdAt">): Promise<string> {
  const ref = await applications().add({
    ...data,
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
  });
  await jobs().doc(data.jobId).update({ applicationCount: FieldValue.increment(1) });
  return ref.id;
}

export async function updateJobApplication(
  applicationId: string,
  data: Partial<Pick<JobApplication, "quote" | "message">>,
): Promise<void> {
  await applications().doc(applicationId).update({ ...data, updatedAt: FieldValue.serverTimestamp() });
}

/** Accept one application, reject the rest, and assign the job to the hired agent. */
export async function hireApplicant(
  jobId: string,
  application: JobApplication,
  orgId: string,
  projectId: string,
): Promise<void> {
  await claimJob(jobId, application.agentId, orgId, projectId, application.agentName);

  const others = (await getJobApplications(jobId)).filter((a) => a.id !== application.id && a.status === "pending");
  const batch = adminDb().batch();
  batch.update(applications().doc(application.id), { status: "accepted" });
  for (const other of others) {
    batch.update(applications().doc(other.id), { status: "rejected" });
  }
  await batch.commit();
}

// ─── Escrow state (records on-chain tx results; see GigEscrow) ───────

async function updateJobEscrow(jobId: string, patch: Partial<GigEscrow>): Promise<void> {
  const job = await getJob(jobId);
  if (!job?.escrow) throw new Error("Job has no escrow record");
  await jobs().doc(jobId).update({
    escrow: { ...job.escrow, ...patch },
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function recordEscrowClaimed(jobId: string, claimTxSig: string): Promise<void> {
  await updateJobEscrow(jobId, { claimTxSig, status: "claimed" });
}

export async function recordEscrowDelivered(jobId: string, deliveryTxSig: string): Promise<void> {
  await updateJobEscrow(jobId, { deliveryTxSig, status: "delivered" });
}

export async function recordEscrowDisputed(jobId: string, disputeTxSig: string): Promise<void> {
  await updateJobEscrow(jobId, { disputeTxSig, status: "disputed" });
}
