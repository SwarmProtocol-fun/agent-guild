/**
 * dimos-bench — pure logic: validating a submitted dimos eval run and
 * ranking runs into a leaderboard. No Firestore, no Next imports, so it is
 * unit-testable (src/lib/mods/__tests__/dimos-bench.test.ts).
 *
 * The shapes mirror what `dimos evals run` writes to its run directory
 * (dimos/evals/runner.py): manifest.json, summary.json, results.jsonl.
 */

export const MAX_CASES = 500;
const MAX_TEXT = 500;
const MAX_ID = 200;

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

/** A validated submission, before the server stamps identity and time. */
export interface RunSubmission {
  suite: string;
  agentModule: string;
  model: string;
  tags: string[];
  dimosGitSha: string | null;
  dimosDirty: boolean;
  summary: RunSummary;
  results: CaseResult[];
}

export interface BenchRun extends RunSubmission {
  id: string;
  agentId: string;
  agentName: string;
  orgId: string;
  createdAt: string;
}

export interface LeaderboardRow {
  agentId: string;
  agentName: string;
  model: string;
  agentModule: string;
  bestRunId: string;
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
export function parseSubmission(body: unknown): { ok: true; run: RunSubmission } | { ok: false; errors: string[] } {
  if (!isObj(body)) return { ok: false, errors: ["body must be a JSON object"] };
  const errors: string[] = [];
  const suite = text(body.suite, MAX_ID);
  const agentModule = text(body.agentModule, MAX_ID);
  if (!suite) errors.push("suite is required (dotted dimos suite module)");
  if (!agentModule) errors.push("agentModule is required (dotted dimos agent module)");
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
      summary: summarize(cases),
      results: cases,
    },
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
