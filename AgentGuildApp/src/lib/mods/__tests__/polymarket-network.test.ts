/**
 * Opt-in smoke test against the real Polymarket and Hyperliquid APIs
 * (Firestore stays mocked). Run with: POLYMARKET_NET=1 npx vitest run polymarket-network
 */
import { describe, it, expect, vi } from "vitest";

const account = {
  agentId: "a1", orgId: "org1", mode: "paper", paperCash: 1000, paperStartCash: 1000, live: null,
  risk: { maxOrderUsd: 25, maxExposureUsd: 100, maxDailyLossUsd: 50 },
};
const store = {
  ensureAccount: vi.fn(async () => account),
  getAccount: vi.fn(),
  updateAccount: vi.fn(),
  resetPaper: vi.fn(),
  addPaperFunds: vi.fn(async (...args: [string, number]) => 1000 + args[1]),
  listPaperPositions: vi.fn(async () => []),
  getPaperPosition: vi.fn(async () => null),
  listAllOpenPaperPositions: vi.fn(async () => []),
  applyPaperFill: vi.fn(async () => ({ realized: 0, cash: 990 })),
  settlePaperPosition: vi.fn(),
  recordTrade: vi.fn(),
  listTrades: vi.fn(async () => []),
  getDailyRealizedPnl: vi.fn(async () => 0),
  createBot: vi.fn(),
  getBot: vi.fn(),
  listBots: vi.fn(async () => []),
  listEnabledBots: vi.fn(async () => [] as unknown[]),
  updateBot: vi.fn(),
  deleteBot: vi.fn(),
  addBotLog: vi.fn(),
  listBotLog: vi.fn(async () => []),
  createAiRequest: vi.fn<(req: unknown) => Promise<string>>(async () => "r1"),
  getAiRequest: vi.fn(),
  listOpenAiRequests: vi.fn(async () => []),
  answerAiRequest: vi.fn(),
  expireAiRequest: vi.fn(),
  PaperError: class PaperError extends Error {},
  PAPER_START_CASH: 1000,
};
vi.mock("@/lib/mods/polymarket-store", () => store);
vi.mock("@/lib/agent-wallets", () => ({ listAgentWallets: vi.fn(), generateAgentWallet: vi.fn(), getAgentWalletEvmPrivateKey: vi.fn() }));
vi.mock("@/lib/skills", () => ({ enforceCapability: vi.fn(async () => ({})), getAgentCapabilities: vi.fn(async () => []) }));
vi.mock("@/lib/firestore-admin", () => ({ getAgent: vi.fn(async (id: string) => ({ id, orgId: "org1" })), getAgentsByOrg: vi.fn(), getOrganizationsByWalletAdmin: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ requireOrgMembershipByAddress: vi.fn() }));

const { default: mod, runPolymarketTick } = await import("../../../../mods/polymarket-trading/server");
const { checkGeoblock } = await import("../../../../mods/polymarket-trading/live");

type Handler = (req: Request, ctx: unknown) => Promise<Response>;
const route = (key: string) => mod.routes![key] as Handler;
const agentCtx = (params: Record<string, string> = {}) => ({ log: { info() {}, warn() {}, error() {} }, params, session: null, agent: { agentId: "a1", orgId: "org1" } });

describe.skipIf(!process.env.POLYMARKET_NET)("polymarket against the real APIs", () => {
  it("lists trending markets, reads a book and history, and paper-buys against the real book", async () => {
    const { events } = await (await route("GET /markets")(new Request("http://x/markets"), agentCtx())).json();
    expect(events.length).toBeGreaterThan(0);
    const market = events.flatMap((e: { markets: { acceptingOrders: boolean; outcomes: unknown[] }[] }) => e.markets).find((m: { acceptingOrders: boolean; outcomes: unknown[] }) => m.acceptingOrders && m.outcomes.length === 2);
    const token = market.outcomes[0].tokenId;
    const { book } = await (await route("GET /book/:tokenId")(new Request("http://x/"), agentCtx({ tokenId: token }))).json();
    expect(book.asks.length + book.bids.length).toBeGreaterThan(0);
    const { history } = await (await route("GET /history/:tokenId")(new Request("http://x/?interval=1d&fidelity=60"), agentCtx({ tokenId: token }))).json();
    expect(Array.isArray(history)).toBe(true);

    const resp = await route("POST /order")(new Request("http://x/", { method: "POST", body: JSON.stringify({ conditionId: market.conditionId, outcomeIndex: 0, side: "buy", usd: 5 }) }), agentCtx());
    const body = await resp.json();
    console.log("paper order:", market.question, body);
    if (book.asks.length) {
      expect(resp.status).toBe(200);
      expect(body.shares).toBeGreaterThan(0);
    }
  }, 30_000);

  it("finds the live BTC 5-minute window and runs both BTC bots through a real tick", async () => {
    const { market, window } = await (await route("GET /markets/btc-5m")(new Request("http://x/"), agentCtx())).json();
    console.log("btc window:", window.slug, market?.question);
    expect(market?.outcomes.map((o: { name: string }) => o.name)).toEqual(["Up", "Down"]);

    store.listEnabledBots.mockResolvedValueOnce([
      { id: "mid", agentId: "a1", orgId: "org1", type: "mid-price", enabled: true, sizeUsd: 5, market: null, params: { entryUntilMs: 290_000 }, state: {}, lastRunAt: null, createdAt: null },
      { id: "fade", agentId: "a1", orgId: "org1", type: "streak-fade", enabled: true, sizeUsd: 5, market: null, params: { entryUntilMs: 290_000 }, state: {}, lastRunAt: null, createdAt: null },
      { id: "ai", agentId: "a1", orgId: "org1", type: "ai", enabled: true, sizeUsd: 5, market: null, params: { target: "btc-5m" }, state: {}, lastRunAt: null, createdAt: null },
    ]);
    // 10s into the current window, so the AI Predictor asks its once-per-window question.
    const result = await runPolymarketTick(Math.floor(Date.now() / 300_000) * 300_000 + 10_000);
    console.log("tick:", result);
    for (const call of store.updateBot.mock.calls) console.log("  bot", call[0], JSON.stringify(call[1]));
    for (const call of store.addBotLog.mock.calls) console.log("  log", call[0], JSON.stringify(call[1]));
    if (store.createAiRequest.mock.calls.length) {
      const req = (store.createAiRequest.mock.calls as unknown as [{ system: string; prompt: string }][])[0][0];
      console.log("AI prompt:\n" + req.system + "\n---\n" + req.prompt.slice(0, 1500));
    }
    expect(result.errors).toBe(0);
    // Each BTC bot either recorded why it skipped or traded.
    const touched = new Set(store.updateBot.mock.calls.map((c) => c[0]));
    expect(touched.has("mid") && touched.has("fade")).toBe(true);
  }, 30_000);

  it("reports the geoblock status for this machine", async () => {
    const geo = await checkGeoblock();
    console.log("geoblock:", geo);
    expect(typeof geo.blocked).toBe("boolean");
  });
});
