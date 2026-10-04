import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { ServerMod, RouteContext } from "../sdk";

// Capabilities granted to the test agent; tests flip entries on and off.
const granted = new Set<string>();

const updateInstall = vi.fn(async (_data: unknown) => {});
vi.mock("@/lib/firebase-admin", () => ({
  adminDb: () => ({ collection: () => ({ doc: () => ({ update: (d: unknown) => updateInstall(d) }) }) }),
}));
vi.mock("@/lib/settlement/registry", () => ({ settleOnChains: vi.fn(), hashJobResult: vi.fn(), getBalance: vi.fn(), verifyReceipt: vi.fn() }));
vi.mock("@/lib/solana/platform", () => ({ agentAlreadyRegistered: vi.fn(), getAgentSlashingHistoryOnChain: vi.fn(), mintIdentityToken: vi.fn() }));
vi.mock("@/lib/solana/client", () => ({ getScoreEventHistoryForAsn: vi.fn() }));
vi.mock("@/lib/firestore-admin", () => ({
  getAgentCapabilities: vi.fn(async () => [...granted].map((key) => ({ key }))),
  getModInstallations: vi.fn(async () => [{ id: "inst1", modId: "mod-solana-settlement", enabledCapabilities: ["solana-settlement"] }]),
  getAgent: vi.fn(async (id: string) => (id === "a1" ? { id: "a1", orgId: "o1", name: "chef" } : null)),
  getAgentsByOrg: vi.fn(async () => []),
  getOrganizationsByWalletAdmin: vi.fn(async () => [{ id: "o1", name: "Org", ownerAddress: "OWNER" }]),
}));
vi.mock("@/lib/auth-guard", () => ({
  requireOrgMembershipByAddress: vi.fn(async (addr: string) => (addr === "OUTSIDER" ? { ok: false, status: 403, error: "Not a member" } : { ok: true })),
}));
const devKey = Keypair.generate();
vi.mock("@/lib/agent-wallets", () => ({
  listAgentWallets: vi.fn(async () => [{ id: "w1", chain: "solana", label: "solana-dev", orgId: "o1", publicKey: devKey.publicKey.toBase58() }]),
  generateAgentWallet: vi.fn(),
  getAgentWalletKeypair: vi.fn(async () => devKey),
}));
const enqueueTask = vi.fn(async (task: unknown) => (task ? "task-1" : ""));
vi.mock("@/lib/gateway/store", () => ({
  enqueueTask: (t: unknown) => enqueueTask(t),
  getTask: vi.fn(async (id: string) => (id === "task-1"
    ? { id, orgId: "o1", taskType: "solana-anchor", status: "completed", result: { ok: 1 }, payload: { action: "build", privateKey: "SECRET" } }
    : { id, orgId: "other", taskType: "solana-anchor", status: "queued", payload: {} })),
  getAvailableWorkers: vi.fn(async () => []),
}));

const AGENT_CTX = { agent: { agentId: "a1", orgId: "o1" }, session: null };
const SESSION_CTX = (address = "OWNER") => ({ agent: null, session: { address, role: "operator" } });

async function call(method: string, path: string, ctxBase: object, body?: unknown) {
  const { default: mod } = (await import("../../../../mods/solana-settlement/server")) as { default: ServerMod };
  const { matchRoute } = await import("../router");
  const url = new URL(`http://x/api/mods/solana-settlement${path}`);
  const m = matchRoute(mod.routes!, method, url.pathname.split("/").slice(4));
  if (!m) throw new Error(`no route ${method} ${path}`);
  const handler = typeof m.def === "function" ? m.def : m.def.handler;
  const req = new Request(url, { method, body: body ? JSON.stringify(body) : undefined });
  return (await handler(req, { params: m.params, ...ctxBase } as unknown as RouteContext)) as Response;
}

const FILES = { "Anchor.toml": "", "programs/x/src/lib.rs": "" };

beforeEach(() => {
  granted.clear();
  enqueueTask.mockClear();
});

describe("capability gating", () => {
  it("an agent needs the matching upgrade for each tool", async () => {
    expect((await call("POST", "/dev/pda", AGENT_CTX, { programId: devKey.publicKey.toBase58(), seeds: [] })).status).toBe(403);
    granted.add("solana-dev-inspect");
    expect((await call("POST", "/dev/pda", AGENT_CTX, { programId: devKey.publicKey.toBase58(), seeds: [] })).status).toBe(200);
    expect((await call("POST", "/dev/simulate", AGENT_CTX, { instructions: [] })).status).toBe(403);
    expect((await call("POST", "/dev/anchor", AGENT_CTX, { action: "build", files: FILES })).status).toBe(403);
  });

  it("a browser session reads freely but acts only for agents in its org", async () => {
    expect((await call("POST", "/dev/pda", SESSION_CTX(), { programId: devKey.publicKey.toBase58(), seeds: [] })).status).toBe(200);
    granted.add("solana-dev-devnet");
    expect((await call("POST", "/dev/send", SESSION_CTX("OUTSIDER"), { agentId: "a1", instructions: [] })).status).toBe(403);
    expect((await call("POST", "/dev/send", SESSION_CTX(), { instructions: [] })).status).toBe(400); // no agentId
  });
});

describe("devnet safety", () => {
  it("never signs on mainnet", async () => {
    granted.add("solana-dev-devnet");
    const res = await call("POST", "/dev/send", AGENT_CTX, { cluster: "mainnet-beta", instructions: [{ kind: "transfer", to: devKey.publicKey.toBase58(), sol: 1 }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/only signs on devnet\/testnet/);
    expect((await call("POST", "/dev/airdrop", AGENT_CTX, { cluster: "mainnet-beta", sol: 1 })).status).toBe(400);
  });

  it("rejects arbitrary RPC URLs as a cluster", async () => {
    granted.add("solana-dev-simulate");
    expect((await call("POST", "/dev/simulate", AGENT_CTX, { cluster: "http://169.254.169.254", instructions: [] })).status).toBe(400);
  });
});

describe("anchor jobs", () => {
  it("validates the project and enqueues a solana-anchor task", async () => {
    granted.add("solana-dev-anchor");
    expect((await call("POST", "/dev/anchor", AGENT_CTX, { action: "build", files: { "../x": "" } })).status).toBe(400);
    expect((await call("POST", "/dev/anchor", AGENT_CTX, { action: "build", files: { "lib.rs": "" } })).status).toBe(400);
    const res = await call("POST", "/dev/anchor", AGENT_CTX, { action: "build", files: FILES });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskId).toBe("task-1");
    expect(body.warning).toMatch(/No GatewayAgent worker/);
    const task = enqueueTask.mock.calls[0][0] as { taskType: string; payload: Record<string, unknown> };
    expect(task.taskType).toBe("solana-anchor");
    expect(task.payload.privateKey).toBeUndefined();
  });

  it("deploy also needs the devnet upgrade, and carries the key under the auto-scrubbed field", async () => {
    granted.add("solana-dev-anchor");
    expect((await call("POST", "/dev/anchor", AGENT_CTX, { action: "deploy", files: FILES })).status).toBe(403);
    granted.add("solana-dev-devnet");
    expect((await call("POST", "/dev/anchor", AGENT_CTX, { action: "deploy", files: FILES })).status).toBe(200);
    const task = enqueueTask.mock.calls[0][0] as { payload: { privateKey: string; deploy: { cluster: string } } };
    expect(JSON.parse(task.payload.privateKey)).toEqual(Array.from(devKey.secretKey));
    expect(task.payload.deploy.cluster).toBe("devnet");
  });

  it("job status never echoes the payload and is scoped to the caller's org", async () => {
    granted.add("solana-dev-anchor");
    const res = await call("GET", "/dev/anchor/task-1", AGENT_CTX);
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect((await call("GET", "/dev/anchor/task-other", AGENT_CTX)).status).toBe(404);
  });
});

describe("agent picker", () => {
  it("lists the operator's agents even when one capability lookup fails", async () => {
    const fa = await import("@/lib/firestore-admin");
    vi.mocked(fa.getAgentsByOrg).mockResolvedValueOnce([{ id: "a1", name: "chef" }, { id: "a2", name: "scout" }] as never);
    vi.mocked(fa.getAgentCapabilities).mockRejectedValueOnce(new Error("boom"));
    const res = await call("GET", "/my-agents", SESSION_CTX());
    expect(res.status).toBe(200);
    const { agents } = await res.json();
    expect(agents.map((a: { name: string }) => a.name)).toEqual(["chef", "scout"]);
    expect(agents[0].isOwner).toBe(true);
  });
});

describe("discovery and upgrades", () => {
  it("every agent tool points at a real route", async () => {
    const { default: mod } = (await import("../../../../mods/solana-settlement/server")) as { default: ServerMod };
    const { matchRoute } = await import("../router");
    const res = await call("GET", "/agent/tools", { agent: null, session: null });
    const { tools } = (await res.json()) as { tools: { name: string; method: string; path: string }[] };
    expect(tools.length).toBeGreaterThan(10);
    for (const t of tools) {
      const path = t.path.replace(/\{[^}]+\}/g, "x").split("/");
      expect(matchRoute(mod.routes!, t.method, path), t.name).not.toBeNull();
    }
  });

  it("GET /me reports upgrades even when none are granted", async () => {
    const res = await call("GET", "/me", AGENT_CTX);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.capabilities["solana-dev-inspect"]).toBe(false);
    expect(body.devWallet.address).toBe(devKey.publicKey.toBase58());
  });

  it("only the org owner can enable all upgrades", async () => {
    expect((await call("POST", "/upgrade", SESSION_CTX("SOMEONE"), { orgId: "o1" })).status).toBe(403);
    const res = await call("POST", "/upgrade", SESSION_CTX(), { orgId: "o1" });
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toEqual(["solana-dev-inspect", "solana-dev-simulate", "solana-dev-devnet", "solana-dev-anchor"]);
    expect(updateInstall).toHaveBeenCalledWith({ enabledCapabilities: ["solana-settlement", "solana-dev-inspect", "solana-dev-simulate", "solana-dev-devnet", "solana-dev-anchor"] });
  });
});
