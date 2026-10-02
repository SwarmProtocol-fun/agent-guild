/**
 * Agent harness evolution (SIA-style) — pure logic, no Firestore.
 *
 * Every connected agent runs under a *playbook*: operating instructions the
 * daemon injects into whatever runtime generates its replies. A playbook
 * evolves in generations, the way SIA (Self-Improving AI, arXiv 2605.27276)
 * evolves a target agent's harness:
 *
 *   1. The agent runs under generation N and collects outcomes.
 *   2. Its feedback step (`agent-guild evolve`, on the agent's own model)
 *      reads GET /api/v1/harness/feedback and proposes generation N+1 with
 *      an improvement note.
 *   3. The org owner approves it; it goes live and gets scored in turn.
 *
 * Scores come from outcomes the hub already trusts — the buyer's
 * approve/reject decision and 1-5 rating on jobs the agent took — plus
 * agent-reported reply results, weighted lower because they are
 * self-reported. Each outcome is credited to the generation that was live
 * when it happened.
 */

export const MAX_PLAYBOOK_CHARS = 8000;
export const MAX_IMPROVEMENT_CHARS = 4000;
export const MAX_OUTCOMES_PER_REPORT = 50;

/** Score for a generation needs this many signals before it is compared. */
export const MIN_SCORED_SIGNALS = 5;
/** A generation this far below its parent is flagged as a regression. */
export const REGRESSION_MARGIN = 0.05;
/** Improvements smaller than this don't count toward escaping a plateau. */
export const PLATEAU_EPSILON = 0.02;
/** This many scored generations in a row without improvement = plateau. */
export const PLATEAU_WINDOW = 3;

const JOB_WEIGHT = 3;
const REPLY_WEIGHT = 1;

export type GenerationStatus = "proposed" | "active" | "retired" | "rejected";

export interface HarnessGeneration {
  generation: number;
  parentGeneration: number | null;
  playbook: string;
  improvement: string;
  status: GenerationStatus;
  proposedBy: "agent" | "owner";
  proposedAt: number;
  activatedAt: number | null;
  retiredAt: number | null;
  decidedBy: string | null;
}

/** A buyer's verdict on a job the agent took (from jobs + gigReviews). */
export interface JobOutcome {
  jobId: string;
  title: string;
  at: number;
  approved: boolean;
  rating: number | null;
  notes: string;
}

/** An agent-reported reply result (POST /api/v1/harness/outcomes). */
export interface ReplyOutcome {
  generation: number;
  ok: boolean;
  detail: string;
  at: number;
}

export interface GenerationScore {
  generation: number;
  score: number | null;
  signals: number;
  jobs: { n: number; mean: number | null };
  replies: { n: number; okRate: number | null };
}

export interface LineageAnalysis {
  scores: GenerationScore[];
  activeGeneration: number | null;
  /** Active generation scores clearly below its parent — owner should consider a rollback. */
  regression: boolean;
  /** The last PLATEAU_WINDOW scored generations didn't beat the best before them. */
  plateaued: boolean;
  bestGeneration: number | null;
}

/** A job verdict as a 0..1 value: the rating when there is one, else approve/reject. */
export function jobValue(o: JobOutcome): number {
  if (o.rating != null) return (Math.min(5, Math.max(1, o.rating)) - 1) / 4;
  return o.approved ? 1 : 0;
}

/** The generation live at time `at`, or null (the runtime's default prompt). */
export function generationAt(generations: HarnessGeneration[], at: number): number | null {
  let live: HarnessGeneration | null = null;
  for (const g of generations) {
    if (g.activatedAt == null || g.activatedAt > at) continue;
    if (g.retiredAt != null && g.retiredAt <= at) continue;
    if (!live || g.activatedAt > live.activatedAt!) live = g;
  }
  return live ? live.generation : null;
}

export function scoreGenerations(
  generations: HarnessGeneration[],
  jobs: JobOutcome[],
  replies: ReplyOutcome[],
): GenerationScore[] {
  const jobValues = new Map<number, number[]>();
  for (const job of jobs) {
    const gen = generationAt(generations, job.at);
    if (gen == null) continue;
    jobValues.set(gen, [...(jobValues.get(gen) ?? []), jobValue(job)]);
  }
  const replyOks = new Map<number, boolean[]>();
  for (const r of replies) replyOks.set(r.generation, [...(replyOks.get(r.generation) ?? []), r.ok]);

  return generations
    .filter((g) => g.activatedAt != null)
    .map((g) => {
      const jv = jobValues.get(g.generation) ?? [];
      const ro = replyOks.get(g.generation) ?? [];
      const jobSum = jv.reduce((s, v) => s + v, 0);
      const okCount = ro.filter(Boolean).length;
      const weight = jv.length * JOB_WEIGHT + ro.length * REPLY_WEIGHT;
      return {
        generation: g.generation,
        score: weight ? (jobSum * JOB_WEIGHT + okCount * REPLY_WEIGHT) / weight : null,
        signals: jv.length + ro.length,
        jobs: { n: jv.length, mean: jv.length ? jobSum / jv.length : null },
        replies: { n: ro.length, okRate: ro.length ? okCount / ro.length : null },
      };
    })
    .sort((a, b) => a.generation - b.generation);
}

export function analyzeLineage(
  generations: HarnessGeneration[],
  jobs: JobOutcome[],
  replies: ReplyOutcome[],
): LineageAnalysis {
  const scores = scoreGenerations(generations, jobs, replies);
  const active = generations.find((g) => g.status === "active") ?? null;
  const byGen = new Map(scores.map((s) => [s.generation, s]));
  const comparable = (s: GenerationScore | undefined): s is GenerationScore & { score: number } =>
    !!s && s.score != null && s.signals >= MIN_SCORED_SIGNALS;

  let regression = false;
  if (active?.parentGeneration != null) {
    const mine = byGen.get(active.generation);
    const parent = byGen.get(active.parentGeneration);
    if (comparable(mine) && comparable(parent)) regression = mine.score < parent.score - REGRESSION_MARGIN;
  }

  const scored = scores.filter(comparable);
  let plateaued = false;
  if (scored.length > PLATEAU_WINDOW) {
    const before = scored.slice(0, -PLATEAU_WINDOW);
    const recent = scored.slice(-PLATEAU_WINDOW);
    const bestBefore = Math.max(...before.map((s) => s.score));
    plateaued = recent.every((s) => s.score <= bestBefore + PLATEAU_EPSILON);
  }

  const best = scored.reduce<(GenerationScore & { score: number }) | null>(
    (b, s) => (!b || s.score > b.score ? s : b),
    null,
  );

  return {
    scores,
    activeGeneration: active?.generation ?? null,
    regression,
    plateaued,
    bestGeneration: best?.generation ?? null,
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate POST /api/v1/harness (an agent proposing its next generation). */
export function parseProposal(
  body: unknown,
): { ok: true; playbook: string; improvement: string; parentGeneration: number | null } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "body must be a JSON object" };
  const playbook = typeof body.playbook === "string" ? body.playbook.trim() : "";
  const improvement = typeof body.improvement === "string" ? body.improvement.trim() : "";
  if (!playbook) return { ok: false, error: "playbook is required" };
  if (playbook.length > MAX_PLAYBOOK_CHARS) return { ok: false, error: `playbook is over ${MAX_PLAYBOOK_CHARS} characters` };
  if (!improvement) return { ok: false, error: "improvement is required — say what changed and why" };
  if (improvement.length > MAX_IMPROVEMENT_CHARS) {
    return { ok: false, error: `improvement is over ${MAX_IMPROVEMENT_CHARS} characters` };
  }
  const parent = body.parentGeneration;
  if (parent != null && !(typeof parent === "number" && Number.isInteger(parent) && parent >= 1)) {
    return { ok: false, error: "parentGeneration must be a generation number or null" };
  }
  return { ok: true, playbook, improvement, parentGeneration: (parent as number | null | undefined) ?? null };
}

/** Validate POST /api/v1/harness/outcomes. Timestamps are the server's, not the agent's. */
export function parseOutcomes(body: unknown, now: number): { ok: true; outcomes: ReplyOutcome[] } | { ok: false; error: string } {
  if (!isObj(body) || !Array.isArray(body.outcomes)) return { ok: false, error: "outcomes must be an array" };
  if (body.outcomes.length === 0) return { ok: false, error: "outcomes is empty" };
  if (body.outcomes.length > MAX_OUTCOMES_PER_REPORT) {
    return { ok: false, error: `at most ${MAX_OUTCOMES_PER_REPORT} outcomes per report` };
  }
  const outcomes: ReplyOutcome[] = [];
  for (const [i, raw] of body.outcomes.entries()) {
    if (!isObj(raw)) return { ok: false, error: `outcomes[${i}] must be an object` };
    const gen = raw.generation;
    if (!(typeof gen === "number" && Number.isInteger(gen) && gen >= 1)) {
      return { ok: false, error: `outcomes[${i}].generation must be a generation number` };
    }
    if (typeof raw.ok !== "boolean") return { ok: false, error: `outcomes[${i}].ok must be true or false` };
    outcomes.push({
      generation: gen,
      ok: raw.ok,
      detail: typeof raw.detail === "string" ? raw.detail.slice(0, 300) : "",
      at: now,
    });
  }
  return { ok: true, outcomes };
}

export interface FeedbackContext {
  activeGeneration: number | null;
  playbook: string | null;
  analysis: Omit<LineageAnalysis, "scores">;
  /** Each generation's improvement note and score, oldest first — what has been tried. */
  lineage: { generation: number; status: GenerationStatus; improvement: string; score: number | null; signals: number }[];
  /** Outcomes under the live generation (or the default prompt, if none is live). */
  failures: { kind: "job" | "reply"; at: number; summary: string }[];
  successes: { kind: "job"; at: number; summary: string }[];
  counts: { jobs: number; replies: number; replyFailures: number };
}

const FEEDBACK_FAILURES = 25;
const FEEDBACK_SUCCESSES = 10;

/**
 * What the agent's feedback step reads before proposing generation N+1 —
 * SIA's "feedback agent" input. Failures are a buyer rejection, a rating of
 * 3 or below, or a reply the runtime couldn't produce or deliver.
 */
export function buildFeedback(
  generations: HarnessGeneration[],
  jobs: JobOutcome[],
  replies: ReplyOutcome[],
): FeedbackContext {
  const { scores, ...analysis } = analyzeLineage(generations, jobs, replies);
  const active = generations.find((g) => g.status === "active") ?? null;
  const live = active?.generation ?? null;
  const byGen = new Map(scores.map((s) => [s.generation, s]));

  const liveJobs = jobs.filter((j) => generationAt(generations, j.at) === live);
  const liveReplies = live == null ? [] : replies.filter((r) => r.generation === live);
  const jobLine = (j: JobOutcome) =>
    `${j.approved ? "approved" : "rejected"}${j.rating != null ? `, rated ${j.rating}/5` : ""}: "${j.title}"${j.notes ? ` — buyer: ${j.notes}` : ""}`;
  const isFailure = (j: JobOutcome) => !j.approved || (j.rating != null && j.rating <= 3);

  const failures = [
    ...liveJobs.filter(isFailure).map((j) => ({ kind: "job" as const, at: j.at, summary: jobLine(j) })),
    ...liveReplies.filter((r) => !r.ok).map((r) => ({ kind: "reply" as const, at: r.at, summary: r.detail || "reply failed" })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, FEEDBACK_FAILURES);

  return {
    activeGeneration: live,
    playbook: active?.playbook ?? null,
    analysis,
    lineage: generations.map((g) => ({
      generation: g.generation,
      status: g.status,
      improvement: g.improvement,
      score: byGen.get(g.generation)?.score ?? null,
      signals: byGen.get(g.generation)?.signals ?? 0,
    })),
    failures,
    successes: liveJobs
      .filter((j) => !isFailure(j))
      .slice(0, FEEDBACK_SUCCESSES)
      .map((j) => ({ kind: "job" as const, at: j.at, summary: jobLine(j) })),
    counts: {
      jobs: liveJobs.length,
      replies: liveReplies.length,
      replyFailures: liveReplies.filter((r) => !r.ok).length,
    },
  };
}
