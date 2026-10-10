import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyFill,
  bookOrder,
  fundingPayment,
  isLiquidatable,
  paperPerformance,
  ratchetTrail,
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
  it("a trailing stop starts at the trail distance and only ratchets in the position's favor", () => {
    const booked = bookOrder(10_000, [], { coin: "ETH", isBuy: true, sz: 1, px: 2000, feeRate: 0, leverage: 1, reduceOnly: false, stopLossPct: 10, trailingStopPct: 2 }, { ETH: 2000 }, META);
    if ("error" in booked) throw new Error(booked.error);
    expect(booked.position).toMatchObject({ slPx: 1960, trailPct: 2 }); // trail replaces the 10% stop

    const long = booked.position!;
    expect(ratchetTrail(long, 2100)).toBeCloseTo(2058);
    expect(ratchetTrail({ ...long, slPx: 2058 }, 2050)).toBeNull(); // never loosens
    expect(ratchetTrail({ ...long, slPx: 2058 }, 2101)).toBeCloseTo(2058.98);
    expect(triggerHit({ ...long, slPx: 2058 }, 2057)).toBe("sl");

    const short = pos({ szi: -1, slPx: 2040, trailPct: 2 });
    expect(ratchetTrail(short, 1900)).toBeCloseTo(1938);
    expect(ratchetTrail(short, 2010)).toBeNull();
    expect(ratchetTrail(pos({ slPx: 1900 }), 2500)).toBeNull(); // a plain stop doesn't move
  });

  it("a flip or a fresh position drops the trail", () => {
    const flipped = applyFill(pos({ slPx: 1960, trailPct: 2 }), "ETH", false, 2, 2000, 1, 4);
    expect(flipped.position).toMatchObject({ szi: -1, slPx: null, trailPct: null });
  });

  it("scores a run of fills: win rate, profit factor, expectancy and drawdown, net of fees", () => {
    const perf = paperPerformance([
      { realizedPnl: 0, fee: 1, at: 1 },     // open
      { realizedPnl: 101, fee: 1, at: 2 },   // +100 net
      { realizedPnl: 0, fee: 1, at: 3 },     // open
      { realizedPnl: -49, fee: 1, at: 4 },   // −50 net
      { realizedPnl: 0, fee: 1, at: 5 },
      { realizedPnl: 26, fee: 1, at: 6 },    // +25 net
    ], 1000);
    expect(perf).toMatchObject({ closed: 3, wins: 2, losses: 1, fees: 6, largestWin: 100, largestLoss: -50 });
    expect(perf.winRate).toBeCloseTo(2 / 3);
    expect(perf.netPnl).toBeCloseTo(72); // 101 − 49 + 26 − 6 fees
    expect(perf.profitFactor).toBeCloseTo(125 / 50);
    expect(perf.expectancy).toBeCloseTo(75 / 3);
    expect(perf.curve[0].equity).toBe(1000);
    expect(perf.curve.at(-1)!.equity).toBeCloseTo(1072);
    expect(perf.maxDrawdownPct).toBeCloseTo((52 / 1099) * 100); // 1099 peak → 1047 after the next open fee
  });

  it("scores order-independently and handles no losses", () => {
    const perf = paperPerformance([{ realizedPnl: 10, fee: 0, at: 2 }, { realizedPnl: 0, fee: 0, at: 1 }], 100);
    expect(perf.profitFactor).toBeNull();
    expect(perf.curve.map((p) => p.t)).toEqual([1, 1, 2]);
    expect(paperPerformance([], 100)).toMatchObject({ closed: 0, winRate: 0, netPnl: 0, maxDrawdownPct: 0 });
  });

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
  getStrategies: vi.fn(async () => [] as unknown[]),
  getInstantTrading: vi.fn(async () => null),
  getAgentWallet: vi.fn(async () => null),
  getRiskConfig: vi.fn(async () => null as unknown),
  getDailyRealizedPnl: vi.fn(async () => 0),
  getPaperAccount: vi.fn(async () => ({ agentId: "a1", orgId: "org1", balance: 10_000, startBalance: 10_000, dailyPnl: 0 }) as { agentId: string; orgId: string; balance: number; startBalance: number; dailyPnl: number; resetAt?: Date | null }),
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
  updatePaperTrailingStop: vi.fn(),
  getPaperTradeHistory: vi.fn(),
  listOrgStrategies: vi.fn(async () => [] as unknown[]),
  listOrgPaperAccounts: vi.fn(async () => ({ accounts: [] as unknown[], positions: [] as unknown[] })),
  listOrgPaperFills: vi.fn(async () => [] as unknown[]),
  updateStrategy: vi.fn(),
  deleteStrategy: vi.fn(),
  stopStrategies: vi.fn(),
  expireAiRequest: vi.fn(async () => {}),
};
const enqueueTask = vi.fn(async () => "task-1");
const enforceCapability = vi.fn(async () => ({}));

vi.mock("@/lib/mods/hyperliquid-store", () => store);
vi.mock("@/lib/agent-wallets", () => ({ listAgentWallets: vi.fn(async () => []), generateAgentWallet: vi.fn(), getAgentWalletEvmPrivateKey: vi.fn() }));
vi.mock("@/lib/gateway/store", () => ({ enqueueTask, getTask: vi.fn() }));
vi.mock("@/lib/settlement/registry", () => ({ settleOnChains: vi.fn(), hashJobResult: vi.fn() }));
vi.mock("@/lib/secrets", () => ({ encryptValue: vi.fn(), decryptValue: vi.fn() }));
const getAgentsByOrg = vi.fn(async () => [] as unknown[]);
vi.mock("@/lib/firestore-admin", () => ({ enforceCapability, getAgentCapabilities: vi.fn(async () => []), getAgent: vi.fn(), getAgentsByOrg, getOrganizationsByWalletAdmin: vi.fn() }));
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

  it("passes a trailing stop through to the fill and refuses an out-of-range one", async () => {
    const resp = await route("POST /paper/trade")(post({ coin: "ETH", isBuy: true, sizeUsd: 100, trailingStopPct: 3 }), agentCtx());
    expect(resp.status).toBe(200);
    expect(store.bookPaperFill.mock.calls[0][1]).toMatchObject({ trailingStopPct: 3 });

    const bad = await route("POST /paper/trade")(post({ coin: "ETH", isBuy: true, sizeUsd: 100, trailingStopPct: 80 }), agentCtx());
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/trailingStopPct/);
  });

  it("the paper tick ratchets a trailing stop behind the mark without firing it", async () => {
    store.listAllPaperOrders.mockResolvedValue([]);
    store.listAllPaperPositions.mockResolvedValue([
      { id: "a1_ETH", agentId: "a1", orgId: "org1", coin: "ETH", szi: -1, entryPx: 2000, leverage: 1, slPx: 2040, tpPx: null, trailPct: 2, fundingPaid: 0, lastFundingAt: new Date() },
    ]);
    const result = await runHyperliquidPaperTick(); // mark 1890
    expect(result).toMatchObject({ trailed: 1, triggered: 0 });
    const [agentId, coin, slPx] = store.updatePaperTrailingStop.mock.calls[0] as unknown as [string, string, number];
    expect([agentId, coin]).toEqual(["a1", "ETH"]);
    expect(slPx).toBeCloseTo(1927.8);
  });

  it("history reports performance since the account's last reset", async () => {
    const resetAt = new Date("2026-10-01T00:00:00Z");
    store.getPaperAccount.mockResolvedValue({ agentId: "a1", orgId: "org1", balance: 5000, startBalance: 5000, dailyPnl: 0, resetAt });
    store.getPaperTradeHistory.mockResolvedValue({ trades: [], stats: {}, performance: {} });
    const resp = await route("GET /paper/history/:agentId")(new Request("http://x/"), { ...agentCtx({ agentId: "a1" }) });
    expect(resp.status).toBe(200);
    expect(store.getPaperTradeHistory).toHaveBeenCalledWith("a1", undefined, { since: resetAt, startBalance: 5000 });
  });

  it("ranks the org's paper bots and accounts, skipping live bots", async () => {
    store.listOrgStrategies.mockResolvedValue([
      { id: "s1", agentId: "a1", orgId: "org1", type: "ai", coin: "ETH", sizeUsd: 50, enabled: true, paper: true, params: { goal: "Trend follow ETH on the hourly", eliminated: false } },
      { id: "s2", agentId: "a2", orgId: "org1", type: "dca", coin: "BTC", sizeUsd: 25, enabled: true, paper: true, params: {} },
      { id: "live", agentId: "a1", orgId: "org1", type: "dca", coin: "ETH", sizeUsd: 25, enabled: true, paper: false, params: {} },
    ]);
    store.listOrgPaperFills.mockResolvedValue([
      { strategyId: "s2", realizedPnl: 10, fee: 0, at: 1 },
      { strategyId: "s1", realizedPnl: -5, fee: 0, at: 2 },
    ]);
    store.listOrgPaperAccounts.mockResolvedValue({
      accounts: [{ agentId: "a1", orgId: "org1", balance: 10_000, startBalance: 10_000, dailyPnl: 0 }],
      positions: [{ agentId: "a1", coin: "ETH", szi: 1, entryPx: 1900, leverage: 1, slPx: null, tpPx: null }],
    });
    getAgentsByOrg.mockResolvedValue([{ id: "a1", name: "Scout" }, { id: "a2", name: "Bishop" }]);

    const resp = await route("GET /leaderboard/:agentId")(new Request("http://x/"), agentCtx({ agentId: "a1" }));
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.bots.map((b: { id: string }) => b.id)).toEqual(["s2", "s1"]);
    expect(data.bots[0]).toMatchObject({ agentName: "Bishop", returnOnSizePct: 40, rank: 1 });
    expect(data.bots[1]).toMatchObject({ goal: "Trend follow ETH on the hourly", status: "running" });
    expect(data.accounts[0]).toMatchObject({ agentName: "Scout", equity: 10_100, openPositions: 1 }); // marked at the 2000 mid
    expect(store.listOrgStrategies).toHaveBeenCalledWith("org1");

    const other = await route("GET /leaderboard/:agentId")(new Request("http://x/"), agentCtx({ agentId: "someone-else" }));
    expect(other.status).toBe(403);
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

  it("starts paper training from a goal and refuses a second trainer on the same coin", async () => {
    const goal = "Fade ETH when hourly funding is extreme. Stay flat otherwise.";
    store.getStrategy.mockResolvedValueOnce(null);
    const resp = await route("POST /paper/train")(post({ coin: "eth", goal, sizeUsd: 25 }), agentCtx());
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data).toMatchObject({ id: "s-new", paper: true, coin: "ETH", goal, sizeUsd: 25, firstRound: "waiting" });
    expect(store.createStrategy).toHaveBeenCalledWith(expect.objectContaining({
      type: "ai", coin: "ETH", paper: true, wallet: "", sizeUsd: 25,
      params: expect.objectContaining({ goal, intervalMs: 60_000, maxDrawdownPct: 10 }),
    }));
    expect(enforceCapability).toHaveBeenCalledWith("a1", "org1", "hyperliquid-run-strategy");
    expect(enqueueTask).not.toHaveBeenCalled();

    store.getStrategies.mockResolvedValueOnce([
      { id: "s-new", enabled: true, paper: true, type: "ai", coin: "ETH" },
    ]);
    const again = await route("POST /paper/train")(post({ coin: "ETH", goal }), agentCtx());
    expect(again.status).toBe(409);

    const short = await route("POST /paper/train")(post({ coin: "BTC", goal: "buy" }), agentCtx());
    expect(short.status).toBe(400);
    const tooFast = await route("POST /paper/train")(post({ coin: "BTC", goal, intervalMs: 30_000 }), agentCtx());
    expect(tooFast.status).toBe(400);
  });

  it("lists paper tools in the agent manifest", async () => {
    const data = await (await route("GET /agent/tools")(new Request("http://x/"), agentCtx())).json();
    const names = data.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["hyperliquid_paper_account", "hyperliquid_paper_trade", "hyperliquid_paper_close", "hyperliquid_paper_cancel", "hyperliquid_paper_train"]));
  });
});

describe("bot management: edit, delete, emergency stop", () => {
  const aiBot = (p: Record<string, unknown> = {}) => ({
    id: "s1", orgId: "org1", agentId: "a1", wallet: "", type: "ai", coin: "ETH", sizeUsd: 25, enabled: true, paper: true,
    pendingSignal: false, webhookToken: null,
    params: { intervalMs: 3_600_000, maxDrawdownPct: 10, goal: "Trend follow ETH hourly", openRequestId: "req-9", startEquity: 9_800 },
    ...p,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    store.getRiskConfig.mockResolvedValue(null);
    stubMarket();
  });

  it("edits settings and size, keeping the bot's runtime state", async () => {
    store.getStrategy.mockResolvedValue(aiBot());
    const resp = await route("POST /strategy/:id/edit")(post({ sizeUsd: 40, params: { maxDrawdownPct: 20, intervalMs: 7_200_000 } }), agentCtx({ id: "s1" }));
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.changed.sort()).toEqual(["intervalMs", "maxDrawdownPct", "sizeUsd"]);
    const [id, patch] = store.updateStrategy.mock.calls[0] as unknown as [string, { sizeUsd: number; params: Record<string, unknown> }];
    expect(id).toBe("s1");
    expect(patch.sizeUsd).toBe(40);
    expect(patch.params).toMatchObject({ maxDrawdownPct: 20, intervalMs: 7_200_000, goal: "Trend follow ETH hourly", openRequestId: "req-9", startEquity: 9_800 });
  });

  it("re-validates an edit like a new bot, and refuses identity changes", async () => {
    store.getStrategy.mockResolvedValue(aiBot());
    const tooFast = await route("POST /strategy/:id/edit")(post({ params: { intervalMs: 1000 } }), agentCtx({ id: "s1" }));
    expect(tooFast.status).toBe(400);
    const coin = await route("POST /strategy/:id/edit")(post({ coin: "BTC" }), agentCtx({ id: "s1" }));
    expect((await coin.json()).error).toMatch(/delete it and create/);
    const small = await route("POST /strategy/:id/edit")(post({ sizeUsd: 5 }), agentCtx({ id: "s1" }));
    expect(small.status).toBe(400);

    store.getStrategy.mockResolvedValue({ ...aiBot(), type: "grid", coin: "ETH", params: { lowerPrice: 1800, upperPrice: 2200, levels: 5, visitedLevels: [1, 2] } });
    const inverted = await route("POST /strategy/:id/edit")(post({ params: { lowerPrice: 2500 } }), agentCtx({ id: "s1" }));
    expect(inverted.status).toBe(400);
    const moved = await route("POST /strategy/:id/edit")(post({ params: { levels: 8 } }), agentCtx({ id: "s1" }));
    expect(moved.status).toBe(200);
    const [, patch] = store.updateStrategy.mock.calls[0] as unknown as [string, { params: Record<string, unknown> }];
    expect(patch.params).toEqual({ lowerPrice: 1800, upperPrice: 2200, levels: 8 }); // new levels, old visited set dropped
    expect(store.updateStrategy).toHaveBeenCalledTimes(1);
  });

  it("an agent can't edit or delete another agent's bot", async () => {
    store.getStrategy.mockResolvedValue(aiBot({ agentId: "a2" }));
    expect((await route("POST /strategy/:id/edit")(post({ sizeUsd: 30 }), agentCtx({ id: "s1" }))).status).toBe(403);
    expect((await route("POST /strategy/:id/delete")(post({}), agentCtx({ id: "s1" }))).status).toBe(403);
    expect(store.deleteStrategy).not.toHaveBeenCalled();
  });

  it("deletes a bot after stopping it, expires its open AI round, and lists positions it left", async () => {
    store.getStrategy.mockResolvedValue(aiBot());
    store.listPaperPositions.mockResolvedValue([{ coin: "ETH", szi: 0.01 }, { coin: "BTC", szi: 0.001 }]);
    const resp = await route("POST /strategy/:id/delete")(post({}), agentCtx({ id: "s1" }));
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(store.toggleStrategy).toHaveBeenCalledWith("s1", false);
    expect(store.expireAiRequest).toHaveBeenCalledWith("req-9");
    expect(store.deleteStrategy).toHaveBeenCalledWith("s1");
    expect(data.leftOpen).toEqual([{ coin: "ETH", szi: 0.01 }]); // BTC isn't this bot's coin
  });

  it("emergency stop turns off every running or pending bot and cancels AI rounds, leaving positions by default", async () => {
    store.getStrategies.mockResolvedValue([
      aiBot(),
      { ...aiBot({ id: "s2", type: "dca", coin: "BTC", params: { intervalMs: 60_000 } }), enabled: false, pendingSignal: true },
      aiBot({ id: "s3", enabled: false, params: {} }),
      aiBot({ id: "other-org", orgId: "org2" }),
    ]);
    const resp = await route("POST /strategy/stop-all")(post({}), agentCtx());
    const data = await resp.json();
    expect(data.scope).toBe("agent");
    expect(store.stopStrategies).toHaveBeenCalledWith(["s1", "s2"]);
    expect(store.expireAiRequest).toHaveBeenCalledWith("req-9");
    expect(data.closed).toEqual([]);
    expect(store.bookPaperFill).not.toHaveBeenCalled();
  });

  it("emergency stop with closePositions flattens the stopped bots' paper coins only", async () => {
    store.getStrategies.mockResolvedValue([aiBot()]);
    store.listPaperPositions.mockResolvedValue([
      { coin: "ETH", szi: -0.02, entryPx: 2000, leverage: 1 },
      { coin: "BTC", szi: 0.001, entryPx: 80_000, leverage: 1 },
    ]);
    store.listPaperOrders.mockResolvedValue([{ id: "o-eth", coin: "ETH" }, { id: "o-btc", coin: "BTC" }] as never);
    const data = await (await route("POST /strategy/stop-all")(post({ closePositions: true }), agentCtx())).json();
    expect(data.closed).toEqual([{ agentId: "a1", coin: "ETH", paper: true, taskId: "trade-1" }]);
    expect(store.bookPaperFill).toHaveBeenCalledTimes(1);
    expect(store.bookPaperFill.mock.calls[0][1]).toMatchObject({ coin: "ETH", isBuy: true, sz: 0.02, reduceOnly: true });
    expect(store.deletePaperOrder).toHaveBeenCalledWith("o-eth");
    expect(store.deletePaperOrder).not.toHaveBeenCalledWith("o-btc");
  });

  it("a stopped signal bot ignores fires", async () => {
    store.getStrategy.mockResolvedValue({ ...aiBot({ type: "signal", params: {} }), enabled: false });
    const resp = await route("POST /strategy/:id/signal")(post({}), agentCtx({ id: "s1" }));
    expect(resp.status).toBe(409);
    expect(store.bookPaperFill).not.toHaveBeenCalled();
  });

  it("lists the bot management tools as POST, which agent runtimes can send", async () => {
    const data = await (await route("GET /agent/tools")(new Request("http://x/"), agentCtx())).json();
    const tools = (data.tools as { name: string; method: string; path: string }[]).filter((t) => /edit_bot|delete_bot|stop_all/.test(t.name));
    expect(tools.map((t) => [t.name, t.method, t.path])).toEqual([
      ["hyperliquid_edit_bot", "POST", "strategy/{id}/edit"],
      ["hyperliquid_delete_bot", "POST", "strategy/{id}/delete"],
      ["hyperliquid_stop_all_bots", "POST", "strategy/stop-all"],
    ]);
  });
});
