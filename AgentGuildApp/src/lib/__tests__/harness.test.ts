import { describe, expect, it } from "vitest";
import {
  analyzeLineage,
  buildFeedback,
  generationAt,
  jobValue,
  parseOutcomes,
  parseProposal,
  scoreGenerations,
  type HarnessGeneration,
  type JobOutcome,
  type ReplyOutcome,
} from "../harness";

function gen(generation: number, activatedAt: number | null, retiredAt: number | null, extra: Partial<HarnessGeneration> = {}): HarnessGeneration {
  return {
    generation,
    parentGeneration: generation > 1 ? generation - 1 : null,
    playbook: `playbook ${generation}`,
    improvement: `change ${generation}`,
    status: activatedAt == null ? "proposed" : retiredAt == null ? "active" : "retired",
    proposedBy: "agent",
    proposedAt: (activatedAt ?? 0) - 1,
    activatedAt,
    retiredAt,
    decidedBy: null,
    ...extra,
  };
}

const job = (at: number, approved: boolean, rating: number | null = null, notes = ""): JobOutcome => ({
  jobId: `j${at}`,
  title: `job ${at}`,
  at,
  approved,
  rating,
  notes,
});

const reply = (generation: number, ok: boolean, at = 0): ReplyOutcome => ({ generation, ok, detail: ok ? "" : "timed out", at });

describe("generationAt", () => {
  const gens = [gen(1, 100, 200), gen(2, 200, null), gen(3, null, null)];

  it("credits an outcome to the generation live at that time", () => {
    expect(generationAt(gens, 50)).toBeNull();
    expect(generationAt(gens, 100)).toBe(1);
    expect(generationAt(gens, 199)).toBe(1);
    expect(generationAt(gens, 200)).toBe(2);
    expect(generationAt(gens, 10_000)).toBe(2);
  });

  it("never credits a proposal that was not live", () => {
    expect(generationAt([gen(3, null, null)], 10_000)).toBeNull();
  });
});

describe("scoring", () => {
  it("uses the rating when there is one, else approve/reject", () => {
    expect(jobValue(job(1, true, 5))).toBe(1);
    expect(jobValue(job(1, true, 1))).toBe(0);
    expect(jobValue(job(1, true, 3))).toBe(0.5);
    expect(jobValue(job(1, true))).toBe(1);
    expect(jobValue(job(1, false))).toBe(0);
  });

  it("weights buyer verdicts over self-reported replies", () => {
    const [s] = scoreGenerations([gen(1, 0, null)], [job(10, true)], [reply(1, false), reply(1, false), reply(1, false)]);
    // (1 job × 3 + 0 ok × 1) / (3 + 3)
    expect(s.score).toBeCloseTo(0.5);
    expect(s.signals).toBe(4);
    expect(s.jobs).toEqual({ n: 1, mean: 1 });
    expect(s.replies.okRate).toBe(0);
  });

  it("does not score generations that never went live", () => {
    expect(scoreGenerations([gen(1, 0, null), gen(2, null, null)], [], []).map((s) => s.generation)).toEqual([1]);
  });
});

describe("analyzeLineage", () => {
  const replies = (generation: number, okCount: number, total = 10) =>
    Array.from({ length: total }, (_, i) => reply(generation, i < okCount));

  it("flags a regression when the active generation scores below its parent", () => {
    const gens = [gen(1, 0, 100), gen(2, 100, null)];
    const a = analyzeLineage(gens, [], [...replies(1, 9), ...replies(2, 6)]);
    expect(a.activeGeneration).toBe(2);
    expect(a.regression).toBe(true);
    expect(a.bestGeneration).toBe(1);
  });

  it("does not flag a regression on too few signals", () => {
    const gens = [gen(1, 0, 100), gen(2, 100, null)];
    expect(analyzeLineage(gens, [], [...replies(1, 9), ...replies(2, 0, 2)]).regression).toBe(false);
  });

  it("detects a plateau after a window of non-improving generations", () => {
    const gens = [gen(1, 0, 1), gen(2, 1, 2), gen(3, 2, 3), gen(4, 3, null)];
    const flat = analyzeLineage(gens, [], [...replies(1, 8), ...replies(2, 8), ...replies(3, 7), ...replies(4, 8)]);
    expect(flat.plateaued).toBe(true);
    const rising = analyzeLineage(gens, [], [...replies(1, 5), ...replies(2, 6), ...replies(3, 7), ...replies(4, 9)]);
    expect(rising.plateaued).toBe(false);
  });
});

describe("buildFeedback", () => {
  it("lists failures under the live generation only", () => {
    const gens = [gen(1, 0, 100), gen(2, 100, null)];
    const fb = buildFeedback(
      gens,
      [job(50, false, null, "old"), job(150, false, null, "missed the brief"), job(160, true, 2), job(170, true, 5)],
      [reply(1, false, 60), reply(2, false, 180), reply(2, true, 190)],
    );
    expect(fb.activeGeneration).toBe(2);
    expect(fb.playbook).toBe("playbook 2");
    expect(fb.failures.map((f) => f.kind)).toEqual(["reply", "job", "job"]);
    expect(fb.failures[2].summary).toContain("missed the brief");
    expect(fb.failures.some((f) => f.summary.includes("old"))).toBe(false);
    expect(fb.successes).toHaveLength(1);
    expect(fb.counts).toEqual({ jobs: 3, replies: 2, replyFailures: 1 });
    expect(fb.lineage.map((l) => l.improvement)).toEqual(["change 1", "change 2"]);
  });
});

describe("validation", () => {
  it("requires a playbook and an improvement note", () => {
    expect(parseProposal({ playbook: "x" })).toEqual({ ok: false, error: expect.stringContaining("improvement") });
    expect(parseProposal({ playbook: "x".repeat(9000), improvement: "y" }).ok).toBe(false);
    expect(parseProposal({ playbook: " x ", improvement: " y ", parentGeneration: 2 })).toEqual({
      ok: true,
      playbook: "x",
      improvement: "y",
      parentGeneration: 2,
    });
    expect(parseProposal({ playbook: "x", improvement: "y", parentGeneration: "2" }).ok).toBe(false);
  });

  it("stamps outcomes with the server's time", () => {
    const r = parseOutcomes({ outcomes: [{ generation: 1, ok: true, at: 1 }] }, 999);
    expect(r).toEqual({ ok: true, outcomes: [{ generation: 1, ok: true, detail: "", at: 999 }] });
    expect(parseOutcomes({ outcomes: [{ generation: 0, ok: true }] }, 1).ok).toBe(false);
    expect(parseOutcomes({ outcomes: Array(51).fill({ generation: 1, ok: true }) }, 1).ok).toBe(false);
  });
});
