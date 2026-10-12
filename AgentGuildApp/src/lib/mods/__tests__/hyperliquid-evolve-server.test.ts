import { describe, it, expect, vi, beforeEach } from "vitest";

const store = {
  // Live orders in flight: none, so only the open position is checked.
  reserveLiveExposure: vi.fn(async ({ check }: { check: (pendingUsd: number) => string | null }) => {
    const error = check(0);
    return error ? { error } : { id: "res-1" };
  }),
  bindLiveExposure: vi.fn(async () => {}),
  releaseLiveExposure: vi.fn(async () => {}),
  getEnabledStrategies: vi.fn(async () => [] as unknown[]),
  getStrategy: vi.fn(),
  touchStrategyRun: vi.fn(),
  toggleStrategy: vi.fn(),
  recordAiDecision: vi.fn(),
  getAiDecisions: vi.fn(async () => [] as unknown[]),
  createAiRequest: vi.fn(async () => "rev-1"),
  getAiRequest: vi.fn(),
  listOpenAiRequests: vi.fn(),
  answerAiRequest: vi.fn(),
  expireAiRequest: vi.fn(),
  setStrategyEvolution: vi.fn(),
  getInstantTrading: vi.fn(),
  getAgentWallet: vi.fn(async () => null),
  getRiskConfig: vi.fn(async () => null),
  getDailyRealizedPnl: vi.fn(async () => 0),
};

vi.mock("@/lib/mods/hyperliquid-store", () => store);
vi.mock("@/lib/agent-wallets", () => ({ listAgentWallets: vi.fn(async () => []), generateAgentWallet: vi.fn(), getAgentWalletEvmPrivateKey: vi.fn() }));
vi.mock("@/lib/gateway/store", () => ({ enqueueTask: vi.fn(), getTask: vi.fn() }));
vi.mock("@/lib/settlement/registry", () => ({ settleOnChains: vi.fn(), hashJobResult: vi.fn() }));
vi.mock("@/lib/secrets", () => ({ encryptValue: vi.fn(), decryptValue: vi.fn() }));
vi.mock("@/lib/firestore-admin", () => ({ enforceCapability: vi.fn(async () => ({})), getAgentCapabilities: vi.fn(async () => []), getAgent: vi.fn(), getAgentsByOrg: vi.fn(), getOrganizationsByWalletAdmin: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ requireOrgMembershipByAddress: vi.fn() }));

const { default: mod, runReflectionPass } = await import("../../../../mods/hyperliquid-trading/server");
const { newEvolution } = await import("../../../../mods/hyperliquid-trading/evolve");

type Handler = (req: Request, ctx: unknown) => Promise<Response>;
function route(key: string): Handler {
  const def = mod.routes![key] as Handler | { handler: Handler };
  return typeof def === "function" ? def : def.handler;
}
const agentCtx = (params: Record<string, string> = {}) => ({
  modId: "hyperliquid-trading", log: { info() {}, warn() {}, error() {} }, emit: async () => {},
  params, session: null, agent: { agentId: "a1", orgId: "org1" },
});
const post = (body: unknown) => new Request("http://x/", { method: "POST", body: JSON.stringify(body) });

function aiBot(evolution: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    id: "s1", orgId: "org1", agentId: "a1", wallet: "", type: "ai", coin: "ETH", sizeUsd: 25, enabled: true, paper: true,
    params: { intervalMs: 60_000, maxDrawdownPct: 10, goal: "Trend follow ETH" },
    lastRunAt: null, createdAt: null, pendingSignal: false, pendingSince: null, pendingContext: null, webhookToken: null,
    evolution: { ...newEvolution(), ...evolution },
    ...extra,
  };
}

/** A decision log (newest first, like the store) of n winning long round trips on ETH. */
function log(n: number) {
  const base = Date.now() - n * 20 * 60_000;
  return Array.from({ length: n }, (_, i) => [
    { action: "open-long", price: 100, reasoning: `trend up ${i}`, error: null, createdAt: new Date(base + i * 1_200_000) },
    { action: "close", price: 102, reasoning: `target ${i}`, error: null, createdAt: new Date(base + i * 1_200_000 + 600_000) },
  ]).flat().reverse();
}

beforeEach(() => {
  vi.clearAllMocks();
  store.getAiDecisions.mockResolvedValue([]);
});

describe("reflection pass", () => {
  it("asks the agent for a review once enough trips have closed, and remembers the question", async () => {
    store.getAiDecisions.mockResolvedValue(log(5));
    const result = await runReflectionPass([aiBot()] as never);
    expect(result).toEqual({ asked: 1, reverted: 0 });
    const req = (store.createAiRequest.mock.calls[0] as unknown[])[0] as { purpose: string; prompt: string; strategyId: string };
    expect(req).toMatchObject({ purpose: "reflect", strategyId: "s1" });
    expect(req.prompt).toContain("GOAL: Trend follow ETH");
    expect(req.prompt).toContain("why in: trend up 0");
    expect(store.setStrategyEvolution).toHaveBeenCalledWith("s1", expect.objectContaining({ requestId: "rev-1" }));
  });

  it("waits with too few trips, and skips bots that are off, stopped or eliminated", async () => {
    store.getAiDecisions.mockResolvedValue(log(2));
    await runReflectionPass([aiBot()] as never);
    expect(store.createAiRequest).not.toHaveBeenCalled();

    store.getAiDecisions.mockResolvedValue(log(9));
    await runReflectionPass([
      aiBot({ enabled: false }),
      aiBot({}, { enabled: false }),
      aiBot({}, { params: { intervalMs: 60_000, maxDrawdownPct: 10, eliminated: true } }),
    ] as never);
    expect(store.createAiRequest).not.toHaveBeenCalled();
  });

  it("is throttled, and leaves a review the agent is still answering alone", async () => {
    store.getAiDecisions.mockResolvedValue(log(9));
    await runReflectionPass([aiBot({ checkedAt: Date.now() - 1000 })] as never);
    store.getAiRequest.mockResolvedValue({ id: "rev-0", status: "open", expiresAt: new Date(Date.now() + 60_000) });
    await runReflectionPass([aiBot({ requestId: "rev-0" })] as never);
    expect(store.createAiRequest).not.toHaveBeenCalled();
    expect(store.getAiDecisions).not.toHaveBeenCalled();
  });
});

describe("answering a review", () => {
  const review = { id: "rev-1", agentId: "a1", orgId: "org1", purpose: "reflect", strategyId: "s1", coin: "ETH", coins: null, system: "s", prompt: "p", status: "open", expiresAt: new Date(Date.now() + 60_000) };

  it("adopts the lessons as the next version and logs them", async () => {
    store.getAiRequest.mockResolvedValue(review);
    store.answerAiRequest.mockResolvedValue({ ...review, status: "answered" });
    store.getStrategy.mockResolvedValue(aiBot({ requestId: "rev-1" }));
    store.getAiDecisions.mockResolvedValue(log(5));
    const resp = await route("POST /ai/requests/:id/answer")(
      post({ text: "Wins came from trend entries.\nLESSONS\n- Only long above the 20-bar average.\n- Take profit near +2%." }),
      agentCtx({ id: "rev-1" }),
    );
    expect(await resp.json()).toEqual({ ok: true, decision: "LESSONS v1" });
    expect(store.setStrategyEvolution).toHaveBeenCalledWith("s1", expect.objectContaining({
      version: 1, lessons: "- Only long above the 20-bar average.\n- Take profit near +2%.", requestId: null, note: "reflected",
    }));
    expect(store.recordAiDecision).toHaveBeenCalledWith("s1", expect.objectContaining({ action: "hold", reasoning: expect.stringContaining("lessons v1") }));
  });

  it("rejects an answer without lessons and never trades a review", async () => {
    store.getAiRequest.mockResolvedValue(review);
    const resp = await route("POST /ai/requests/:id/answer")(post({ text: "Looks fine. LONG" }), agentCtx({ id: "rev-1" }));
    expect(resp.status).toBe(400);
    expect(store.answerAiRequest).not.toHaveBeenCalled();
    expect(store.setStrategyEvolution).not.toHaveBeenCalled();
  });

  it("ignores a review that was superseded", async () => {
    store.getAiRequest.mockResolvedValue(review);
    store.answerAiRequest.mockResolvedValue({ ...review, status: "answered" });
    store.getStrategy.mockResolvedValue(aiBot({ requestId: "rev-2" }));
    const resp = await route("POST /ai/requests/:id/answer")(post({ text: "LESSONS\n- something useful" }), agentCtx({ id: "rev-1" }));
    expect(await resp.json()).toMatchObject({ ok: true, decision: "LESSONS not adopted" });
    expect(store.setStrategyEvolution).not.toHaveBeenCalled();
  });
});

describe("POST /strategy/:id/evolution", () => {
  const call = (body: unknown) => route("POST /strategy/:id/evolution")(post(body), agentCtx({ id: "s1" }));

  it("turns self-improvement off, queues a review, and resets lessons", async () => {
    store.getStrategy.mockResolvedValue(aiBot({ lessons: "- old lesson", version: 2, requestId: "rev-9" }));
    expect((await (await call({ enabled: false })).json()).evolution).toMatchObject({ enabled: false, requestId: null });
    expect((await (await call({ reflectNow: true })).json()).evolution).toMatchObject({ forceReflect: true, checkedAt: null });
    const reset = (await (await call({ reset: true })).json()).evolution;
    expect(reset).toMatchObject({ lessons: null, version: 3, note: "reset" });
    expect(reset.history[0]).toMatchObject({ version: 2, lessons: "- old lesson" });
  });

  it("refuses non-AI bots and empty bodies", async () => {
    store.getStrategy.mockResolvedValue({ ...aiBot(), type: "dca" });
    expect((await call({ enabled: true })).status).toBe(400);
    store.getStrategy.mockResolvedValue(aiBot());
    expect((await call({})).status).toBe(400);
  });
});
