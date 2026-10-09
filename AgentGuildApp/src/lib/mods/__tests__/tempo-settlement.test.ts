import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerMod, RouteContext } from "../sdk";

const OWNER = "0x00000000000000000000000000000000000000aa";
const MEMBER = "0x00000000000000000000000000000000000000bb";
const AGENT_WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";

const state = vi.hoisted(() => ({
  jobs: [] as Record<string, unknown>[],
  wallets: {} as Record<string, { chain: string; publicKey: string; label?: string }[]>,
  caps: [] as { key: string }[],
  /** In-memory stand-in for tempoPayouts, keyed like the real store. */
  payouts: new Map<string, Record<string, unknown>>(),
  failBatch: false,
}));

vi.mock("@/lib/firestore-admin", () => ({
  getOrganizationsByWalletAdmin: vi.fn(async (addr: string) =>
    [OWNER, MEMBER].includes(addr.toLowerCase())
      ? [{ id: "o1", name: "Org One", ownerAddress: OWNER, members: [OWNER, MEMBER] }]
      : []),
  getAgentsByOrg: vi.fn(async () => [{ id: "a1", name: "Ada" }, { id: "a2", name: "Bob" }]),
  getAgentCapabilities: vi.fn(async () => state.caps),
}));

vi.mock("@/lib/jobs-admin", () => ({
  listOrgJobsByStatus: vi.fn(async () => ({ jobs: state.jobs, nextCursor: null })),
}));

vi.mock("@/lib/agent-wallets", () => ({
  listAgentWallets: vi.fn(async (agentId: string) => state.wallets[agentId] ?? []),
  generateAgentWallet: vi.fn(async (agentId: string) => {
    const w = { chain: "evm", publicKey: OTHER_WALLET, label: "Tempo payouts" };
    state.wallets[agentId] = [...(state.wallets[agentId] ?? []), w];
    return w;
  }),
}));

vi.mock("@/lib/wallet-address", () => ({ canonicalizeWalletAddress: (a: string) => a.toLowerCase() }));

vi.mock("@/lib/settlement/registry", () => ({
  hashJobResult: vi.fn(({ taskId }: { taskId: string }) => `hash-${taskId}`),
  verifyReceipt: vi.fn(async () => ({ found: true, hashVerified: true, confirmedAt: "2026-10-08T00:00:00.000Z" })),
  tempoAdapter: {
    settleBatch: vi.fn(async () => {
      if (state.failBatch) throw new Error("rpc down");
      return { txSig: "0xbatch", explorerUrl: "https://explore/tx/0xbatch" };
    }),
    payoutStatus: vi.fn(async () => ({
      network: "Tempo Testnet (Moderato)", token: "0xusd", tokenSymbol: "AlphaUSD", payoutWallet: "0xpay",
      payoutWalletUrl: "https://explore/address/0xpay", balance: 500, feeMode: "sponsor-relay", missing: [], error: null,
    })),
  },
}));

vi.mock("@/lib/mods/tempo-payouts-store", () => {
  const key = (u: { kind: string; jobId?: string; agentId?: string; taskId?: string }) =>
    u.kind === "job" ? `job:${u.jobId}` : `task:${u.agentId}:${u.taskId}`;
  return {
    claimPayout: vi.fn(async (unit: never, payout: Record<string, unknown>) => {
      const existing = state.payouts.get(key(unit));
      if (!existing) { state.payouts.set(key(unit), { ...payout }); return { state: "claimed" }; }
      if (existing.orgId !== payout.orgId) return { state: "conflict" };
      return existing.status === "paid" ? { state: "paid", payout: existing } : { state: "pending" };
    }),
    releasePayouts: vi.fn(async (units: never[]) => { for (const u of units) state.payouts.delete(key(u)); }),
    markPayoutsPaid: vi.fn(async (units: never[], tx: { txSig: string; explorerUrl: string }) => {
      for (const u of units) Object.assign(state.payouts.get(key(u))!, { status: "paid", ...tx, paidAt: "2026-10-08T00:00:00.000Z" });
      return true;
    }),
    listPayouts: vi.fn(async (orgIds: string[]) => [...state.payouts.values()].filter((p) => orgIds.includes(p.orgId as string))),
    getPayoutsByTx: vi.fn(async (txSig: string) => [...state.payouts.values()].filter((p) => p.txSig === txSig)),
  };
});

vi.mock("@/lib/chains", () => ({
  getChain: vi.fn(() => ({ contracts: { usdc: "0xusd", treasury: "0xtreasury" }, explorer: { txUrl: (h: string) => h } })),
  USDC_DECIMALS: 6,
}));

type Mod = ServerMod & { routes: NonNullable<ServerMod["routes"]> };

function ctx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    modId: "tempo-settlement",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emit: vi.fn(async () => {}),
    params: {},
    session: { address: OWNER, role: "operator" },
    agent: null,
    ...overrides,
  };
}

async function call(mod: Mod, routeKey: string, req: Request, overrides: Partial<RouteContext> = {}) {
  const def = mod.routes[routeKey];
  const handler = typeof def === "function" ? def : def.handler;
  const result = await handler(req, ctx(overrides));
  return result instanceof Response ? result : Response.json(result);
}

const post = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) });
const get = (path = "") => new Request(`http://x/${path}`);

function job(id: string, extra: Record<string, unknown> = {}) {
  return { id, orgId: "o1", title: `Job ${id}`, status: "completed", reviewStatus: "approved", takenByAgentId: "a1", reward: "$20", ...extra };
}

describe("tempo-settlement mod (Tempo payouts)", () => {
  let mod: Mod;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.MPP_SECRET_KEY;
    delete process.env.TEMPO_MAX_PAYOUT_USDC;
    state.jobs = [job("j1"), job("j2", { takenByAgentId: "a2", reward: "0.5 SOL" })];
    state.wallets = { a1: [{ chain: "evm", publicKey: AGENT_WALLET }, { chain: "solana", publicKey: "SoLaNa" }] };
    state.caps = [];
    state.payouts.clear();
    state.failBatch = false;
    vi.resetModules();
    mod = (await import("../../../../mods/tempo-settlement/server")).default as Mod;
  });

  it("parses only dollar rewards into a suggested amount", async () => {
    const { parseUsdReward } = await import("../../../../mods/tempo-settlement/server");
    expect(parseUsdReward("$1,250.50")).toBe(1250.5);
    expect(parseUsdReward("150")).toBe(150);
    expect(parseUsdReward("25 USDC")).toBe(25);
    expect(parseUsdReward("0.5 SOL")).toBeNull();
    expect(parseUsdReward(undefined)).toBeNull();
  });

  it("GET /overview reports the payout wallet and the caller's orgs with owner flag", async () => {
    const res = await (await call(mod, "GET /overview", get())).json();
    expect(res.tokenSymbol).toBe("AlphaUSD");
    expect(res.maxPayoutUsdc).toBe(100);
    expect(res.orgs).toEqual([{ id: "o1", name: "Org One", isOwner: true }]);
  });

  it("GET /payable lists approved jobs with EVM wallets only and skips unapproved, prepaid and paid ones", async () => {
    state.jobs.push(
      job("pending-review", { reviewStatus: "pending" }),
      job("escrowed", { escrow: { status: "funded" } }),
      job("unassigned", { takenByAgentId: undefined }),
      job("already"),
    );
    state.payouts.set("job:already", { orgId: "o1", jobId: "already", status: "paid" });

    const res = await (await call(mod, "GET /payable", get("payable?orgId=o1"))).json();
    expect(res.jobs.map((j: { jobId: string }) => j.jobId)).toEqual(["j1", "j2"]);
    expect(res.jobs[0]).toMatchObject({ agentName: "Ada", suggestedUsdc: 20, wallets: [{ address: AGENT_WALLET, label: null }] });
    expect(res.jobs[1]).toMatchObject({ suggestedUsdc: null, wallets: [] });
  });

  it("GET /payable 403s for an org the caller isn't in", async () => {
    const res = await call(mod, "GET /payable", get("payable?orgId=other"));
    expect(res.status).toBe(403);
  });

  it("POST /payouts pays several jobs in one transaction and records them", async () => {
    state.wallets.a2 = [{ chain: "evm", publicKey: OTHER_WALLET }];
    const { tempoAdapter } = await import("@/lib/settlement/registry");
    const res = await call(mod, "POST /payouts", post({
      orgId: "o1",
      items: [{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }, { jobId: "j2", to: OTHER_WALLET, amountUsdc: 5.5 }],
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ txSig: "0xbatch", paid: 2, totalUsdc: 25.5, persisted: true });
    expect(vi.mocked(tempoAdapter.settleBatch)).toHaveBeenCalledOnce();
    expect(vi.mocked(tempoAdapter.settleBatch).mock.calls[0][0]).toEqual([
      { to: AGENT_WALLET, resultHash: "hash-job:j1", amountUsdc: 20 },
      { to: OTHER_WALLET, resultHash: "hash-job:j2", amountUsdc: 5.5 },
    ]);

    const history = await (await call(mod, "GET /history", get())).json();
    expect(history.payouts).toHaveLength(2);
    expect(history.payouts.every((p: { status: string }) => p.status === "paid")).toBe(true);
  });

  it("POST /payouts never pays the same job twice", async () => {
    const body = { orgId: "o1", items: [{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }] };
    expect((await call(mod, "POST /payouts", post(body))).status).toBe(200);
    const again = await call(mod, "POST /payouts", post(body));
    expect(again.status).toBe(409);
    const { tempoAdapter } = await import("@/lib/settlement/registry");
    expect(vi.mocked(tempoAdapter.settleBatch)).toHaveBeenCalledOnce();
  });

  it("POST /payouts is owner-only", async () => {
    const res = await call(mod, "POST /payouts", post({ orgId: "o1", items: [{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 1 }] }), {
      session: { address: MEMBER, role: "operator" },
    });
    expect(res.status).toBe(403);
  });

  it("POST /payouts refuses a wallet that isn't the agent's", async () => {
    const res = await call(mod, "POST /payouts", post({ orgId: "o1", items: [{ jobId: "j1", to: OTHER_WALLET, amountUsdc: 1 }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/agent's own Tempo wallets/);
  });

  it("POST /payouts refuses unapproved jobs and amounts over the cap", async () => {
    state.jobs.push(job("j3", { reviewStatus: "pending" }));
    const unapproved = await call(mod, "POST /payouts", post({ orgId: "o1", items: [{ jobId: "j3", to: AGENT_WALLET, amountUsdc: 1 }] }));
    expect(unapproved.status).toBe(400);

    process.env.TEMPO_MAX_PAYOUT_USDC = "10";
    const tooMuch = await call(mod, "POST /payouts", post({ orgId: "o1", items: [{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 11 }] }));
    expect(tooMuch.status).toBe(400);
    expect((await tooMuch.json()).error).toMatch(/limit/);
  });

  it("POST /payouts releases claims when the Tempo transaction fails, so it can be retried", async () => {
    state.failBatch = true;
    const body = { orgId: "o1", items: [{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }] };
    expect((await call(mod, "POST /payouts", post(body))).status).toBe(502);
    expect(state.payouts.size).toBe(0);

    state.failBatch = false;
    expect((await call(mod, "POST /payouts", post(body))).status).toBe(200);
  });

  it("POST /wallet gives an agent a Tempo wallet once", async () => {
    const created = await (await call(mod, "POST /wallet", post({ orgId: "o1", agentId: "a2" }))).json();
    expect(created).toEqual({ address: OTHER_WALLET, created: true });
    const again = await (await call(mod, "POST /wallet", post({ orgId: "o1", agentId: "a2" }))).json();
    expect(again.created).toBe(false);
  });

  it("POST /settle needs a signed agent with the tempo-settle upgrade", async () => {
    const body = { taskId: "t1", amountUsdc: 1 };
    expect((await call(mod, "POST /settle", post(body))).status).toBe(401);
    expect((await call(mod, "POST /settle", post(body), { agent: { agentId: "a1", orgId: "o1" } })).status).toBe(403);

    state.caps = [{ key: "tempo-settle" }];
    const res = await call(mod, "POST /settle", post(body), { agent: { agentId: "a1", orgId: "o1" } });
    expect(res.status).toBe(200);
    expect((await res.json()).receipt).toMatchObject({ to: AGENT_WALLET, status: "paid", txSig: "0xbatch" });

    const replay = await (await call(mod, "POST /settle", post(body), { agent: { agentId: "a1", orgId: "o1" } })).json();
    expect(replay.replayed).toBe(true);
  });

  it("GET /verify/:txSig checks every memo in the tx, scoped to the caller's orgs", async () => {
    await call(mod, "POST /payouts", post({ orgId: "o1", items: [{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }] }));
    const ok = await (await call(mod, "GET /verify/:txSig", get(), { params: { txSig: "0xbatch" } })).json();
    expect(ok.hashVerified).toBe(true);

    const outsider = await call(mod, "GET /verify/:txSig", get(), { params: { txSig: "0xbatch" }, session: { address: "0xnobody", role: "operator" } });
    expect(outsider.status).toBe(404);
  });

  it("GET /export returns this org's payouts as CSV", async () => {
    await call(mod, "POST /payouts", post({ orgId: "o1", items: [{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }] }));
    const res = await call(mod, "GET /export", get());
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
    const lines = (await res.text()).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`Job j1,,${AGENT_WALLET},20,0xbatch`);
  });

  it("GET /paid/ping returns 501 when MPP_SECRET_KEY is not configured", async () => {
    const res = await call(mod, "GET /paid/ping", get());
    expect(res.status).toBe(501);
  });
});
