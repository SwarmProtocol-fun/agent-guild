import { describe, it, expect, vi, beforeEach } from "vitest";

// The tick, end to end, with Polymarket / Hyperliquid / OKX / Firestore mocked.
// Times are real BTC window boundaries so the rules' clocks line up.

const T15 = 1_800_000_000_000 - (1_800_000_000_000 % 900_000); // a 15-minute window start
const W5 = T15 + 600_000; // the 5m window sharing its close

const paperAccount = () => ({
  agentId: "a1", orgId: "org1", mode: "paper", paperCash: 1000, paperStartCash: 1000, live: null,
  risk: { maxOrderUsd: 25, maxExposureUsd: 100, maxDailyLossUsd: 50 },
});
const ZERO = { entries: 0, wins: 0, losses: 0, realizedPnl: 0, volumeUsd: 0 };
const makeBot = (type: string, over: Record<string, unknown> = {}) => ({
  id: "b1", agentId: "a1", orgId: "org1", type, enabled: true, sizeUsd: 10, market: null, params: {},
  maxLossUsd: null, stats: { paper: { ...ZERO }, live: { ...ZERO } }, state: {}, lastRunAt: null, createdAt: null, ...over,
});

const store = {
  ensureAccount: vi.fn(async () => paperAccount()),
  getAccount: vi.fn(async () => paperAccount()),
  updateAccount: vi.fn(), resetPaper: vi.fn(), addPaperFunds: vi.fn(),
  listPaperPositions: vi.fn(async () => []),
  getPaperPosition: vi.fn(async () => null as unknown),
  listAllOpenPaperPositions: vi.fn(async () => []),
  applyPaperFill: vi.fn(async () => ({ realized: 0, cash: 990 })),
  settlePaperPosition: vi.fn(),
  recordTrade: vi.fn(), listTrades: vi.fn(async () => []), getDailyRealizedPnl: vi.fn(async () => 0),
  createBot: vi.fn(), getBot: vi.fn(), listBots: vi.fn(async () => []),
  listEnabledBots: vi.fn(async () => [] as unknown[]),
  updateBot: vi.fn(), deleteBot: vi.fn(), addBotLog: vi.fn(), listBotLog: vi.fn(async () => []),
  createAiRequest: vi.fn(), getAiRequest: vi.fn(), listOpenAiRequests: vi.fn(async () => []), answerAiRequest: vi.fn(), expireAiRequest: vi.fn(),
  createPaperOrder: vi.fn(async (d: Record<string, unknown>) => ({ ...d, id: `o-${String(d.tag)}`, filledShares: 0, status: "open", cancelReason: null })),
  listOpenPaperOrders: vi.fn(async () => [] as unknown[]),
  listAgentPaperOrders: vi.fn(async () => [] as unknown[]),
  updatePaperOrder: vi.fn(),
  applyRestingFill: vi.fn(),
  getWhaleUniverse: vi.fn(async () => ({ addresses: [] as string[], refreshedAt: 0 })),
  setWhaleUniverse: vi.fn(),
  acquireTickLock: vi.fn(async () => true),
  releaseTickLock: vi.fn(async () => {}),
  PaperError: class PaperError extends Error {},
  PAPER_START_CASH: 1000,
};

const mkMarket = (id: string, slug: string, priceToBeat: number) => ({
  id, conditionId: id, slug, question: `BTC ${slug}`, eventSlug: slug, eventTitle: null, groupItemTitle: null, description: "", endDate: "2099-01-01T00:00:00Z", image: null,
  outcomes: [{ name: "Up", tokenId: `${id}-up`, price: 0.5 }, { name: "Down", tokenId: `${id}-down`, price: 0.5 }],
  bestBid: 0.5, bestAsk: 0.5, lastTradePrice: 0.5, volume24hr: 0, liquidity: 0, tickSize: 0.01, minOrderSize: 5,
  negRisk: false, acceptingOrders: true, closed: false, fee: null, winnerIndex: null, priceToBeat,
});
const book = (bid: number | null, ask: number | null) => ({
  bids: bid == null ? [] : [{ price: bid, size: 1000 }], asks: ask == null ? [] : [{ price: ask, size: 1000 }], tickSize: 0.01, minOrderSize: 5, negRisk: false,
});

const env = {
  m5: mkMarket("c5", `btc-updown-5m-${W5 / 1000}`, 100_000),
  m15: mkMarket("c15", `btc-updown-15m-${T15 / 1000}`, 100_000),
  books: {} as Record<string, ReturnType<typeof book>>,
  spot: 100_000,
  bars: [] as { t: number; o: number; h: number; l: number; c: number; v?: number }[],
};

vi.mock("@/lib/mods/polymarket-store", () => store);
vi.mock("@/lib/agent-wallets", () => ({ listAgentWallets: vi.fn(async () => []), generateAgentWallet: vi.fn(), getAgentWalletEvmPrivateKey: vi.fn() }));
vi.mock("@/lib/firestore-admin", () => ({
  enforceCapability: vi.fn(async () => ({})), getAgentCapabilities: vi.fn(async () => []), getAgent: vi.fn(async () => ({ orgId: "org1" })),
  getAgentsByOrg: vi.fn(), getOrganizationsByWalletAdmin: vi.fn(), getModInstallStatus: vi.fn(), enableModCapabilities: vi.fn(), postAgentDmMessage: vi.fn(),
}));
vi.mock("@/lib/auth-guard", () => ({ requireOrgMembershipByAddress: vi.fn(async () => ({ ok: true, org: { ownerAddress: "0x0" } })) }));
vi.mock("../../../../mods/polymarket-trading/live", () => ({
  checkGeoblock: vi.fn(), ensureApprovals: vi.fn(), getLiveWalletState: vi.fn(), placeLiveOrder: vi.fn(), getLiveOpenOrders: vi.fn(), cancelLiveOrder: vi.fn(),
}));
vi.mock("../../../../mods/polymarket-trading/markets", async (orig) => ({
  ...(await orig<typeof import("../../../../mods/polymarket-trading/markets")>()),
  getBtcWindowMarket: vi.fn(async (win: { slug: string }) => (win.slug.includes("15m") ? env.m15 : win.slug === env.m5.slug ? env.m5 : null)),
  getBook: vi.fn(async (tokenId: string) => env.books[tokenId] ?? book(null, null)),
  getMarketByConditionId: vi.fn(async () => env.m5),
  getTapePrints: vi.fn(async () => new Map()),
  getWalletPositions: vi.fn(async () => []),
}));
vi.mock("../../../../mods/polymarket-trading/feeds", async (orig) => ({
  ...(await orig<typeof import("../../../../mods/polymarket-trading/feeds")>()),
  hlInfo: vi.fn(async () => ({ BTC: String(env.spot) })),
  btcCandles: vi.fn(async (interval: string) => (interval === "1m" ? env.bars : [])),
  recentBtcLiquidations: vi.fn(async () => []),
  btcPositions: vi.fn(async () => []),
}));

const markets = await import("../../../../mods/polymarket-trading/markets");
const { runPolymarketTick, processPaperOrders, parseBotParams } = await import("../../../../mods/polymarket-trading/server");

/** 1-minute bars with a constant high−low range (and true range) of `range`. */
const flatBars = (from: number, count: number, range: number) =>
  Array.from({ length: count }, (_, i) => ({ t: from + i * 60_000, o: env.spot, h: env.spot + range / 2, l: env.spot - range / 2, c: env.spot, v: 10 }));

beforeEach(() => {
  vi.clearAllMocks();
  env.books = {};
  env.spot = 100_000;
  env.bars = [];
  env.m5 = mkMarket("c5", `btc-updown-5m-${W5 / 1000}`, 100_000);
  store.acquireTickLock.mockResolvedValue(true);
});

describe("resting paper orders", () => {
  const order = {
    id: "o1", agentId: "a1", orgId: "org1", botId: "b1", conditionId: "c5", question: "q", slug: "s", endDate: null,
    tokenId: "c5-up", outcomeIndex: 0, outcome: "Up", side: "buy", price: 0.45, shares: 10, filledShares: 0,
    status: "open", checkedTo: W5, expiresAt: W5 + 290_000, tag: "up", cancelReason: null,
  };

  it("fills from prints below the bid, books a maker trade, and logs it to the bot", async () => {
    store.listOpenPaperOrders.mockResolvedValueOnce([order]);
    vi.mocked(markets.getTapePrints).mockResolvedValueOnce(new Map([["c5-up", [{ price: 0.44, size: 4, ts: W5 + 10_000 }, { price: 0.45, size: 99, ts: W5 + 20_000 }]]]));
    store.applyRestingFill.mockResolvedValueOnce({ shares: 4, realized: 0, order: { ...order, filledShares: 4 } });
    const r = await processPaperOrders(W5 + 60_000);
    expect(r).toMatchObject({ checked: 1, filled: 1, expired: 0 });
    expect(store.applyRestingFill).toHaveBeenCalledWith("o1", 4, W5 + 60_000);
    expect(store.recordTrade).toHaveBeenCalledWith(expect.objectContaining({ side: "buy", shares: 4, price: 0.45, fee: 0, strategyId: "b1", orderId: "o1" }));
    expect(store.addBotLog).toHaveBeenCalledWith("b1", expect.objectContaining({ kind: "entry" }));
  });

  it("advances the checked mark when nothing traded through, and expires stale orders", async () => {
    store.listOpenPaperOrders.mockResolvedValueOnce([order, { ...order, id: "o2", expiresAt: W5 + 30_000 }]);
    const r = await processPaperOrders(W5 + 60_000);
    expect(r.expired).toBe(1);
    expect(store.updatePaperOrder).toHaveBeenCalledWith("o1", { checkedTo: W5 + 60_000 });
    expect(store.updatePaperOrder).toHaveBeenCalledWith("o2", { status: "cancelled", cancelReason: "Expired" });
  });
});

describe("the tick", () => {
  it("does nothing while another tick holds the lock", async () => {
    store.acquireTickLock.mockResolvedValueOnce(false);
    expect(await runPolymarketTick(W5)).toMatchObject({ locked: true, bots: 0 });
    expect(store.listEnabledBots).not.toHaveBeenCalled();
  });

  it("flip harvester: buys the last-minute dog and rests a 62¢ sell on all of it in high vol", async () => {
    const now = W5 + 240_500;
    env.spot = 99_999; // a hair under the strike: Up is the dog
    env.bars = flatBars(W5 - 30 * 60_000, 34, 10); // ATR4 = 10, so cushion 1 = 0.1× ATR4
    env.books = { "c5-up": book(0.34, 0.35), "c5-down": book(0.64, 0.66) };
    store.listEnabledBots.mockResolvedValueOnce([makeBot("flip-harvest")]);
    store.applyPaperFill.mockResolvedValueOnce({ realized: 0, cash: 990 });
    const r = await runPolymarketTick(now);
    expect(r.entered).toBe(1);
    expect(store.applyPaperFill).toHaveBeenCalledWith("a1", "org1", expect.objectContaining({ tokenId: "c5-up" }), "buy", expect.objectContaining({ avgPrice: 0.35 }), "b1");
    // 24h bars are the same flat range, so ATR4 == median → "high" regime → sell 100%.
    expect(store.createPaperOrder).toHaveBeenCalledWith(expect.objectContaining({ side: "sell", price: 0.62, tokenId: "c5-up", tag: "exit", shares: 28.57 }));
  });

  it("box builder: rests bids on both sides under 94¢ in a wide book", async () => {
    env.books = { "c5-up": book(0.5, 0.55), "c5-down": book(0.45, 0.5) };
    store.listEnabledBots.mockResolvedValueOnce([makeBot("box-builder")]);
    const r = await runPolymarketTick(W5 + 5_000);
    expect(r.entered).toBe(1);
    const calls = store.createPaperOrder.mock.calls.map((c) => c[0] as { tag: string; price: number; side: string; expiresAt: number });
    expect(calls.map((c) => c.tag)).toEqual(["up", "down"]);
    expect(calls[0].price + calls[1].price).toBeLessThanOrEqual(0.94 + 1e-9);
    expect(calls.every((c) => c.side === "buy" && c.expiresAt === W5 + 290_000)).toBe(true);
  });

  it("box builder: a stranded leg at T-90 that isn't clearly winning is sold", async () => {
    env.books = { "c5-up": book(0.3, 0.32), "c5-down": book(0.66, 0.7) };
    env.spot = 99_990;
    env.bars = flatBars(W5 - 30 * 60_000, 34, 10);
    store.listEnabledBots.mockResolvedValueOnce([makeBot("box-builder", { state: { window: W5, enteredWindow: W5, fleet: { phase: "quoted", shares: 10 } } })]);
    store.listAgentPaperOrders.mockResolvedValueOnce([
      { id: "u", botId: "b1", conditionId: "c5", tag: "up", status: "filled", price: 0.47, shares: 10, filledShares: 10 },
      { id: "d", botId: "b1", conditionId: "c5", tag: "down", status: "open", price: 0.45, shares: 10, filledShares: 0 },
    ]);
    store.getPaperPosition.mockResolvedValue({ shares: 10, avgPrice: 0.47 });
    store.applyPaperFill.mockResolvedValueOnce({ realized: -1.7, cash: 1003 });
    await runPolymarketTick(W5 + 240_000);
    expect(store.updatePaperOrder).toHaveBeenCalledWith("d", { status: "cancelled", cancelReason: expect.stringMatching(/Stranded Up is losing/) });
    expect(store.applyPaperFill).toHaveBeenCalledWith("a1", "org1", expect.objectContaining({ tokenId: "c5-up" }), "sell", expect.objectContaining({ shares: 10 }), "b1");
    store.getPaperPosition.mockResolvedValue(null);
  });

  it("corridor: buys the 15m leader and the 5m opposite with equal shares", async () => {
    env.m5 = mkMarket("c5", `btc-updown-5m-${W5 / 1000}`, 100_150); // p10: BTC +15bps at minute 10
    env.bars = flatBars(T15, 10, 100); // ATR14 = 100 → lead/ATR = 1.5
    env.books = { "c15-up": book(0.79, 0.8), "c15-down": book(0.19, 0.21), "c5-up": book(0.54, 0.56), "c5-down": book(0.44, 0.45) };
    store.listEnabledBots.mockResolvedValueOnce([makeBot("corridor")]);
    store.applyPaperFill.mockImplementation(async () => ({ realized: 0, cash: 990 }));
    const r = await runPolymarketTick(T15 + 620_000);
    expect(r.entered).toBe(1);
    const legs = store.applyPaperFill.mock.calls.map((c) => ({ token: (c[2] as { tokenId: string }).tokenId, shares: (c[4] as { shares: number }).shares }));
    expect(legs.map((l) => l.token)).toEqual(["c15-up", "c5-down"]);
    expect(legs[0].shares).toBe(legs[1].shares);
  });

  it("corridor: an unpaired first leg is flattened", async () => {
    env.m5 = mkMarket("c5", `btc-updown-5m-${W5 / 1000}`, 100_150);
    env.bars = flatBars(T15, 10, 100);
    env.books = { "c15-up": book(0.79, 0.8), "c15-down": book(0.19, 0.21), "c5-up": book(0.54, 0.56), "c5-down": book(0.44, 0.45) };
    store.listEnabledBots.mockResolvedValueOnce([makeBot("corridor")]);
    store.applyPaperFill.mockImplementationOnce(async () => ({ realized: 0, cash: 990 })).mockImplementationOnce(async () => { throw new store.PaperError("Not enough paper cash"); });
    store.getPaperPosition.mockResolvedValue({ shares: 7.8, avgPrice: 0.8 });
    const r = await runPolymarketTick(T15 + 620_000);
    expect(r.errors).toBe(1);
    expect(store.applyPaperFill).toHaveBeenLastCalledWith("a1", "org1", expect.objectContaining({ tokenId: "c15-up" }), "sell", expect.anything(), "b1");
    expect(store.addBotLog).toHaveBeenCalledWith("b1", expect.objectContaining({ kind: "error", reason: expect.stringMatching(/flattened leg 1/) }));
    store.getPaperPosition.mockResolvedValue(null);
  });

  it("spread maker: pulls its resting quote when the flip breaks", async () => {
    env.spot = 100_050; // way off the strike vs ATR4 10
    env.bars = flatBars(W5 - 30 * 60_000, 34, 10);
    env.books = { "c5-up": book(0.3, 0.62), "c5-down": book(0.4, 0.52) };
    store.listEnabledBots.mockResolvedValueOnce([makeBot("spread-maker", { state: { window: W5, enteredWindow: W5, fleet: { orderId: "q1" } } })]);
    store.listAgentPaperOrders.mockResolvedValueOnce([{ id: "q1", status: "open", price: 0.41, shares: 24, filledShares: 0, outcome: "Up" }]);
    await runPolymarketTick(W5 + 200_000);
    expect(store.updatePaperOrder).toHaveBeenCalledWith("q1", { status: "cancelled", cancelReason: expect.stringMatching(/Flip broke/) });
  });
});

describe("fleet bot params", () => {
  it("keeps Moon Dev's defaults and accepts in-range numeric overrides only", () => {
    expect(parseBotParams("flip-harvest", {})).toMatchObject({ exitPrice: 0.62, maxAsk: 0.45 });
    expect(parseBotParams("flip-harvest", { exitPrice: 0.65, junk: 5 })).toMatchObject({ exitPrice: 0.65 });
    expect(parseBotParams("flip-harvest", { exitPrice: 0.65, junk: 5 })).not.toHaveProperty("junk");
    expect(parseBotParams("flip-harvest", { exitPrice: 3 })).toMatch(/exitPrice must be between 0 and 1/);
    expect(parseBotParams("near-liq", { minWhaleUsd: 250_000 })).toMatchObject({ minWhaleUsd: 250_000, maxDistancePct: 0.5 });
    expect(parseBotParams("corridor", { actFromMs: 2_000_000 })).toMatch(/actFromMs/);
  });
});
