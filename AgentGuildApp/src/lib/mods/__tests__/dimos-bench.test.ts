import { describe, expect, it } from "vitest";
import {
  buildLeaderboard, feedbackContext, lineageReport, parseReplay, parseSubmission, replayBrief, resolveLineage,
  MAX_CASES, MAX_FRAMES, type BenchRun,
} from "../../../../mods/dimos-bench/bench";

const body = (results: unknown[], extra: Record<string, unknown> = {}) => ({
  suite: "dimos.evals.suites.examples",
  agentModule: "dimos.evals.agents.question_answer",
  model: "gpt-5.6-luna",
  results,
  ...extra,
});

describe("parseSubmission", () => {
  it("recomputes the summary from the cases instead of trusting the submitter", () => {
    const parsed = parseSubmission(
      body(
        [
          { case_id: "a", score: 1, passed: true, cost_usd: 0.02, duration_s: 3 },
          { case_id: "b", score: 0.5, passed: false, error: "timeout", cost_usd: 0.01, duration_s: 2 },
        ],
        { summary: { meanScore: 1, passRate: 1 }, code: { git_sha: "abc", dirty: true } },
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.run.summary).toEqual({ n: 2, meanScore: 0.75, passRate: 0.5, errors: 1, durationS: 5, costUsd: 0.03 });
    expect(parsed.run.dimosGitSha).toBe("abc");
    expect(parsed.run.dimosDirty).toBe(true);
  });

  it("clamps scores to 0..1 and keeps unknown cost unknown", () => {
    const parsed = parseSubmission(body([{ case_id: "a", score: 7 }, { case_id: "b", score: -1, cost_usd: null }]));
    if (!parsed.ok) throw new Error(parsed.errors.join());
    expect(parsed.run.results.map((r) => r.score)).toEqual([1, 0]);
    expect(parsed.run.summary.costUsd).toBeNull();
  });

  it("rejects missing fields, duplicate cases and oversized runs", () => {
    expect(parseSubmission({ results: [] })).toMatchObject({ ok: false });
    expect(parseSubmission(body([{ score: 1 }]))).toEqual({ ok: false, errors: ["results[0] needs a case_id"] });
    expect(parseSubmission(body([{ case_id: "a" }, { case_id: "a" }]))).toMatchObject({ ok: false });
    const many = Array.from({ length: MAX_CASES + 1 }, (_, i) => ({ case_id: `c${i}` }));
    expect(parseSubmission(body(many))).toMatchObject({ ok: false });
  });
});

describe("buildLeaderboard", () => {
  const run = (id: string, agentId: string, model: string, meanScore: number, passRate: number, createdAt: string): BenchRun => ({
    id, agentId, agentName: agentId, orgId: "o", model, createdAt,
    suite: "s", agentModule: "dimos.evals.agents.pi", tags: [], dimosGitSha: null, dimosDirty: false,
    summary: { n: 2, meanScore, passRate, errors: 0, durationS: 1, costUsd: null },
    results: [], lineageId: id, parentRunId: null, generation: 0, harnessSha: null, improvement: "",
  });

  it("keeps each agent+model's best run and ranks by mean, then pass rate", () => {
    const rows = buildLeaderboard([
      run("r1", "alpha", "m1", 0.5, 0.5, "2026-01-01"),
      run("r2", "alpha", "m1", 0.9, 0.5, "2026-01-02"),
      run("r3", "beta", "m1", 0.9, 1, "2026-01-03"),
      run("r4", "alpha", "m2", 0.1, 0, "2026-01-04"),
    ]);
    expect(rows.map((r) => [r.agentId, r.model, r.bestRunId, r.runs])).toEqual([
      ["beta", "m1", "r3", 1],
      ["alpha", "m1", "r2", 2],
      ["alpha", "m2", "r4", 1],
    ]);
    expect(rows[1].lastRunAt).toBe("2026-01-02");
  });
});

const genRun = (id: string, generation: number, meanScore: number, extra: Partial<BenchRun> = {}): BenchRun => ({
  id, agentId: "alpha", agentName: "Alpha", orgId: "o", model: "m", createdAt: `2026-01-0${generation + 1}T00:00:00Z`,
  suite: "s", agentModule: "a", tags: [], dimosGitSha: null, dimosDirty: false,
  summary: { n: 2, meanScore, passRate: meanScore, errors: 0, durationS: 1, costUsd: null },
  results: [], lineageId: "lin", parentRunId: null, generation, harnessSha: null, improvement: `note ${generation}`,
  ...extra,
});

describe("lineage submissions", () => {
  it("reads lineage claims, ignores a claimed generation, validates formats", () => {
    const parsed = parseSubmission(body([{ case_id: "a" }], { parentRunId: "p1", generation: 99, harnessSha: "abc1234", improvement: "  x  " }));
    if (!parsed.ok) throw new Error(parsed.errors.join());
    expect(parsed.lineage).toEqual({ lineageId: null, parentRunId: "p1" });
    expect(parsed.run.harnessSha).toBe("abc1234");
    expect(parsed.run.improvement).toBe("x");
    expect(parseSubmission(body([{ case_id: "a" }], { harnessSha: "NOT-HEX" }))).toMatchObject({ ok: false });
    expect(parseSubmission(body([{ case_id: "a" }], { lineageId: "bad id!" }))).toMatchObject({ ok: false });
  });

  const base = { runId: "new", agentId: "alpha", suite: "s", lineageTaken: false };

  it("puts a child at parent generation + 1 in the parent's lineage", () => {
    const parent = genRun("p1", 2, 0.5);
    expect(resolveLineage({ ...base, claim: { lineageId: null, parentRunId: "p1" }, parent })).toEqual({
      ok: true, lineageId: "lin", parentRunId: "p1", generation: 3,
    });
  });

  it("refuses a parent from another agent, another suite, another lineage, or that doesn't exist", () => {
    const claim = { lineageId: null, parentRunId: "p1" };
    expect(resolveLineage({ ...base, claim, parent: null })).toMatchObject({ ok: false, status: 404 });
    expect(resolveLineage({ ...base, claim, parent: genRun("p1", 0, 1, { agentId: "beta" }) })).toMatchObject({ ok: false, status: 403 });
    expect(resolveLineage({ ...base, claim, parent: genRun("p1", 0, 1, { suite: "other" }) })).toMatchObject({ ok: false, status: 400 });
    expect(resolveLineage({ ...base, claim: { lineageId: "x", parentRunId: "p1" }, parent: genRun("p1", 0, 1) })).toMatchObject({ ok: false });
  });

  it("roots a lineage at generation 0, under its own id or an unused name", () => {
    expect(resolveLineage({ ...base, claim: { lineageId: null, parentRunId: null }, parent: null })).toMatchObject({ lineageId: "new", generation: 0 });
    expect(resolveLineage({ ...base, claim: { lineageId: "mine", parentRunId: null }, parent: null })).toMatchObject({ lineageId: "mine" });
    expect(resolveLineage({ ...base, claim: { lineageId: "mine", parentRunId: null }, parent: null, lineageTaken: true })).toMatchObject({ ok: false, status: 409 });
  });
});

describe("lineageReport", () => {
  it("reports best score per generation, deltas, and plateau after `patience` flat generations", () => {
    const runs = [genRun("g0", 0, 0.4), genRun("g1", 1, 0.6), genRun("g1b", 1, 0.5), genRun("g2", 2, 0.55), genRun("g3", 3, 0.6)];
    const r = lineageReport(runs, { patience: 2, minDelta: 0 })!;
    expect(r.generations.map((g) => [g.generation, g.runId, g.runs])).toEqual([[0, "g0", 1], [1, "g1", 2], [2, "g2", 1], [3, "g3", 1]]);
    expect(r.generations.map((g) => g.delta === null ? null : +g.delta.toFixed(2))).toEqual([null, 0.2, -0.05, 0.05]);
    expect(r.generations[1].improvement).toBe("note 1");
    expect([r.bestGeneration, r.generationsSinceImprovement, r.plateau, r.decision]).toEqual([1, 2, true, "stop"]); // a tie is not a gain
    expect(lineageReport(runs, { patience: 3, minDelta: 0 })!.decision).toBe("continue");
    expect(lineageReport([], { patience: 3, minDelta: 0 })).toBeNull();
  });

  it("only counts gains larger than minDelta", () => {
    const r = lineageReport([genRun("g0", 0, 0.5), genRun("g1", 1, 0.505)], { patience: 1, minDelta: 0.01 })!;
    expect([r.bestGeneration, r.plateau]).toEqual([0, true]);
  });
});

describe("feedbackContext", () => {
  it("lists errors then failures worst-first, and the improvement chain oldest-first", () => {
    const c = (caseId: string, score: number, passed: boolean, error = "") => ({
      caseId, score, passed, error, durationS: 1, finalAnswer: `ans ${caseId}`, steps: 3, toolCalls: 2,
      promptTokens: 100, completionTokens: 10, costUsd: null, endedBy: "answer",
    });
    const run = genRun("g2", 2, 0.4, { parentRunId: "g1", results: [c("ok", 1, true), c("meh", 0.5, false), c("bad", 0, false), c("boom", 0, false, "timeout")] });
    const ctx = feedbackContext(run, [genRun("g1", 1, 0.3), genRun("g0", 0, 0.2)]);
    expect(ctx.failures.map((f) => [f.caseId, f.kind])).toEqual([["boom", "error"], ["bad", "failed"], ["meh", "failed"]]);
    expect(ctx.failures[1]).toMatchObject({ finalAnswer: "ans bad", steps: 3, toolCalls: 2, promptTokens: 100 });
    expect(ctx.passedCaseIds).toEqual(["ok"]);
    expect(ctx.improvementHistory.map((h) => [h.runId, h.improvement])).toEqual([["g0", "note 0"], ["g1", "note 1"], ["g2", "note 2"]]);
  });
});

describe("parseReplay", () => {
  const ids = { runId: "r1", caseId: "c1" };
  const jpeg = "/9j/4AAQSkZJRg==";

  it("keeps the path, frames and actions sorted by time, and ignores client-sent ids", () => {
    const parsed = parseReplay(
      {
        runId: "someone-else", caseId: "other", environment: "MujocoSim", source: "go2",
        path: [[2, 1, 0, 0], [0, 0, 0, 0]],
        frames: [{ t: 1, w: 360, h: 270, jpeg }],
        actions: [{ t: 0.5, name: "relative_move", args: '{"forward":1}' }, { name: "speak" }],
        streams: [{ name: "odom", count: 11 }],
      },
      ids,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.replay.runId).toBe("r1");
    expect(parsed.replay.caseId).toBe("c1");
    expect(parsed.replay.path.map((p) => p[0])).toEqual([0, 2]);
    expect(parsed.replay.actions[1]).toEqual({ t: null, name: "speak", args: "" });
    expect(replayBrief(parsed.replay)).toEqual({
      caseId: "c1", environment: "MujocoSim", source: "go2", poses: 2, frames: 1, actions: 2,
    });
  });

  it("rejects empty replays, malformed poses, non-JPEG frames and too many frames", () => {
    expect(parseReplay({ path: [], frames: [] }, ids).ok).toBe(false);
    expect(parseReplay({ path: [[0, 1, 2]] }, ids).ok).toBe(false);
    expect(parseReplay({ path: [[0, 1, 2, Number.NaN]] }, ids).ok).toBe(false);
    expect(parseReplay({ frames: [{ t: 0, jpeg: "iVBORw0KGgo=" }] }, ids).ok).toBe(false); // a PNG
    expect(parseReplay({ frames: [{ t: 0, jpeg: `${jpeg}<script>` }] }, ids).ok).toBe(false);
    const many = Array.from({ length: MAX_FRAMES + 1 }, (_, t) => ({ t, jpeg }));
    expect(parseReplay({ frames: many }, ids).ok).toBe(false);
  });
});
