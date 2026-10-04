/**
 * dimos-bench — pure logic: validating a submitted dimos eval run and
 * ranking runs into a leaderboard. No Firestore, no Next imports, so it is
 * unit-testable (src/lib/mods/__tests__/dimos-bench.test.ts).
 *
 * The shapes mirror what `dimos evals run` writes to its run directory
 * (dimos/evals/runner.py): manifest.json, summary.json, results.jsonl.
 */

export const MAX_CASES = 500;
export const MAX_IMPROVEMENT = 8000;
const MAX_TEXT = 500;
const MAX_ID = 200;
const LINEAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;

export interface CaseResult {
  caseId: string;
  score: number;
  passed: boolean;
  durationS: number;
  error: string;
  finalAnswer: string;
  steps: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  endedBy: string;
}

export interface RunSummary {
  n: number;
  meanScore: number;
  passRate: number;
  errors: number;
  durationS: number;
  costUsd: number | null;
}

/** Lineage fields as the submitter claims them; resolveLineage() decides the real ones. */
export interface LineageClaim {
  lineageId: string | null;
  parentRunId: string | null;
}

/** A validated submission, before the server stamps identity, lineage and time. */
export interface RunSubmission {
  suite: string;
  agentModule: string;
  model: string;
  tags: string[];
  dimosGitSha: string | null;
  dimosDirty: boolean;
  /** Hash of the harness code that produced this run (prompts, tools, agent loop). */
  harnessSha: string | null;
  /** What changed versus the parent run, written by whoever made the change. */
  improvement: string;
  summary: RunSummary;
  results: CaseResult[];
}

export interface BenchRun extends RunSubmission {
  id: string;
  /** The root run's id unless the lineage was started under a chosen name. */
  lineageId: string;
  parentRunId: string | null;
  /** 0 for a lineage's first run, parent's generation + 1 after that. */
  generation: number;
  agentId: string;
  agentName: string;
  orgId: string;
  /** The worker agent that ran it, when queued from the panel (agentId is then the agent under test). */
  ranBy?: string | null;
  jobId?: string | null;
  createdAt: string;
}

export interface LeaderboardRow {
  agentId: string;
  agentName: string;
  model: string;
  agentModule: string;
  bestRunId: string;
  generation: number;
  lineageId: string;
  meanScore: number;
  passRate: number;
  n: number;
  costUsd: number | null;
  runs: number;
  lastRunAt: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = MAX_TEXT) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const count = (v: unknown) => Math.max(0, Math.floor(num(v)));
const unit = (v: unknown) => Math.min(1, Math.max(0, num(v)));
const cost = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** dimos EvalResult (snake_case, results.jsonl line) → CaseResult. */
function parseCase(raw: unknown): CaseResult | null {
  if (!isObj(raw)) return null;
  const caseId = text(raw.case_id, MAX_ID);
  if (!caseId) return null;
  const score = unit(raw.score);
  return {
    caseId,
    score,
    passed: raw.passed === true,
    durationS: Math.max(0, num(raw.duration_s)),
    error: text(raw.error),
    finalAnswer: text(raw.final_answer),
    steps: count(raw.steps),
    toolCalls: count(raw.tool_calls),
    promptTokens: count(raw.prompt_tokens),
    completionTokens: count(raw.completion_tokens),
    costUsd: cost(raw.cost_usd),
    endedBy: text(raw.ended_by, 32),
  };
}

/**
 * The summary is recomputed from the cases rather than trusted from the
 * submitter, the same way dimos's own `summarize()` derives it — so a run
 * can't claim a mean score its cases don't add up to.
 */
export function summarize(results: CaseResult[]): RunSummary {
  const n = results.length;
  const costs = results.map((r) => r.costUsd);
  return {
    n,
    meanScore: n ? results.reduce((s, r) => s + r.score, 0) / n : 0,
    passRate: n ? results.filter((r) => r.passed).length / n : 0,
    errors: results.filter((r) => r.error).length,
    durationS: results.reduce((s, r) => s + r.durationS, 0),
    costUsd: costs.some((c) => c === null) ? null : costs.reduce<number>((s, c) => s + (c ?? 0), 0),
  };
}

/** Validate a POST /runs body. Returns the submission or a list of problems. */
export function parseSubmission(
  body: unknown,
): { ok: true; run: RunSubmission; lineage: LineageClaim } | { ok: false; errors: string[] } {
  if (!isObj(body)) return { ok: false, errors: ["body must be a JSON object"] };
  const errors: string[] = [];
  const suite = text(body.suite, MAX_ID);
  const agentModule = text(body.agentModule, MAX_ID);
  if (!suite) errors.push("suite is required (dotted dimos suite module)");
  if (!agentModule) errors.push("agentModule is required (dotted dimos agent module)");
  if (body.lineageId != null && !(typeof body.lineageId === "string" && LINEAGE_ID_RE.test(body.lineageId))) {
    errors.push("lineageId must be 1-64 letters, digits, _ or -");
  }
  if (body.parentRunId != null && !(typeof body.parentRunId === "string" && LINEAGE_ID_RE.test(body.parentRunId))) {
    errors.push("parentRunId must be a run id");
  }
  if (body.harnessSha != null && !(typeof body.harnessSha === "string" && SHA_RE.test(body.harnessSha))) {
    errors.push("harnessSha must be a lowercase hex hash (7-64 chars)");
  }
  if (body.improvement != null && typeof body.improvement !== "string") errors.push("improvement must be text");
  else if (typeof body.improvement === "string" && body.improvement.length > MAX_IMPROVEMENT) {
    errors.push(`improvement notes are capped at ${MAX_IMPROVEMENT} characters`);
  }
  if (!Array.isArray(body.results) || body.results.length === 0) errors.push("results must be a non-empty array");
  else if (body.results.length > MAX_CASES) errors.push(`at most ${MAX_CASES} cases per run`);
  if (errors.length) return { ok: false, errors };

  const results = (body.results as unknown[]).map(parseCase);
  const bad = results.findIndex((r) => r === null);
  if (bad !== -1) return { ok: false, errors: [`results[${bad}] needs a case_id`] };
  const cases = results as CaseResult[];
  if (new Set(cases.map((c) => c.caseId)).size !== cases.length) {
    return { ok: false, errors: ["duplicate case_id in results"] };
  }

  const code = isObj(body.code) ? body.code : {};
  return {
    ok: true,
    run: {
      suite,
      agentModule,
      model: text(body.model, MAX_ID) || "unknown",
      tags: Array.isArray(body.tags) ? body.tags.map((t) => text(t, 64)).filter(Boolean).slice(0, 20) : [],
      dimosGitSha: text(code.git_sha, 64) || null,
      dimosDirty: code.dirty === true,
      harnessSha: (body.harnessSha as string | undefined) ?? null,
      improvement: ((body.improvement as string | undefined) ?? "").trim(),
      summary: summarize(cases),
      results: cases,
    },
    // A submitted `generation` is deliberately not read: the server derives it.
    lineage: {
      lineageId: (body.lineageId as string | undefined) ?? null,
      parentRunId: (body.parentRunId as string | undefined) ?? null,
    },
  };
}

export type LineageResolution =
  | { ok: true; lineageId: string; parentRunId: string | null; generation: number }
  | { ok: false; status: number; error: string };

/**
 * Where a new run sits in a lineage. With a parent, the parent must be the
 * same agent's run on the same suite, and the child inherits its lineage at
 * generation + 1. Without one, the run starts a lineage: under the chosen
 * lineageId if it is unused, else under its own run id.
 */
export function resolveLineage(args: {
  runId: string;
  agentId: string;
  suite: string;
  claim: LineageClaim;
  parent: BenchRun | null;
  /** Runs already filed under claim.lineageId (only consulted without a parent). */
  lineageTaken: boolean;
}): LineageResolution {
  const { runId, agentId, suite, claim, parent, lineageTaken } = args;
  if (claim.parentRunId) {
    if (!parent) return { ok: false, status: 404, error: `parent run ${claim.parentRunId} not found` };
    if (parent.agentId !== agentId) return { ok: false, status: 403, error: "parent run belongs to a different agent" };
    if (parent.suite !== suite) {
      return { ok: false, status: 400, error: `parent run is on suite ${parent.suite}, not ${suite}` };
    }
    if (claim.lineageId && claim.lineageId !== parent.lineageId) {
      return { ok: false, status: 400, error: `parent run is in lineage ${parent.lineageId}, not ${claim.lineageId}` };
    }
    return { ok: true, lineageId: parent.lineageId, parentRunId: parent.id, generation: parent.generation + 1 };
  }
  if (claim.lineageId && lineageTaken) {
    return { ok: false, status: 409, error: `lineage ${claim.lineageId} already exists; extend it with parentRunId` };
  }
  return { ok: true, lineageId: claim.lineageId ?? runId, parentRunId: null, generation: 0 };
}

// ── Lineage report (the scheduler signal) ────────────────────────────────

export interface GenerationPoint {
  generation: number;
  /** The best run of this generation (a lineage can branch). */
  runId: string;
  meanScore: number;
  passRate: number;
  /** Change in meanScore versus the previous generation's best; null for the first. */
  delta: number | null;
  improvement: string;
  harnessSha: string | null;
  runs: number;
  createdAt: string;
}

export interface LineageReport {
  lineageId: string;
  agentId: string;
  agentName: string;
  suite: string;
  generations: GenerationPoint[];
  bestGeneration: number;
  bestRunId: string;
  bestScore: number;
  generationsSinceImprovement: number;
  /** No new best score in the last `patience` generations. */
  plateau: boolean;
  patience: number;
  minDelta: number;
  decision: "continue" | "stop";
}

/**
 * Score per generation and whether the lineage has stopped improving: the
 * running best must rise by more than `minDelta`, and `plateau` is set once
 * `patience` generations pass without that happening.
 */
export function lineageReport(runs: BenchRun[], opts: { patience: number; minDelta: number }): LineageReport | null {
  if (runs.length === 0) return null;
  const byGen = new Map<number, BenchRun[]>();
  for (const run of runs) byGen.set(run.generation, [...(byGen.get(run.generation) ?? []), run]);

  const generations: GenerationPoint[] = [];
  for (const generation of [...byGen.keys()].sort((a, b) => a - b)) {
    const group = byGen.get(generation)!;
    const best = [...group].sort(
      (a, b) => b.summary.meanScore - a.summary.meanScore || a.createdAt.localeCompare(b.createdAt),
    )[0];
    const prev = generations.at(-1);
    generations.push({
      generation,
      runId: best.id,
      meanScore: best.summary.meanScore,
      passRate: best.summary.passRate,
      delta: prev ? best.summary.meanScore - prev.meanScore : null,
      improvement: best.improvement,
      harnessSha: best.harnessSha,
      runs: group.length,
      createdAt: best.createdAt,
    });
  }

  let bestPoint = generations[0];
  for (const point of generations.slice(1)) {
    if (point.meanScore > bestPoint.meanScore + opts.minDelta) bestPoint = point;
  }
  const latest = generations.at(-1)!.generation;
  const since = latest - bestPoint.generation;
  const plateau = since >= opts.patience;
  const root = runs.find((r) => r.generation === generations[0].generation)!;
  return {
    lineageId: root.lineageId,
    agentId: root.agentId,
    agentName: root.agentName,
    suite: root.suite,
    generations,
    bestGeneration: bestPoint.generation,
    bestRunId: bestPoint.runId,
    bestScore: bestPoint.meanScore,
    generationsSinceImprovement: since,
    plateau,
    patience: opts.patience,
    minDelta: opts.minDelta,
    decision: plateau ? "stop" : "continue",
  };
}

// ── Feedback context (what a feedback / meta agent reads) ────────────────

export interface FeedbackContext {
  run: {
    id: string;
    agentId: string;
    agentName: string;
    suite: string;
    agentModule: string;
    model: string;
    lineageId: string;
    generation: number;
    harnessSha: string | null;
    dimosGitSha: string | null;
    summary: RunSummary;
  };
  /** Cases that errored or did not pass, worst first. */
  failures: (Pick<CaseResult, "caseId" | "score" | "error" | "finalAnswer" | "steps" | "toolCalls" | "promptTokens" | "completionTokens" | "endedBy"> & {
    kind: "error" | "failed";
  })[];
  passedCaseIds: string[];
  /** Earlier generations' notes, oldest first, ending with this run's own. */
  improvementHistory: { runId: string; generation: number; meanScore: number; harnessSha: string | null; improvement: string }[];
}

/** `chain` is this run's ancestors, nearest first (as walked via parentRunId). */
export function feedbackContext(run: BenchRun, chain: BenchRun[]): FeedbackContext {
  const failures = run.results
    .filter((c) => c.error || !c.passed)
    .sort((a, b) => Number(!a.error) - Number(!b.error) || a.score - b.score)
    .map((c) => ({
      caseId: c.caseId,
      kind: (c.error ? "error" : "failed") as "error" | "failed",
      score: c.score,
      error: c.error,
      finalAnswer: c.finalAnswer,
      steps: c.steps,
      toolCalls: c.toolCalls,
      promptTokens: c.promptTokens,
      completionTokens: c.completionTokens,
      endedBy: c.endedBy,
    }));
  return {
    run: {
      id: run.id,
      agentId: run.agentId,
      agentName: run.agentName,
      suite: run.suite,
      agentModule: run.agentModule,
      model: run.model,
      lineageId: run.lineageId,
      generation: run.generation,
      harnessSha: run.harnessSha,
      dimosGitSha: run.dimosGitSha,
      summary: run.summary,
    },
    failures,
    passedCaseIds: run.results.filter((c) => c.passed && !c.error).map((c) => c.caseId),
    improvementHistory: [...chain].reverse().concat(run).map((r) => ({
      runId: r.id,
      generation: r.generation,
      meanScore: r.summary.meanScore,
      harnessSha: r.harnessSha,
      improvement: r.improvement,
    })),
  };
}

/**
 * One row per (agent, model, agent module): its best run on the suite by
 * mean score, ties broken by pass rate, then the earlier run. Only runs over
 * the same case selection are comparable, so callers pass a single suite.
 */
export function buildLeaderboard(runs: BenchRun[]): LeaderboardRow[] {
  const groups = new Map<string, BenchRun[]>();
  for (const run of runs) {
    const key = `${run.agentId}\u0000${run.model}\u0000${run.agentModule}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const better = (a: BenchRun, b: BenchRun) =>
    b.summary.meanScore - a.summary.meanScore ||
    b.summary.passRate - a.summary.passRate ||
    a.createdAt.localeCompare(b.createdAt);

  return [...groups.values()]
    .map((group) => {
      const best = [...group].sort(better)[0];
      return {
        agentId: best.agentId,
        agentName: best.agentName,
        model: best.model,
        agentModule: best.agentModule,
        bestRunId: best.id,
        generation: best.generation,
        lineageId: best.lineageId,
        meanScore: best.summary.meanScore,
        passRate: best.summary.passRate,
        n: best.summary.n,
        costUsd: best.summary.costUsd,
        runs: group.length,
        lastRunAt: group.map((r) => r.createdAt).sort().at(-1)!,
      };
    })
    .sort((a, b) => b.meanScore - a.meanScore || b.passRate - a.passRate || a.agentName.localeCompare(b.agentName));
}

// ── Robot replay: what the robot did in one case ─────────────────────────

export const MAX_POSES = 400;
export const MAX_FRAMES = 8;
export const MAX_ACTIONS = 60;
/** Base64 bytes per keyframe (~75 KB JPEG); 8 of them keep a document well under 1 MiB. */
export const MAX_FRAME_B64 = 100_000;

/** [t, x, y, yaw]: seconds from the recording's start, metres, radians. */
export type Pose = [number, number, number, number];

export interface Keyframe {
  t: number;
  w: number;
  h: number;
  /** base64 JPEG */
  jpeg: string;
}

export interface RobotAction {
  /** Seconds from the recording's start; null when the recording's clock isn't the agent's (a frozen dataset). */
  t: number | null;
  name: string;
  args: string;
}

export interface RobotReplay {
  runId: string;
  caseId: string;
  /** dimOS environment class, e.g. MujocoSim, Habitat, DimSim, Dataset. */
  environment: string;
  /** Dataset name or recording id. */
  source: string;
  path: Pose[];
  frames: Keyframe[];
  actions: RobotAction[];
  streams: { name: string; count: number }[];
}

export type ReplayBrief = Pick<RobotReplay, "caseId" | "environment" | "source"> & {
  poses: number;
  frames: number;
  actions: number;
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const JPEG_B64_RE = /^\/9j\/[A-Za-z0-9+/]+=*$/; // base64 of a JPEG starts with FF D8 FF

/** Validate a PUT /runs/:runId/media/:caseId body (the python client's robot.json + actions). */
export function parseReplay(
  body: unknown,
  ids: { runId: string; caseId: string },
): { ok: true; replay: RobotReplay } | { ok: false; errors: string[] } {
  if (!isObj(body)) return { ok: false, errors: ["body must be a JSON object"] };
  const errors: string[] = [];
  const path = Array.isArray(body.path) ? body.path : [];
  const frames = Array.isArray(body.frames) ? body.frames : [];
  const actions = Array.isArray(body.actions) ? body.actions : [];
  if (path.length > MAX_POSES) errors.push(`at most ${MAX_POSES} poses`);
  if (frames.length > MAX_FRAMES) errors.push(`at most ${MAX_FRAMES} frames`);
  if (actions.length > MAX_ACTIONS) errors.push(`at most ${MAX_ACTIONS} actions`);
  if (!path.length && !frames.length) errors.push("a replay needs a path or frames");

  const poses: Pose[] = [];
  path.forEach((p, i) => {
    if (Array.isArray(p) && p.length === 4 && p.every(finite)) poses.push(p as Pose);
    else errors.push(`path[${i}] must be [t, x, y, yaw]`);
  });
  const keyframes: Keyframe[] = [];
  frames.forEach((f, i) => {
    if (!isObj(f) || !finite(f.t) || typeof f.jpeg !== "string") return errors.push(`frames[${i}] needs t and jpeg`);
    if (f.jpeg.length > MAX_FRAME_B64) return errors.push(`frames[${i}] is over ${MAX_FRAME_B64} base64 bytes`);
    if (!JPEG_B64_RE.test(f.jpeg)) return errors.push(`frames[${i}].jpeg must be a base64 JPEG`);
    keyframes.push({ t: f.t, w: count(f.w), h: count(f.h), jpeg: f.jpeg });
  });
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    replay: {
      ...ids,
      environment: text(body.environment, 64) || "unknown",
      source: text(body.source, MAX_ID),
      path: poses.sort((a, b) => a[0] - b[0]),
      frames: keyframes.sort((a, b) => a.t - b.t),
      actions: actions.filter(isObj).map((a) => ({
        t: finite(a.t) ? a.t : null,
        name: text(a.name, 80),
        args: text(a.args, 200),
      })),
      streams: (Array.isArray(body.streams) ? body.streams : [])
        .filter(isObj)
        .slice(0, 50)
        .map((s) => ({ name: text(s.name, 64), count: count(s.count) }))
        .filter((s) => s.name),
    },
  };
}

export function replayBrief(r: RobotReplay): ReplayBrief {
  return {
    caseId: r.caseId,
    environment: r.environment,
    source: r.source,
    poses: r.path.length,
    frames: r.frames.length,
    actions: r.actions.length,
  };
}

// ── Benchmark jobs: queued from the panel, run by an agentguild-dimos worker ──

/** Suites that ship with dimOS, for the panel's picker. `robot`: needs a sim or robot recording. */
/** The robots the shipped suites benchmark on; a suite outside the catalog is "other". */
export const BENCH_ROBOTS = {
  go2: "Unitree Go2 (quadruped)",
  xarm: "UFactory xArm (robot arm)",
  habitat: "Habitat agent (virtual)",
  other: "Other / custom",
} as const;
export type BenchRobot = keyof typeof BENCH_ROBOTS;

export const SUITE_CATALOG: { suite: string; label: string; cases: number; needs: "dataset" | "sim"; robot: BenchRobot }[] = [
  { suite: "dimos.evals.suites.examples", label: "Examples (go2 recording)", cases: 2, needs: "dataset", robot: "go2" },
  { suite: "dimos.evals.suites.go2_smoke", label: "Go2 smoke (recordings)", cases: 5, needs: "dataset", robot: "go2" },
  { suite: "dimos.evals.suites.go2_vqa", label: "Go2 visual QA", cases: 3, needs: "dataset", robot: "go2" },
  { suite: "dimos.evals.suites.mujoco_xarm", label: "MuJoCo xArm pick & place", cases: 2, needs: "sim", robot: "xarm" },
  { suite: "dimos.evals.suites.habitat_smoke", label: "Habitat navigation", cases: 1, needs: "sim", robot: "habitat" },
  { suite: "dimos.evals.suites.dimsim_house", label: "DimSim house navigation", cases: 1, needs: "sim", robot: "go2" },
  { suite: "dimos.evals.suites.dimsim_apartment_qa", label: "DimSim apartment QA", cases: 23, needs: "sim", robot: "go2" },
];

/** Which robot a suite benchmarks on: the catalog's answer, else "other". */
export function suiteRobot(suite: string): BenchRobot {
  return SUITE_CATALOG.find((x) => x.suite === suite)?.robot ?? "other";
}

/** dimOS agent harnesses a job can run; `remote` hands each case to the Agent Guild agent itself. */
export const HARNESSES = {
  pi: "dimos.evals.agents.pi",
  dimcode: "dimos.evals.agents.dimcode",
  question_answer: "dimos.evals.agents.question_answer",
  remote: "agentguild_dimos.remote_agent",
} as const;
export type HarnessKey = keyof typeof HARNESSES;

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface BenchJob {
  id: string;
  orgId: string;
  /** The agent the run is filed under. */
  targetAgentId: string;
  targetAgentName: string;
  requestedBy: string;
  suite: string;
  harness: HarnessKey;
  agentModule: string;
  /** `--set k=v` overrides for the harness (model=…, target=… for remote). */
  settings: Record<string, string>;
  limit: number;
  tags: string[];
  status: JobStatus;
  workerAgentId: string | null;
  workerName: string | null;
  casesDone: number;
  casesTotal: number | null;
  lastCase: { caseId: string; passed: boolean; score: number; error: string } | null;
  runId: string | null;
  error: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const SETTING_KEY_RE = /^[a-z_][a-z0-9_]{0,40}$/;
const MODULE_RE = /^[A-Za-z_][\w.]{0,199}$/;

/** Validate a POST /jobs body. The caller checks the target agent belongs to the requester's org. */
export function parseJobRequest(body: unknown):
  | { ok: true; job: Pick<BenchJob, "targetAgentId" | "suite" | "harness" | "agentModule" | "settings" | "limit" | "tags"> }
  | { ok: false; errors: string[] } {
  if (!isObj(body)) return { ok: false, errors: ["body must be a JSON object"] };
  const errors: string[] = [];
  const targetAgentId = text(body.targetAgentId, MAX_ID);
  const suite = text(body.suite, MAX_ID);
  const harness = body.harness as HarnessKey;
  if (!targetAgentId) errors.push("pick an agent");
  if (!MODULE_RE.test(suite)) errors.push("suite must be a dotted python module");
  if (!(harness in HARNESSES)) errors.push(`harness must be one of ${Object.keys(HARNESSES).join(", ")}`);
  const settings: Record<string, string> = {};
  if (isObj(body.settings)) {
    for (const [k, v] of Object.entries(body.settings)) {
      if (!SETTING_KEY_RE.test(k)) errors.push(`setting ${k} is not a valid field name`);
      else if (typeof v === "string" && v.trim()) settings[k] = v.trim().slice(0, 200);
    }
  }
  if (harness !== "remote" && !settings.model) errors.push("a model is required for a dimOS harness");
  if (errors.length) return { ok: false, errors };
  // The remote harness evaluates the agent itself: its target is always the job's agent.
  if (harness === "remote") settings.target = targetAgentId;
  return {
    ok: true,
    job: {
      targetAgentId,
      suite,
      harness,
      agentModule: HARNESSES[harness],
      settings,
      limit: Math.min(MAX_CASES, count(body.limit)),
      tags: Array.isArray(body.tags) ? body.tags.map((t) => text(t, 64)).filter(Boolean).slice(0, 20) : [],
    },
  };
}
