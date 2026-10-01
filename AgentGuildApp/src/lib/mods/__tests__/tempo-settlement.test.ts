import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerMod, RouteContext } from "../sdk";

vi.mock("@/lib/skills", () => ({
  enforceCapability: vi.fn(async () => ({})),
}));

vi.mock("@/lib/settlement/registry", () => ({
  settleOnChains: vi.fn(async (_chains: string[], params: { taskId: string; resultHash: string }) => ({
    receipts: [{ chain: "tempo", txSig: `0xtx-${params.taskId}`, explorerUrl: `https://explore/0xtx-${params.taskId}`, receiptHash: params.resultHash, reputationUpdated: false }],
    errors: [],
  })),
  hashJobResult: vi.fn(({ taskId }: { taskId: string }) => `hash-${taskId}`),
  getBalance: vi.fn(async () => ({ usdc: 42 })),
  verifyReceipt: vi.fn(async () => ({ found: true, hashVerified: true })),
  tempoAdapter: {
    settleBatch: vi.fn(async (_wallet: string, items: { resultHash: string }[]) => ({
      txSig: "0xbatch", explorerUrl: "https://explore/0xbatch",
    })),
  },
}));

vi.mock("@/lib/chains", () => ({
  getChain: vi.fn(() => ({
    rpc: "http://rpc.invalid",
    contracts: { usdc: "0xusdc", treasury: "0xtreasury" },
    explorer: { txUrl: (h: string) => `https://explore/${h}` },
  })),
  USDC_DECIMALS: 6,
}));

vi.mock("ethers", () => ({
  ethers: {
    JsonRpcProvider: vi.fn().mockImplementation(function MockProvider() {
      return { getFeeData: async () => ({ gasPrice: 100n, maxFeePerGas: null, maxPriorityFeePerGas: null }) };
    }),
  },
}));

type Mod = ServerMod & { routes: NonNullable<ServerMod["routes"]> };

function ctx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    modId: "tempo-settlement",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emit: vi.fn(async () => {}),
    params: {},
    session: { address: "0x1", role: "operator" },
    agent: null,
    ...overrides,
  };
}

async function call(mod: Mod, routeKey: string, req: Request, params: Record<string, string> = {}) {
  const def = mod.routes[routeKey];
  const handler = typeof def === "function" ? def : def.handler;
  const result = await handler(req, ctx({ params }));
  return result instanceof Response ? result : Response.json(result);
}

function post(body: unknown) {
  return new Request("http://x", { method: "POST", body: JSON.stringify(body) });
}

async function freshMod(): Promise<Mod> {
  vi.resetModules();
  const serverModule = await import("../../../../mods/tempo-settlement/server");
  return serverModule.default as Mod;
}

describe("tempo-settlement mod", () => {
  let mod: Mod;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.MPP_SECRET_KEY;
    mod = await freshMod();
  });

  it("POST /settle requires orgId/agentId/agentWallet/taskId/amountUsdc", async () => {
    const res = await call(mod, "POST /settle", post({ orgId: "o1" }));
    expect(res.status).toBe(400);
  });

  it("POST /settle rejects when the capability check fails", async () => {
    const { enforceCapability } = await import("@/lib/skills");
    vi.mocked(enforceCapability).mockRejectedValueOnce(new Error("no capability"));
    const res = await call(mod, "POST /settle", post({ orgId: "o1", agentId: "a1", agentWallet: "0xw", taskId: "t1", amountUsdc: 1 }));
    expect(res.status).toBe(403);
  });

  it("POST /settle settles and records history", async () => {
    const res = await call(mod, "POST /settle", post({ orgId: "o1", agentId: "a1", agentWallet: "0xw", taskId: "t1", amountUsdc: 1.5 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.receipt.txSig).toBe("0xtx-t1");
    expect(json.receipt.amountUsdc).toBe(1.5);

    const history = await (await call(mod, "GET /history", new Request("http://x/history"))).json();
    expect(history.history).toHaveLength(1);
    expect(history.history[0].taskId).toBe("t1");
  });

  it("POST /settle with a reused idempotencyKey short-circuits to the cached receipt", async () => {
    const { settleOnChains } = await import("@/lib/settlement/registry");
    const body = { orgId: "o1", agentId: "a1", agentWallet: "0xw", taskId: "t1", amountUsdc: 1, idempotencyKey: "idem-1" };
    const first = await (await call(mod, "POST /settle", post(body))).json();
    const second = await (await call(mod, "POST /settle", post({ ...body, taskId: "t2" }))).json();
    expect(second.receipt.txSig).toBe(first.receipt.txSig);
    expect(vi.mocked(settleOnChains)).toHaveBeenCalledOnce();
  });

  it("GET /history filters by agentId, taskId, and excludes voided records by default", async () => {
    await call(mod, "POST /settle", post({ orgId: "o1", agentId: "a1", agentWallet: "0xw", taskId: "t1", amountUsdc: 1 }));
    await call(mod, "POST /settle", post({ orgId: "o1", agentId: "a2", agentWallet: "0xw", taskId: "t2", amountUsdc: 2 }));

    const byAgent = await (await call(mod, "GET /history", new Request("http://x/history?agentId=a1"))).json();
    expect(byAgent.history).toHaveLength(1);
    expect(byAgent.history[0].agentId).toBe("a1");

    await call(mod, "POST /void/:txSig", post({ reason: "test" }), { txSig: "0xtx-t1" });

    const afterVoid = await (await call(mod, "GET /history", new Request("http://x/history"))).json();
    expect(afterVoid.history.map((h: { taskId: string }) => h.taskId)).toEqual(["t2"]);

    const withVoid = await (await call(mod, "GET /history", new Request("http://x/history?includeVoid=true"))).json();
    expect(withVoid.history).toHaveLength(2);
  });

  it("POST /void/:txSig 404s for an unknown tx", async () => {
    const res = await call(mod, "POST /void/:txSig", post({ reason: "x" }), { txSig: "0xnope" });
    expect(res.status).toBe(404);
  });

  it("GET /agent/:agentId/total excludes voided settlements", async () => {
    await call(mod, "POST /settle", post({ orgId: "o1", agentId: "a1", agentWallet: "0xw", taskId: "t1", amountUsdc: 3 }));
    await call(mod, "POST /settle", post({ orgId: "o1", agentId: "a1", agentWallet: "0xw", taskId: "t2", amountUsdc: 4 }));
    await call(mod, "POST /void/:txSig", post({}), { txSig: "0xtx-t1" });

    const total = await (await call(mod, "GET /agent/:agentId/total", new Request("http://x"), { agentId: "a1" })).json();
    expect(total.totalUsdc).toBe(4);
    expect(total.settlementCount).toBe(1);
  });

  it("GET /stats aggregates totals, voids, and top agents", async () => {
    await call(mod, "POST /settle", post({ orgId: "o1", agentId: "a1", agentWallet: "0xw", taskId: "t1", amountUsdc: 10 }));
    await call(mod, "POST /settle", post({ orgId: "o1", agentId: "a2", agentWallet: "0xw", taskId: "t2", amountUsdc: 5 }));
    await call(mod, "POST /void/:txSig", post({}), { txSig: "0xtx-t2" });

    const stats = await (await call(mod, "GET /stats", new Request("http://x"))).json();
    expect(stats.settlementCount).toBe(1);
    expect(stats.voidCount).toBe(1);
    expect(stats.totalUsdc).toBe(10);
    expect(stats.uniqueAgents).toBe(1);
    expect(stats.topAgents[0]).toMatchObject({ agentId: "a1", totalUsdc: 10 });
  });

  it("GET /export returns a CSV with a header row and one row per settlement", async () => {
    await call(mod, "POST /settle", post({ orgId: "o1", agentId: "a1", agentWallet: "0xw", taskId: "t1", amountUsdc: 1 }));
    const res = await call(mod, "GET /export", new Request("http://x"));
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("agentId,taskId,txSig,amountUsdc,resultHash,invoiceRef,void,voidReason,at");
    expect(lines[1]).toContain("a1,t1,0xtx-t1,1,");
  });

  it("POST /settle/batch settles every item atomically in one transaction", async () => {
    const { tempoAdapter } = await import("@/lib/settlement/registry");
    const res = await call(mod, "POST /settle/batch", post({
      orgId: "o1", agentId: "a1", agentWallet: "0xw",
      settlements: [{ taskId: "t1", amountUsdc: 1 }, { taskId: "t2", amountUsdc: 2 }],
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.settled).toBe(2);
    expect(json.receipts.every((r: { txSig: string }) => r.txSig === "0xbatch")).toBe(true);
    expect(vi.mocked(tempoAdapter.settleBatch)).toHaveBeenCalledOnce();
  });

  it("POST /settle/batch rejects more than 25 settlements", async () => {
    const settlements = Array.from({ length: 26 }, (_, i) => ({ taskId: `t${i}`, amountUsdc: 1 }));
    const res = await call(mod, "POST /settle/batch", post({ orgId: "o1", agentId: "a1", agentWallet: "0xw", settlements }));
    expect(res.status).toBe(400);
  });

  it("meter accrues across calls and flush settles the pending total then clears it", async () => {
    await call(mod, "POST /meter/accrue", post({ orgId: "o1", agentId: "a1", amountUsdc: 0.01, taskId: "tick-1" }));
    await call(mod, "POST /meter/accrue", post({ orgId: "o1", agentId: "a1", amountUsdc: 0.02, taskId: "tick-2" }));

    const pending = await (await call(mod, "GET /meter/:agentId", new Request("http://x"), { agentId: "a1" })).json();
    expect(pending.pendingUsdc).toBeCloseTo(0.03);
    expect(pending.meteredTasks).toBe(2);

    const flushRes = await call(mod, "POST /meter/flush/:agentId", post({ agentWallet: "0xw" }), { agentId: "a1" });
    expect(flushRes.status).toBe(200);
    const flushed = await flushRes.json();
    expect(flushed.receipt.amountUsdc).toBeCloseTo(0.03);
    expect(flushed.flushedTaskCount).toBe(2);

    const after = await (await call(mod, "GET /meter/:agentId", new Request("http://x"), { agentId: "a1" })).json();
    expect(after.pendingUsdc).toBe(0);
  });

  it("POST /meter/flush/:agentId 400s when nothing has accrued", async () => {
    const res = await call(mod, "POST /meter/flush/:agentId", post({ agentWallet: "0xw" }), { agentId: "never-accrued" });
    expect(res.status).toBe(400);
  });

  it("GET /paid/ping returns 501 when MPP_SECRET_KEY is not configured", async () => {
    const res = await call(mod, "GET /paid/ping", new Request("http://x"));
    expect(res.status).toBe(501);
  });

  it("GET /verify/:txSig 404s for a tx with no local record", async () => {
    const res = await call(mod, "GET /verify/:txSig", new Request("http://x"), { txSig: "0xghost" });
    expect(res.status).toBe(404);
  });

  it("GET /invoice/:ref sums settlements sharing an invoice reference", async () => {
    await call(mod, "POST /settle", post({ orgId: "o1", agentId: "a1", agentWallet: "0xw", taskId: "t1", amountUsdc: 1, invoiceRef: "INV-1" }));
    await call(mod, "POST /settle", post({ orgId: "o1", agentId: "a1", agentWallet: "0xw", taskId: "t2", amountUsdc: 2, invoiceRef: "INV-1" }));
    const res = await (await call(mod, "GET /invoice/:ref", new Request("http://x"), { ref: "INV-1" })).json();
    expect(res.totalUsdc).toBe(3);
    expect(res.settlements).toHaveLength(2);
  });

  it("GET /estimate returns Tempo's current fee data", async () => {
    const res = await (await call(mod, "GET /estimate", new Request("http://x"))).json();
    expect(res.chain).toBe("tempo");
    expect(res.gasPrice).toBe("100");
  });
});
