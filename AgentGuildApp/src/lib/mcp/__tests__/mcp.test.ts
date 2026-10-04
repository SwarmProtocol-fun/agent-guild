// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = {
  jobs: [] as Record<string, unknown>[],
  delivered: [] as unknown[],
  claimed: [] as unknown[],
  working: "# WORKING",
};

vi.mock("@/lib/agent-tokens", () => ({
  bearerToken: (h: Headers) => (h.get("authorization") || "").replace(/^Bearer /, "") || null,
  verifyAgentToken: async (t: string) => {
    const base = { agentId: "agentA", orgId: "org1", agentName: "Ada", issuedAt: 0, expiresAt: 0, jti: "j" };
    if (t === "agt_read") return { ...base, scopes: ["mcp:read"] };
    if (t === "agt_write") return { ...base, scopes: ["mcp:write"] };
    if (t === "agt_other") return { ...base, scopes: ["llm:proxy"] };
    return null;
  },
}));
vi.mock("@/app/api/v1/rate-limit", () => ({ rateLimit: async () => null }));
vi.mock("@/lib/firestore-admin", () => ({
  getAgent: async (id: string) => ({ id, orgId: "org1", type: "writer", trustScore: 80, tasksCompleted: 3 }),
  getJobsByOrg: async (orgId: string) => state.jobs.filter((j) => j.orgId === orgId),
}));
vi.mock("@/lib/jobs-admin", () => ({
  getJob: async (id: string) => state.jobs.find((j) => j.id === id) ?? null,
  getIncomingGigOrders: async (orgId: string) => state.jobs.filter((j) => j.sellerOrgId === orgId),
  claimJob: async (...args: unknown[]) => { state.claimed.push(args); return "task1"; },
  submitJobDelivery: async (...args: unknown[]) => { state.delivered.push(args); },
}));
vi.mock("@/lib/agent-memory-server", () => ({
  ALLOWED_SECTIONS: { working_md: ["Current Focus", "Notes"], memory_md: ["Learnings"], daily_note: ["Summary"] },
  isAllowedSection: (doc: string, s: string) => (({ working_md: ["Current Focus", "Notes"], memory_md: ["Learnings"], daily_note: ["Summary"] }) as Record<string, string[]>)[doc].includes(s),
  getOrCreateWorkingMd: async () => ({ content: state.working }),
  updateWorkingMd: async (_a: unknown, content: string) => { state.working = content; return { updatedAt: 1 }; },
  getOrCreateMemoryMd: async () => ({ content: "# MEMORY" }),
  appendMemoryMd: async () => ({ updatedAt: 2 }),
  getDailyNoteIfExists: async () => null,
  appendDailyNote: async () => ({ updatedAt: 3 }),
}));
vi.mock("@/lib/agent-directory", () => ({ searchDirectory: async () => [] }));
vi.mock("@/lib/harness-store", () => ({ listGenerations: async () => [], listJobOutcomes: async () => [], listReplyOutcomes: async () => [] }));

import { POST, GET } from "@/app/api/v1/mcp/route";
import { NextRequest } from "next/server";

let nextId = 1;
function rpc(method: string, params?: Record<string, unknown>, token = "agt_write", headers: Record<string, string> = {}) {
  return new NextRequest("https://agent-guild.com/api/v1/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
  });
}
const call = async (name: string, args: Record<string, unknown> = {}, token = "agt_write") => (await (await POST(rpc("tools/call", { name, arguments: args }, token))).json()).result;

beforeEach(() => {
  state.jobs = [
    { id: "open1", orgId: "org1", title: "Open job", description: "x".repeat(1000), status: "open", priority: "high" },
    { id: "apps1", orgId: "org1", title: "Needs application", description: "", status: "open", hiringMode: "applications" },
    { id: "mine1", orgId: "org1", title: "Mine", description: "", status: "in_progress", takenByAgentId: "agentA" },
    { id: "theirs", orgId: "org2", title: "Other org", description: "", status: "open" },
    { id: "gig1", orgId: "buyer", sellerOrgId: "org1", gigId: "g", title: "Gig order", description: "", status: "in_progress", takenByAgentId: "agentA" },
  ];
  state.delivered = [];
  state.claimed = [];
});

describe("MCP transport", () => {
  it("initializes, negotiating the protocol version", async () => {
    const res = await (await POST(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }))).json();
    expect(res.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "agent-guild" } });
    const old = await (await POST(rpc("initialize", { protocolVersion: "1999-01-01" }))).json();
    expect(old.result.protocolVersion).toBe("2025-11-25");
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const req = new NextRequest("https://agent-guild.com/api/v1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer agt_read" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("rejects missing tokens, wrong scopes, foreign origins and unknown protocol versions", async () => {
    const noAuth = await POST(rpc("ping", undefined, "nope"));
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect((await POST(rpc("ping", undefined, "agt_other"))).status).toBe(403);
    expect((await POST(rpc("ping", undefined, "agt_read", { origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(rpc("ping", undefined, "agt_read", { origin: "https://agent-guild.com" }))).status).toBe(200);
    expect((await POST(rpc("ping", undefined, "agt_read", { "mcp-protocol-version": "2020-01-01" }))).status).toBe(400);
  });

  it("returns JSON-RPC errors for unknown methods and offers no SSE stream", async () => {
    expect((await (await POST(rpc("resources/list"))).json()).error.code).toBe(-32601);
    expect((await GET()).status).toBe(405);
  });
});

describe("MCP tools", () => {
  it("lists only the tools the token's scopes allow", async () => {
    const names = async (t: string) => (await (await POST(rpc("tools/list", undefined, t))).json()).result.tools.map((x: { name: string }) => x.name);
    const read = await names("agt_read");
    expect(read).toContain("list_jobs");
    expect(read).not.toContain("deliver_job");
    expect(await names("agt_write")).toEqual(expect.arrayContaining(["deliver_job", "claim_job", "remember", "list_jobs"]));
    const denied = await (await POST(rpc("tools/call", { name: "deliver_job", arguments: {} }, "agt_read"))).json();
    expect(denied.error.message).toMatch(/mcp:write/);
  });

  it("lists open jobs in the agent's org only, and the agent's own jobs including gig orders", async () => {
    const open = await call("list_jobs", { filter: "open" }, "agt_read");
    expect(open.structuredContent.jobs.map((j: { id: string }) => j.id)).toEqual(["open1", "apps1"]);
    expect(open.structuredContent.jobs[0].description).toHaveLength(400);
    const mine = await call("list_jobs", { filter: "mine" }, "agt_read");
    expect(mine.structuredContent.jobs.map((j: { id: string }) => j.id).sort()).toEqual(["gig1", "mine1"]);
  });

  it("hides other orgs' jobs", async () => {
    const r = await call("get_job", { jobId: "theirs" }, "agt_read");
    expect(r.isError).toBe(true);
    expect((await call("get_job", { jobId: "open1" }, "agt_read")).structuredContent.description).toHaveLength(1000);
  });

  it("claims through the same checks as the REST API", async () => {
    expect((await call("claim_job", { jobId: "apps1" })).content[0].text).toMatch(/application/);
    expect((await call("claim_job", { jobId: "theirs" })).isError).toBe(true);
    const ok = await call("claim_job", { jobId: "open1" });
    expect(ok.structuredContent).toMatchObject({ jobId: "open1", status: "in_progress", taskId: "task1" });
    expect(state.claimed[0]).toEqual(["open1", "agentA", "org1", "", "Ada"]);
  });

  it("delivers only jobs the agent holds", async () => {
    expect((await call("deliver_job", { jobId: "open1", deliveryNotes: "done" })).content[0].text).toMatch(/not assigned/);
    expect((await call("deliver_job", { jobId: "mine1" })).content[0].text).toMatch(/deliveryNotes is required/);
    const ok = await call("deliver_job", { jobId: "gig1", deliveryNotes: "  here it is  " });
    expect(ok.isError).toBeUndefined();
    expect(state.delivered[0]).toEqual(["gig1", { deliveryNotes: "here it is", deliveryFiles: undefined, completedByAgentName: "Ada" }]);
  });

  it("reads and writes memory, validating sections", async () => {
    await call("update_working_memory", { content: "# focus: ship" });
    expect((await call("read_memory", { doc: "working" }, "agt_read")).structuredContent.content).toBe("# focus: ship");
    expect((await call("remember", { entry: "x", section: "Bogus" })).content[0].text).toMatch(/section must be one of/);
    expect((await call("read_memory", { doc: "daily", date: "yesterday" })).content[0].text).toMatch(/YYYY-MM-DD/);
  });
});
