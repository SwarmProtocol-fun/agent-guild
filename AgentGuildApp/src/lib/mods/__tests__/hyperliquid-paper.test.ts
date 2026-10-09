import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyFill,
  bookOrder,
  fundingPayment,
  isLiquidatable,
  restingFillable,
  summarize,
  triggerHit,
  walkBook,
  TAKER_FEE_RATE,
  MAKER_FEE_RATE,
  type PaperPosition,
} from "../../../../mods/hyperliquid-trading/paper";

const META = { ETH: { szDecimals: 4, maxLeverage: 25 }, BTC: { szDecimals: 5, maxLeverage: 40 } };
const pos = (p: Partial<PaperPosition> = {}): PaperPosition => ({ coin: "ETH", szi: 1, entryPx: 2000, leverage: 1, slPx: null, tpPx: null, ...p });

describe("paper engine", () => {
  it("walks the book best-first and stops at the limit, leaving the rest unfilled", () => {
    const asks = [{ px: 2000, sz: 0.5 }, { px: 2001, sz: 0.5 }, { px: 2030, sz: 10 }];
    const fill = walkBook(asks, 1.2, true, 2010, 4);
    expect(fill.sz).toBe(1);
    expect(fill.avgPx).toBeCloseTo(2000.5);
    expect(walkBook(asks, 1, true, 1999, 4).sz).toBe(0);
    const bids = [{ px: 1999, sz: 2 }];
    expect(walkBook(bids, 1, false, 1990, 4)).toMatchObject({ sz: 1, avgPx: 1999 });
  });

  it("adds at a weighted entry, realizes on reduce, and flips past zero at the fill price", () => {
    const added = applyFill(pos(), "ETH", true, 1, 2200, 1, 4);
    expect(added.position).toMatchObject({ szi: 2, entryPx: 2100 });

    const reduced = applyFill(pos({ szi: 2 }), "ETH", false, 0.5, 2100, 1, 4);
    expect(reduced.realized).toBeCloseTo(50);
    expect(reduced.position).toMatchObject({ szi: 1.5, entryPx: 2000 });

    const closed = applyFill(pos({ szi: -1 }), "ETH", true, 1, 1900, 1, 4);
    expect(closed).toEqual({ position: null, realized: 100 });

    const flipped = applyFill(pos({ slPx: 1900 }), "ETH", false, 3, 1800, 2, 4);
    expect(flipped.realized).toBeCloseTo(-200);
    expect(flipped.position).toMatchObject({ szi: -2, entryPx: 1800, slPx: null });
  });

  it("charges the taker fee and refuses an order the account can't margin", () => {
    const ok = bookOrder(10_000, [], { coin: "ETH", isBuy: true, sz: 2, px: 2000, feeRate: TAKER_FEE_RATE, leverage: 1, reduceOnly: false }, { ETH: 2000 }, META);
    expect(ok).toMatchObject({ sz: 2, realized: 0 });
    expect((ok as { fee: number }).fee).toBeCloseTo(4000 * TAKER_FEE_RATE);

    const tooBig = bookOrder(10_000, [], { coin: "ETH", isBuy: true, sz: 6, px: 2000, feeRate: TAKER_FEE_RATE, leverage: 1, reduceOnly: false }, { ETH: 2000 }, META);
    expect(tooBig).toHaveProperty("error");
    expect((tooBig as { error: string }).error).toMatch(/Not enough paper margin/);

    // Same size fits at 2x leverage.
    expect(bookOrder(10_000, [], { coin: "ETH", isBuy: true, sz: 6, px: 2000, feeRate: TAKER_FEE_RATE, leverage: 2, reduceOnly: false }, { ETH: 2000 }, META)).not.toHaveProperty("error");
  });

  it("clamps leverage to the coin's max and sets SL/TP through the entry", () => {
    const booked = bookOrder(10_000, [], {
      coin: "ETH", isBuy: false, sz: 1, px: 2000, feeRate: TAKER_FEE_RATE, leverage: 100, reduceOnly: false, stopLossPct: 5, takeProfitPct: 10,
    }, { ETH: 2000 }, META) as { position: PaperPosition };
    expect(booked.position.leverage).toBe(25);
    expect(booked.position.slPx).toBeCloseTo(2100);
    expect(booked.position.tpPx).toBeCloseTo(1800);
  });

  it("reduce-only clamps to the open size and never opens or adds", () => {
    const held = [pos({ szi: 0.5 })];
    const closed = bookOrder(10_000, held, { coin: "ETH", isBuy: false, sz: 3, px: 2100, feeRate: TAKER_FEE_RATE, leverage: 1, reduceOnly: true }, { ETH: 2100 }, META);
    expect(closed).toMatchObject({ sz: 0.5, position: null, realized: 50 });
    expect(bookOrder(10_000, held, { coin: "ETH", isBuy: true, sz: 1, px: 2100, feeRate: TAKER_FEE_RATE, leverage: 1, reduceOnly: true }, {}, META)).toHaveProperty("error");
    expect(bookOrder(10_000, [], { coin: "ETH", isBuy: false, sz: 1, px: 2100, feeRate: TAKER_FEE_RATE, leverage: 1, reduceOnly: true }, {}, META)).toHaveProperty("error");
  });

  it("marks positions, and liquidates once equity drops under maintenance margin", () => {
    const s = summarize(1000, [pos({ szi: 10, leverage: 20 })], { ETH: 1950 }, META);
    expect(s.unrealizedPnl).toBeCloseTo(-500);
    expect(s.equity).toBeCloseTo(500);
    expect(s.maintenanceMargin).toBeCloseTo(19500 / 50);
    expect(isLiquidatable(s)).toBe(false);
    expect(isLiquidatable(summarize(1000, [pos({ szi: 10, leverage: 20 })], { ETH: 1910 }, META))).toBe(true);
  });

  it("fires stop loss before take profit, resting limits on a cross, and funding by side", () => {
    expect(triggerHit(pos({ slPx: 1900, tpPx: 2200 }), 1890)).toBe("sl");
    expect(triggerHit(pos({ slPx: 1900, tpPx: 2200 }), 2201)).toBe("tp");
    expect(triggerHit(pos({ szi: -1, slPx: 2100, tpPx: 1800 }), 2050)).toBeNull();
    expect(triggerHit(pos({ szi: -1, slPx: 2100, tpPx: 1800 }), 1799)).toBe("tp");
    expect(restingFillable(true, 2000, 1999)).toBe(true);
    expect(restingFillable(true, 2000, 2001)).toBe(false);
    expect(restingFillable(false, 2000, 2001)).toBe(true);
    expect(fundingPayment(1, 2000, 0.0001)).toBeCloseTo(-0.2); // long pays
    expect(fundingPayment(-1, 2000, 0.0001)).toBeCloseTo(0.2); // short receives
  });
});

// ── Server: routes, paper bots, the paper tick ─────────────────────────────

const store = {
  getEnabledStrategies: vi.fn(async () => [] as unknown[]),
  getStrategy: vi.fn(),
  touchStrategyRun: vi.fn(),
  toggleStrategy: vi.fn(),
  markStrategyPending: vi.fn(),
  clearStrategyPending: vi.fn(),
  createStrategy: vi.fn(async () => "s-new"),
  getInstantTrading: vi.fn(async () => null),
  getAgentWallet: vi.fn(async () => null),
  getRiskConfig: vi.fn(async () => null as unknown),
  getDailyRealizedPnl: vi.fn(async () => 0),
  getPaperAccount: vi.fn(async () => ({ agentId: "a1", orgId: "org1", balance: 10_000, startBalance: 10_000, dailyPnl: 0 })),
  resetPaperAccount: vi.fn(),
  listPaperPositions: vi.fn(async () => [] as unknown[]),
  listAllPaperPositions: vi.fn(async () => [] as unknown[]),
  createPaperOrder: vi.fn(async () => "order-1"),
  getPaperOrder: vi.fn(),
  listPaperOrders: vi.fn(async () => []),
  listAllPaperOrders: vi.fn(async () => [] as unknown[]),
  deletePaperOrder: vi.fn(),
  bookPaperFill: vi.fn(async (_agentId: string, order: { sz: number }) => ({ balance: 9999, position: null, sz: order.sz, fee: 1, realized: 0, tradeId: "trade-1" }) as unknown),
  applyPaperFunding: vi.fn(),
  getPaperTradeHistory: vi.fn(),
};
const enqueueTask = vi.fn(async () => "task-1");
const enforceCapability = vi.fn(async () => ({}));

vi.mock("@/lib/mods/hyperliquid-store", () => store);
vi.mock("@/lib/agent-wallets", () => ({ listAgentWallets: vi.fn(async () => []), generateAgentWallet: vi.fn(), getAgentWalletEvmPrivateKey: vi.fn() }));
vi.mock("@/lib/gateway/store", () => ({ enqueueTask, getTask: vi.fn() }));
vi.mock("@/lib/settlement/registry", () => ({ settleOnChains: vi.fn(), hashJobResult: vi.fn() }));
vi.mock("@/lib/secrets", () => ({ encryptValue: vi.fn(), decryptValue: vi.fn() }));
vi.mock("@/lib/firestore-admin", () => ({ enforceCapability, getAgentCapabilities: vi.fn(async () => []), getAgent: vi.fn(), getAgentsByOrg: vi.fn(), getOrganizationsByWalletAdmin: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ requireOrgMembershipByAddress: vi.fn() }));

const { default: mod, runHyperliquidStrategyTick, runHyperliquidPaperTick } = await import("../../../../mods/hyperliquid-trading/server");

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

const infoCalls: { url: string; type: string }[] = [];
function stubMarket() {
  infoCalls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    infoCalls.push({ url, type: body.type });
    const json = (data: unknown) => ({ ok: true, json: async () => data });
    if (body.type === "allMids") return json({ ETH: "2000" });
    if (body.type === "meta") return json({ universe: [{ name: "ETH", szDecimals: 4, maxLeverage: 25 }] });
    if (body.type === "l2Book") return json({ levels: [[{ px: "1999.9", sz: "50" }], [{ px: "2000.1", sz: "0.01" }, { px: "2001", sz: "50" }]] });
    if (body.type === "metaAndAssetCtxs") {
      return json([{ universe: [{ name: "ETH", szDecimals: 4, maxLeverage: 25 }] }, [{ funding: "0.0001", oraclePx: "1890", markPx: "1890", midPx: "1890" }]]);
    }
    throw new Error(`unexpected ${body.type}`);
  }));
}

describe("paper trading routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.getRiskConfig.mockResolvedValue(null);
    store.getPaperAccount.mockResolvedValue({ agentId: "a1", orgId: "org1", balance: 10_000, startBalance: 10_000, dailyPnl: 0 });
    stubMarket();
  });

  it("fills a market order against the real mainnet book at the taker fee — no wallet or passphrase", async () => {
    const resp = await route("POST /paper/trade")(post({ coin: "ETH", isBuy: true, sizeUsd: 100 }), agentCtx());
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data).toMatchObject({ paper: true, taskId: "trade-1", resting: null });
    expect(infoCalls.every((c) => c.url === "https://api.hyperliquid.xyz/info")).toBe(true);

    const [, order, , , fillCtx] = store.bookPaperFill.mock.calls[0] as unknown as [string, { sz: number; px: number; feeRate: number }, unknown, unknown, { reason: string }];
    expect(order.sz).toBe(0.05); // $100 / $2000 mid
    expect(order.px).toBeGreaterThan(2000.1); // walked past the thin top level
    expect(order.feeRate).toBe(TAKER_FEE_RATE);
    expect(fillCtx.reason).toBe("manual");
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(enforceCapability).toHaveBeenCalledWith("a1", "org1", "hyperliquid-trade");
  });

  it("rests a limit order that isn't marketable yet", async () => {
    const resp = await route("POST /paper/trade")(post({ coin: "ETH", isBuy: true, sizeUsd: 100, orderType: "limit", limitPrice: 1900 }), agentCtx());
    const data = await resp.json();
    expect(store.bookPaperFill).not.toHaveBeenCalled();
    expect(data.resting).toEqual({ orderId: "order-1", sz: 0.05, limitPx: 1900 }); // sized from the mid, like live
    expect(store.createPaperOrder).toHaveBeenCalledWith(expect.objectContaining({ coin: "ETH", isBuy: true, limitPx: 1900 }));
  });

  it("holds paper to the same risk limits as live, using the paper daily PnL", async () => {
    store.getRiskConfig.mockResolvedValue({ leverage: 3, maxPositionUsd: 50, maxDailyLossUsd: 20 });
    const tooBig = await route("POST /paper/trade")(post({ coin: "ETH", isBuy: true, sizeUsd: 100 }), agentCtx());
    expect(tooBig.status).toBe(400);
    expect((await tooBig.json()).error).toMatch(/maxPositionUsd/);

    store.getPaperAccount.mockResolvedValue({ agentId: "a1", orgId: "org1", balance: 9970, startBalance: 10_000, dailyPnl: -25 });
    const lossy = await route("POST /paper/trade")(post({ coin: "ETH", isBuy: true, sizeUsd: 25 }), agentCtx());
    expect((await lossy.json()).error).toMatch(/Daily loss limit/);
    expect(store.bookPaperFill).not.toHaveBeenCalled();
  });

  it("refuses an order under Hyperliquid's $10 minimum", async () => {
    const resp = await route("POST /paper/trade")(post({ coin: "ETH", isBuy: true, sizeUsd: 5 }), agentCtx());
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/minimum/);
  });

  it("closes exactly the open size, reduce-only", async () => {
    store.listPaperPositions.mockResolvedValue([{ coin: "ETH", szi: -0.1234, entryPx: 2100 }]);
    const resp = await route("POST /paper/close")(post({ coin: "ETH" }), agentCtx());
    expect(resp.status).toBe(200);
    const [, order] = store.bookPaperFill.mock.calls[0] as unknown as [string, { isBuy: boolean; sz: number; reduceOnly: boolean }];
    expect(order).toMatchObject({ isBuy: true, sz: 0.1234, reduceOnly: true });
  });

  it("a paper bot needs no wallet to create, and the tick trades it without instant trading", async () => {
    const created = await route("POST /strategy")(post({ type: "dca", coin: "ETH", sizeUsd: 25, params: { intervalMs: 60_000 }, paper: true }), agentCtx());
    expect(created.status).toBe(200);
    expect(store.createStrategy).toHaveBeenCalledWith(expect.objectContaining({ paper: true, wallet: "" }));

    const bot = {
      id: "s1", orgId: "org1", agentId: "a1", wallet: "", type: "dca", coin: "ETH", sizeUsd: 25, enabled: true, paper: true,
      params: { intervalMs: 60_000 }, lastRunAt: null, createdAt: null, pendingSignal: false, pendingSince: null, pendingContext: null, webhookToken: null,
    };
    store.getEnabledStrategies.mockResolvedValue([bot]);
    store.getStrategy.mockResolvedValue({ ...bot, pendingSignal: true, pendingContext: {} });
    const result = await runHyperliquidStrategyTick();
    expect(result.executed).toBe(1);
    expect(store.bookPaperFill).toHaveBeenCalledWith("a1", expect.objectContaining({ coin: "ETH", isBuy: true }), expect.anything(), expect.anything(), expect.objectContaining({ reason: "strategy", strategyId: "s1" }));
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(store.clearStrategyPending).toHaveBeenCalledWith("s1");
  });

  it("the paper tick fills crossed limits as a maker and fires stop losses at the mark", async () => {
    store.listAllPaperOrders.mockResolvedValue([
      { id: "o1", agentId: "a1", orgId: "org1", coin: "ETH", isBuy: true, sz: 0.1, limitPx: 1900, leverage: 1, reduceOnly: false, stopLossPct: null, takeProfitPct: null, strategyId: null },
      { id: "o2", agentId: "a1", orgId: "org1", coin: "ETH", isBuy: true, sz: 0.1, limitPx: 1800, leverage: 1, reduceOnly: false, stopLossPct: null, takeProfitPct: null, strategyId: null },
    ]);
    const held = { id: "a2_ETH", agentId: "a2", orgId: "org1", coin: "ETH", szi: 1, entryPx: 2000, leverage: 1, slPx: 1900, tpPx: null, fundingPaid: 0, lastFundingAt: new Date() };
    store.listAllPaperPositions.mockResolvedValue([held]);

    const result = await runHyperliquidPaperTick();
    expect(result).toMatchObject({ filled: 1, triggered: 1, errors: 0 });
    const calls = store.bookPaperFill.mock.calls as unknown as [string, { px: number; feeRate: number; reduceOnly: boolean }, unknown, unknown, { reason: string; restingOrderId?: string }][];
    expect(calls[0][1]).toMatchObject({ px: 1900, feeRate: MAKER_FEE_RATE });
    expect(calls[0][4]).toMatchObject({ reason: "limit", restingOrderId: "o1" });
    expect(calls.find((c) => c[4].reason === "sl")?.[1]).toMatchObject({ px: 1890, reduceOnly: true });
  });

  it("the paper tick charges an hour of funding to a long", async () => {
    store.listAllPaperOrders.mockResolvedValue([]);
    const since = new Date(Date.now() - 61 * 60_000);
    store.listAllPaperPositions.mockResolvedValue([
      { id: "a1_ETH", agentId: "a1", orgId: "org1", coin: "ETH", szi: 2, entryPx: 1890, leverage: 1, slPx: null, tpPx: null, fundingPaid: 0, lastFundingAt: since },
    ]);
    const result = await runHyperliquidPaperTick();
    expect(result.funded).toBe(1);
    const [agentId, coin, amount] = store.applyPaperFunding.mock.calls[0] as unknown as [string, string, number];
    expect([agentId, coin]).toEqual(["a1", "ETH"]);
    expect(amount).toBeCloseTo(-2 * 1890 * 0.0001);
  });

  it("lists paper tools in the agent manifest", async () => {
    const data = await (await route("GET /agent/tools")(new Request("http://x/"), agentCtx())).json();
    const names = data.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["hyperliquid_paper_account", "hyperliquid_paper_trade", "hyperliquid_paper_close", "hyperliquid_paper_cancel"]));
  });
});
