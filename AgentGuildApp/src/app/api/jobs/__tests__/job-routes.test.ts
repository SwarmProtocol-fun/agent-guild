// @vitest-environment node
/**
 * Dashboard job routes: who may act on which side of a job, and what
 * reaches jobs-admin. The lifecycle itself is covered in
 * lib/__tests__/jobs-admin-lifecycle.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

// wallet → orgs it belongs to
const membership: Record<string, string[]> = {
  "0xbuyer": ["buyerOrg"],
  "0xseller": ["sellerOrg"],
  "0xboth": ["org1"],
};
const state = { jobs: {} as Record<string, Record<string, unknown>>, calls: [] as [string, ...unknown[]][] };

vi.mock("@/lib/auth-guard", () => ({
  getWalletAddress: (req: NextRequest) => req.headers.get("x-wallet-address"),
  requireOrgMember: async (req: NextRequest, orgId: string) => {
    const w = req.headers.get("x-wallet-address");
    if (!w) return { ok: false, status: 401, error: "auth" };
    return membership[w]?.includes(orgId) ? { ok: true, walletAddress: w } : { ok: false, status: 403, error: "Not a member" };
  },
}));
vi.mock("@/lib/firestore-admin", () => ({
  getAgent: async (id: string) => (id === "agentS" ? { id, name: "Sam", orgId: "sellerOrg" } : id === "agent1" ? { id, name: "Ada", orgId: "org1" } : null),
}));
vi.mock("@/lib/jobs-admin", async () => {
  const { JobActionError } = await import("@/lib/job-lifecycle");
  return {
    getJob: async (id: string) => state.jobs[id] ?? null,
    reviewDelivery: async (...a: unknown[]) => { state.calls.push(["review", ...a]); return state.jobs[a[0] as string]; },
    recordEscrowReleased: async (...a: unknown[]) => { state.calls.push(["release", ...a]); },
    submitJobDelivery: async (...a: unknown[]) => { state.calls.push(["deliver", ...a]); },
    createJob: async (...a: unknown[]) => { state.calls.push(["create", ...a]); return "new1"; },
    cancelJob: async (id: string) => {
      if (state.jobs[id].status === "completed") throw new JobActionError("A completed job can't be cancelled", 409);
      state.calls.push(["cancel", id]);
    },
  };
});

import { POST as review } from "@/app/api/jobs/[jobId]/review/route";
import { POST as deliver } from "@/app/api/jobs/[jobId]/deliver/route";
import { POST as cancel } from "@/app/api/jobs/[jobId]/cancel/route";
import { POST as create } from "@/app/api/jobs/route";

const req = (wallet: string | null, body: unknown) =>
  new NextRequest("https://agent-guild.com/api/jobs/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...(wallet ? { "x-wallet-address": wallet } : {}) },
    body: JSON.stringify(body),
  });
const ctx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });

beforeEach(() => {
  state.calls = [];
  state.jobs = {
    gig: {
      id: "gig", orgId: "buyerOrg", sellerOrgId: "sellerOrg", gigId: "g1", status: "completed",
      reviewStatus: "pending", deliveryNotes: "x", takenByAgentId: "agentS",
    },
    escrowed: {
      id: "escrowed", orgId: "buyerOrg", sellerOrgId: "sellerOrg", gigId: "g1", status: "completed",
      reviewStatus: "pending", deliveryNotes: "x", escrow: { status: "delivered" },
    },
    internal: { id: "internal", orgId: "org1", status: "in_progress", takenByAgentId: "agent1", claimedByAgentName: "Ada" },
    done: { id: "done", orgId: "org1", status: "completed" },
  };
});

describe("POST /api/jobs/:jobId/review", () => {
  it("lets the buyer review, with the session wallet as the reviewer", async () => {
    const res = await review(req("0xbuyer", { decision: "reject", notes: "redo" }), ctx("gig"));
    expect(res.status).toBe(200);
    expect(state.calls).toEqual([["review", "gig", { approve: false, notes: "redo" }, { type: "user", id: "0xbuyer" }]]);
  });

  it("stops the seller approving its own work and hides the job from outsiders", async () => {
    expect((await review(req("0xseller", { decision: "approve" }), ctx("gig"))).status).toBe(403);
    expect((await review(req("0xstranger", { decision: "approve" }), ctx("gig"))).status).toBe(404);
    expect((await review(req(null, { decision: "approve" }), ctx("gig"))).status).toBe(401);
    expect(state.calls).toEqual([]);
  });

  it("validates the decision", async () => {
    expect((await review(req("0xbuyer", { decision: "reject" }), ctx("gig"))).status).toBe(400);
  });

  it("won't approve an escrowed order until the release is signed, then records it", async () => {
    const blocked = await review(req("0xbuyer", { decision: "approve" }), ctx("escrowed"));
    expect(blocked.status).toBe(409);
    expect(state.calls).toEqual([]);
    const ok = await review(req("0xbuyer", { decision: "approve", releaseTxSig: "sig123" }), ctx("escrowed"));
    expect(ok.status).toBe(200);
    expect(state.calls.map((c) => c[0])).toEqual(["release", "review"]);
    expect(state.calls[0]).toEqual(["release", "escrowed", "sig123", { type: "user", id: "0xbuyer" }]);
  });
});

describe("POST /api/jobs/:jobId/deliver", () => {
  it("is the seller side's action, credited to the assigned agent", async () => {
    state.jobs.gig.status = "in_progress";
    expect((await deliver(req("0xbuyer", { deliveryNotes: "done" }), ctx("gig"))).status).toBe(403);
    const res = await deliver(req("0xseller", { deliveryNotes: "done", deliveryFiles: ["https://x.io/f"] }), ctx("gig"));
    expect(res.status).toBe(200);
    expect(state.calls[0]).toEqual([
      "deliver", "gig",
      { deliveryNotes: "done", deliveryFiles: ["https://x.io/f"], completedByAgentName: "Sam" },
      { type: "user", id: "0xseller" },
    ]);
  });

  it("on an ordinary job the posting org is both sides", async () => {
    expect((await deliver(req("0xboth", { deliveryNotes: "done" }), ctx("internal"))).status).toBe(200);
  });

  it("rejects non-http links and jobs not in progress", async () => {
    expect((await deliver(req("0xboth", { deliveryNotes: "d", deliveryFiles: ["javascript:x"] }), ctx("internal"))).status).toBe(400);
    expect((await deliver(req("0xboth", { deliveryNotes: "d" }), ctx("done"))).status).toBe(409);
  });
});

describe("POST /api/jobs/:jobId/cancel", () => {
  it("passes JobActionError statuses through", async () => {
    expect((await cancel(req("0xboth", { reason: "no" }), ctx("internal"))).status).toBe(200);
    expect((await cancel(req("0xboth", {}), ctx("done"))).status).toBe(409);
  });
});

describe("POST /api/jobs", () => {
  it("posts as the session wallet, ignoring a spoofed postedByAddress", async () => {
    const res = await create(req("0xboth", { orgId: "org1", title: "T", postedByAddress: "0xevil", status: "completed" }));
    expect(res.status).toBe(201);
    const [, input, meta] = state.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(meta).toEqual({ orgId: "org1", postedByAddress: "0xboth" });
    expect(input).not.toHaveProperty("status");
    expect(input).not.toHaveProperty("postedByAddress");
  });

  it("requires membership of the target org", async () => {
    expect((await create(req("0xbuyer", { orgId: "org1", title: "T" }))).status).toBe(403);
  });
});
