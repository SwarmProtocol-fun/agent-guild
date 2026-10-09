import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getCronJob, updateCronJob, requireOrgMember, recordCronExecution } = vi.hoisted(() => ({
  getCronJob: vi.fn(),
  updateCronJob: vi.fn(),
  requireOrgMember: vi.fn(),
  recordCronExecution: vi.fn(),
}));

vi.mock("@/lib/firestore-admin", () => ({ getCronJob, updateCronJob, getAgent: vi.fn() }));
vi.mock("@/lib/cron-history", () => ({ recordCronExecution }));
vi.mock("@/app/api/v1/rate-limit", () => ({ rateLimit: async () => null }));
vi.mock("@/lib/auth-guard", () => ({
  getWalletAddress: (req: NextRequest) => req.headers.get("x-wallet-address"),
  requireOrgMember,
  unauthorized: (e: string) => Response.json({ error: e }, { status: 401 }),
  forbidden: (e: string) => Response.json({ error: e }, { status: 403 }),
}));

import { POST as testPOST } from "../test/route";
import { POST as pausePOST } from "../pause/route";

const params = { params: Promise.resolve({ id: "job1" }) };
const req = (body?: unknown) =>
  new NextRequest("http://localhost/api/cron/job1/x", {
    method: "POST",
    headers: { "x-wallet-address": "0xabc", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeEach(() => {
  vi.clearAllMocks();
  getCronJob.mockResolvedValue({ id: "job1", orgId: "orgA", name: "J", message: "m", schedule: "* * * * *", enabled: true, agentIds: [] });
});

describe("cron job routes check membership in the job's org", () => {
  it("test: rejects a wallet outside the job's org", async () => {
    requireOrgMember.mockResolvedValue({ ok: false, error: "Not a member", status: 403 });
    const res = await testPOST(req(), params);
    expect(res.status).toBe(403);
    expect(requireOrgMember).toHaveBeenCalledWith(expect.anything(), "orgA");
    expect(recordCronExecution).not.toHaveBeenCalled();
  });

  it("test: allows a member", async () => {
    requireOrgMember.mockResolvedValue({ ok: true });
    const res = await testPOST(req(), params);
    expect(res.status).toBe(200);
  });

  it("pause: ignores a client-supplied orgId and checks the job's org", async () => {
    requireOrgMember.mockResolvedValue({ ok: false, error: "Not a member", status: 403 });
    const res = await pausePOST(req({ orgId: "attackerOrg", paused: true }), params);
    expect(res.status).toBe(403);
    expect(requireOrgMember).toHaveBeenCalledWith(expect.anything(), "orgA");
    expect(updateCronJob).not.toHaveBeenCalled();
  });

  it("pause: rejects with no orgId at all (previously skipped the check)", async () => {
    requireOrgMember.mockResolvedValue({ ok: false, error: "Not a member", status: 403 });
    const res = await pausePOST(req({ paused: true }), params);
    expect(res.status).toBe(403);
    expect(updateCronJob).not.toHaveBeenCalled();
  });

  it("pause: lets a member pause", async () => {
    requireOrgMember.mockResolvedValue({ ok: true });
    const res = await pausePOST(req({ paused: true }), params);
    expect(res.status).toBe(200);
    expect(updateCronJob).toHaveBeenCalledWith("job1", { paused: true });
  });
});
