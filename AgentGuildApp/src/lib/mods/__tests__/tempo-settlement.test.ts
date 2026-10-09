import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerMod, RouteContext } from "../sdk";

const OWNER = "0x00000000000000000000000000000000000000aa";
const MEMBER = "0x00000000000000000000000000000000000000bb";
const AGENT_WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";

const state = vi.hoisted(() => ({
  jobs: [] as Record<string, unknown>[],
  wallets: {} as Record<string, { chain: string; publicKey: string; label?: string }[]>,
  /** In-memory stand-in for tempoPayouts, keyed like the real store. */
  payouts: new Map<string, Record<string, unknown>>(),
  /** Transfers "on Tempo", keyed by memo. */
  chain: new Map<string, { from: string; to: string; amount: bigint; memo: string; txHash: string; blockNumber: bigint }>(),
  missing: [] as string[],
}));

const PAYER = "0x00000000000000000000000000000000000000cc";

vi.mock("@/lib/firestore-admin", () => ({
  getOrganizationsByWalletAdmin: vi.fn(async (addr: string) =>
    [OWNER, MEMBER].includes(addr.toLowerCase())
      ? [{ id: "o1", name: "Org One", ownerAddress: OWNER, members: [OWNER, MEMBER] }]
      : []),
  getAgentsByOrg: vi.fn(async () => [{ id: "a1", name: "Ada" }, { id: "a2", name: "Bob" }]),
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
  verifyReceipt: vi.fn(async () => ({ found: true, hashVerified: true, confirmedAt: "2026-10-08T00:00:00.000Z" })),
  tempoAdapter: {
    payoutToken: vi.fn(async (holder?: string) => ({
      network: "Tempo Testnet (Moderato)",
      chain: { chainId: 42431, name: "Tempo", rpcUrl: "https://rpc", nativeCurrency: { name: "USD", symbol: "USD", decimals: 6 } },
      token: "0xusd", tokenSymbol: "AlphaUSD", decimals: 6, balance: holder ? 500 : null, missing: state.missing, error: null,
    })),
    blockNumber: vi.fn(async () => 1000n),
    findMemoTransfer: vi.fn(async ({ memo, to, minAmount, txHash }: { memo: string; to: string; minAmount: bigint; txHash?: string }) => {
      const t = state.chain.get(memo);
      return t && (!txHash || t.txHash === txHash) && t.to.toLowerCase() === to.toLowerCase() && t.amount >= minAmount ? t : null;
    }),
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
    getPayout: vi.fn(async (unit: never) => state.payouts.get(key(unit)) ?? null),
    releasePayouts: vi.fn(async (units: never[]) => { for (const u of units) state.payouts.delete(key(u)); }),
    markPayoutsPaid: vi.fn(async (units: never[], tx: Record<string, unknown>) => {
      for (const u of units) Object.assign(state.payouts.get(key(u))!, { status: "paid", ...tx, paidAt: "2026-10-08T00:00:00.000Z" });
      return true;
    }),
    listPayouts: vi.fn(async (orgIds: string[]) => [...state.payouts.values()].filter((p) => orgIds.includes(p.orgId as string))),
    getPayoutsByTx: vi.fn(async (txSig: string) => [...state.payouts.values()].filter((p) => p.txSig === txSig)),
  };
});

vi.mock("@/lib/chains", () => ({
  getChain: vi.fn(() => ({ contracts: { usdc: "0xusd", treasury: "0xtreasury" }, explorer: { txUrl: (h: string) => `https://explore/tx/${h}` } })),
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
  return { id, orgId: "o1", title: `Job ${id}`, status: "completed", reviewStatus: "approved", takenByAgentId: "a1", reward: "$20", deliveryNotes: `done ${id}`, ...extra };
}

type Transfer = { jobId: string; to: string; amountUsdc: number; amountBase: string; memo: string };

/** What the owner's wallet does: send the transfer, which lands on "Tempo". */
function walletSends(t: Transfer, overrides: Partial<{ to: string; amount: bigint; txHash: string }> = {}) {
  const txHash = overrides.txHash ?? `0x${t.jobId.padStart(64, "0")}`;
  state.chain.set(t.memo, { from: PAYER, to: overrides.to ?? t.to, amount: overrides.amount ?? BigInt(t.amountBase), memo: t.memo, txHash, blockNumber: 1001n });
  return txHash;
}

/** Pretend the owner's wallet sent this transfer and it landed. */
function land(t: { memo: string; to: string; amountBase: string }, extra: Partial<{ to: string; amount: bigint }> = {}) {
  const txHash = `0x${"ab".repeat(31)}${String(state.chain.size).padStart(2, "0")}`;
  state.chain.set(t.memo, { from: OWNER, to: t.to, amount: BigInt(t.amountBase), memo: t.memo, txHash, blockNumber: 1001n, ...extra });
  return txHash;
}

describe("tempo-settlement mod (Tempo payouts, paid from the owner's wallet)", () => {
  let mod: Mod;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.MPP_SECRET_KEY;
    state.jobs = [job("j1", { deliveryNotes: "did it" }), job("j2", { takenByAgentId: "a2", reward: "0.5 SOL" })];
    state.wallets = { a1: [{ chain: "evm", publicKey: AGENT_WALLET }, { chain: "solana", publicKey: "SoLaNa" }] };
    state.payouts.clear();
    state.chain.clear();
    state.missing = [];
    vi.resetModules();
    mod = (await import("../../../../mods/tempo-settlement/server")).default as Mod;
  });

  const start = (items: unknown[], overrides: Partial<RouteContext> = {}) =>
    call(mod, "POST /payouts/start", post({ orgId: "o1", items }), overrides);
  const confirm = (jobId: string, txHash?: string, overrides: Partial<RouteContext> = {}) =>
    call(mod, "POST /payouts/confirm", post({ orgId: "o1", jobId, txHash }), overrides);

  it("parses only dollar rewards into a suggested amount", async () => {
    const { parseUsdReward } = await import("../../../../mods/tempo-settlement/server");
    expect(parseUsdReward("$1,250.50")).toBe(1250.5);
    expect(parseUsdReward("150")).toBe(150);
    expect(parseUsdReward("25 USDC")).toBe(25);
    expect(parseUsdReward("0.5 SOL")).toBeNull();
    expect(parseUsdReward(undefined)).toBeNull();
  });

  it("derives a distinct memo per job from its org, id and delivery", async () => {
    const { jobReceiptHash } = await import("../../../../mods/tempo-settlement/server");
    const a = jobReceiptHash({ id: "j1", orgId: "o1", deliveryNotes: "x" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(jobReceiptHash({ id: "j2", orgId: "o1", deliveryNotes: "x" })).not.toBe(a);
    expect(jobReceiptHash({ id: "j1", orgId: "o1", deliveryNotes: "y" })).not.toBe(a);
  });

  it("GET /overview reports the token, the payer's balance and the caller's orgs — no platform wallet", async () => {
    const res = await (await call(mod, "GET /overview", get(`overview?payer=${OWNER}`))).json();
    expect(res).toMatchObject({ tokenSymbol: "AlphaUSD", balance: 500, chain: { chainId: 42431 } });
    expect(res).not.toHaveProperty("payoutWallet");
    expect(res.orgs).toEqual([{ id: "o1", name: "Org One", isOwner: true }]);
  });

  it("GET /payable lists approved jobs with EVM wallets only and skips unapproved, prepaid, paid and reserved ones", async () => {
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
    expect(res.waiting).toEqual([]);

    await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }]);
    const after = await (await call(mod, "GET /payable", get("payable?orgId=o1"))).json();
    expect(after.jobs.map((j: { jobId: string }) => j.jobId)).toEqual(["j2"]);
    expect(after.waiting).toMatchObject([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20, amountBase: "20000000", agentName: "Ada" }]);
  });

  it("GET /payable 403s for an org the caller isn't in", async () => {
    const res = await call(mod, "GET /payable", get("payable?orgId=other"));
    expect(res.status).toBe(403);
  });

  it("POST /payouts/start reserves jobs and returns the transfers for the owner's wallet — the server sends nothing", async () => {
    state.wallets.a2 = [{ chain: "evm", publicKey: OTHER_WALLET }];
    const res = await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }, { jobId: "j2", to: OTHER_WALLET, amountUsdc: 5.5 }]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ token: "0xusd", chain: { chainId: 42431 } });
    expect(body.transfers).toMatchObject([
      { jobId: "j1", to: AGENT_WALLET, amountUsdc: 20, amountBase: "20000000" },
      { jobId: "j2", to: OTHER_WALLET, amountUsdc: 5.5, amountBase: "5500000" },
    ]);
    expect(body.transfers[0].memo).toMatch(/^0x[0-9a-f]{64}$/);
    expect(state.payouts.get("job:j1")).toMatchObject({ status: "pending", fromBlock: "1000", paidBy: OWNER });
  });

  it("POST /payouts/confirm marks a job paid only once the transfer is on-chain", async () => {
    const { transfers: [t] } = await (await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }])).json();

    expect(await (await confirm("j1")).json()).toMatchObject({ status: "pending", txSig: null });

    const txHash = land(t);
    const res = await (await confirm("j1", txHash)).json();
    expect(res).toMatchObject({ status: "paid", txSig: txHash, explorerUrl: `https://explore/tx/${txHash}` });
    expect(state.payouts.get("job:j1")).toMatchObject({ status: "paid", txSig: txHash, paidBy: OWNER });

    const history = await (await call(mod, "GET /history", get())).json();
    expect(history.payouts).toMatchObject([{ jobId: "j1", status: "paid" }]);
  });

  it("POST /payouts/confirm finds the transfer by memo when the browser lost the tx hash", async () => {
    const { transfers: [t] } = await (await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }])).json();
    land(t);
    expect((await (await confirm("j1")).json()).status).toBe("paid");
  });

  it("POST /payouts/confirm ignores a copied memo that didn't pay the agent in full", async () => {
    const { transfers: [t] } = await (await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }])).json();
    const { tempoAdapter } = await import("@/lib/settlement/registry");
    land(t, { to: OTHER_WALLET });
    expect((await (await confirm("j1")).json()).status).toBe("pending");

    state.chain.clear();
    land(t, { amount: 1n });
    expect((await (await confirm("j1")).json()).status).toBe("pending");
    expect(state.payouts.get("job:j1")?.status).toBe("pending");
    expect(vi.mocked(tempoAdapter.findMemoTransfer).mock.calls[0][0]).toMatchObject({ to: AGENT_WALLET, minAmount: 20_000_000n, fromBlock: 1000n });
  });

  it("POST /payouts/confirm is scoped to the caller's org", async () => {
    await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }]);
    const res = await confirm("j1", undefined, { session: { address: "0xnobody", role: "operator" } });
    expect(res.status).toBe(403);
  });

  it("never pays the same job twice: a paid job can't be started again", async () => {
    const { transfers: [t] } = await (await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }])).json();
    await confirm("j1", land(t));
    const again = await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }]);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already paid/);
  });

  it("restarting a reserved job returns the same transfer; changing it is refused and new reservations are released", async () => {
    const first = await (await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }])).json();
    const resumed = await (await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }])).json();
    expect(resumed.transfers).toEqual(first.transfers);

    state.wallets.a2 = [{ chain: "evm", publicKey: OTHER_WALLET }];
    const changed = await start([{ jobId: "j2", to: OTHER_WALLET, amountUsdc: 1 }, { jobId: "j1", to: AGENT_WALLET, amountUsdc: 25 }]);
    expect(changed.status).toBe(409);
    expect(state.payouts.has("job:j2")).toBe(false);
  });

  it("POST /payouts/cancel frees a job nothing was sent for, but marks it paid if the transfer did go out", async () => {
    const { transfers: [t] } = await (await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }])).json();
    const cancelled = await (await call(mod, "POST /payouts/cancel", post({ orgId: "o1", jobId: "j1" }))).json();
    expect(cancelled).toEqual({ cancelled: true, status: "cancelled" });
    expect(state.payouts.has("job:j1")).toBe(false);

    await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }]);
    land(t);
    const raced = await (await call(mod, "POST /payouts/cancel", post({ orgId: "o1", jobId: "j1" }))).json();
    expect(raced).toMatchObject({ cancelled: false, status: "paid" });
    expect(state.payouts.get("job:j1")?.status).toBe("paid");
  });

  it("start and cancel are owner-only, and agents can't pay at all", async () => {
    const asMember = { session: { address: MEMBER, role: "operator" as const } };
    expect((await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 1 }], asMember)).status).toBe(403);
    expect((await call(mod, "POST /payouts/cancel", post({ orgId: "o1", jobId: "j1" }), asMember)).status).toBe(403);
    expect((await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 1 }], { agent: { agentId: "a1", orgId: "o1" } })).status).toBe(403);
    expect(mod.routes["POST /settle"]).toBeUndefined();
  });

  it("POST /payouts/start refuses a wallet that isn't the agent's, unapproved jobs and bad amounts", async () => {
    const wrongWallet = await start([{ jobId: "j1", to: OTHER_WALLET, amountUsdc: 1 }]);
    expect(wrongWallet.status).toBe(400);
    expect((await wrongWallet.json()).error).toMatch(/agent's own Tempo wallets/);

    state.jobs.push(job("j3", { reviewStatus: "pending" }));
    expect((await start([{ jobId: "j3", to: AGENT_WALLET, amountUsdc: 1 }])).status).toBe(400);
    expect((await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 0.0000001 }])).status).toBe(400);
    expect((await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: -1 }])).status).toBe(400);
    expect(state.payouts.size).toBe(0);
  });

  it("POST /payouts/start says what's missing when the token isn't configured", async () => {
    state.missing = ["TEMPO_USDC_ADDRESS"];
    const res = await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 1 }]);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/TEMPO_USDC_ADDRESS/);
  });

  it("POST /wallet gives an agent a Tempo wallet once", async () => {
    const created = await (await call(mod, "POST /wallet", post({ orgId: "o1", agentId: "a2" }))).json();
    expect(created).toEqual({ address: OTHER_WALLET, created: true });
    const again = await (await call(mod, "POST /wallet", post({ orgId: "o1", agentId: "a2" }))).json();
    expect(again.created).toBe(false);
  });

  it("GET /verify/:txSig checks the memo, scoped to the caller's orgs", async () => {
    const { transfers: [t] } = await (await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }])).json();
    const txHash = land(t);
    await confirm("j1", txHash);
    const ok = await (await call(mod, "GET /verify/:txSig", get(), { params: { txSig: txHash } })).json();
    expect(ok.hashVerified).toBe(true);

    const outsider = await call(mod, "GET /verify/:txSig", get(), { params: { txSig: txHash }, session: { address: "0xnobody", role: "operator" } });
    expect(outsider.status).toBe(404);
  });

  it("GET /export returns this org's payouts as CSV", async () => {
    const { transfers: [t] } = await (await start([{ jobId: "j1", to: AGENT_WALLET, amountUsdc: 20 }])).json();
    const txHash = land(t);
    await confirm("j1", txHash);
    const res = await call(mod, "GET /export", get());
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
    const lines = (await res.text()).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`Job j1,,${AGENT_WALLET},20,${txHash}`);
  });

  it("GET /paid/ping returns 501 when MPP_SECRET_KEY is not configured", async () => {
    const res = await call(mod, "GET /paid/ping", get());
    expect(res.status).toBe(501);
  });
});
