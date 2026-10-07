import { describe, it, expect } from "vitest";
import {
  canCancel,
  canEdit,
  diffJobFields,
  isAwaitingReview,
  isHttpUrl,
  nextRevision,
  parseReward,
  validateDelivery,
  validateJobInput,
  validateReview,
} from "@/lib/job-lifecycle";
import type { GigEscrow } from "@/lib/firestore";

describe("validateJobInput (create)", () => {
  it("applies defaults and trims", () => {
    const r = validateJobInput({ title: "  Write docs  ", reward: 50 }, false);
    expect(r).toEqual({
      ok: true,
      value: {
        title: "Write docs",
        description: "",
        reward: "50",
        requiredSkills: [],
        priority: "medium",
        projectId: "",
        hiringMode: "instant",
      },
    });
  });

  it("requires a title and rejects bad enums, negative rewards and oversize fields", () => {
    expect(validateJobInput({}, false)).toMatchObject({ ok: false, error: "title is required" });
    expect(validateJobInput({ title: "x", priority: "urgent" }, false)).toMatchObject({ ok: false });
    expect(validateJobInput({ title: "x", hiringMode: "auction" }, false)).toMatchObject({ ok: false });
    expect(validateJobInput({ title: "x", reward: "-5" }, false)).toMatchObject({ ok: false, error: "reward cannot be negative" });
    expect(validateJobInput({ title: "x".repeat(201) }, false)).toMatchObject({ ok: false });
    expect(validateJobInput({ title: "x", requiredSkills: [1] }, false)).toMatchObject({ ok: false });
    expect(validateJobInput({ title: "x", minTrustScore: 101 }, false)).toMatchObject({ ok: false });
    expect(validateJobInput({ title: "x", minCompletedJobs: 1.5 }, false)).toMatchObject({ ok: false });
    expect(validateJobInput(null, false)).toMatchObject({ ok: false });
  });

  it("dedupes skills and keeps requirements only for instant hiring", () => {
    const instant = validateJobInput({ title: "x", requiredSkills: ["a", " a ", "b", ""], minTrustScore: "70" }, false);
    expect(instant.ok && instant.value.requiredSkills).toEqual(["a", "b"]);
    expect(instant.ok && instant.value.minTrustScore).toBe(70);
    const apps = validateJobInput({ title: "x", hiringMode: "applications", minTrustScore: 70 }, false);
    expect(apps.ok && apps.value.minTrustScore).toBeUndefined();
  });
});

describe("validateJobInput (edit)", () => {
  it("returns only the fields present, and null clears reward", () => {
    expect(validateJobInput({ priority: "high" }, true)).toEqual({ ok: true, value: { priority: "high" } });
    expect(validateJobInput({ reward: null }, true)).toEqual({ ok: true, value: { reward: undefined } });
    expect(validateJobInput({ title: "" }, true)).toMatchObject({ ok: false });
  });
});

describe("validateDelivery", () => {
  it("requires notes and only accepts http(s) file links", () => {
    expect(validateDelivery({ deliveryNotes: " " })).toMatchObject({ ok: false });
    expect(validateDelivery({ deliveryNotes: "done", deliveryFiles: ["javascript:alert(1)"] })).toMatchObject({ ok: false });
    expect(validateDelivery({ deliveryNotes: "done", deliveryFiles: "https://x" })).toMatchObject({ ok: false });
    expect(validateDelivery({ deliveryNotes: " done ", deliveryFiles: ["https://a.io/x.pdf", " ", 3] })).toEqual({
      ok: true,
      value: { deliveryNotes: "done", deliveryFiles: ["https://a.io/x.pdf"] },
    });
    expect(validateDelivery({ deliveryNotes: "done", deliveryFiles: Array(21).fill("https://a.io") })).toMatchObject({ ok: false });
  });
});

describe("validateReview", () => {
  it("needs a decision, and notes when sending work back", () => {
    expect(validateReview({ decision: "maybe" })).toMatchObject({ ok: false });
    expect(validateReview({ decision: "reject", notes: "" })).toMatchObject({ ok: false });
    expect(validateReview({ decision: "reject", notes: " fix the intro " })).toEqual({ ok: true, value: { approve: false, notes: "fix the intro" } });
    expect(validateReview({ decision: "approve" })).toEqual({ ok: true, value: { approve: true, notes: "" } });
  });
});

describe("state checks", () => {
  it("awaiting review = completed + pending + a delivery", () => {
    expect(isAwaitingReview({ status: "completed", reviewStatus: "pending", deliveryNotes: "x" })).toBe(true);
    // The old dashboard check required reviewStatus to be unset, which no delivered job ever is.
    expect(isAwaitingReview({ status: "completed", reviewStatus: undefined, deliveryNotes: "x" })).toBe(false);
    expect(isAwaitingReview({ status: "completed", reviewStatus: "approved", deliveryNotes: "x" })).toBe(false);
    expect(isAwaitingReview({ status: "in_progress", reviewStatus: "rejected", deliveryNotes: "x" })).toBe(false);
  });

  it("edits only while open; cancels before delivery and never with locked escrow", () => {
    expect(canEdit({ status: "open" })).toBe(true);
    expect(canEdit({ status: "in_progress" })).toBe(false);
    expect(canCancel({ status: "open" }).ok).toBe(true);
    expect(canCancel({ status: "in_progress" }).ok).toBe(true);
    expect(canCancel({ status: "completed" }).ok).toBe(false);
    expect(canCancel({ status: "closed" }).ok).toBe(false);
    const escrow = { status: "funded" } as GigEscrow;
    expect(canCancel({ status: "in_progress", escrow }).ok).toBe(false);
    expect(canCancel({ status: "in_progress", escrow: { ...escrow, status: "resolved" } }).ok).toBe(true);
  });

  it("counts revisions and parses rewards", () => {
    expect(nextRevision({})).toBe(1);
    expect(nextRevision({ deliveryHistory: [{ notes: "", files: [], at: 1 }] })).toBe(2);
    expect(parseReward("$1,250.50")).toBe(1250.5);
    expect(parseReward("lots")).toBe(0);
    expect(isHttpUrl("https://x.io")).toBe(true);
    expect(isHttpUrl("data:text/html,hi")).toBe(false);
  });

  it("diffs only effective changes", () => {
    expect(diffJobFields({ title: "a", priority: "low", requiredSkills: ["x"] }, { title: "a", priority: "high", requiredSkills: ["x"] }))
      .toEqual({ priority: { from: "low", to: "high" } });
    expect(diffJobFields({ reward: "5" }, { reward: undefined })).toEqual({ reward: { from: "5", to: null } });
  });
});
