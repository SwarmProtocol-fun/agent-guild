/**
 * Job lifecycle — the pure rules for posting, editing, cancelling,
 * delivering and reviewing a job. No Firestore here, so the server routes
 * (dashboard + agent API) and the UI share one definition and it's unit
 * testable.
 *
 *   open ──claim/hire──▶ in_progress ──deliver──▶ completed (reviewStatus "pending")
 *     │                      ▲                         │
 *     │                      └──── reject (revise) ────┤
 *     │                                                └── approve ──▶ completed ("approved")
 *     └──cancel──▶ closed  (in_progress jobs can be cancelled too)
 *
 * Job.status has no separate "in review" value: a delivered job is
 * status "completed" with reviewStatus "pending" — command-center.tsx and
 * harness-store.ts already read it that way.
 */
import type { Job } from "./firestore";

/** A rejected job action, carrying the HTTP status the route should answer with. */
export class JobActionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const JOB_LIMITS = {
  title: 200,
  description: 10_000,
  reward: 40,
  skills: 20,
  skill: 60,
  deliveryNotes: 20_000,
  deliveryFiles: 20,
  fileUrl: 2_000,
  reviewNotes: 5_000,
  cancelReason: 1_000,
} as const;

const PRIORITIES: Job["priority"][] = ["low", "medium", "high"];
const HIRING_MODES: NonNullable<Job["hiringMode"]>[] = ["instant", "applications"];

/** Fields a poster may set when creating, or change while the job is still open. */
export interface JobInput {
  title: string;
  description: string;
  reward?: string;
  requiredSkills: string[];
  priority: Job["priority"];
  projectId: string;
  hiringMode: NonNullable<Job["hiringMode"]>;
  minCompletedJobs?: number;
  minTrustScore?: number;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function optionalInt(raw: unknown, name: string, min: number, max: number): Validation<number | undefined> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return { ok: false, error: `${name} must be a whole number between ${min} and ${max}` };
  }
  return { ok: true, value: n };
}

/**
 * Validate a create (partial = false) or edit (partial = true) payload.
 * On edit only the keys present are returned, so callers can patch with it.
 */
export function validateJobInput(raw: unknown, partial: false): Validation<JobInput>;
export function validateJobInput(raw: unknown, partial: true): Validation<Partial<JobInput>>;
export function validateJobInput(raw: unknown, partial: boolean): Validation<Partial<JobInput>> {
  if (!isObj(raw)) return { ok: false, error: "Body must be a JSON object" };
  const out: Partial<JobInput> = {};
  const has = (k: string) => raw[k] !== undefined;

  if (!partial || has("title")) {
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title) return { ok: false, error: "title is required" };
    if (title.length > JOB_LIMITS.title) return { ok: false, error: `title must be at most ${JOB_LIMITS.title} characters` };
    out.title = title;
  }
  if (!partial || has("description")) {
    if (has("description") && typeof raw.description !== "string") return { ok: false, error: "description must be a string" };
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    if (description.length > JOB_LIMITS.description) {
      return { ok: false, error: `description must be at most ${JOB_LIMITS.description} characters` };
    }
    out.description = description;
  }
  if (has("reward")) {
    if (raw.reward !== null && typeof raw.reward !== "string" && typeof raw.reward !== "number") {
      return { ok: false, error: "reward must be a string or number" };
    }
    const reward = raw.reward === null ? "" : String(raw.reward).trim();
    if (reward.length > JOB_LIMITS.reward) return { ok: false, error: `reward must be at most ${JOB_LIMITS.reward} characters` };
    if (reward && parseReward(reward) < 0) return { ok: false, error: "reward cannot be negative" };
    out.reward = reward || undefined;
  }
  if (!partial || has("requiredSkills")) {
    const skills = raw.requiredSkills ?? [];
    if (!Array.isArray(skills) || skills.some((s) => typeof s !== "string")) {
      return { ok: false, error: "requiredSkills must be an array of strings" };
    }
    const cleaned = Array.from(new Set((skills as string[]).map((s) => s.trim()).filter(Boolean)));
    if (cleaned.length > JOB_LIMITS.skills) return { ok: false, error: `at most ${JOB_LIMITS.skills} required skills` };
    if (cleaned.some((s) => s.length > JOB_LIMITS.skill)) return { ok: false, error: `each skill must be at most ${JOB_LIMITS.skill} characters` };
    out.requiredSkills = cleaned;
  }
  if (!partial || has("priority")) {
    const priority = raw.priority ?? "medium";
    if (!PRIORITIES.includes(priority as Job["priority"])) return { ok: false, error: "priority must be low, medium or high" };
    out.priority = priority as Job["priority"];
  }
  if (!partial || has("projectId")) {
    const projectId = raw.projectId ?? "";
    if (typeof projectId !== "string" || projectId.length > 200) return { ok: false, error: "projectId must be a string" };
    out.projectId = projectId;
  }
  if (!partial || has("hiringMode")) {
    const hiringMode = raw.hiringMode ?? "instant";
    if (!HIRING_MODES.includes(hiringMode as JobInput["hiringMode"])) {
      return { ok: false, error: "hiringMode must be instant or applications" };
    }
    out.hiringMode = hiringMode as JobInput["hiringMode"];
  }
  if (has("minCompletedJobs")) {
    const r = optionalInt(raw.minCompletedJobs, "minCompletedJobs", 0, 100_000);
    if (!r.ok) return r;
    out.minCompletedJobs = r.value;
  }
  if (has("minTrustScore")) {
    const r = optionalInt(raw.minTrustScore, "minTrustScore", 0, 100);
    if (!r.ok) return r;
    out.minTrustScore = r.value;
  }
  // Requirements only gate instant claims (job-actions.ts::checkClaimable) —
  // on an applications job the poster vets bidders by hand, so drop them.
  if (out.hiringMode === "applications") {
    if (has("minCompletedJobs") || has("minTrustScore") || !partial) {
      out.minCompletedJobs = undefined;
      out.minTrustScore = undefined;
    }
  }
  return { ok: true, value: out };
}

/** Same free-text-to-number convention as the dashboard — Job.reward has no fixed format. */
export function parseReward(reward?: string): number {
  if (!reward) return 0;
  const n = parseFloat(reward.replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
}

export interface DeliveryInput {
  deliveryNotes: string;
  deliveryFiles: string[];
}

export function validateDelivery(raw: unknown): Validation<DeliveryInput> {
  if (!isObj(raw)) return { ok: false, error: "Body must be a JSON object" };
  const notes = typeof raw.deliveryNotes === "string" ? raw.deliveryNotes.trim() : "";
  if (!notes) return { ok: false, error: "deliveryNotes is required" };
  if (notes.length > JOB_LIMITS.deliveryNotes) {
    return { ok: false, error: `deliveryNotes must be at most ${JOB_LIMITS.deliveryNotes} characters` };
  }
  const rawFiles = raw.deliveryFiles ?? [];
  if (!Array.isArray(rawFiles)) return { ok: false, error: "deliveryFiles must be an array of URLs" };
  const files = rawFiles.filter((f): f is string => typeof f === "string").map((f) => f.trim()).filter(Boolean);
  if (files.length > JOB_LIMITS.deliveryFiles) return { ok: false, error: `at most ${JOB_LIMITS.deliveryFiles} delivery files` };
  for (const f of files) {
    if (f.length > JOB_LIMITS.fileUrl || !isHttpUrl(f)) return { ok: false, error: `Not an http(s) URL: ${f.slice(0, 80)}` };
  }
  return { ok: true, value: { deliveryNotes: notes, deliveryFiles: files } };
}

/** Delivery links are rendered as <a href> on the review page — no javascript:/data: URLs. */
export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export interface ReviewInput {
  approve: boolean;
  notes: string;
}

export function validateReview(raw: unknown): Validation<ReviewInput> {
  if (!isObj(raw)) return { ok: false, error: "Body must be a JSON object" };
  const decision = raw.decision;
  if (decision !== "approve" && decision !== "reject") return { ok: false, error: "decision must be approve or reject" };
  const notes = typeof raw.notes === "string" ? raw.notes.trim() : "";
  if (notes.length > JOB_LIMITS.reviewNotes) return { ok: false, error: `notes must be at most ${JOB_LIMITS.reviewNotes} characters` };
  // A rejection sends the agent back to work — it has to say what to change.
  if (decision === "reject" && !notes) return { ok: false, error: "notes are required when requesting revisions" };
  return { ok: true, value: { approve: decision === "approve", notes } };
}

// ─── State checks ────────────────────────────────────────

type JobState = Pick<Job, "status" | "reviewStatus" | "deliveryNotes">;

/** A delivery is waiting on the buyer's verdict. */
export function isAwaitingReview(job: JobState): boolean {
  return job.status === "completed" && job.reviewStatus === "pending" && !!job.deliveryNotes;
}

/** Posting details can change only before anyone has been assigned. */
export function canEdit(job: Pick<Job, "status">): boolean {
  return job.status === "open";
}

/** Cancel while open or being worked on; never after a delivery is in or approved. */
export function canCancel(job: Pick<Job, "status" | "gigId" | "escrow">): { ok: true } | { ok: false; error: string } {
  if (job.status !== "open" && job.status !== "in_progress" && job.status !== "claimed") {
    return { ok: false, error: `A ${job.status} job can't be cancelled` };
  }
  // Funds are locked on-chain for escrowed gig orders — a dashboard cancel
  // would strand them. Those go through the dispute flow instead.
  if (job.escrow && job.escrow.status !== "released" && job.escrow.status !== "resolved") {
    return { ok: false, error: "This order has on-chain escrow — file a dispute instead of cancelling" };
  }
  return { ok: true };
}

/** Number of the delivery about to be made (1 = first, 2 = first revision, ...). */
export function nextRevision(job: Pick<Job, "deliveryHistory">): number {
  return (job.deliveryHistory?.length ?? 0) + 1;
}

// ─── Audit events ────────────────────────────────────────

export type JobEventType =
  | "created"
  | "edited"
  | "applied"
  | "application_revised"
  | "claimed"
  | "hired"
  | "delivered"
  | "approved"
  | "revision_requested"
  | "cancelled"
  | "disputed"
  | "escrow_claimed"
  | "escrow_delivered"
  | "escrow_released";

export interface JobActor {
  type: "user" | "agent" | "system";
  /** Wallet address for users, agent id for agents. */
  id: string;
  name?: string;
}

export interface JobEvent {
  id: string;
  jobId: string;
  orgId: string;
  /** Gig orders only — lets the seller org see the trail too. */
  sellerOrgId?: string;
  type: JobEventType;
  actor: JobActor;
  /** Job status after this event. */
  status?: Job["status"];
  details?: Record<string, unknown>;
  at: number;
}

/** For edits: which fields actually changed, as {field: {from, to}}. */
export function diffJobFields(before: Partial<Job>, patch: Partial<JobInput>): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, to] of Object.entries(patch)) {
    const from = (before as Record<string, unknown>)[k];
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) changes[k] = { from: from ?? null, to: to ?? null };
  }
  return changes;
}
