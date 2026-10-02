/**
 * Agent harness evolution — Firestore persistence (server-only, Admin SDK).
 * The logic lives in ./harness.ts.
 *
 *   agentHarness/{agentId}                      head: { agentId, orgId, activeGeneration, nextGeneration }
 *   agentHarness/{agentId}/generations/{gen}    HarnessGeneration
 *   agentHarness/{agentId}/outcomes/{auto}      ReplyOutcome (agent-reported)
 *
 * Job outcomes aren't stored here: they're read from `jobs` (takenByAgentId,
 * reviewStatus, reviewedAt, reviewNotes) and `gigReviews` (rating) when the
 * lineage is scored, so the buyer's verdict is the only source for them.
 */
import { adminDb } from "@/lib/firebase-admin";
import type { HarnessGeneration, JobOutcome, ReplyOutcome } from "./harness";

const HARNESS = "agentHarness";
const MAX_GENERATIONS = 100;
const MAX_JOBS = 200;
const MAX_REPLY_OUTCOMES = 1000;

function head(agentId: string) {
  return adminDb().collection(HARNESS).doc(agentId);
}
function generationsRef(agentId: string) {
  return head(agentId).collection("generations");
}
function outcomesRef(agentId: string) {
  return head(agentId).collection("outcomes");
}

export class HarnessError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function toMillis(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (v && typeof (v as { toMillis?: unknown }).toMillis === "function") return (v as { toMillis: () => number }).toMillis();
  return null;
}

export async function listGenerations(agentId: string): Promise<HarnessGeneration[]> {
  const snap = await generationsRef(agentId).orderBy("generation", "desc").limit(MAX_GENERATIONS).get();
  return snap.docs.map((d) => d.data() as HarnessGeneration).sort((a, b) => a.generation - b.generation);
}

export async function getActiveGeneration(agentId: string): Promise<HarnessGeneration | null> {
  const h = await head(agentId).get();
  const active = h.data()?.activeGeneration;
  if (typeof active !== "number") return null;
  const g = await generationsRef(agentId).doc(String(active)).get();
  return g.exists ? (g.data() as HarnessGeneration) : null;
}

/**
 * File a new generation as "proposed". Any earlier pending proposal is
 * rejected as superseded — the owner reviews one candidate at a time.
 */
export async function proposeGeneration(
  agent: { agentId: string; orgId: string },
  input: { playbook: string; improvement: string; parentGeneration: number | null },
  proposedBy: "agent" | "owner",
  decidedBy: string | null = null,
): Promise<HarnessGeneration> {
  const db = adminDb();
  return db.runTransaction(async (tx) => {
    const h = await tx.get(head(agent.agentId));
    const pending = await tx.get(generationsRef(agent.agentId).where("status", "==", "proposed"));
    const activeGeneration = (h.data()?.activeGeneration as number | null | undefined) ?? null;
    const parent = input.parentGeneration ?? activeGeneration;
    if (parent != null) {
      const p = await tx.get(generationsRef(agent.agentId).doc(String(parent)));
      if (!p.exists) throw new HarnessError(`parent generation ${parent} does not exist`, 400);
    }
    const generation = ((h.data()?.nextGeneration as number | undefined) ?? 1);
    const now = Date.now();
    const doc: HarnessGeneration = {
      generation,
      parentGeneration: parent,
      playbook: input.playbook,
      improvement: input.improvement,
      status: "proposed",
      proposedBy,
      proposedAt: now,
      activatedAt: null,
      retiredAt: null,
      decidedBy,
    };
    for (const p of pending.docs) tx.update(p.ref, { status: "rejected", decidedBy: "superseded", retiredAt: now });
    tx.set(generationsRef(agent.agentId).doc(String(generation)), doc);
    tx.set(
      head(agent.agentId),
      { agentId: agent.agentId, orgId: agent.orgId, activeGeneration, nextGeneration: generation + 1, updatedAt: now },
      { merge: true },
    );
    return doc;
  });
}

/**
 * Make `generation` the live playbook (approve a proposal, or roll back to a
 * retired one). The previously active generation is retired at the same
 * instant, so every outcome maps to exactly one generation.
 */
export async function activateGeneration(agentId: string, generation: number, decidedBy: string): Promise<void> {
  const db = adminDb();
  await db.runTransaction(async (tx) => {
    const h = await tx.get(head(agentId));
    const target = await tx.get(generationsRef(agentId).doc(String(generation)));
    if (!target.exists) throw new HarnessError("Generation not found", 404);
    const status = (target.data() as HarnessGeneration).status;
    if (status === "active") throw new HarnessError("Generation is already active", 409);
    if (status === "rejected") throw new HarnessError("A rejected generation can't be activated", 409);
    const current = h.data()?.activeGeneration as number | null | undefined;
    const now = Date.now();
    if (current != null) tx.update(generationsRef(agentId).doc(String(current)), { status: "retired", retiredAt: now });
    tx.update(target.ref, { status: "active", activatedAt: now, retiredAt: null, decidedBy });
    tx.set(head(agentId), { activeGeneration: generation, updatedAt: now }, { merge: true });
  });
}

export async function rejectGeneration(agentId: string, generation: number, decidedBy: string): Promise<void> {
  const ref = generationsRef(agentId).doc(String(generation));
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HarnessError("Generation not found", 404);
    if ((snap.data() as HarnessGeneration).status !== "proposed") {
      throw new HarnessError("Only a proposed generation can be rejected", 409);
    }
    tx.update(ref, { status: "rejected", decidedBy, retiredAt: Date.now() });
  });
}

/** Turn the playbook off: the agent goes back to its runtime's default prompt. */
export async function deactivate(agentId: string): Promise<void> {
  await adminDb().runTransaction(async (tx) => {
    const h = await tx.get(head(agentId));
    const current = h.data()?.activeGeneration as number | null | undefined;
    if (current == null) return;
    const now = Date.now();
    tx.update(generationsRef(agentId).doc(String(current)), { status: "retired", retiredAt: now });
    tx.set(head(agentId), { activeGeneration: null, updatedAt: now }, { merge: true });
  });
}

/**
 * Store agent-reported outcomes, keeping only those for generations that
 * have actually been live — an agent can't pad a proposal's score before
 * it ships. Returns how many were kept.
 */
export async function recordReplyOutcomes(agentId: string, outcomes: ReplyOutcome[]): Promise<number> {
  const live = new Set(
    (await listGenerations(agentId)).filter((g) => g.activatedAt != null).map((g) => g.generation),
  );
  const kept = outcomes.filter((o) => live.has(o.generation));
  if (!kept.length) return 0;
  const batch = adminDb().batch();
  for (const o of kept) batch.set(outcomesRef(agentId).doc(), o);
  await batch.commit();
  return kept.length;
}

export async function listReplyOutcomes(agentId: string): Promise<ReplyOutcome[]> {
  const snap = await outcomesRef(agentId).orderBy("at", "desc").limit(MAX_REPLY_OUTCOMES).get();
  return snap.docs.map((d) => d.data() as ReplyOutcome);
}

/** Buyer verdicts on jobs this agent took, newest first. */
export async function listJobOutcomes(agentId: string): Promise<JobOutcome[]> {
  const db = adminDb();
  const snap = await db.collection("jobs").where("takenByAgentId", "==", agentId).limit(MAX_JOBS).get();
  const reviewed = snap.docs.filter((d) => {
    const s = d.data().reviewStatus;
    return s === "approved" || s === "rejected";
  });
  const ratings = new Map<string, { rating: number; review: string }>();
  const gigJobs = reviewed.filter((d) => d.data().gigId);
  if (gigJobs.length) {
    const reviews = await db.getAll(...gigJobs.map((d) => db.collection("gigReviews").doc(d.id)));
    for (const r of reviews) {
      const data = r.data();
      if (data && typeof data.rating === "number") ratings.set(r.id, { rating: data.rating, review: data.review ?? "" });
    }
  }
  return reviewed
    .map((d) => {
      const job = d.data();
      const rated = ratings.get(d.id);
      return {
        jobId: d.id,
        title: String(job.title ?? "").slice(0, 200),
        at: toMillis(job.reviewedAt) ?? toMillis(job.updatedAt) ?? 0,
        approved: job.reviewStatus === "approved",
        rating: rated?.rating ?? null,
        notes: [job.reviewNotes, rated?.review].filter(Boolean).join(" · ").slice(0, 1000),
      };
    })
    .sort((a, b) => b.at - a.at);
}
