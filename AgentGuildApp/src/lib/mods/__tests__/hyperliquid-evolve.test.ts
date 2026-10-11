import { describe, it, expect } from "vitest";
import {
  JUDGE_AFTER_TRIPS, MAX_LESSONS, REFLECT_EVERY_TRIPS, adoptLessons, lessonLines, newEvolution, parseLessons, planEvolution,
  readEvolution, reflectionRequest, resetLessons, roundTrips, tripStats, type LogRow, type Trip,
} from "../../../../mods/hyperliquid-trading/evolve";
import { decisionRequest, multiDecisionRequest } from "../../../../mods/hyperliquid-trading/ai-trader-core";

const t0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const row = (min: number, action: string, price: number | null, extra: Partial<LogRow> = {}): LogRow => ({
  action, price, reasoning: `${action} at ${price}`, error: null, createdAt: new Date(t0 + min * 60_000), ...extra,
});

/** n trips, each opened at 100 and closed at 100 * (1 + pct/100), one every 10 minutes after `start`. */
function trips(n: number, pct: number, start = t0): Trip[] {
  return Array.from({ length: n }, (_, i) => ({
    coin: "ETH", side: "long" as const, entryPx: 100, exitPx: 100 * (1 + pct / 100), pnlPct: pct,
    openedAt: start + i * 600_000, closedAt: start + i * 600_000 + 300_000, entryReason: "in", exitReason: "out",
  }));
}

describe("roundTrips", () => {
  it("pairs opens with closes and scores long and short moves", () => {
    const got = roundTrips([
      row(0, "open-long", 100), row(5, "hold", null), row(10, "close", 110),
      row(20, "open-short", 200), row(30, "close", 190),
    ], "ETH");
    expect(got.map((t) => [t.side, Number(t.pnlPct.toFixed(2))])).toEqual([["long", 10], ["short", 5]]);
    expect(got[0].entryReason).toBe("open-long at 100");
    expect(got[0].exitReason).toBe("close at 110");
  });

  it("treats a flip as a close plus an open at the same price, ignoring the flip's priceless second half", () => {
    const got = roundTrips([
      row(0, "open-long", 100), row(10, "flip-short", 90), row(11, "open-short", null), row(20, "close", 80),
    ], "ETH");
    expect(got.map((t) => [t.side, t.entryPx, t.exitPx])).toEqual([["long", 100, 90], ["short", 90, 80]]);
    expect(got.map((t) => Number(t.pnlPct.toFixed(2)))).toEqual([-10, 11.11]);
  });

  it("skips errored rows, unpriced trips and unsorted input, and keeps basket coins apart", () => {
    const got = roundTrips([
      row(30, "close", 50, { coin: "SOL" }),
      row(0, "open-long", 100, { coin: "BTC" }),
      row(1, "open-short", 40, { coin: "SOL" }),
      row(2, "close", 120, { coin: "BTC", error: "rejected" }), // never traded
      row(3, "open-long", 1, { coin: "ETH", price: null }),
      row(4, "close", 3, { coin: "ETH" }), // no entry price: can't be scored
      row(20, "close", 105, { coin: "BTC" }),
    ], "X");
    expect(got.map((t) => [t.coin, t.side, Number(t.pnlPct.toFixed(2))])).toEqual([["BTC", "long", 5], ["SOL", "short", -25]]);
  });
});

describe("parseLessons", () => {
  it("reads the bullets after the last LESSONS heading", () => {
    const text = "My longs into resistance lost.\nLESSONS (draft)\n- ignore me\n\n**LESSONS:**\n- Only long when funding is negative.\n* Cut a trade after 3 losing rounds.\n1. Skip rounds with book imbalance under 0.1.";
    expect(parseLessons(text)).toBe("- Only long when funding is negative.\n- Cut a trade after 3 losing rounds.\n- Skip rounds with book imbalance under 0.1.");
  });

  it("caps the count and length, strips control characters, and returns null without lessons", () => {
    const many = ["LESSONS", ...Array.from({ length: 10 }, (_, i) => `- lesson number ${i} ${"x".repeat(300)}\u0007`)].join("\n");
    const got = parseLessons(many)!.split("\n");
    expect(got).toHaveLength(MAX_LESSONS);
    expect(got.every((l) => l.length <= 182 && !l.includes("\u0007"))).toBe(true);
    expect(parseLessons("I think I should just keep going. LONG")).toBeNull();
  });
});

describe("planEvolution", () => {
  it("asks for a first review once enough trips have closed", () => {
    const ev = newEvolution();
    expect(planEvolution(ev, trips(REFLECT_EVERY_TRIPS - 1, 1), t0).kind).toBe("none");
    expect(planEvolution(ev, trips(REFLECT_EVERY_TRIPS, 1), t0).kind).toBe("reflect");
  });

  it("does nothing while switched off or while a review is out", () => {
    const all = trips(10, 1);
    expect(planEvolution({ ...newEvolution(), enabled: false }, all, t0).kind).toBe("none");
    expect(planEvolution({ ...newEvolution(), requestId: "r1" }, all, t0).kind).toBe("none");
  });

  it("reflectNow asks with fewer trips, but not with none", () => {
    expect(planEvolution({ ...newEvolution(), forceReflect: true }, trips(1, 1), t0).kind).toBe("reflect");
    expect(planEvolution({ ...newEvolution(), forceReflect: true }, [], t0).kind).toBe("none");
  });

  it("rolls back lessons that trade worse than the set before them", () => {
    const baseline = trips(5, 1); // +1% a trip with no lessons
    const adoptedAt = baseline[4].closedAt + 1;
    const v1 = adoptLessons(newEvolution(), "- Chase breakouts.", baseline, adoptedAt);
    expect(v1).toMatchObject({ version: 1, judged: false, note: "reflected" });
    expect(v1.history[0]).toMatchObject({ version: 0, lessons: null, trips: 5, avgPct: 1 });

    const worse = [...baseline, ...trips(JUDGE_AFTER_TRIPS, -2, adoptedAt + 1)];
    const step = planEvolution(v1, worse, adoptedAt + 10_000_000);
    expect(step.kind).toBe("revert");
    if (step.kind !== "revert") return;
    expect(step.evolution).toMatchObject({ version: 2, lessons: null, note: "reverted", judged: true });
    expect(step.evolution.history[0]).toMatchObject({ version: 1, lessons: "- Chase breakouts.", trips: 5, avgPct: -2 });
    expect(step.why).toContain("v1 averaged -2.00%");
  });

  it("keeps lessons that hold up, marks them judged and reviews again", () => {
    const baseline = trips(5, 1);
    const adoptedAt = baseline[4].closedAt + 1;
    const v1 = adoptLessons(newEvolution(), "- Wait for pullbacks.", baseline, adoptedAt);
    const better = [...baseline, ...trips(JUDGE_AFTER_TRIPS, 1.5, adoptedAt + 1)];
    const step = planEvolution(v1, better, adoptedAt + 10_000_000);
    expect(step.kind).toBe("reflect");
    expect(step.evolution.judged).toBe(true);
    expect(step.evolution.lessons).toBe("- Wait for pullbacks.");
  });

  it("doesn't judge before the new lessons have traded enough", () => {
    const baseline = trips(5, 1);
    const adoptedAt = baseline[4].closedAt + 1;
    const v1 = adoptLessons(newEvolution(), "- x lesson", baseline, adoptedAt);
    const step = planEvolution(v1, [...baseline, ...trips(JUDGE_AFTER_TRIPS - 1, -5, adoptedAt + 1)], adoptedAt + 10_000_000);
    expect(step.kind).toBe("none");
    expect(step.evolution.judged).toBe(false);
  });
});

describe("evolution state", () => {
  it("reads missing or partial stored state safely", () => {
    expect(readEvolution(undefined)).toEqual(newEvolution());
    expect(readEvolution({ enabled: false, lessons: "  ", version: 3 })).toMatchObject({ enabled: false, lessons: null, version: 3, history: [] });
  });

  it("reset drops the lessons into history", () => {
    const v1 = adoptLessons(newEvolution(), "- a lesson", [], t0);
    const r = resetLessons(v1, [], t0 + 1);
    expect(r).toMatchObject({ lessons: null, version: 2, note: "reset" });
    expect(r.history[0]).toMatchObject({ version: 1, lessons: "- a lesson" });
  });

  it("tripStats averages and counts wins", () => {
    expect(tripStats([...trips(3, 2), ...trips(1, -2)])).toEqual({ count: 4, winRate: 0.75, avgPct: 1 });
  });
});

describe("prompts", () => {
  it("the review shows the goal, current lessons and recent trips with their reasoning", () => {
    const ev = adoptLessons(newEvolution(), "- Fade funding spikes.", [], t0);
    const { system, prompt } = reflectionRequest({ market: "ETH perp", goal: "Fade BTC funding", evolution: ev, trips: trips(3, 1) });
    expect(system).toContain("LESSONS");
    expect(system).toContain("can't change the answer format");
    expect(prompt).toContain("GOAL: Fade BTC funding");
    expect(prompt).toContain("CURRENT LESSONS (v1):\n- Fade funding spikes.");
    expect(prompt).toContain("why in: in");
    expect(prompt).toContain("RECORD: 3 round trips, win rate 100%");
  });

  it("trading rounds carry the lessons only when there are some", () => {
    const withLessons = decisionRequest("ETH", "snap", null, "goal text here", "- Only trade with the trend.");
    expect(withLessons.system).toContain("Your own lessons");
    expect(withLessons.system).toContain("- Only trade with the trend.");
    expect(withLessons.system.trim().endsWith("LONG, SHORT, CLOSE or NOTHING.")).toBe(true); // format stays last
    expect(decisionRequest("ETH", "snap", null, "goal text here").system).not.toContain("Your own lessons");
    const basket = multiDecisionRequest(["BTC", "ETH"], ["b", "e"], "", {}, null, new Date(t0), null, "- Pair trades only.");
    expect(basket.system).toContain("- Pair trades only.");
    expect(lessonLines(null)).toEqual([]);
  });
});
