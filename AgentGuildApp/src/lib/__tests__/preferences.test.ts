// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildPreferenceData, judgedDeliveries, toJsonl, type JobRecord } from "../preferences";

const job = (over: Partial<JobRecord>): JobRecord => ({
  jobId: "j1",
  title: "Write a landing page headline",
  description: "For a budgeting app.",
  deliveries: [],
  reviews: [],
  rating: null,
  ...over,
});

describe("preference data", () => {
  it("pairs each rejected delivery with the approved one", () => {
    const { dpo, kto } = buildPreferenceData([job({
      deliveries: [{ notes: "Save money.", at: 1 }, { notes: "Money, sorted.", at: 3 }, { notes: "Know where every dollar goes.", at: 5 }],
      reviews: [{ approved: false, at: 2, notes: "too bland" }, { approved: false, at: 4, notes: "closer" }, { approved: true, at: 6, notes: "" }],
      rating: 5,
    })]);
    expect(dpo).toHaveLength(2);
    expect(dpo[0]).toMatchObject({
      prompt: "Write a landing page headline\n\nFor a budgeting app.",
      chosen: "Know where every dollar goes.",
      rejected: "Save money.",
      meta: { jobId: "j1", rejectionNotes: "too bland", rating: 5 },
    });
    expect(kto.map((r) => r.label)).toEqual([false, false, true]);
  });

  it("makes KTO rows but no pairs from first-time approvals, and low ratings count as bad", () => {
    const { dpo, kto } = buildPreferenceData([
      job({ jobId: "a", deliveries: [{ notes: "fine work", at: 1 }], reviews: [{ approved: true, at: 2, notes: "" }], rating: 4 }),
      job({ jobId: "b", deliveries: [{ notes: "meh work", at: 1 }], reviews: [{ approved: true, at: 2, notes: "" }], rating: 2 }),
    ]);
    expect(dpo).toHaveLength(0);
    expect(kto.map((r) => [r.meta.jobId, r.label])).toEqual([["a", true], ["b", false]]);
  });

  it("skips pairs when the approval was rated low", () => {
    const { dpo } = buildPreferenceData([job({
      deliveries: [{ notes: "v1", at: 1 }, { notes: "v2", at: 3 }],
      reviews: [{ approved: false, at: 2, notes: "" }, { approved: true, at: 4, notes: "" }],
      rating: 1,
    })]);
    expect(dpo).toHaveLength(0);
  });

  it("legacy jobs (final delivery only) never pair the delivery against itself", () => {
    const j = job({
      deliveries: [{ notes: "final text", at: 0 }],
      reviews: [{ approved: false, at: 2, notes: "redo" }, { approved: true, at: 4, notes: "" }],
    });
    expect(judgedDeliveries(j)).toEqual([{ completion: "final text", approved: true, notes: "", final: true }]);
    expect(buildPreferenceData([j]).dpo).toHaveLength(0);
  });

  it("redacts secrets in exported text", () => {
    const { kto } = buildPreferenceData([job({
      description: "Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      deliveries: [{ notes: "done", at: 1 }],
      reviews: [{ approved: true, at: 2, notes: "" }],
    })]);
    expect(kto[0].prompt).not.toContain("sk-ant-api03");
  });

  it("writes JSONL", () => {
    expect(toJsonl([{ a: 1 }, { b: "x\ny" }])).toBe('{"a":1}\n{"b":"x\\ny"}\n');
    expect(toJsonl([])).toBe("");
  });
});
