import { describe, it, expect, vi, beforeEach } from "vitest";

const store = {
  getEnabledStrategies: vi.fn(),
  getStrategy: vi.fn(),
  touchStrategyRun: vi.fn(),
  toggleStrategy: vi.fn(),
  markStrategyPending: vi.fn(),
  clearStrategyPending: vi.fn(),
  recordAiDecision: vi.fn(),
  getAiDecisions: vi.fn(),
  createAiRequest: vi.fn(async () => "req-1"),
  getAiRequest: vi.fn(),
  listOpenAiRequests: vi.fn(),
  answerAiRequest: vi.fn(),
  expireAiRequest: vi.fn(),
  getInstantTrading: vi.fn(),
  getAgentWallet: vi.fn(async () => null),
  getRiskConfig: vi.fn(async () => null),
  getDailyRealizedPnl: vi.fn(async () => 0),
};
const enqueueTask = vi.fn(async () => "task-1");

vi.mock("@/lib/mods/hyperliquid-store", () => store);
vi.mock("@/lib/agent-wallets", () => ({
  listAgentWallets: vi.fn(async () => []),
  generateAgentWallet: vi.fn(),
  getAgentWalletEvmPrivateKey: vi.fn(async () => "0xcustodial"),
}));
vi.mock("@/lib/gateway/store", () => ({ enqueueTask, getTask: vi.fn() }));
vi.mock("@/lib/settlement/registry", () => ({ settleOnChains: vi.fn(), hashJobResult: vi.fn() }));
vi.mock("@/lib/secrets", () => ({ encryptValue: vi.fn(), decryptValue: vi.fn() }));
vi.mock("@/lib/firestore-admin", () => ({ enforceCapability: vi.fn(async () => ({})), getAgentCapabilities: vi.fn(async () => []), getAgent: vi.fn(), getAgentsByOrg: vi.fn(), getOrganizationsByWalletAdmin: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ requireOrgMembershipByAddress: vi.fn() }));

const { default: mod, runAiTraderTick } = await import("../../../../mods/hyperliquid-trading/server");

type Handler = (req: Request, ctx: unknown) => Promise<Response>;
function route(key: string): Handler {
  const def = mod.routes![key] as Handler | { handler: Handler };
  return typeof def === "function" ? def : def.handler;
}
const agentCtx = (agentId: string, params: Record<string, string> = {}) => ({
  modId: "hyperliquid-trading", log: { info() {}, warn() {}, error() {} }, emit: async () => {},
  params, session: null, agent: { agentId, orgId: "org1" },
});
const post = (body: unknown) => new Request("http://x/", { method: "POST", body: JSON.stringify(body) });

const INSTANT = { agentId: "a1", orgId: "org1", walletId: "w1", address: "0xabc", network: "testnet" };

function aiBot(params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    id: "s1", orgId: "org1", agentId: "a1", wallet: "0xabc", type: "ai", coin: "ETH", sizeUsd: 25, enabled: true,
    params: { intervalMs: 3_600_000, maxDrawdownPct: 50, ...params },
    lastRunAt: null, createdAt: null, pendingSignal: false, pendingSince: null, pendingContext: null, webhookToken: null,
    ...extra,
  };
}

function liveRequest(extra: Record<string, unknown> = {}) {
  return {
    id: "req-1", agentId: "a1", orgId: "org1", purpose: "live", strategyId: "s1", coin: "ETH",
    system: "sys", prompt: "MARKET SNAPSHOT …\n\nCurrent position: FLAT (no open position)\n\nWhat is your decision?",
    status: "open", decision: null, reasoning: null, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    ...extra,
  };
}

/** Stubs Hyperliquid's info API: account value, an optional ETH position, candles, book, market, mids. */
function stubHyperliquid({ accountValue = 200, position = null as null | { szi: string; positionValue: string } } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const json = (d: unknown) => new Response(JSON.stringify(d));
    switch (body.type) {
      case "clearinghouseState":
        return json({
          marginSummary: { accountValue: String(accountValue), totalMarginUsed: "0", totalNtlPos: "0" },
          assetPositions: position ? [{ position: { coin: "ETH", entryPx: "100", unrealizedPnl: "0", ...position } }] : [],
        });
      case "spotClearinghouseState":
        return json({ balances: [] });
      case "candleSnapshot":
        return json(Array.from({ length: 60 }, (_, i) => ({ t: i * 3_600_000, o: "100", h: "101", l: "99", c: "100", v: "1" })));
      case "l2Book":
        return json({ levels: [[{ px: "99.9" }], [{ px: "100.1" }]] });
      case "metaAndAssetCtxs":
        return json([{ universe: [] }, []]);
      case "allMids":
        return json({ ETH: "100" });
      default:
        throw new Error(`unexpected info call ${body.type}`);
    }
  }));
}

describe("AI Trader — the agent's own model decides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.getInstantTrading.mockResolvedValue(INSTANT);
    store.createAiRequest.mockResolvedValue("req-1");
  });

  it("a due bot puts the round's question to its agent — no model runs on the hub", async () => {
    store.getEnabledStrategies.mockResolvedValue([aiBot()]);
    stubHyperliquid();

    expect(await runAiTraderTick()).toEqual({ due: 1, asked: 1, errors: 0 });
    expect(store.createAiRequest).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "a1", purpose: "live", strategyId: "s1", coin: "ETH",
      prompt: expect.stringContaining("ETH-PERP"), system: expect.stringContaining("LONG, SHORT, CLOSE or NOTHING"),
    }));
    expect(store.touchStrategyRun).toHaveBeenCalledWith("s1", expect.objectContaining({ openRequestId: "req-1", startEquity: 200 }));
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("the agent's answer is traded from its own wallet", async () => {
    store.getAiRequest.mockResolvedValue(liveRequest());
    store.answerAiRequest.mockImplementation(async (_id, decision, reasoning) => liveRequest({ status: "answered", decision, reasoning }));
    store.getStrategy.mockResolvedValue(aiBot({ openRequestId: "req-1" }));
    stubHyperliquid();

    const resp = await route("POST /ai/requests/:id/answer")(
      post({ text: "Momentum is building above the 20-bar average. LONG" }), agentCtx("a1", { id: "req-1" }),
    );
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body).toMatchObject({ decision: "LONG", action: "open-long", taskId: "task-1" });
    expect(enqueueTask).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ coin: "ETH", isBuy: true, sizeUsd: 25, privateKey: "0xcustodial" }),
    }));
    expect(store.recordAiDecision).toHaveBeenCalledWith("s1", expect.objectContaining({ decision: "LONG", model: "agent" }));
  });

  it("only the asked agent can answer, and only once", async () => {
    store.getAiRequest.mockResolvedValue(liveRequest());
    const answer = route("POST /ai/requests/:id/answer");

    expect((await answer(post({ decision: "LONG" }), agentCtx("someone-else", { id: "req-1" }))).status).toBe(404);
    store.answerAiRequest.mockResolvedValue(null); // already answered / expired
    expect((await answer(post({ decision: "LONG" }), agentCtx("a1", { id: "req-1" }))).status).toBe(409);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("rejects an answer with no decision in it", async () => {
    store.getAiRequest.mockResolvedValue(liveRequest());
    const resp = await route("POST /ai/requests/:id/answer")(post({ text: "hmm, not sure" }), agentCtx("a1", { id: "req-1" }));
    expect(resp.status).toBe(400);
    expect(store.answerAiRequest).not.toHaveBeenCalled();
  });

  it("a round the agent never answers is skipped, not traded", async () => {
    store.getEnabledStrategies.mockResolvedValue([aiBot({ openRequestId: "req-1" }, { lastRunAt: new Date() })]);
    store.getAiRequest.mockResolvedValue(liveRequest({ expiresAt: new Date(Date.now() - 1000) }));

    await runAiTraderTick();

    expect(store.expireAiRequest).toHaveBeenCalledWith("req-1");
    expect(store.touchStrategyRun).toHaveBeenCalledWith("s1", expect.objectContaining({ openRequestId: null }));
    expect(store.recordAiDecision).toHaveBeenCalledWith("s1", expect.objectContaining({ error: expect.stringMatching(/didn't answer/) }));
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("a flip only closes now and leaves the new side for the next tick", async () => {
    store.getAiRequest.mockResolvedValue(liveRequest());
    store.answerAiRequest.mockImplementation(async (_id, decision, reasoning) => liveRequest({ status: "answered", decision, reasoning }));
    store.getStrategy.mockResolvedValue(aiBot({ openRequestId: "req-1" }));
    stubHyperliquid({ position: { szi: "0.5", positionValue: "50" } });

    await route("POST /ai/requests/:id/answer")(post({ decision: "SHORT", reasoning: "rolling over" }), agentCtx("a1", { id: "req-1" }));

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueueTask).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ isBuy: false, sizeUsd: 50, reduceOnly: true }),
    }));
    expect(store.touchStrategyRun).toHaveBeenCalledWith("s1", expect.objectContaining({ flipTo: "short" }));
  });

  it("eliminates the bot at its drawdown limit without asking the agent", async () => {
    store.getEnabledStrategies.mockResolvedValue([aiBot({ startEquity: 200 })]);
    stubHyperliquid({ accountValue: 90 });

    await runAiTraderTick();

    expect(store.createAiRequest).not.toHaveBeenCalled();
    expect(store.toggleStrategy).toHaveBeenCalledWith("s1", false);
    expect(store.touchStrategyRun).toHaveBeenCalledWith("s1", expect.objectContaining({ eliminated: true }));
  });

  it("queues the answer for the passphrase when the agent isn't on instant trading", async () => {
    store.getInstantTrading.mockResolvedValue(null);
    store.getAgentWallet.mockResolvedValueOnce({ network: "testnet", address: "0xabc" } as never);
    store.getAiRequest.mockResolvedValue(liveRequest());
    store.answerAiRequest.mockImplementation(async (_id, decision, reasoning) => liveRequest({ status: "answered", decision, reasoning }));
    store.getStrategy.mockResolvedValue(aiBot({ openRequestId: "req-1" }));
    stubHyperliquid();

    await route("POST /ai/requests/:id/answer")(post({ decision: "SHORT" }), agentCtx("a1", { id: "req-1" }));

    expect(enqueueTask).not.toHaveBeenCalled();
    expect(store.markStrategyPending).toHaveBeenCalledWith("s1", expect.objectContaining({ action: "open-short" }));
  });

  it("the agent's work queue is agent-only", async () => {
    store.listOpenAiRequests.mockResolvedValue([liveRequest()]);
    const list = route("GET /ai/requests");
    expect((await list(new Request("http://x/"), { ...agentCtx("a1"), agent: null })).status).toBe(401);
    const body = await (await list(new Request("http://x/"), agentCtx("a1"))).json();
    expect(body.requests).toEqual([expect.objectContaining({ id: "req-1", prompt: expect.stringContaining("SNAPSHOT") })]);
    expect(store.listOpenAiRequests).toHaveBeenCalledWith("a1");
  });
});
