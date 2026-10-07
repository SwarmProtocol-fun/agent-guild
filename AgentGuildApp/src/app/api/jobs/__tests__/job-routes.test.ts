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
const state = {
  jobs: {} as Record<string, Record<string, unknown>>,
  calls: [] as [string, ...unknown[]][],
  verify: { verified: true, signer: "PosterSol", args: new Uint8Array([0x88, 0x13]) } as Record<string, unknown>,
  verifyCalls: [] as unknown[][],
};

vi.mock("@/lib/solana/escrow-tx-verify", async () => {
  const real = await vi.importActual<typeof import("@/lib/solana/escrow-tx-verify")>("@/lib/solana/escrow-tx-verify");
  return {
    decodeAgentBps: real.decodeAgentBps,
    verifyEscrowTx: async (...a: unknown[]) => { state.verifyCalls.push(a); return state.verify; },
  };
});

vi.mock("@/lib/auth-guard", () => ({
  getWalletAddress: (req: NextRequest) => req.headers.get("x-wallet-address"),
  requirePlatformAdmin: (req: NextRequest) => ({ ok: req.headers.get("x-wallet-address") === "0xadmin" }),
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
    dispatchJob: async (...a: unknown[]) => { state.calls.push(["dispatch", ...a]); return { jobId: "d1", taskIds: ["t1"] }; },
    reopenJob: async (...a: unknown[]) => { state.calls.push(["reopen", ...a]); },
    recordEscrowResolved: async (...a: unknown[]) => { state.calls.push(["resolved", ...a]); },
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
import { POST as dispatch } from "@/app/api/jobs/dispatch/route";
import { POST as reopen } from "@/app/api/jobs/[jobId]/reopen/route";
import { POST as resolveEscrow } from "@/app/api/admin/jobs/[jobId]/escrow-resolve/route";

const req = (wallet: string | null, body: unknown) =>
  new NextRequest("https://agent-guild.com/api/jobs/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...(wallet ? { "x-wallet-address": wallet } : {}) },
    body: JSON.stringify(body),
  });
const ctx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });

beforeEach(() => {
  state.calls = [];
  state.verifyCalls = [];
  state.verify = { verified: true, signer: "PosterSol", args: new Uint8Array([0x88, 0x13]) };
  state.jobs = {
    gig: {
      id: "gig", orgId: "buyerOrg", sellerOrgId: "sellerOrg", gigId: "g1", status: "completed",
      reviewStatus: "pending", deliveryNotes: "x", takenByAgentId: "agentS",
    },
    escrowed: {
      id: "escrowed", orgId: "buyerOrg", sellerOrgId: "sellerOrg", gigId: "g1", status: "completed",
      reviewStatus: "pending", deliveryNotes: "x",
      escrow: { status: "disputed", taskPda: "Pda1", posterSolanaAddress: "PosterSol" },
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
    // Verified as an approve_delivery on this order's PDA, signed by the order's poster wallet.
    expect(state.verifyCalls[0]).toEqual(["sig123", "approve_delivery", "Pda1", "PosterSol"]);
  });

  it("refuses a release signature that doesn't check out on-chain", async () => {
    state.verify = { verified: false, reason: "Transaction has no approve_delivery instruction for this order's escrow" };
    const res = await review(req("0xbuyer", { decision: "approve", releaseTxSig: "forged" }), ctx("escrowed"));
    expect(res.status).toBe(422);
    expect(state.calls).toEqual([]);
    state.verify = { verified: false, reason: "not yet", retryable: true };
    expect((await review(req("0xbuyer", { decision: "approve", releaseTxSig: "slow" }), ctx("escrowed"))).status).toBe(503);
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

describe("POST /api/jobs/dispatch", () => {
  it("turns a prompt into a job for the team, posted as the session wallet", async () => {
    const prompt = "x".repeat(130);
    const res = await dispatch(req("0xboth", { orgId: "org1", prompt, agentIds: ["agent1", "agent2", 7], priority: "high" }));
    expect(res.status).toBe(201);
    const [, input, meta, agentIds] = state.calls[0] as [string, Record<string, unknown>, unknown, string[]];
    expect(input).toMatchObject({ title: `${"x".repeat(120)}…`, description: prompt, priority: "high", hiringMode: "instant" });
    expect(meta).toEqual({ orgId: "org1", postedByAddress: "0xboth" });
    expect(agentIds).toEqual(["agent1", "agent2"]);
  });

  it("needs agents and org membership", async () => {
    expect((await dispatch(req("0xboth", { orgId: "org1", prompt: "p" }))).status).toBe(400);
    expect((await dispatch(req("0xseller", { orgId: "org1", prompt: "p", agentIds: ["a"] }))).status).toBe(403);
  });
});

describe("POST /api/jobs/:jobId/reopen", () => {
  it("is the poster's action", async () => {
    expect((await reopen(req("0xboth", { reason: "stalled" }), ctx("internal"))).status).toBe(200);
    expect(state.calls[0]).toEqual(["reopen", "internal", "stalled", { type: "user", id: "0xboth" }]);
    expect((await reopen(req("0xseller", {}), ctx("gig"))).status).toBe(403);
  });
});

describe("POST /api/admin/jobs/:jobId/escrow-resolve", () => {
  it("is platform-admin only", async () => {
    expect((await resolveEscrow(req("0xbuyer", { resolveTxSig: "s" }), ctx("escrowed"))).status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it("records the split read from the verified transaction, not the request", async () => {
    const res = await resolveEscrow(req("0xadmin", { resolveTxSig: "s", agentBps: 10000 }), ctx("escrowed"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, agentBps: 5000 });
    expect(state.verifyCalls[0]).toEqual(["s", "resolve_dispute", "Pda1"]);
    expect(state.calls[0]).toEqual(["resolved", "escrowed", "s", 5000, { type: "user", id: "0xadmin", name: "Platform admin" }]);
  });

  it("rejects unverifiable signatures and jobs without escrow", async () => {
    state.verify = { verified: false, reason: "bad" };
    expect((await resolveEscrow(req("0xadmin", { resolveTxSig: "s" }), ctx("escrowed"))).status).toBe(422);
    expect((await resolveEscrow(req("0xadmin", { resolveTxSig: "s" }), ctx("internal"))).status).toBe(409);
  });
});
