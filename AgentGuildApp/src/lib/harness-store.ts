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
import type { DocumentData, DocumentSnapshot } from "firebase-admin/firestore";
import { liveWindows, type HarnessGeneration, type JobOutcome, type ReplyOutcome } from "./harness";
import type { JobRecord } from "./preferences";

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

/** Close the open live window of a generation document (for retiring it at `now`). */
function closeWindow(snap: DocumentSnapshot, now: number) {
  const g = snap.data() as HarnessGeneration;
  const windows = liveWindows(g).map((w) => (w.to == null ? { ...w, to: now } : w));
  return { status: "retired", retiredAt: now, windows };
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
      windows: [],
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
    const currentSnap = current != null ? await tx.get(generationsRef(agentId).doc(String(current))) : null;
    const now = Date.now();
    if (currentSnap?.exists) tx.update(currentSnap.ref, closeWindow(currentSnap, now));
    // A rollback keeps the generation's earlier live spans — and its first
    // activatedAt — so outcomes from back then still count toward it.
    const g = target.data() as HarnessGeneration;
    tx.update(target.ref, {
      status: "active",
      activatedAt: g.activatedAt ?? now,
      retiredAt: null,
      windows: [...liveWindows(g), { from: now, to: null }],
      decidedBy,
    });
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
    const currentSnap = await tx.get(generationsRef(agentId).doc(String(current)));
    const now = Date.now();
    if (currentSnap.exists) tx.update(currentSnap.ref, closeWindow(currentSnap, now));
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

interface ReviewEvent {
  approved: boolean;
  at: number;
  notes: string;
}

/**
 * A job's review decisions, oldest first: reviewHistory when it has one,
 * else just the current reviewStatus (jobs reviewed before history was kept).
 * A job that was sent back and then re-delivered sits at "pending" with its
 * rejection only in the history, so it still counts.
 */
function reviewEvents(job: DocumentData): ReviewEvent[] {
  if (Array.isArray(job.reviewHistory) && job.reviewHistory.length) {
    return (job.reviewHistory as { status?: unknown; at?: unknown; notes?: unknown }[])
      .filter((e) => e.status === "approved" || e.status === "rejected")
      .map((e) => ({ approved: e.status === "approved", at: toMillis(e.at) ?? 0, notes: typeof e.notes === "string" ? e.notes : "" }))
      .sort((a, b) => a.at - b.at);
  }
  if (job.reviewStatus !== "approved" && job.reviewStatus !== "rejected") return [];
  return [{
    approved: job.reviewStatus === "approved",
    at: toMillis(job.reviewedAt) ?? toMillis(job.updatedAt) ?? 0,
    notes: typeof job.reviewNotes === "string" ? job.reviewNotes : "",
  }];
}

/**
 * Buyer verdicts on jobs this agent took, newest first — one per review
 * decision, so a revision request still counts after a later approval. A
 * gig rating belongs to the order's final approval.
 */
export async function listJobOutcomes(agentId: string): Promise<JobOutcome[]> {
  const db = adminDb();
  const snap = await db.collection("jobs").where("takenByAgentId", "==", agentId).limit(MAX_JOBS).get();
  const reviewed = snap.docs.map((d) => ({ doc: d, events: reviewEvents(d.data()) })).filter((j) => j.events.length);
  const ratings = new Map<string, { rating: number; review: string }>();
  const gigJobs = reviewed.filter((j) => j.doc.data().gigId && j.events.at(-1)!.approved);
  if (gigJobs.length) {
    const reviews = await db.getAll(...gigJobs.map((j) => db.collection("gigReviews").doc(j.doc.id)));
    for (const r of reviews) {
      const data = r.data();
      if (data && typeof data.rating === "number") ratings.set(r.id, { rating: data.rating, review: data.review ?? "" });
    }
  }
  return reviewed
    .flatMap(({ doc, events }) => {
      const title = String(doc.data().title ?? "").slice(0, 200);
      const rated = ratings.get(doc.id);
      return events.map((e, i) => {
        const final = i === events.length - 1;
        return {
          jobId: doc.id,
          title,
          at: e.at,
          approved: e.approved,
          rating: final && e.approved ? rated?.rating ?? null : null,
          notes: [e.notes, final ? rated?.review : ""].filter(Boolean).join(" · ").slice(0, 1000),
        };
      });
    })
    .sort((a, b) => b.at - a.at);
}

/**
 * Jobs this agent delivered and had reviewed, with every delivery and verdict
 * — the input to the preference-data export (lib/preferences.ts). Jobs from
 * before deliveryHistory existed contribute their final delivery only.
 */
export async function listJobRecords(agentId: string, max = 1000): Promise<JobRecord[]> {
  const db = adminDb();
  const snap = await db.collection("jobs").where("takenByAgentId", "==", agentId).limit(max).get();
  const reviewed = snap.docs.map((d) => ({ doc: d, reviews: reviewEvents(d.data()) })).filter((j) => j.reviews.length);
  const ratings = new Map<string, number>();
  const gigJobs = reviewed.filter((j) => j.doc.data().gigId && j.reviews.at(-1)!.approved);
  for (let i = 0; i < gigJobs.length; i += 100) {
    const chunk = gigJobs.slice(i, i + 100);
    for (const r of await db.getAll(...chunk.map((j) => db.collection("gigReviews").doc(j.doc.id)))) {
      const rating = r.data()?.rating;
      if (typeof rating === "number") ratings.set(r.id, rating);
    }
  }
  return reviewed.map(({ doc, reviews }) => {
    const data = doc.data();
    const history = Array.isArray(data.deliveryHistory) ? (data.deliveryHistory as { notes?: unknown; at?: unknown }[]) : [];
    const deliveries = history.length
      ? history.map((h) => ({ notes: typeof h.notes === "string" ? h.notes : "", at: toMillis(h.at) ?? 0 })).sort((a, b) => a.at - b.at)
      : typeof data.deliveryNotes === "string" ? [{ notes: data.deliveryNotes, at: toMillis(data.completedAt) ?? 0 }] : [];
    return {
      jobId: doc.id,
      title: String(data.title ?? ""),
      description: String(data.description ?? ""),
      deliveries,
      reviews,
      rating: ratings.get(doc.id) ?? null,
    };
  });
}
