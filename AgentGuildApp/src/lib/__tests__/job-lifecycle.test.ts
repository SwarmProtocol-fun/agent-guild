import { describe, it, expect } from "vitest";
import {
  canCancel,
  canEdit,
  diffJobFields,
  isAwaitingReview,
  isHttpUrl,
  nextRevision,
  parseReward,
  REVIEW_WINDOW,
  reviewDueAt,
  reviewSweepAction,
  validateDelivery,
  validateRating,
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

describe("ratings", () => {
  it("accepts 1–5 whole stars with an optional comment", () => {
    expect(validateRating({ rating: 4, ratingComment: " solid " }, true)).toEqual({ ok: true, value: { rating: 4, comment: "solid" } });
    expect(validateRating({}, false)).toEqual({ ok: true, value: null });
    expect(validateRating({}, true)).toMatchObject({ ok: false });
    for (const bad of [0, 6, 3.5, "5"]) expect(validateRating({ rating: bad }, true)).toMatchObject({ ok: false });
    expect(validateRating({ rating: 5, ratingComment: "x".repeat(2001) }, true)).toMatchObject({ ok: false });
  });
});

describe("review deadline", () => {
  const DAY = 86_400_000;
  it("defaults to 7 days, honours the job's window, and clamps it", () => {
    expect(reviewDueAt({}, 0)).toBe(7 * DAY);
    expect(reviewDueAt({ reviewWindowDays: 3 }, 1000)).toBe(1000 + 3 * DAY);
    expect(reviewDueAt({ reviewWindowDays: 90 }, 0)).toBe(REVIEW_WINDOW.maxDays * DAY);
    expect(validateJobInput({ title: "x", reviewWindowDays: 14 }, false)).toMatchObject({ ok: true, value: { reviewWindowDays: 14 } });
    expect(validateJobInput({ title: "x", reviewWindowDays: 0 }, false)).toMatchObject({ ok: false });
    expect(validateJobInput({ title: "x", reviewWindowDays: 31 }, false)).toMatchObject({ ok: false });
  });

  it("decides what the sweep does with each delivery", () => {
    const due = 10 * DAY;
    const pending = { status: "completed" as const, reviewStatus: "pending" as const, deliveryNotes: "x", reviewDueAt: due };
    expect(reviewSweepAction({ ...pending, reviewDueAt: undefined }, 0)).toBe("start_clock");
    expect(reviewSweepAction(pending, due - 2 * DAY)).toBe("none");
    expect(reviewSweepAction(pending, due - DAY / 2)).toBe("remind");
    expect(reviewSweepAction({ ...pending, reviewReminderSentAt: 1 }, due - DAY / 2)).toBe("none");
    expect(reviewSweepAction(pending, due)).toBe("auto_approve");
    expect(reviewSweepAction({ ...pending, reviewStatus: "approved" }, due + 1)).toBe("none");
    const escrow = { status: "delivered" } as GigEscrow;
    expect(reviewSweepAction({ ...pending, escrow }, due)).toBe("flag_overdue");
    expect(reviewSweepAction({ ...pending, escrow, reviewOverdueAt: 1 }, due)).toBe("none");
    expect(reviewSweepAction({ ...pending, escrow: { ...escrow, status: "released" } }, due)).toBe("auto_approve");
  });
});
