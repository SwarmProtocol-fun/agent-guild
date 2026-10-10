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
  addPaperFunds: vi.fn(async (...args: [string, number]) => 1000 + args[1]),
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
  createPaperOrder: vi.fn(async (d: Record<string, unknown>) => ({ ...d, id: `o${Math.random()}`, filledShares: 0, status: "open", cancelReason: null })),
  listOpenPaperOrders: vi.fn(async () => [] as unknown[]),
  listAgentPaperOrders: vi.fn(async () => [] as unknown[]),
  updatePaperOrder: vi.fn(),
  applyRestingFill: vi.fn(),
  getWhaleUniverse: vi.fn(async () => ({ addresses: [] as string[], refreshedAt: 0 })),
  setWhaleUniverse: vi.fn(),
  acquireTickLock: vi.fn(async () => true),
  releaseTickLock: vi.fn(),
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
const getModInstallStatus = vi.fn(async () => ({ installed: true, enabled: true, installationId: "i1" as string | null, enabledCapabilities: [] as string[] }));
const postAgentDmMessage = vi.fn(async () => ({ channelId: "c1", messageId: "m1" }));
const enableModCapabilities = vi.fn(async () => ({ installed: true, enabled: ["polymarket-trade", "polymarket-run-bots"] }));

vi.mock("@/lib/mods/polymarket-store", () => store);
vi.mock("@/lib/agent-wallets", () => wallets);
// Capability checks must go through the admin SDK; the client SDK in @/lib/skills is unauthenticated on the server.
vi.mock("@/lib/skills", () => ({
  enforceCapability: vi.fn(async () => { throw new Error("Missing or insufficient permissions."); }),
  getAgentCapabilities: vi.fn(async () => { throw new Error("Missing or insufficient permissions."); }),
}));
vi.mock("@/lib/firestore-admin", () => ({
  enforceCapability,
  getModInstallStatus,
  enableModCapabilities,
  postAgentDmMessage,
  getAgentCapabilities: vi.fn(async () => []),
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

const { default: mod, checkBuyRisk, runPolymarketTick, resolvePaperPositions, parseBotParams } = await import("../../../../mods/polymarket-trading/server");

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

const ZERO = { entries: 0, wins: 0, losses: 0, realizedPnl: 0, volumeUsd: 0 };
const makeBot = (over: Record<string, unknown> = {}) => ({
  id: "b1", agentId: "a1", orgId: "org1", type: "mid-price", enabled: true, sizeUsd: 5, market: null, params: {},
  maxLossUsd: null, stats: { paper: { ...ZERO }, live: { ...ZERO } }, state: {}, lastRunAt: null, createdAt: null, ...over,
});

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

  it("only the signed-in org owner can grant the trading capabilities, and only on an existing install", async () => {
    const grant = route("POST /grant");
    expect((await grant(post({ agentId: "a1" }), asAgent)).status).toBe(403);
    expect((await grant(post({ agentId: "a1" }), asMember)).status).toBe(403);
    expect(enableModCapabilities).not.toHaveBeenCalled();

    const ok = await grant(post({ agentId: "a1" }), asOwner);
    expect(ok.status).toBe(200);
    expect(enableModCapabilities).toHaveBeenCalledWith("org1", "mod-polymarket-trading", ["polymarket-trade", "polymarket-run-bots"]);

    enableModCapabilities.mockResolvedValueOnce({ installed: false, enabled: [] });
    const missing = await grant(post({ agentId: "a1" }), asOwner);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatch(/Install it from the Market/);
  });

  it("AI bots keep trimmed operator instructions and reject bad ones", () => {
    expect(parseBotParams("ai", { target: "btc-5m", instructions: "  Fade spikes.  " })).toMatchObject({ target: "btc-5m", instructions: "Fade spikes." });
    expect(parseBotParams("ai", { target: "btc-5m", instructions: "   " })).not.toHaveProperty("instructions");
    expect(parseBotParams("ai", { target: "btc-5m", instructions: 5 })).toMatch(/must be text/);
    expect(parseBotParams("ai", { target: "btc-5m", instructions: "x".repeat(2001) })).toMatch(/at most 2000/);
  });

  it("only the signed-in owner can send the agent a prompt, posted as themselves", async () => {
    const prompt = route("POST /prompt");
    expect((await prompt(post({ agentId: "a1", text: "trade" }), asAgent)).status).toBe(403);
    expect((await prompt(post({ agentId: "a1", text: "trade" }), asMember)).status).toBe(403);
    expect((await prompt(post({ agentId: "a1", text: "   " }), asOwner)).status).toBe(400);
    expect((await prompt(post({ agentId: "a1", text: "x".repeat(8001) }), asOwner)).status).toBe(400);
    expect(postAgentDmMessage).not.toHaveBeenCalled();

    const ok = await prompt(post({ agentId: "a1", text: "  Make one paper trade  " }), asOwner);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ channelId: "c1", messageId: "m1" });
    expect(postAgentDmMessage).toHaveBeenCalledWith({
      agentId: "a1", orgId: "org1", agentName: "Trader", senderAddress: OWNER, text: "Make one paper trade",
    });
  });

  it("GET /me reports whether the org installed the mod", async () => {
    getModInstallStatus.mockResolvedValueOnce({ installed: false, enabled: false, installationId: null, enabledCapabilities: [] });
    const res = await route("GET /me")(new Request("http://x/"), asAgent);
    const body = await res.json();
    expect(body.install).toEqual({ installed: false, enabled: false });
    expect(body.capabilities).toEqual({ "polymarket-trade": false, "polymarket-run-bots": false });
    expect(getModInstallStatus).toHaveBeenCalledWith("org1", "mod-polymarket-trading");
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
    expect(store.applyPaperFill).toHaveBeenCalledWith("a1", "org1", expect.objectContaining({ tokenId: "t-yes" }), "buy", expect.objectContaining({ shares: 25 }), null);
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
    expect(store.applyPaperFill).toHaveBeenCalledWith("a1", "org1", expect.objectContaining({ tokenId: "t-yes" }), "buy", expect.anything(), "b1");
    expect(store.addBotLog).toHaveBeenCalledWith("b1", expect.objectContaining({ kind: "decision", decision: "BUY_YES" }));
  });

  it("people can add paper money; the agent can't, and amounts are bounded", async () => {
    const fund = route("POST /paper/fund");
    expect((await fund(post({ agentId: "a1", amount: 500 }), asAgent)).status).toBe(403);
    expect((await fund(post({ agentId: "a1", amount: 0 }), asMember)).status).toBe(400);
    expect((await fund(post({ agentId: "a1", amount: 2_000_000 }), asMember)).status).toBe(400);
    expect(store.addPaperFunds).not.toHaveBeenCalled();
    const ok = await fund(post({ agentId: "a1", amount: 500 }), asMember);
    expect(await ok.json()).toEqual({ ok: true, cash: 1500 });
    expect(store.addPaperFunds).toHaveBeenCalledWith("a1", 500);
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

  it("passes the bot id through to the paper fill and the trade", async () => {
    const { default: _m, ...server } = await import("../../../../mods/polymarket-trading/server");
    void _m;
    await server.executeOrder({
      account: paperAccount() as never, market: market as never, outcomeIndex: 0, side: "buy", usd: 10, kind: "market", strategyId: "b1",
    });
    expect(store.applyPaperFill).toHaveBeenCalledWith("a1", "org1", expect.anything(), "buy", expect.anything(), "b1");
    expect(store.recordTrade).toHaveBeenCalledWith(expect.objectContaining({ strategyId: "b1" }));
  });

  it("credits a paper resolution to the bot that bought the position", async () => {
    store.listAllOpenPaperPositions.mockResolvedValueOnce([{
      id: "a1_t-yes", agentId: "a1", orgId: "org1", conditionId: "0xc", question: "Will it?", slug: "m", endDate: "2000-01-01T00:00:00Z",
      tokenId: "t-yes", outcomeIndex: 0, outcome: "Yes", shares: 10, avgPrice: 0.4, realizedPnl: 0, open: true, strategyId: "b1",
    }] as never);
    const markets = await import("../../../../mods/polymarket-trading/markets");
    vi.mocked(markets.getMarketByConditionId).mockResolvedValueOnce({ ...market, closed: true, winnerIndex: 0 } as never);
    store.settlePaperPosition.mockResolvedValueOnce({ payout: 10, realized: 6 });
    expect(await resolvePaperPositions()).toMatchObject({ settled: 1 });
    expect(store.recordTrade).toHaveBeenCalledWith(expect.objectContaining({ side: "resolve", strategyId: "b1", realizedPnl: 6 }));
    expect(store.addBotLog).toHaveBeenCalledWith("b1", expect.objectContaining({ kind: "resolve" }));
  });

  it("reading the account pays out a resolved winner without the tick", async () => {
    const pos = {
      id: "a1_t-no", agentId: "a1", orgId: "org1", conditionId: "0xc", question: "Will it?", slug: "m", endDate: "2000-01-01T00:00:00Z",
      tokenId: "t-no", outcomeIndex: 1, outcome: "No", shares: 10, avgPrice: 0.94, realizedPnl: 0, open: true, strategyId: null,
    };
    store.listPaperPositions.mockResolvedValueOnce([pos] as never).mockResolvedValueOnce([]);
    const markets = await import("../../../../mods/polymarket-trading/markets");
    vi.mocked(markets.getMarketByConditionId).mockResolvedValueOnce({ ...market, closed: true, winnerIndex: 1 } as never);
    store.settlePaperPosition.mockResolvedValueOnce({ payout: 10, realized: 0.6 });
    const res = await route("GET /account/:agentId")(new Request("http://x/"), { ...asAgent, params: { agentId: "a1" } });
    expect(res.status).toBe(200);
    expect(store.settlePaperPosition).toHaveBeenCalledWith("a1_t-no", true);
    expect(store.recordTrade).toHaveBeenCalledWith(expect.objectContaining({ side: "resolve", status: "won", realizedPnl: 0.6 }));
    expect((await res.json()).positions).toEqual([]);
  });

  it("pays a market that resolved before its scheduled end date", async () => {
    store.listAllOpenPaperPositions.mockResolvedValueOnce([{
      id: "a1_t-yes", agentId: "a1", orgId: "org1", conditionId: "0xc", question: "By Dec 31?", slug: "m", endDate: "2099-12-31T00:00:00Z",
      tokenId: "t-yes", outcomeIndex: 0, outcome: "Yes", shares: 10, avgPrice: 0.4, realizedPnl: 0, open: true, strategyId: null,
    }] as never);
    const markets = await import("../../../../mods/polymarket-trading/markets");
    vi.mocked(markets.getMarketByConditionId).mockResolvedValueOnce({ ...market, closed: true, winnerIndex: 0 } as never);
    store.settlePaperPosition.mockResolvedValueOnce({ payout: 10, realized: 6 });
    expect(await resolvePaperPositions()).toMatchObject({ settled: 1 });
    expect(store.settlePaperPosition).toHaveBeenCalledWith("a1_t-yes", true);
  });

  it("checks past-due markets first, so the batch cap can't starve a closed one", async () => {
    const pos = (i: number, endDate: string) => ({
      id: `a1_t${i}`, agentId: "a1", orgId: "org1", conditionId: `0x${i}`, question: "q", slug: "m", endDate,
      tokenId: `t${i}`, outcomeIndex: 0, outcome: "Yes", shares: 1, avgPrice: 0.5, realizedPnl: 0, open: true, strategyId: null,
    });
    const future = Array.from({ length: 30 }, (_, i) => pos(i, "2099-01-01T00:00:00Z"));
    store.listAllOpenPaperPositions.mockResolvedValueOnce([...future, pos(99, "2000-01-01T00:00:00Z")] as never);
    const markets = await import("../../../../mods/polymarket-trading/markets");
    vi.mocked(markets.getMarketByConditionId).mockClear();
    const res = await resolvePaperPositions();
    expect(res.checked).toBe(25);
    expect(vi.mocked(markets.getMarketByConditionId).mock.calls[0][0]).toBe("0x99");
  });

  it("POST /paper/claim settles now and returns the new paper cash; strangers can't", async () => {
    const claim = route("POST /paper/claim");
    expect((await claim(post({ agentId: "a1" }), ctx({ session: { address: "0xcccccccccccccccccccccccccccccccccccccccc" } }))).status).toBe(403);
    store.listPaperPositions.mockResolvedValueOnce([{
      id: "a1_t-no", agentId: "a1", orgId: "org1", conditionId: "0xc", question: "Will it?", slug: "m", endDate: "2000-01-01T00:00:00Z",
      tokenId: "t-no", outcomeIndex: 1, outcome: "No", shares: 10.63, avgPrice: 0.94, realizedPnl: 0, open: true, strategyId: null,
    }] as never);
    const markets = await import("../../../../mods/polymarket-trading/markets");
    vi.mocked(markets.getMarketByConditionId).mockResolvedValueOnce({ ...market, closed: true, winnerIndex: 1 } as never);
    store.settlePaperPosition.mockResolvedValueOnce({ payout: 10.63, realized: 0.64 });
    store.ensureAccount.mockResolvedValueOnce({ ...paperAccount(), paperCash: 1000.6 });
    const res = await claim(post({ agentId: "a1" }), asMember);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checked: 1, settled: 1, paperCash: 1000.6 });
  });

  it("the tick stops a bot that has hit its loss limit and doesn't run it", async () => {
    store.getAccount.mockResolvedValue(paperAccount());
    store.listEnabledBots.mockResolvedValueOnce([
      makeBot({ type: "price-trigger", maxLossUsd: 10, stats: { paper: { ...ZERO, realizedPnl: -10.5 }, live: { ...ZERO } } }),
    ] as never);
    const result = await runPolymarketTick();
    expect(result.bots).toBe(0);
    expect(store.updateBot).toHaveBeenCalledWith("b1", expect.objectContaining({ enabled: false }));
    expect(store.addBotLog).toHaveBeenCalledWith("b1", expect.objectContaining({ reason: expect.stringMatching(/Loss limit hit/) }));
  });

  it("starting a bot needs the bots capability and refuses one past its loss limit", async () => {
    const toggle = route("POST /bots/:id/toggle");
    store.getAccount.mockResolvedValue(paperAccount());
    store.getBot.mockResolvedValue(makeBot({ enabled: false }));
    enforceCapability.mockRejectedValueOnce(new Error('Agent a1 does not have capability "polymarket-run-bots"'));
    expect((await toggle(post({ enabled: true }), ctx({ ...asMember, params: { id: "b1" } }))).status).toBe(403);

    store.getBot.mockResolvedValue(makeBot({ enabled: false, maxLossUsd: 5, stats: { paper: { ...ZERO, realizedPnl: -6 }, live: { ...ZERO } } }));
    const refused = await toggle(post({ enabled: true }), ctx({ ...asMember, params: { id: "b1" } }));
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/loss limit/);

    // Stopping never needs the capability.
    enforceCapability.mockRejectedValue(new Error("no"));
    expect((await toggle(post({ enabled: false }), ctx({ ...asMember, params: { id: "b1" } }))).status).toBe(200);
    enforceCapability.mockReset();
    enforceCapability.mockResolvedValue({});
  });

  it("edits a bot: re-validates params, and an agent can only tighten its loss limit", async () => {
    const update = route("POST /bots/:id/update");
    store.getBot.mockResolvedValue(makeBot({ maxLossUsd: 20, params: { minStreak: 4, atrMult: 3, maxAsk: 0.52, entryUntilMs: 60_000 }, type: "streak-fade" }));
    const asAgentOn = ctx({ agent: { agentId: "a1", orgId: "org1" }, params: { id: "b1" } });

    expect((await update(post({ maxLossUsd: 50 }), asAgentOn)).status).toBe(403);
    expect((await update(post({ maxLossUsd: null }), asAgentOn)).status).toBe(403);
    expect((await update(post({ sizeUsd: 100 }), asAgentOn)).status).toBe(400); // over maxOrderUsd
    expect(store.updateBot).not.toHaveBeenCalled();

    expect((await update(post({ maxLossUsd: 10, params: { minStreak: 6 } }), asAgentOn)).status).toBe(200);
    expect(store.updateBot).toHaveBeenCalledWith("b1", {
      maxLossUsd: 10, params: { minStreak: 6, atrMult: 3, maxAsk: 0.52, entryUntilMs: 60_000 },
    });
    // A person may loosen or clear it.
    expect((await update(post({ maxLossUsd: null }), ctx({ ...asMember, params: { id: "b1" } }))).status).toBe(200);
  });

  it("lists the bot tools for agents", async () => {
    const resp = await route("GET /agent/tools")(new Request("http://x/"), ctx({}));
    const names = (await resp.json()).tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["polymarket_bots", "polymarket_bot_create", "polymarket_bot_toggle", "polymarket_bot_log"]));
  });
});
