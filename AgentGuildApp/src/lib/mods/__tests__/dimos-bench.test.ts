import { describe, expect, it } from "vitest";
import { buildLeaderboard, parseSubmission, MAX_CASES, type BenchRun } from "../../../../mods/dimos-bench/bench";

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
    results: [],
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
