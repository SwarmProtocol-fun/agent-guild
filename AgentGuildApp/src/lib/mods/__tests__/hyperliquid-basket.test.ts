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
  getStrategies: vi.fn(async () => []),
  createStrategy: vi.fn(async () => "new-id"),
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

const { default: mod, runAiTraderTick, runHyperliquidStrategyTick, pickBasketCoins } = await import("../../../../mods/hyperliquid-trading/server");

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

function basketRequest(extra: Record<string, unknown> = {}) {
  return {
    id: "req-1", agentId: "a1", orgId: "org1", purpose: "live", strategyId: "s1", coin: "BTC/ETH", coins: ["BTC", "ETH"],
    system: "sys", prompt: "BASKET SNAPSHOT …", status: "open", decision: null, reasoning: null,
    createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), ...extra,
  };
}

/** Hyperliquid info API with BTC and ETH listed; optional open positions. */
function stubHyperliquid(positions: { coin: string; szi: string; positionValue: string }[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const json = (d: unknown) => new Response(JSON.stringify(d));
    switch (body.type) {
      case "clearinghouseState":
        return json({
          marginSummary: { accountValue: "500", totalMarginUsed: "0", totalNtlPos: "0" },
          assetPositions: positions.map((p) => ({ position: { entryPx: "100", unrealizedPnl: "0", ...p } })),
        });
      case "spotClearinghouseState":
        return json({ balances: [] });
      case "candleSnapshot": {
        const drift = body.req.coin === "BTC" ? 0.01 : 0.011;
        return json(Array.from({ length: 112 }, (_, i) => {
          const c = String(100 * Math.exp(drift * Math.sin(i / 4) + (body.req.coin === "ETH" && i === 111 ? 0.03 : 0)));
          return { t: i * 3_600_000, o: c, h: c, l: c, c, v: "1" };
        }));
      }
      case "metaAndAssetCtxs":
        return json([
          { universe: [{ name: "BTC", maxLeverage: 40 }, { name: "ETH", maxLeverage: 25 }, { name: "SOL", maxLeverage: 20 }] },
          [
            { funding: "0.0000125", openInterest: "10", prevDayPx: "100", dayNtlVlm: "3000000000", markPx: "100", oraclePx: "100" },
            { funding: "0.0001", openInterest: "10", prevDayPx: "100", dayNtlVlm: "2000000000", markPx: "100.5", oraclePx: "100" },
            { funding: "0", openInterest: "10", prevDayPx: "100", dayNtlVlm: "1000000000", markPx: "100", oraclePx: "100" },
          ],
        ]);
      case "predictedFundings":
        return json([["ETH", [["HlPerp", { fundingRate: "0.0001", fundingIntervalHours: 1 }], ["BinPerp", { fundingRate: "0.0001", fundingIntervalHours: 8 }]]]]);
      case "allMids":
        return json({ BTC: "100", ETH: "100" });
      default:
        throw new Error(`unexpected info call ${body.type}`);
    }
  }));
}

describe("basket bots — trade several coins per round", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.getInstantTrading.mockResolvedValue(INSTANT);
    store.createAiRequest.mockResolvedValue("req-1");
    store.getStrategies.mockResolvedValue([]);
  });

  it("asks one question covering every coin, with the cross-market scan", async () => {
    store.getEnabledStrategies.mockResolvedValue([aiBot({ coins: ["BTC", "ETH"] }, { coin: "BTC/ETH" })]);
    stubHyperliquid();

    expect(await runAiTraderTick()).toEqual({ due: 1, asked: 1, errors: 0 });
    const req = (store.createAiRequest.mock.calls as unknown[][])[0][0] as Record<string, string>;
    expect(req).toMatchObject({ coin: "BTC/ETH", coins: ["BTC", "ETH"] });
    expect(req.prompt).toContain("## BTC-PERP");
    expect(req.prompt).toContain("## ETH-PERP");
    expect(req.prompt).toContain("FUNDING VS OTHER VENUES");
    expect(req.prompt).toContain("ETH,+87.6,Binance,+10.9,76.6,SHORT");
    expect(req.prompt).toContain("PERP PREMIUM TO ORACLE");
    expect(req.system).toContain("DECISIONS");
  });

  it("trades both legs of a pair answer and remembers the coins it holds", async () => {
    store.getAiRequest.mockResolvedValue(basketRequest());
    store.answerAiRequest.mockImplementation(async (_id, decision, reasoning) => basketRequest({ status: "answered", decision, reasoning }));
    store.getStrategy.mockResolvedValue(aiBot({ coins: ["BTC", "ETH"], openRequestId: "req-1" }, { coin: "BTC/ETH" }));
    stubHyperliquid();

    const resp = await route("POST /ai/requests/:id/answer")(
      post({ text: "ETH is rich to BTC and pays funding.\nDECISIONS\nBTC: LONG\nETH: SHORT\nSOL: LONG" }), agentCtx("a1", { id: "req-1" }),
    );
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.decision).toBe("BTC:LONG ETH:SHORT");
    expect(body.actions).toEqual([
      { coin: "BTC", action: "open-long", taskId: "task-1", error: null },
      { coin: "ETH", action: "open-short", taskId: "task-1", error: null },
    ]);
    expect(enqueueTask).toHaveBeenCalledTimes(2);
    expect(enqueueTask).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ coin: "BTC", isBuy: true }) }));
    expect(enqueueTask).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ coin: "ETH", isBuy: false }) }));
    expect(store.recordAiDecision).toHaveBeenCalledWith("s1", expect.objectContaining({ coin: "ETH", decision: "SHORT" }));
    expect(store.touchStrategyRun).toHaveBeenLastCalledWith("s1", expect.objectContaining({ openRequestId: null, owned: ["BTC", "ETH"] }));
  });

  it("a live flip in a basket closes now and opens that coin's new side on a later tick", async () => {
    store.getAiRequest.mockResolvedValue(basketRequest());
    store.answerAiRequest.mockImplementation(async () => basketRequest({ status: "answered" }));
    store.getStrategy.mockResolvedValue(aiBot({ coins: ["BTC", "ETH"], openRequestId: "req-1" }, { coin: "BTC/ETH" }));
    stubHyperliquid([{ coin: "ETH", szi: "0.5", positionValue: "50" }]);

    await route("POST /ai/requests/:id/answer")(post({ decisions: { ETH: "SHORT" } }), agentCtx("a1", { id: "req-1" }));

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueueTask).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ coin: "ETH", reduceOnly: true }) }));
    expect(store.touchStrategyRun).toHaveBeenLastCalledWith("s1", expect.objectContaining({ flips: { ETH: "short" } }));

    // Next tick: the close has filled (no ETH position) — open the short.
    vi.clearAllMocks();
    store.getInstantTrading.mockResolvedValue(INSTANT);
    store.getEnabledStrategies.mockResolvedValue([aiBot({ coins: ["BTC", "ETH"], flips: { ETH: "short" } }, { coin: "BTC/ETH", lastRunAt: new Date() })]);
    stubHyperliquid();
    await runAiTraderTick();
    expect(enqueueTask).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ coin: "ETH", isBuy: false }) }));
    expect(store.createAiRequest).not.toHaveBeenCalled();
    expect(store.touchStrategyRun).toHaveBeenCalledWith("s1", expect.objectContaining({ flips: {} }));
  });

  it("an explicit NOTHING trades nothing", async () => {
    store.getAiRequest.mockResolvedValue(basketRequest());
    store.answerAiRequest.mockImplementation(async () => basketRequest({ status: "answered" }));
    store.getStrategy.mockResolvedValue(aiBot({ coins: ["BTC", "ETH"], openRequestId: "req-1" }, { coin: "BTC/ETH" }));
    stubHyperliquid();

    const body = await (await route("POST /ai/requests/:id/answer")(post({ text: "Nothing stretched. NOTHING" }), agentCtx("a1", { id: "req-1" }))).json();
    expect(body).toMatchObject({ decision: "NOTHING", actions: [] });
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("a live basket without instant trading is refused at creation", async () => {
    store.getInstantTrading.mockResolvedValue(null);
    const resp = await route("POST /strategy")(post({
      wallet: "0xabc", type: "ai", sizeUsd: 25, params: { coins: ["BTC", "ETH"], intervalMs: 3_600_000 },
    }), agentCtx("a1"));
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/instant trading/);
  });

  it("a scan takes the most-traded coins no other bot claims, keeping what it holds", () => {
    const market = ["BTC", "ETH", "SOL", "DOGE", "XRP"].map((coin) => ({ coin }));
    expect(pickBasketCoins({ intervalMs: 1, maxDrawdownPct: 10, scanTop: 3, owned: ["XRP"] }, market, ["XRP", "ETH"], new Set(["BTC"])))
      .toEqual(["XRP", "ETH", "SOL"]);
    expect(pickBasketCoins({ intervalMs: 1, maxDrawdownPct: 10, coins: ["BTC", "GONE"] }, market, [], new Set())).toEqual(["BTC"]);
  });
});

/** BTC/ETH candles where ETH ends `kick` (log) rich — kick 0.025 ≈ z +2.7, 0 ≈ z −0.9. */
function stubPair(kick: number, positions: { coin: string; szi: string; positionValue: string }[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const json = (d: unknown) => new Response(JSON.stringify(d));
    if (body.type === "clearinghouseState") {
      return json({
        marginSummary: { accountValue: "500", totalMarginUsed: "0", totalNtlPos: "0" },
        assetPositions: positions.map((p) => ({ position: { entryPx: "100", unrealizedPnl: "0", ...p } })),
      });
    }
    if (body.type === "spotClearinghouseState") return json({ balances: [] });
    if (body.type === "candleSnapshot") {
      const eth = body.req.coin === "ETH";
      return json(Array.from({ length: 60 }, (_, i) => {
        const b = 100 * Math.exp(0.3 * Math.sin(i / 5));
        const c = String(eth ? 2 * b * Math.exp(0.01 * Math.sin(i * 2.3) + (i === 59 ? kick : 0)) : b);
        return { t: i * 3_600_000, o: c, h: c, l: c, c, v: "1" };
      }));
    }
    throw new Error(`unexpected info call ${body.type}`);
  }));
}

function pairsBot(params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    id: "p1", orgId: "org1", agentId: "a1", wallet: "0xabc", type: "pairs", coin: "ETH/BTC", sizeUsd: 50, enabled: true,
    params: { coins: ["ETH", "BTC"], interval: "1h", lookbackBars: 60, entryZ: 2, exitZ: 0.5, stopZ: 4, maxHoldBars: 72, minCorrelation: 0.6, open: null, ...params },
    lastRunAt: null, createdAt: null, pendingSignal: false, pendingSince: null, pendingContext: null, webhookToken: null, paper: false,
    ...extra,
  };
}

describe("pairs arbitrage bot — rule-based, both legs together", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.getInstantTrading.mockResolvedValue(INSTANT);
    store.getStrategies.mockResolvedValue([]);
  });

  it("opens long the cheap leg and short the rich one when the spread is stretched", async () => {
    store.getEnabledStrategies.mockResolvedValue([pairsBot()]);
    stubPair(0.025);

    expect(await runHyperliquidStrategyTick()).toMatchObject({ executed: 1, errors: 0 });
    expect(enqueueTask).toHaveBeenCalledTimes(2);
    expect(enqueueTask).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ coin: "BTC", isBuy: true }) }));
    expect(enqueueTask).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ coin: "ETH", isBuy: false, sizeUsd: 50 }) }));
    expect(store.touchStrategyRun).toHaveBeenCalledWith("p1", expect.objectContaining({
      open: expect.objectContaining({ a: "ETH", b: "BTC", longLeg: "BTC", shortLeg: "ETH" }),
    }));
    expect(store.recordAiDecision).toHaveBeenCalledWith("p1", expect.objectContaining({ action: "open", error: null }));
  });

  it("closes both legs reduce-only once the spread converges", async () => {
    const open = { a: "ETH", b: "BTC", longLeg: "BTC", shortLeg: "ETH", entryZ: 2.6, beta: 1, openedAt: Date.now() - 3_600_000 };
    store.getEnabledStrategies.mockResolvedValue([pairsBot({ open })]);
    stubPair(0, [{ coin: "BTC", szi: "0.5", positionValue: "50" }, { coin: "ETH", szi: "-0.25", positionValue: "50" }]);

    await runHyperliquidStrategyTick();

    expect(enqueueTask).toHaveBeenCalledTimes(2);
    expect(enqueueTask).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ coin: "BTC", isBuy: false, reduceOnly: true }) }));
    expect(enqueueTask).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ coin: "ETH", isBuy: true, reduceOnly: true }) }));
    expect(store.touchStrategyRun).toHaveBeenCalledWith("p1", expect.objectContaining({ open: null }));
  });

  it("closes a lone leg right away, even between scheduled checks", async () => {
    const open = { a: "ETH", b: "BTC", longLeg: "BTC", shortLeg: "ETH", entryZ: 2.6, beta: 1, openedAt: Date.now() - 600_000 };
    store.getEnabledStrategies.mockResolvedValue([pairsBot({ open }, { lastRunAt: new Date() })]);
    stubPair(0.025, [{ coin: "BTC", szi: "0.5", positionValue: "50" }]); // the ETH short is gone

    await runHyperliquidStrategyTick();

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueueTask).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ coin: "BTC", isBuy: false, reduceOnly: true }) }));
    expect(store.recordAiDecision).toHaveBeenCalledWith("p1", expect.objectContaining({ action: "close", reasoning: expect.stringMatching(/ETH leg is gone/) }));
  });

  it("stays quiet between checks when nothing is wrong", async () => {
    store.getEnabledStrategies.mockResolvedValue([pairsBot({}, { lastRunAt: new Date() })]);
    stubPair(0.025);
    await runHyperliquidStrategyTick();
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(store.touchStrategyRun).not.toHaveBeenCalled();
  });

  it("is created with defaults from a flat agent-tool body, and refused live without instant trading", async () => {
    store.getInstantTrading.mockResolvedValue(null);
    const live = await route("POST /strategy")(post({ wallet: "0xabc", type: "pairs", coins: ["BTC", "ETH"], sizeUsd: 50 }), agentCtx("a1"));
    expect(live.status).toBe(400);
    expect((await live.json()).error).toMatch(/instant trading/);

    const created = await route("POST /strategy")(post({ type: "pairs", coins: "BTC,ETH,SOL", sizeUsd: 50, paper: true }), agentCtx("a1"));
    expect(created.status).toBe(200);
    expect(store.createStrategy).toHaveBeenCalledWith(expect.objectContaining({
      type: "pairs", coin: "BTC/ETH/SOL", paper: true,
      params: expect.objectContaining({ coins: ["BTC", "ETH", "SOL"], entryZ: 2, exitZ: 0.5, stopZ: 4, open: null }),
    }));
  });
});
