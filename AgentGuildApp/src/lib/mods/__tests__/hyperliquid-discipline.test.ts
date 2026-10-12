import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  autoPauseReason, bracketFor, COOLDOWN_ROUNDS, guardAction, lastExitAt, MIN_HOLD_ROUNDS, openPositions, PAUSE_TRIPS, ROUND_TRIP_COST_PCT,
} from "../../../../mods/hyperliquid-trading/discipline";
import type { Trip } from "../../../../mods/hyperliquid-trading/evolve";

// These tests assert the worker queue (enqueueTask). Testnet orders sign natively by default; hyperliquid-testnet.test.ts covers that path.
process.env.HYPERLIQUID_EXECUTION = "worker";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 12, 12);

describe("discipline rules", () => {
  const base = { atr: 0.5, openedAt: null, lastExitAt: null, roundMs: HOUR, now: NOW };

  it("refuses entries when the expected move can't cover twice the round-trip cost", () => {
    // 1-minute ETH: ATR about 0.06% → expected move 0.17%, under 0.30%.
    expect(guardAction({ ...base, action: "open-long", atr: 0.06 })).toMatchObject({ action: "hold", note: expect.stringMatching(/Too quiet/) });
    // 15-minute ETH: ATR about 0.15% → 0.42%, enough.
    expect(guardAction({ ...base, action: "open-short", atr: 0.15 })).toEqual({ action: "open-short", note: null });
    // Unknown volatility doesn't block.
    expect(guardAction({ ...base, action: "open-long", atr: null })).toEqual({ action: "open-long", note: null });
  });

  it("holds a fresh position through its first rounds, then lets it go", () => {
    const young = { ...base, openedAt: NOW - (MIN_HOLD_ROUNDS - 1) * HOUR };
    expect(guardAction({ ...young, action: "close" })).toMatchObject({ action: "hold", note: expect.stringMatching(/must be held 3/) });
    expect(guardAction({ ...young, action: "flip-short" })).toMatchObject({ action: "hold" });
    expect(guardAction({ ...base, openedAt: NOW - MIN_HOLD_ROUNDS * HOUR, action: "close" })).toEqual({ action: "close", note: null });
  });

  it("closes instead of flipping into a market too quiet to trade", () => {
    const old = { ...base, openedAt: NOW - 10 * HOUR, atr: 0.05 };
    expect(guardAction({ ...old, action: "flip-long" })).toMatchObject({ action: "close", note: expect.stringMatching(/Closed instead of flipping/) });
  });

  it("cools down after an exit before opening again", () => {
    const justOut = { ...base, lastExitAt: NOW - HOUR };
    expect(guardAction({ ...justOut, action: "open-long" })).toMatchObject({ action: "hold", note: expect.stringMatching(/cooling down/) });
    expect(guardAction({ ...base, lastExitAt: NOW - COOLDOWN_ROUNDS * HOUR, action: "open-long" })).toEqual({ action: "open-long", note: null });
  });

  it("sizes the bracket to volatility, never tighter than three round trips", () => {
    expect(bracketFor(0.06)).toEqual({ stopLossPct: 0.45, takeProfitPct: 0.9 });
    const b = bracketFor(0.5); // 1-hour ETH
    expect(b.stopLossPct).toBeCloseTo(1.41, 2);
    expect(b.takeProfitPct).toBeCloseTo(2 * b.stopLossPct, 1);
    expect(bracketFor(20).stopLossPct).toBe(15);
  });

  it("reads open positions and exits from the log, ignoring rows that never traded", () => {
    const at = (h: number) => new Date(NOW - h * HOUR);
    const rows = [
      { coin: null, action: "open-long", reasoning: "", price: 100, error: null, createdAt: at(9) },
      { coin: null, action: "close", reasoning: "", price: 101, error: null, createdAt: at(8) },
      { coin: null, action: "open-short", reasoning: "", price: 100, error: "Waiting for the wallet passphrase", createdAt: at(7) },
      { coin: "SOL", action: "open-short", reasoning: "", price: 20, error: null, createdAt: at(3) },
      { coin: "SOL", action: "flip-long", reasoning: "", price: 19, error: null, createdAt: at(2) },
    ];
    expect([...openPositions(rows, "ETH")]).toEqual([["SOL", NOW - 2 * HOUR]]);
    expect(lastExitAt(rows, "ETH", "ETH")).toBe(NOW - 8 * HOUR);
    expect(lastExitAt(rows, "SOL", "ETH")).toBe(NOW - 2 * HOUR);
  });

  it("pauses after a run of trades that lose after costs, counting only trades since the last pause", () => {
    const trip = (i: number, pnlPct: number): Trip => ({
      coin: "ETH", side: "long", entryPx: 100, exitPx: 100, pnlPct, openedAt: NOW - (i + 1) * HOUR, closedAt: NOW - i * HOUR, entryReason: "", exitReason: "",
    });
    // The losing paper bots' record: about −0.06% a trade before costs.
    const losing = Array.from({ length: PAUSE_TRIPS }, (_, i) => trip(PAUSE_TRIPS - i, -0.06));
    expect(autoPauseReason(losing, null)).toMatch(/Auto-paused: the last 10 trades averaged -0.210%/);
    expect(autoPauseReason(losing.slice(1), null)).toBeNull(); // too few to judge
    expect(autoPauseReason(losing, NOW - 3 * HOUR)).toBeNull(); // only 3 since the pause
    // Small gross wins that don't clear costs still pause.
    expect(autoPauseReason(losing.map((t) => ({ ...t, pnlPct: ROUND_TRIP_COST_PCT / 2 })), null)).toMatch(/0 of 10 cleared/);
    expect(autoPauseReason(losing.map((t) => ({ ...t, pnlPct: 0.4 })), null)).toBeNull();
  });
});

// ── Wired into the AI Trader ─────────────────────────────────────────────────

const store = {
  // Live orders in flight: none, so only the open position is checked.
  reserveLiveExposure: vi.fn(async ({ check }: { check: (pendingUsd: number) => string | null }) => {
    const error = check(0);
    return error ? { error } : { id: "res-1" };
  }),
  bindLiveExposure: vi.fn(async () => {}),
  releaseLiveExposure: vi.fn(async () => {}),
  getEnabledStrategies: vi.fn(),
  getStrategy: vi.fn(),
  touchStrategyRun: vi.fn(),
  toggleStrategy: vi.fn(),
  markStrategyPending: vi.fn(),
  clearStrategyPending: vi.fn(),
  recordAiDecision: vi.fn(),
  getAiDecisions: vi.fn(async () => [] as unknown[]),
  createAiRequest: vi.fn(async () => "req-1"),
  getAiRequest: vi.fn(),
  listOpenAiRequests: vi.fn(),
  answerAiRequest: vi.fn(),
  expireAiRequest: vi.fn(),
  getInstantTrading: vi.fn(),
  getAgentWallet: vi.fn(async () => null),
  getRiskConfig: vi.fn(async () => null),
  getDailyRealizedPnl: vi.fn(async () => 0),
  logBotOrder: vi.fn(),
  setStrategyEvolution: vi.fn(),
};
const enqueueTask = vi.fn(async () => "task-1");

vi.mock("@/lib/mods/hyperliquid-store", () => store);
vi.mock("@/lib/agent-wallets", () => ({
  listAgentWallets: vi.fn(async () => []),
  generateAgentWallet: vi.fn(),
  getAgentWalletEvmPrivateKey: vi.fn(async () => "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"),
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
const agentCtx = (params: Record<string, string> = {}) => ({
  modId: "hyperliquid-trading", log: { info() {}, warn() {}, error() {} }, emit: async () => {},
  params, session: null, agent: { agentId: "a1", orgId: "org1" },
});
const post = (body: unknown) => new Request("http://x/", { method: "POST", body: JSON.stringify(body) });
const INSTANT = { agentId: "a1", orgId: "org1", walletId: "w1", address: "0xabc", network: "testnet" };

function aiBot(params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    id: "s1", orgId: "org1", agentId: "a1", wallet: "0xabc", type: "ai", coin: "ETH", sizeUsd: 25, enabled: true,
    params: { intervalMs: HOUR, maxDrawdownPct: 50, ...params },
    lastRunAt: null, createdAt: null, pendingSignal: false, pendingSince: null, pendingContext: null, webhookToken: null,
    ...extra,
  };
}
function liveRequest(position: "FLAT" | "LONG" = "FLAT") {
  return {
    id: "req-1", agentId: "a1", orgId: "org1", purpose: "live", strategyId: "s1", coin: "ETH", system: "sys",
    prompt: `MARKET SNAPSHOT …\n\nCurrent position: ${position === "FLAT" ? "FLAT (no open position)" : "LONG 0.25 ETH | entry 100"}\n\nWhat is your decision?`,
    status: "open", decision: null, reasoning: null, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  };
}
const logRow = (action: string, hoursAgo: number, price = 100) =>
  ({ coin: null, action, reasoning: "", price, error: null, createdAt: new Date(Date.now() - hoursAgo * HOUR) });

/** Hyperliquid's info API with hourly candles of the given range (high − low, around 100). */
function stubHyperliquid({ range = 2, position = false } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const json = (d: unknown) => new Response(JSON.stringify(d));
    switch (body.type) {
      case "clearinghouseState":
        return json({
          marginSummary: { accountValue: "200", totalMarginUsed: "0", totalNtlPos: "0" },
          assetPositions: position ? [{ position: { coin: "ETH", szi: "0.25", positionValue: "25", entryPx: "100", unrealizedPnl: "0" } }] : [],
        });
      case "spotClearinghouseState": return json({ balances: [] });
      case "candleSnapshot":
        return json(Array.from({ length: 60 }, (_, i) => ({ t: i * HOUR, o: "100", h: String(100 + range / 2), l: String(100 - range / 2), c: "100", v: "1" })));
      case "l2Book": return json({ levels: [[{ px: "99.9", sz: "10" }], [{ px: "100.1", sz: "10" }]] });
      case "metaAndAssetCtxs": return json([{ universe: [] }, []]);
      case "allMids": return json({ ETH: "100" });
      default: return json({});
    }
  }));
}

function answer(decision: string, position: "FLAT" | "LONG" = "FLAT") {
  store.getAiRequest.mockResolvedValue(liveRequest(position));
  store.answerAiRequest.mockImplementation(async (_id: string, d: string, r: string) => ({ ...liveRequest(position), status: "answered", decision: d, reasoning: r }));
  return route("POST /ai/requests/:id/answer")(post({ decision, reasoning: "because" }), agentCtx({ id: "req-1" }));
}
/** Trading-round questions only; the self-review pass asks its own (purpose "reflect"). */
const liveAsks = () => (store.createAiRequest.mock.calls as unknown as [{ purpose: string; system: string }][]).map((c) => c[0]).filter((r) => r.purpose === "live");
const lastRecord = () => store.recordAiDecision.mock.calls.at(-1)?.[1] as Record<string, unknown>;

let clock = Date.now();
beforeEach(() => {
  // Volatility is cached for a minute across bots; move past it so each test sees its own candles.
  clock += 5 * 60_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
  vi.clearAllMocks();
  store.getAiDecisions.mockResolvedValue([]);
  store.getInstantTrading.mockResolvedValue(INSTANT);
  store.getStrategy.mockResolvedValue(aiBot({ openRequestId: "req-1" }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("discipline in the AI Trader", () => {
  it("sends every entry with a stop loss and take profit sized to volatility", async () => {
    stubHyperliquid({ range: 2 }); // ATR 2% on hourly bars
    const body = await (await answer("LONG")).json();
    expect(body).toMatchObject({ action: "open-long", taskId: "task-1" });
    const payload = (enqueueTask.mock.calls[0] as unknown as [{ payload: Record<string, number> }])[0].payload;
    expect(payload.stopLossPct).toBeCloseTo(5.66, 1);
    expect(payload.takeProfitPct).toBeCloseTo(11.31, 1);
  });

  it("doesn't open in a market too quiet to cover costs, and says why", async () => {
    stubHyperliquid({ range: 0.02 });
    const body = await (await answer("LONG")).json();
    expect(body).toMatchObject({ action: "hold", taskId: null });
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(lastRecord()).toMatchObject({ decision: "LONG", action: "hold", reasoning: expect.stringMatching(/because[\s\S]*Too quiet/) });
  });

  it("won't close a position the bot opened an hour ago, unless discipline is off", async () => {
    stubHyperliquid({ position: true });
    store.getAiDecisions.mockResolvedValue([logRow("open-long", 1)]);
    expect(await (await answer("CLOSE", "LONG")).json()).toMatchObject({ action: "hold" });
    expect(enqueueTask).not.toHaveBeenCalled();

    store.getStrategy.mockResolvedValue(aiBot({ openRequestId: "req-1", discipline: false }));
    expect(await (await answer("CLOSE", "LONG")).json()).toMatchObject({ action: "close", taskId: "task-1" });
  });

  it("logs a position its stop or target closed, so reviews count the trade", async () => {
    stubHyperliquid({ position: false });
    store.getEnabledStrategies.mockResolvedValue([aiBot({ guardSince: Date.now() - 24 * HOUR })]);
    store.getAiDecisions.mockResolvedValue([logRow("open-long", 5)]);
    await runAiTraderTick();
    expect(store.recordAiDecision).toHaveBeenCalledWith("s1", expect.objectContaining({
      coin: "ETH", action: "close", price: 100, reasoning: expect.stringMatching(/stop loss or take profit/),
    }));
    expect(liveAsks()).toHaveLength(1); // and the round still goes out
  });

  it("pauses a bot whose recent trades lose after costs, instead of asking it again", async () => {
    stubHyperliquid();
    const since = Date.now() - 48 * HOUR;
    store.getEnabledStrategies.mockResolvedValue([aiBot({ guardSince: since })]);
    store.getAiDecisions.mockResolvedValue(Array.from({ length: PAUSE_TRIPS }, (_, i) => [
      logRow("open-long", 30 - 2 * i, 100), logRow("close", 29 - 2 * i, 99.95),
    ]).flat());
    await runAiTraderTick();
    expect(store.toggleStrategy).toHaveBeenCalledWith("s1", false);
    expect(store.recordAiDecision).toHaveBeenCalledWith("s1", expect.objectContaining({ reasoning: expect.stringMatching(/^Auto-paused/) }));
    expect(liveAsks()).toEqual([]);
    // The pause restarts the count, so turning the bot back on gives it a fresh run.
    const saved = store.touchStrategyRun.mock.calls.at(-1)?.[1] as { guardSince: number };
    expect(saved.guardSince).toBeGreaterThan(since);
  });

  it("starts counting at the first disciplined round, so trades from before don't pause a re-enabled bot", async () => {
    stubHyperliquid();
    store.getEnabledStrategies.mockResolvedValue([aiBot()]);
    store.getAiDecisions.mockResolvedValue(Array.from({ length: PAUSE_TRIPS }, (_, i) => [
      logRow("open-long", 30 - 2 * i, 100), logRow("close", 29 - 2 * i, 99.95),
    ]).flat());
    await runAiTraderTick();
    expect(store.toggleStrategy).not.toHaveBeenCalled();
    expect(store.touchStrategyRun).toHaveBeenCalledWith("s1", expect.objectContaining({ guardSince: expect.any(Number) }));
    expect(liveAsks()).toHaveLength(1);
    expect(liveAsks()[0].system).toContain("This bot's trades are guarded in code");
    // An hourly bot also sees the 4h and daily charts.
    expect((liveAsks()[0] as unknown as { prompt: string }).prompt).toMatch(/HIGHER TIMEFRAMES[\s\S]*4h: trend=[\s\S]*1d: trend=/);
  });
});
