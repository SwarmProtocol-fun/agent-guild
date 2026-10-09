// @vitest-environment node
/**
 * Agent job board API: GET /v1/jobs pages in the query (no full-org scans)
 * and POST /v1/jobs/:id/apply maps a duplicate application to 409. The
 * queries themselves are covered in lib/__tests__/jobs-admin-lifecycle.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const state = {
  verified: { agentId: "agentA", agentName: "Ada", orgId: "org1" } as Record<string, unknown> | null,
  calls: [] as [string, ...unknown[]][],
  page: { jobs: [] as Record<string, unknown>[], nextCursor: null as string | null },
  mine: [] as Record<string, unknown>[],
  applyError: null as Error | null,
};

vi.mock("@/app/api/v1/verify", () => ({
  isTimestampFresh: () => true,
  verifyAgentRequest: async () => state.verified,
}));
vi.mock("@/app/api/v1/rate-limit", () => ({ rateLimit: async () => null }));
vi.mock("@/lib/jobs-admin", async () => {
  const { JobActionError } = await import("@/lib/job-lifecycle");
  return {
    createJob: async () => "new1",
    listOrgJobsByStatus: async (...a: unknown[]) => {
      state.calls.push(["list", ...a]);
      if ((a[2] as { cursor?: string }).cursor === "bad") throw new JobActionError("Invalid cursor", 400);
      return state.page;
    },
    getJobsAssignedToAgent: async (...a: unknown[]) => { state.calls.push(["mine", ...a]); return state.mine; },
    getJob: async (id: string) => ({ id, orgId: "org1", status: "open", hiringMode: "applications" }),
    getJobApplications: async () => [],
    applyToJob: async () => { if (state.applyError) throw state.applyError; return "app1"; },
  };
});

import { GET } from "@/app/api/v1/jobs/route";
import { POST as apply } from "@/app/api/v1/jobs/[jobId]/apply/route";
import { JobActionError } from "@/lib/job-lifecycle";

const get = (qs: string) => GET(new NextRequest(`https://agent-guild.com/api/v1/jobs?agent=a&sig=s&ts=1${qs}`));

beforeEach(() => {
  state.verified = { agentId: "agentA", agentName: "Ada", orgId: "org1" };
  state.calls = [];
  state.page = { jobs: [], nextCursor: null };
  state.mine = [];
  state.applyError = null;
});

describe("GET /v1/jobs", () => {
  it("asks for one page of open jobs and returns the cursor", async () => {
    state.page = { jobs: [{ id: "j1", title: "T", status: "open", priority: "low" }], nextCursor: "j1" };
    const res = await get("&limit=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ count: 1, nextCursor: "j1", jobs: [{ id: "j1", hiringMode: "instant", reward: null }] });
    expect(state.calls).toEqual([["list", "org1", "open", { limit: 1, cursor: null }]]);
  });

  it("passes the cursor and status through, clamping limit to 1..100", async () => {
    await get("&status=in_progress&cursor=j9&limit=500");
    await get("&limit=-5");
    expect(state.calls).toEqual([
      ["list", "org1", "in_progress", { limit: 100, cursor: "j9" }],
      ["list", "org1", "open", { limit: 1, cursor: null }],
    ]);
  });

  it("returns 400 for a bad cursor or status", async () => {
    expect((await get("&cursor=bad")).status).toBe(400);
    expect((await get("&status=bogus")).status).toBe(400);
  });

  it("mine=true lists the agent's own jobs with no cursor", async () => {
    state.mine = [{ id: "g1", gigId: "gig", status: "in_progress", takenByAgentId: "agentA" }];
    const body = await (await get("&mine=true&limit=20")).json();
    expect(state.calls).toEqual([["mine", "agentA", "org1", 20]]);
    expect(body).toMatchObject({ count: 1, nextCursor: null, jobs: [{ id: "g1", upfrontPaymentVerified: false }] });
  });

  it("rejects agents without an org instead of querying with undefined", async () => {
    state.verified = { agentId: "agentA", agentName: "Ada" };
    expect((await get("")).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
});

describe("POST /v1/jobs/:id/apply", () => {
  const post = () => apply(
    new NextRequest("https://agent-guild.com/api/v1/jobs/j1/apply?agent=a&sig=s&ts=1", { method: "POST", body: "{}" }),
    { params: Promise.resolve({ jobId: "j1" }) },
  );

  it("returns 409 when a concurrent apply already landed", async () => {
    state.applyError = new JobActionError("You have already applied to this job", 409);
    expect((await post()).status).toBe(409);
  });

  it("still returns 500 for unexpected errors", async () => {
    state.applyError = new Error("boom");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post()).status).toBe(500);
  });
});
