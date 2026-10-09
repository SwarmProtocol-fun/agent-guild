import { describe, it, expect, vi, beforeEach } from "vitest";

const docUpdate = vi.fn();
const jobs: Record<string, unknown>[] = [];

vi.mock("@/lib/firebase-admin", () => ({
  adminDb: () => ({
    collection: () => ({
      where: () => ({ get: async () => ({ docs: jobs.map((j) => ({ id: j.id, data: () => j })) }) }),
      doc: (id: string) => ({ update: (data: unknown) => docUpdate(id, data) }),
    }),
  }),
}));
vi.mock("@/lib/firestore-admin", () => ({
  ensureAgentGroupChat: async () => ({ id: "hub" }),
  sendMessage: vi.fn(async () => "msg"),
  getAgent: vi.fn(),
}));
vi.mock("@/lib/daily-summary", () => ({}));
vi.mock("@/lib/cron-history", () => ({ recordCronExecution: vi.fn() }));
vi.mock("@/lib/redis", () => ({ getRedis: () => null }));
vi.mock("../triggers", () => ({ fireEvent: vi.fn() }));

import { cronMatchesNow, evaluateRegularCronJobs } from "../cron-evaluator";

describe("cronMatchesNow with a time zone", () => {
  // 2026-10-07T13:00:00Z is 09:00 in New York (EDT) and 06:00 in Los Angeles (PDT)
  const instant = new Date("2026-10-07T13:00:00Z");

  it("reads fields in the given zone", () => {
    expect(cronMatchesNow("0 9 * * *", instant, "America/New_York")).toBe(true);
    expect(cronMatchesNow("0 9 * * *", instant, "America/Los_Angeles")).toBe(false);
    expect(cronMatchesNow("0 6 * * *", instant, "America/Los_Angeles")).toBe(true);
    expect(cronMatchesNow("0 13 * * *", instant, "UTC")).toBe(true);
  });

  it("uses the zone's weekday and day of month across midnight", () => {
    // 2026-10-05T02:30Z is Sunday Oct 4, 19:30 in Los Angeles
    const lateSunday = new Date("2026-10-05T02:30:00Z");
    expect(cronMatchesNow("30 19 * * 0", lateSunday, "America/Los_Angeles")).toBe(true);
    expect(cronMatchesNow("30 19 4 10 *", lateSunday, "America/Los_Angeles")).toBe(true);
    expect(cronMatchesNow("30 2 * * 1", lateSunday, "UTC")).toBe(true);
  });

  it("treats midnight as hour 0", () => {
    expect(cronMatchesNow("0 0 * * *", new Date("2026-10-07T00:00:00Z"), "UTC")).toBe(true);
  });

  it("falls back to UTC for an invalid zone", () => {
    expect(cronMatchesNow("0 13 * * *", instant, "Not/AZone")).toBe(true);
  });
});

describe("evaluateRegularCronJobs", () => {
  beforeEach(() => {
    jobs.length = 0;
    docUpdate.mockReset();
  });

  it("writes lastRun on the job after it fires", async () => {
    jobs.push({ id: "j1", orgId: "o1", name: "Ping", message: "hi", schedule: "* * * * *", enabled: true, timezone: "UTC" });
    const res = await evaluateRegularCronJobs();
    expect(res.fired).toBe(1);
    expect(docUpdate).toHaveBeenCalledWith("j1", {
      lastRun: expect.objectContaining({ success: true, time: expect.any(Date), durationMs: expect.any(Number) }),
    });
  });

  it("skips jobs whose schedule doesn't match in their zone", async () => {
    const now = new Date();
    // An hour that is never "now" in UTC
    const otherHour = (now.getUTCHours() + 12) % 24;
    jobs.push({ id: "j2", orgId: "o1", name: "Later", message: "x", schedule: `* ${otherHour} * * *`, enabled: true, timezone: "UTC" });
    const res = await evaluateRegularCronJobs();
    expect(res.fired).toBe(0);
    expect(docUpdate).not.toHaveBeenCalled();
  });
});
