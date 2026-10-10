import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Candle } from "../../../../mods/hyperliquid-trading/indicators";

// ── Server wiring for the 1.5 bots: breakout, smart DCA, basis, rule-bot SL/TP
// and direction, live bot-fill logging, the live leaderboard. ──────────────

const store = {
  getEnabledStrategies: vi.fn(async () => [] as unknown[]),
  getStrategy: vi.fn(),
  getStrategies: vi.fn(async () => [] as unknown[]),
  touchStrategyRun: vi.fn(),
  toggleStrategy: vi.fn(),
  markStrategyPending: vi.fn(),
  clearStrategyPending: vi.fn(),
  createStrategy: vi.fn(async () => "s-new"),
  updateStrategy: vi.fn(),
  getInstantTrading: vi.fn(async () => null as unknown),
  getAgentWallet: vi.fn(async () => null),
  getRiskConfig: vi.fn(async () => null as unknown),
  getDailyRealizedPnl: vi.fn(async () => 0),
  recordAiDecision: vi.fn(),
  getPaperAccount: vi.fn(async () => ({ agentId: "a1", orgId: "org1", balance: 10_000, startBalance: 10_000, dailyPnl: 0, spot: {} }) as unknown),
  listPaperPositions: vi.fn(async () => [] as unknown[]),
  listAllPaperPositions: vi.fn(async () => [] as unknown[]),
  listAllPaperOrders: vi.fn(async () => [] as unknown[]),
  createPaperOrder: vi.fn(async () => "order-1"),
  bookPaperFill: vi.fn(async (_a: string, order: { sz: number }) => ({ balance: 9_999, position: null, sz: order.sz, fee: 1, realized: 0, tradeId: "trade-1" }) as unknown),
  bookPaperSpotFill: vi.fn(async (_a: string, order: { sz: number }) => ({ balance: 9_900, sz: order.sz, fee: 0.07, realized: 0, tradeId: "spot-1" }) as unknown),
  listOrgStrategies: vi.fn(async () => [] as unknown[]),
  listOrgPaperAccounts: vi.fn(async () => ({ accounts: [] as unknown[], positions: [] as unknown[] })),
  listOrgPaperFills: vi.fn(async () => [] as unknown[]),
  logBotOrder: vi.fn(),
  listPendingBotOrders: vi.fn(async () => [] as unknown[]),
  settleBotOrder: vi.fn(),
  listOrgBotFills: vi.fn(async () => [] as unknown[]),
};
const enqueueTask = vi.fn(async () => "task-1");
const getTask = vi.fn();
const enforceCapability = vi.fn(async () => ({}));
const getAgentsByOrg = vi.fn(async () => [{ id: "a1", name: "Ada" }] as unknown[]);

vi.mock("@/lib/mods/hyperliquid-store", () => store);
vi.mock("@/lib/agent-wallets", () => ({ listAgentWallets: vi.fn(async () => []), generateAgentWallet: vi.fn(), getAgentWalletEvmPrivateKey: vi.fn(async () => "0xkey") }));
vi.mock("@/lib/gateway/store", () => ({ enqueueTask, getTask, newTaskId: vi.fn(), recordCompletedTask: vi.fn() }));
vi.mock("@/lib/settlement/registry", () => ({ settleOnChains: vi.fn(), hashJobResult: vi.fn() }));
vi.mock("@/lib/secrets", () => ({ encryptValue: vi.fn(), decryptValue: vi.fn() }));
vi.mock("@/lib/firestore-admin", () => ({ enforceCapability, enableModCapabilities: vi.fn(), getAgentCapabilities: vi.fn(async () => []), getAgent: vi.fn(), getAgentsByOrg, getOrganizationsByWalletAdmin: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ requireOrgMembershipByAddress: vi.fn() }));
// The AI-only outlets aren't reached by these bots; keep them off the network.
vi.mock("../../../../mods/hyperliquid-trading/intel-fetch", () => ({ getMarketIntel: vi.fn(), getMarketIntelWithin: vi.fn(async () => null) }));

const { default: mod, runHyperliquidStrategyTick } = await import("../../../../mods/hyperliquid-trading/server");

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

const H = 3_600_000;
let candles: Candle[] = [];

function stubMarket() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const json = (data: unknown) => ({ ok: true, json: async () => data });
    if (body.type === "allMids") return json({ ETH: "2001", "@1": "2000" });
    if (body.type === "meta") return json({ universe: [{ name: "ETH", szDecimals: 4, maxLeverage: 25 }] });
    if (body.type === "metaAndAssetCtxs") {
      return json([
        { universe: [{ name: "ETH", szDecimals: 4, maxLeverage: 25 }] },
        [{ funding: "0.0001", openInterest: "100", prevDayPx: "2000", dayNtlVlm: "1000000000", markPx: "2001", oraclePx: "2000", midPx: "2001" }],
      ]);
    }
    if (body.type === "spotMetaAndAssetCtxs") {
      return json([
        { tokens: [{ index: 0, name: "USDC", szDecimals: 8 }, { index: 1, name: "UETH", szDecimals: 4 }], universe: [{ name: "@1", index: 0, tokens: [1, 0] }] },
        [{ midPx: "2000", markPx: "2000", dayNtlVlm: "5000000" }],
      ]);
    }
    if (body.type === "l2Book") {
      return body.coin === "@1"
        ? json({ levels: [[{ px: "1999.5", sz: "50" }], [{ px: "2000.5", sz: "50" }]] })
        : json({ levels: [[{ px: "2000.9", sz: "50" }], [{ px: "2001.1", sz: "50" }]] });
    }
    if (body.type === "candleSnapshot") return json(candles.map((c) => ({ t: c.t, o: String(c.o), h: String(c.h), l: String(c.l), c: String(c.c), v: String(c.v) })));
    throw new Error(`unexpected ${body.type}`);
  }));
}

const bot = (p: Record<string, unknown>) => ({
  id: "b1", orgId: "org1", agentId: "a1", wallet: "", coin: "ETH", sizeUsd: 50, enabled: true, paper: true,
  pendingSignal: false, pendingSince: null, pendingContext: null, webhookToken: null, lastRunAt: null, createdAt: null,
  ...p,
});

beforeEach(() => {
  vi.clearAllMocks();
  store.getRiskConfig.mockResolvedValue(null);
  store.getInstantTrading.mockResolvedValue(null);
  store.getPaperAccount.mockResolvedValue({ agentId: "a1", orgId: "org1", balance: 10_000, startBalance: 10_000, dailyPnl: 0, spot: {} });
  store.listPaperPositions.mockResolvedValue([]);
  store.listPendingBotOrders.mockResolvedValue([]);
  stubMarket();
});

describe("POST /strategy for the new bots", () => {
  it("stores a breakout bot with defaults filled in, and needs instant trading to run live", async () => {
    const resp = await route("POST /strategy")(post({ type: "breakout", coin: "eth", sizeUsd: 50, paper: true, minAdx: 25 }), agentCtx());
    expect(resp.status).toBe(200);
    const created = (store.createStrategy.mock.calls[0] as unknown[])[0] as unknown as { coin: string; params: Record<string, unknown> };
    expect(created.coin).toBe("ETH");
    expect(created.params).toMatchObject({ interval: "4h", minAdx: 25, bbLength: 20, stopLossPct: 3, takeProfitPct: 6, lastNote: null });

    const live = await route("POST /strategy")(post({ type: "breakout", coin: "ETH", sizeUsd: 50, wallet: "0xw" }), agentCtx());
    expect(live.status).toBe(400);
    expect((await live.json()).error).toMatch(/instant trading/);
  });

  it("basis bots are paper only", async () => {
    const live = await route("POST /strategy")(post({ type: "basis", coin: "ETH", sizeUsd: 50, wallet: "0xw" }), agentCtx());
    expect((await live.json()).error).toMatch(/paper only/);
    const ok = await route("POST /strategy")(post({ type: "basis", coin: "ETH", sizeUsd: 50, paper: true, params: { entryAprPct: 20 } }), agentCtx());
    expect(ok.status).toBe(200);
    expect(((store.createStrategy.mock.calls[0] as unknown[])[0] as unknown as { params: unknown }).params).toMatchObject({ coin: "ETH", entryAprPct: 20, exitAprPct: 3, open: null });
  });

  it("stores direction, SL/TP and a smart block on a DCA bot, and validates them", async () => {
    await route("POST /strategy")(post({
      type: "dca", coin: "ETH", sizeUsd: 20, paper: true,
      params: { intervalMs: H, direction: "short", stopLossPct: 4, smart: { stepPct: 5, multiplier: 2, maxSteps: 3 } },
    }), agentCtx());
    expect(((store.createStrategy.mock.calls[0] as unknown[])[0] as unknown as { params: unknown }).params).toEqual({
      intervalMs: H, direction: "short", stopLossPct: 4, smart: { stepPct: 5, multiplier: 2, maxSteps: 3, takeProfitPct: 8 },
    });
    const bad = await route("POST /strategy")(post({ type: "grid", coin: "ETH", sizeUsd: 20, paper: true, params: { lowerPrice: 1, upperPrice: 2, levels: 3, direction: "up" } }), agentCtx());
    expect(bad.status).toBe(400);
  });

  it("an edit keeps a DCA bot's smart block and direction", async () => {
    store.getStrategy.mockResolvedValue(bot({ type: "dca", params: { intervalMs: H, direction: "short", smart: { stepPct: 5, multiplier: 2, maxSteps: 3 } } }));
    const resp = await route("POST /strategy/:id/edit")(post({ params: { intervalMs: 2 * H } }), agentCtx({ id: "b1" }));
    expect(resp.status).toBe(200);
    const [, patch] = store.updateStrategy.mock.calls[0] as unknown as [string, { params: Record<string, unknown> }];
    expect(patch.params).toMatchObject({ intervalMs: 2 * H, direction: "short", smart: { multiplier: 2 } });
  });
});

describe("strategy tick", () => {
  it("smart DCA buys a bigger step under the average entry", async () => {
    const dca = bot({ type: "dca", params: { intervalMs: H, smart: { stepPct: 5, multiplier: 2, maxSteps: 3 } } });
    store.getEnabledStrategies.mockResolvedValue([dca]);
    store.listPaperPositions.mockResolvedValue([{ coin: "ETH", szi: 0.1, entryPx: 2222, leverage: 1, slPx: null, tpPx: null }]); // mid 2001 ≈ 10% under
    store.getStrategy.mockImplementation(async () => ({ ...dca, pendingSignal: true, pendingContext: (store.markStrategyPending.mock.calls[0] as unknown[])[1] }));
    await runHyperliquidStrategyTick();
    expect(store.markStrategyPending.mock.calls[0][1]).toMatchObject({ sizeUsd: 100, step: 1 });
    const order = store.bookPaperFill.mock.calls[0][1] as unknown as { isBuy: boolean; sz: number };
    expect(order.isBuy).toBe(true);
    expect(order.sz).toBeCloseTo(100 / 2001, 3);
  });

  it("smart DCA banks the whole stack at its take profit", async () => {
    const dca = bot({ type: "dca", lastRunAt: new Date(), params: { intervalMs: H, smart: { stepPct: 5, multiplier: 2, maxSteps: 3, takeProfitPct: 10 } } });
    store.getEnabledStrategies.mockResolvedValue([dca]);
    store.listPaperPositions.mockResolvedValue([{ coin: "ETH", szi: 0.1, entryPx: 1800, leverage: 1, slPx: null, tpPx: null }]);
    store.getStrategy.mockImplementation(async () => ({ ...dca, pendingSignal: true, pendingContext: (store.markStrategyPending.mock.calls[0] as unknown[])[1] }));
    await runHyperliquidStrategyTick();
    expect(store.markStrategyPending.mock.calls[0][1]).toMatchObject({ action: "close", sz: 0.1, isLong: true });
    expect(store.bookPaperFill.mock.calls[0][1]).toMatchObject({ isBuy: false, sz: 0.1, reduceOnly: true });
  });

  it("a live short DCA sends its direction, stop loss and bot id, and logs the order", async () => {
    const dca = bot({ type: "dca", paper: false, params: { intervalMs: H, direction: "short", stopLossPct: 4 } });
    store.getEnabledStrategies.mockResolvedValue([dca]);
    store.getInstantTrading.mockResolvedValue({ walletId: "w1", orgId: "org1", network: "testnet" });
    store.getStrategy.mockResolvedValue({ ...dca, pendingSignal: true, pendingContext: {} });
    await runHyperliquidStrategyTick();
    const task = (enqueueTask.mock.calls[0] as unknown[])[0] as unknown as { payload: Record<string, unknown> };
    expect(task.payload).toMatchObject({ isBuy: false, stopLossPct: 4, strategyId: "b1", sizeUsd: 50 });
    expect(store.logBotOrder).toHaveBeenCalledWith(expect.objectContaining({ strategyId: "b1", taskId: "task-1", isBuy: false }));
  });

  it("settles a logged live bot order from its finished task", async () => {
    store.listPendingBotOrders.mockResolvedValue([{ id: "f1", taskId: "t9", createdAt: new Date() }, { id: "f2", taskId: "t10", createdAt: new Date() }]);
    getTask.mockImplementation(async (id: string) => id === "t9"
      ? { status: "completed", result: { data: { fill: { raw: { avgPx: "2000", totalSz: "0.05" }, realizedPnl: 3.5 } } } }
      : { status: "failed" });
    await runHyperliquidStrategyTick();
    expect(store.settleBotOrder).toHaveBeenCalledWith("f1", { status: "filled", sz: 0.05, px: 2000, fee: 0.05 * 2000 * 0.00045, realizedPnl: 3.5 });
    expect(store.settleBotOrder).toHaveBeenCalledWith("f2", { status: "failed" });
  });

  it("a paper basis bot buys spot and shorts the same size of perp when funding pays", async () => {
    // Funding 0.01%/h ≈ 87.6% APR, over the 15% entry.
    store.getEnabledStrategies.mockResolvedValue([bot({ type: "basis", sizeUsd: 100, params: { coin: "ETH", entryAprPct: 15, exitAprPct: 3, minBasisPct: -0.2, maxHoldHours: 168, open: null } })]);
    await runHyperliquidStrategyTick();
    const spot = store.bookPaperSpotFill.mock.calls[0][1] as unknown as { pair: string; token: string; isBuy: boolean; sz: number };
    expect(spot).toMatchObject({ pair: "@1", token: "UETH", isBuy: true, sz: 0.05 });
    const perp = store.bookPaperFill.mock.calls[0][1] as unknown as { coin: string; isBuy: boolean; sz: number };
    expect(perp).toMatchObject({ coin: "ETH", isBuy: false, sz: 0.05 });
    const saved = store.touchStrategyRun.mock.calls.at(-1)![1] as { open: { spotSz: number } };
    expect(saved.open.spotSz).toBe(0.05);
  });

  it("a paper basis bot unwinds both legs when the perp leg is gone", async () => {
    store.getPaperAccount.mockResolvedValue({ agentId: "a1", orgId: "org1", balance: 9_900, startBalance: 10_000, dailyPnl: 0, spot: { UETH: { pair: "@1", token: "UETH", sz: 0.05, avgPx: 2000 } } });
    const open = { coin: "ETH", openedAt: Date.now() - H, entryBasisPct: 0, entryFundingAprPct: 80, spotSz: 0.05, spotPx: 2000 };
    store.getEnabledStrategies.mockResolvedValue([bot({ type: "basis", params: { coin: "ETH", entryAprPct: 15, exitAprPct: 3, minBasisPct: -0.2, maxHoldHours: 168, open } })]);
    await runHyperliquidStrategyTick();
    expect(store.bookPaperSpotFill.mock.calls[0][1]).toMatchObject({ isBuy: false, sz: 0.05 });
    expect((store.touchStrategyRun.mock.calls.at(-1)![1] as { open: unknown }).open).toBeNull();
  });

  it("a paper breakout bot opens long on a squeeze breakout, with its stop and take profit", async () => {
    const now = Date.now();
    const start = Math.floor(now / H) * H - 170 * H;
    const closes: number[] = [];
    for (let i = 0; i < 140; i++) closes.push(100 * (1 + 0.04 * Math.sin(i / 3)));
    for (let i = 0; i < 20; i++) closes.push(100 * (1 + 0.001 * Math.sin(i)));
    candles = closes.map((c, i) => ({ t: start + i * H, o: c, h: c * (i < 140 ? 1.01 : 1.001), l: c * (i < 140 ? 0.99 : 0.999), c, v: 1 }));
    for (let k = 1; k <= 3; k++) {
      const o = candles[candles.length - 1].c;
      const c = 100 * (1 + 0.03 * (k / 3));
      candles.push({ t: start + (159 + k) * H, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1 });
    }
    store.getEnabledStrategies.mockResolvedValue([bot({
      type: "breakout",
      params: { interval: "1h", bbLength: 20, bbMult: 2, squeezeLookback: 100, squeezeWithin: 8, adxLength: 14, minAdx: 10, allowShort: true, exitOnMid: true, stopLossPct: 3, takeProfitPct: 6 },
    })]);
    await runHyperliquidStrategyTick();
    expect(store.bookPaperFill.mock.calls[0][1]).toMatchObject({ coin: "ETH", isBuy: true, stopLossPct: 3, takeProfitPct: 6 });
    expect(store.recordAiDecision).toHaveBeenCalledWith("b1", expect.objectContaining({ action: "open-long" }));
  });
});

describe("leaderboard", () => {
  it("live mode ranks live bots by their own logged fills", async () => {
    store.listOrgStrategies.mockResolvedValue([
      bot({ id: "p1", type: "dca", paper: true, params: {} }),
      bot({ id: "l1", type: "breakout", paper: false, params: {} }),
    ]);
    store.listOrgBotFills.mockResolvedValue([{ strategyId: "l1", realizedPnl: 10, fee: 1, at: 1 }]);
    const resp = await route("GET /leaderboard/:agentId")(new Request("http://x/?mode=live"), agentCtx({ agentId: "a1" }));
    const data = await resp.json();
    expect(data.mode).toBe("live");
    expect(data.bots.map((b: { id: string }) => b.id)).toEqual(["l1"]);
    expect(data.bots[0].netPnl).toBe(9);
    expect(store.listOrgPaperFills).not.toHaveBeenCalled();
  });
});

describe("scanner", () => {
  it("adds spot-perp basis and book imbalance rows", async () => {
    candles = Array.from({ length: 60 }, (_, i) => ({ t: i * H, o: 100, h: 101, l: 99, c: 100 + Math.sin(i), v: 1 }));
    const data = await (await route("GET /scanner")(new Request("http://x/?network=mainnet&coins=ETH"), agentCtx())).json();
    expect(data.basis[0]).toMatchObject({ coin: "ETH", spotToken: "UETH" });
    expect(data.basis[0].fundingAprPct).toBeCloseTo(87.6);
    expect(data.imbalances[0]).toMatchObject({ coin: "ETH" });
  });
});
