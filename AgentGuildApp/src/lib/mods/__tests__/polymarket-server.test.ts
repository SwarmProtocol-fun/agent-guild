import { describe, it, expect, vi, beforeEach } from "vitest";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MEMBER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const paperAccount = (): Record<string, unknown> => ({
  agentId: "a1", orgId: "org1", mode: "paper", paperCash: 1000, paperStartCash: 1000, live: null,
  risk: { maxOrderUsd: 25, maxExposureUsd: 100, maxDailyLossUsd: 50 },
});

const store = {
  ensureAccount: vi.fn(async () => paperAccount()),
  getAccount: vi.fn(),
  updateAccount: vi.fn(),
  resetPaper: vi.fn(),
  listPaperPositions: vi.fn(async () => [] as { shares: number; avgPrice: number }[]),
  getPaperPosition: vi.fn(async () => null),
  listAllOpenPaperPositions: vi.fn(async () => []),
  applyPaperFill: vi.fn(async () => ({ realized: -0.1, cash: 990 })),
  settlePaperPosition: vi.fn(),
  recordTrade: vi.fn(),
  listTrades: vi.fn(async () => []),
  getDailyRealizedPnl: vi.fn(async () => 0),
  createBot: vi.fn(async () => "b1"),
  getBot: vi.fn(),
  listBots: vi.fn(async () => []),
  listEnabledBots: vi.fn(async () => []),
  updateBot: vi.fn(),
  deleteBot: vi.fn(),
  addBotLog: vi.fn(),
  listBotLog: vi.fn(async () => []),
  createAiRequest: vi.fn(),
  getAiRequest: vi.fn(),
  listOpenAiRequests: vi.fn(async () => []),
  answerAiRequest: vi.fn(),
  expireAiRequest: vi.fn(),
  PaperError: class PaperError extends Error {},
  PAPER_START_CASH: 1000,
};

const market = {
  id: "1", conditionId: "0xc", slug: "m", question: "Will it?", eventSlug: null, eventTitle: null, groupItemTitle: null,
  description: "", endDate: "2099-01-01T00:00:00Z", image: null,
  outcomes: [{ name: "Yes", tokenId: "t-yes", price: 0.4 }, { name: "No", tokenId: "t-no", price: 0.6 }],
  bestBid: 0.39, bestAsk: 0.4, lastTradePrice: 0.4, volume24hr: 0, liquidity: 0, tickSize: 0.01, minOrderSize: 5,
  negRisk: false, acceptingOrders: true, closed: false, fee: null, winnerIndex: null, priceToBeat: null,
};

const live = {
  checkGeoblock: vi.fn(async () => ({ blocked: true, country: "US", region: "CA" })),
  ensureApprovals: vi.fn(),
  getLiveWalletState: vi.fn(),
  placeLiveOrder: vi.fn(),
  getLiveOpenOrders: vi.fn(),
  cancelLiveOrder: vi.fn(),
};
const wallets = {
  listAgentWallets: vi.fn(async () => []),
  generateAgentWallet: vi.fn(async () => ({ id: "w1", chain: "evm", publicKey: "0xagent" })),
  getAgentWalletEvmPrivateKey: vi.fn(async () => "0xkey"),
};
const enforceCapability = vi.fn(async () => ({}));

vi.mock("@/lib/mods/polymarket-store", () => store);
vi.mock("@/lib/agent-wallets", () => wallets);
vi.mock("@/lib/skills", () => ({ enforceCapability, getAgentCapabilities: vi.fn(async () => []) }));
vi.mock("@/lib/firestore-admin", () => ({
  getAgent: vi.fn(async (id: string) => ({ id, orgId: "org1", name: "Trader" })),
  getAgentsByOrg: vi.fn(),
  getOrganizationsByWalletAdmin: vi.fn(),
}));
vi.mock("@/lib/auth-guard", () => ({
  requireOrgMembershipByAddress: vi.fn(async (address: string) =>
    [OWNER, MEMBER].includes(address)
      ? { ok: true, org: { id: "org1", ownerAddress: OWNER.toUpperCase().replace("0X", "0x") } }
      : { ok: false, error: "Not a member", status: 403 }),
}));
vi.mock("../../../../mods/polymarket-trading/live", () => live);
vi.mock("../../../../mods/polymarket-trading/markets", async (orig) => ({
  ...(await orig<typeof import("../../../../mods/polymarket-trading/markets")>()),
  getMarketByConditionId: vi.fn(async () => market),
  getBook: vi.fn(async () => ({ bids: [{ price: 0.39, size: 1000 }], asks: [{ price: 0.4, size: 1000 }], tickSize: 0.01, minOrderSize: 5, negRisk: false })),
  getWalletPositions: vi.fn(async () => []),
}));

const { default: mod, checkBuyRisk } = await import("../../../../mods/polymarket-trading/server");

type Handler = (req: Request, ctx: unknown) => Promise<Response>;
function route(key: string): Handler {
  const def = mod.routes![key] as Handler | { handler: Handler };
  return typeof def === "function" ? def : def.handler;
}
function ctx(extra: Record<string, unknown>) {
  return { modId: "polymarket-trading", log: { info() {}, warn() {}, error() {} }, emit: async () => {}, params: {}, session: null, agent: null, ...extra };
}
const post = (body: unknown) => new Request("http://x/", { method: "POST", body: JSON.stringify(body) });
const asOwner = ctx({ session: { address: OWNER, role: "operator" } });
const asMember = ctx({ session: { address: MEMBER, role: "operator" } });
const asAgent = ctx({ agent: { agentId: "a1", orgId: "org1" } });

describe("polymarket mod routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.ensureAccount.mockImplementation(async () => paperAccount());
    store.listPaperPositions.mockResolvedValue([]);
    store.getDailyRealizedPnl.mockResolvedValue(0);
  });

  it("only the org owner can turn on live trading; the agent itself can't", async () => {
    const enable = route("POST /live/enable");
    expect((await enable(post({ agentId: "a1" }), asMember)).status).toBe(403);
    expect((await enable(post({ agentId: "a1" }), ctx({ agent: { agentId: "a1", orgId: "org1" }, session: { address: OWNER } }))).status).toBe(403);
    expect(store.updateAccount).not.toHaveBeenCalled();

    const ok = await enable(post({ agentId: "a1" }), asOwner);
    expect(ok.status).toBe(200);
    expect(wallets.generateAgentWallet).toHaveBeenCalledWith("a1", "org1", OWNER, expect.objectContaining({ chain: "evm" }));
    expect(store.updateAccount).toHaveBeenCalledWith("a1", expect.objectContaining({ mode: "live", live: expect.objectContaining({ address: "0xagent" }) }));
  });

  it("any member (or the agent) can switch live off", async () => {
    expect((await route("POST /live/disable")(post({ agentId: "a1" }), asAgent)).status).toBe(200);
    expect(store.updateAccount).toHaveBeenCalledWith("a1", { mode: "paper", live: null });
  });

  it("an agent can't loosen its own risk limits", async () => {
    expect((await route("POST /risk")(post({ agentId: "a1", maxOrderUsd: 1000 }), asAgent)).status).toBe(403);
    const resp = await route("POST /risk")(post({ agentId: "a1", maxOrderUsd: 50, maxExposureUsd: 200 }), asMember);
    expect(resp.status).toBe(200);
    expect(store.updateAccount).toHaveBeenCalledWith("a1", { risk: { maxOrderUsd: 50, maxExposureUsd: 200, maxDailyLossUsd: 50 } });
  });

  it("paper buy fills against the book and is recorded", async () => {
    const resp = await route("POST /order")(post({ conditionId: "0xc", outcomeIndex: 0, side: "buy", usd: 10 }), asAgent);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body).toMatchObject({ mode: "paper", shares: 25, avgPrice: 0.4 });
    expect(store.applyPaperFill).toHaveBeenCalledWith("a1", "org1", expect.objectContaining({ tokenId: "t-yes" }), "buy", expect.objectContaining({ shares: 25 }));
    expect(store.recordTrade).toHaveBeenCalledWith(expect.objectContaining({ mode: "paper", side: "buy", shares: 25 }));
  });

  it("risk gates block oversize orders, blown daily limits and exposure", async () => {
    const acct = paperAccount() as unknown as Parameters<typeof checkBuyRisk>[0];
    expect(await checkBuyRisk(acct, 30)).toMatch(/max order size/);
    store.getDailyRealizedPnl.mockResolvedValueOnce(-50);
    expect(await checkBuyRisk(acct, 10)).toMatch(/Daily loss limit/);
    store.listPaperPositions.mockResolvedValueOnce([{ shares: 200, avgPrice: 0.48 }]);
    expect(await checkBuyRisk(acct, 10)).toMatch(/exposure/);
    expect(await checkBuyRisk(acct, 10)).toBeNull();

    const resp = await route("POST /order")(post({ conditionId: "0xc", outcomeIndex: 0, side: "buy", usd: 30 }), asAgent);
    expect(resp.status).toBe(400);
    expect(store.applyPaperFill).not.toHaveBeenCalled();
  });

  it("refuses without the trade capability", async () => {
    enforceCapability.mockRejectedValueOnce(new Error('Agent a1 does not have capability "polymarket-trade"'));
    const resp = await route("POST /order")(post({ conditionId: "0xc", outcomeIndex: 0, side: "buy", usd: 10 }), asAgent);
    expect(resp.status).toBe(403);
  });

  it("a live order surfaces the geoblock refusal and records nothing", async () => {
    store.ensureAccount.mockImplementation(async () => ({ ...paperAccount(), mode: "live", live: { walletId: "w1", address: "0xagent", enabledBy: OWNER } }));
    live.placeLiveOrder.mockRejectedValueOnce(new Error("Polymarket blocks order placement from this server's location (CA, US)."));
    const resp = await route("POST /order")(post({ conditionId: "0xc", outcomeIndex: 0, side: "buy", usd: 10 }), asAgent);
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/blocks order placement/);
    expect(store.recordTrade).not.toHaveBeenCalled();
  });

  it("another org's agent can't trade for this one", async () => {
    const resp = await route("POST /order")(post({ agentId: "a1", conditionId: "0xc", outcomeIndex: 0, side: "buy", usd: 10 }), ctx({ session: { address: "0xcccccccccccccccccccccccccccccccccccccccc" } }));
    expect(resp.status).toBe(403);
  });

  it("an AI answer is traded once, by the agent it was asked of", async () => {
    const request = {
      id: "r1", agentId: "a1", orgId: "org1", botId: "b1", conditionId: "0xc", question: "Will it?", system: "", prompt: "",
      holding: false, status: "open", decision: null, reasoning: null, createdAt: null, expiresAt: new Date(Date.now() + 60_000),
    };
    store.getAiRequest.mockResolvedValue(request);
    store.answerAiRequest.mockResolvedValue({ ...request, status: "answered" });
    store.getBot.mockResolvedValue({ id: "b1", agentId: "a1", orgId: "org1", type: "ai", enabled: true, sizeUsd: 10, market: null, params: {}, state: { openRequestId: "r1" }, lastRunAt: null, createdAt: null });

    const other = await route("POST /ai/requests/:id/answer")(post({ text: "BUY_YES" }), ctx({ agent: { agentId: "a2", orgId: "org1" }, params: { id: "r1" } }));
    expect(other.status).toBe(404);

    const resp = await route("POST /ai/requests/:id/answer")(post({ text: "Underpriced at 40¢.\nBUY_YES" }), ctx({ agent: { agentId: "a1", orgId: "org1" }, params: { id: "r1" } }));
    expect(await resp.json()).toMatchObject({ ok: true, decision: "BUY_YES", action: "buy-yes", error: null });
    expect(store.applyPaperFill).toHaveBeenCalledWith("a1", "org1", expect.objectContaining({ tokenId: "t-yes" }), "buy", expect.anything());
    expect(store.addBotLog).toHaveBeenCalledWith("b1", expect.objectContaining({ kind: "decision", decision: "BUY_YES" }));
  });

  it("validates price-trigger bots", async () => {
    const create = route("POST /bots");
    const bad = await create(post({ type: "price-trigger", sizeUsd: 10, conditionId: "0xc", params: { price: 0.3, takeProfit: 0.2 } }), asAgent);
    expect(bad.status).toBe(400);
    store.getBot.mockResolvedValueOnce({ id: "b1", type: "price-trigger", enabled: true, sizeUsd: 10, market: null, params: {}, state: {}, lastRunAt: null, createdAt: null });
    const ok = await create(post({ type: "price-trigger", sizeUsd: 10, conditionId: "0xc", params: { price: 0.3, takeProfit: 0.5, stopLoss: 0.2 } }), asAgent);
    expect(ok.status).toBe(200);
    expect(store.createBot).toHaveBeenCalledWith(expect.objectContaining({
      type: "price-trigger", params: { outcomeIndex: 0, when: "ask-below", price: 0.3, takeProfit: 0.5, stopLoss: 0.2, phase: "armed" },
    }));
  });
});
