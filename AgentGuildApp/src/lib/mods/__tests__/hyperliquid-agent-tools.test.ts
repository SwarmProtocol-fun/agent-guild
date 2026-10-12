import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// These tests assert the worker queue (enqueueTask). Testnet orders sign natively by default; hyperliquid-testnet.test.ts covers that path.
process.env.HYPERLIQUID_EXECUTION = "worker";

const store = {
  // Live orders in flight: none, so only the open position is checked.
  reserveLiveExposure: vi.fn(async ({ check }: { check: (pendingUsd: number) => string | null }) => {
    const error = check(0);
    return error ? { error } : { id: "res-1" };
  }),
  bindLiveExposure: vi.fn(async () => {}),
  releaseLiveExposure: vi.fn(async () => {}),
  getStrategy: vi.fn(),
  getStrategies: vi.fn(async () => [] as unknown[]),
  createStrategy: vi.fn(async () => "new-bot"),
  toggleStrategy: vi.fn(),
  setStrategyEvolution: vi.fn(),
  getInstantTrading: vi.fn(async () => null as unknown),
  getAgentWallet: vi.fn(async () => null),
  getRiskConfig: vi.fn(async () => null),
};

vi.mock("@/lib/mods/hyperliquid-store", () => store);
vi.mock("@/lib/agent-wallets", () => ({ listAgentWallets: vi.fn(async () => []), generateAgentWallet: vi.fn(), getAgentWalletEvmPrivateKey: vi.fn() }));
vi.mock("@/lib/gateway/store", () => ({ enqueueTask: vi.fn(), getTask: vi.fn() }));
vi.mock("@/lib/settlement/registry", () => ({ settleOnChains: vi.fn(), hashJobResult: vi.fn() }));
vi.mock("@/lib/secrets", () => ({ encryptValue: vi.fn(), decryptValue: vi.fn() }));
vi.mock("@/lib/firestore-admin", () => ({ enforceCapability: vi.fn(async () => ({})), getAgentCapabilities: vi.fn(async () => []), getAgent: vi.fn(), getAgentsByOrg: vi.fn(), getOrganizationsByWalletAdmin: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ requireOrgMembershipByAddress: vi.fn() }));

const { default: mod } = await import("../../../../mods/hyperliquid-trading/server");
const { buildAgentBacktest, runAgentBacktest } = await import("../../../../mods/hyperliquid-trading/agent-backtest");
const { connect } = await import("../../../../mods/hyperliquid-trading/agent/hl-agent.mjs");

const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];
const HOUR = 3_600_000;

type Handler = (req: Request, ctx: unknown) => Promise<Response>;
function route(key: string): Handler {
  const def = mod.routes![key] as Handler | { handler: Handler };
  return typeof def === "function" ? def : def.handler;
}
const agentCtx = (params: Record<string, string> = {}, agentId = "a1") => ({
  modId: "hyperliquid-trading", log: { info() {}, warn() {}, error() {} }, emit: async () => {},
  params, session: null, agent: { agentId, orgId: "org1" },
});
const post = (body: unknown) => new Request("http://x/", { method: "POST", body: JSON.stringify(body) });

/** Hourly candles following `closes`, each bar opening at the previous close. */
function candles(closes: number[]) {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { t: i * HOUR, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1 };
  });
}
const ramp = (from: number, to: number, n: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));

beforeEach(() => {
  vi.clearAllMocks();
  store.getStrategies.mockResolvedValue([]);
  store.getInstantTrading.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllGlobals());

describe("agent backtest spec", () => {
  it("takes settings flat (agent tools) or inside params (the panel's bot spec)", () => {
    const flat = buildAgentBacktest({ type: "dca", coin: "eth", sizeUsd: 25, intervalMs: 4 * HOUR, direction: "short", stopLossPct: 5 }, INTERVALS);
    const nested = buildAgentBacktest({ type: "dca", coin: "ETH", sizeUsd: 25, params: { intervalMs: 4 * HOUR, direction: "short", stopLossPct: 5 } }, INTERVALS);
    expect(flat).toEqual(nested);
    expect(flat).toMatchObject({ coin: "ETH", interval: "1h", bars: 500, outOfSamplePct: 30, stopLossPct: 5, strategy: { type: "dca", intervalMs: 4 * HOUR, direction: "short" } });
  });

  it("gives breakout its warm-up and a 4h default", () => {
    const spec = buildAgentBacktest({ type: "breakout", coin: "BTC", sizeUsd: 50 }, INTERVALS);
    if ("error" in spec) throw new Error(spec.error);
    expect(spec.interval).toBe("4h");
    expect(spec.warmup).toBeGreaterThan(20);
  });

  it("refuses what it can't run", () => {
    const bad = (body: Record<string, unknown>) => (buildAgentBacktest(body, INTERVALS) as { error?: string }).error;
    expect(bad({ type: "ai", coin: "BTC", sizeUsd: 25 })).toMatch(/panel/);
    expect(bad({ type: "sniper", coin: "ANY", sizeUsd: 25, mode: "new-listing" })).toMatch(/coin|new-listing/);
    expect(bad({ type: "sniper", coin: "BTC", sizeUsd: 25, mode: "new-listing" })).toMatch(/new-listing/);
    expect(bad({ type: "grid", coin: "BTC", sizeUsd: 25, lowerPrice: 2, upperPrice: 1, levels: 5 })).toMatch(/lowerPrice/);
    expect(bad({ type: "dca", coin: "BTC", sizeUsd: 5, intervalMs: HOUR })).toMatch(/sizeUsd/);
    expect(bad({ type: "dca", coin: "BTC", sizeUsd: 25, intervalMs: HOUR, bars: 6000 })).toMatch(/bars/);
    expect(bad({ type: "dca", coin: "BTC", sizeUsd: 25, intervalMs: HOUR, interval: "2h" })).toMatch(/interval/);
    expect(bad({ type: "dca", coin: "BTC", sizeUsd: 25, intervalMs: HOUR, outOfSamplePct: 80 })).toMatch(/outOfSamplePct/);
  });
});

describe("agent backtest report", () => {
  it("flags a bot that beat holding in sample but not out of sample", async () => {
    // Falls for 140 bars (a short DCA wins), then rises for 60 (it loses while holding wins).
    const spec = buildAgentBacktest({ type: "dca", coin: "ETH", sizeUsd: 100, intervalMs: 4 * HOUR, direction: "short", bars: 200 }, INTERVALS);
    if ("error" in spec) throw new Error(spec.error);
    const report = await runAgentBacktest(spec, candles([...ramp(200, 100, 140), ...ramp(101, 160, 60)]), HOUR);
    if ("error" in report) throw new Error(report.error);
    expect(report.inSample!.edgePct).toBeGreaterThan(0);
    expect(report.outOfSample!.edgePct).toBeLessThan(0);
    expect(report.verdict).toMatch(/overfit/);
    expect(report.inSample!.to < report.outOfSample!.from).toBe(true);
    expect(report.outOfSample!.recentTrades.length).toBeLessThanOrEqual(10);
    expect(report.startBot).toEqual({ coin: "ETH", sizeUsd: 100, type: "dca", params: { intervalMs: 4 * HOUR, direction: "short" } });
  });

  it("runs once over everything when nothing is held out", async () => {
    const spec = buildAgentBacktest({ type: "hold", coin: "BTC", outOfSamplePct: 0, bars: 100 }, INTERVALS);
    if ("error" in spec) throw new Error(spec.error);
    const report = await runAgentBacktest(spec, candles(ramp(100, 110, 100)), HOUR);
    if ("error" in report) throw new Error(report.error);
    expect(report.inSample).toBeUndefined();
    expect(report.full!.returnPct).toBeGreaterThan(5);
    expect(report.startBot).toBeNull();
  });

  it("says so when the exchange returned too little history", async () => {
    const spec = buildAgentBacktest({ type: "breakout", coin: "BTC", sizeUsd: 50 }, INTERVALS);
    if ("error" in spec) throw new Error(spec.error);
    expect(await runAgentBacktest(spec, candles(ramp(100, 110, 30)), HOUR)).toMatchObject({ error: expect.stringMatching(/Only 30 bars/) });
  });
});

describe("POST /backtest", () => {
  it("fetches mainnet candles and returns the report", async () => {
    const closes = ramp(100, 130, 300);
    const bars = candles(closes);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body));
      if (req.type === "meta") return Response.json({ universe: [{ name: "SOL", szDecimals: 2, maxLeverage: 20 }] });
      // Longs pay 0.01% every hour of the history.
      if (req.type === "fundingHistory") return Response.json(bars.filter((k) => k.t >= req.startTime).map((k) => ({ coin: "SOL", time: k.t, fundingRate: "0.0001", premium: "0" })));
      return Response.json(bars.map((k) => ({ ...k, o: String(k.o), h: String(k.h), l: String(k.l), c: String(k.c), v: "1" })));
    });
    vi.stubGlobal("fetch", fetchMock);
    const resp = await route("POST /backtest")(post({ type: "grid", coin: "SOL", sizeUsd: 50, lowerPrice: 90, upperPrice: 140, levels: 10, bars: 300 }), agentCtx());
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body).toMatchObject({ coin: "SOL", type: "grid", interval: "1h", fundingModelled: true, startBot: { type: "grid", params: { levels: 10 } } });
    expect(body.inSample.bars + body.outOfSample.bars).toBe(300);
    // A long grid held through rising prices pays funding, and the report carries round-trip stats.
    expect(body.outOfSample.fundingPaid).toBeGreaterThan(0);
    expect(body.outOfSample.stats).toMatchObject({ trips: expect.any(Number), maxConsecutiveLosses: expect.any(Number) });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toMatch(/testnet/);
    expect(JSON.parse(String(init.body))).toMatchObject({ type: "candleSnapshot", req: { coin: "SOL", interval: "1h" } });
  });

  it("rejects bad settings without fetching, and anonymous callers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await route("POST /backtest")(post({ type: "grid", coin: "SOL", sizeUsd: 50 }), agentCtx())).status).toBe(400);
    expect((await route("POST /backtest")(post({ type: "hold", coin: "SOL" }), { ...agentCtx(), agent: null })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /candles for long backtests", () => {
  it("pages back past one call's worth of bars and adds funding + max leverage on request", async () => {
    const now = 10_000 * HOUR;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body));
      // The perp universe is cached for a minute across tests; SOL is 20x in every mock of it.
      if (req.type === "meta") return Response.json({ universe: [{ name: "SOL", szDecimals: 2, maxLeverage: 20 }] });
      if (req.type === "fundingHistory") {
        // 500 per page, like Hyperliquid.
        const out = [];
        for (let t = Math.ceil(req.startTime / HOUR) * HOUR; t <= req.endTime && out.length < 500; t += HOUR) out.push({ coin: "SOL", time: t, fundingRate: "0.00001", premium: "0" });
        return Response.json(out);
      }
      const out = [];
      for (let t = Math.ceil(req.req.startTime / HOUR) * HOUR; t <= req.req.endTime; t += HOUR) out.push({ t, o: "1", h: "1", l: "1", c: "1", v: "1" });
      return Response.json(out);
    });
    vi.stubGlobal("fetch", fetchMock);
    const resp = await route("GET /candles/:coin")(new Request(`http://x/?interval=1h&network=mainnet&bars=2500&end=${now}&funding=1`), { ...agentCtx({ coin: "SOL" }), params: { coin: "SOL" } });
    const body = await resp.json();
    expect(resp.status).toBe(200);
    const ts = body.candles.map((c: { t: number }) => c.t);
    expect(ts.length).toBeGreaterThanOrEqual(2500);
    expect(new Set(ts).size).toBe(ts.length);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    const candleCalls = fetchMock.mock.calls.filter(([, init]) => JSON.parse(String((init as RequestInit).body)).type === "candleSnapshot");
    expect(candleCalls.length).toBe(3);
    expect(body.maxLeverage).toBe(20);
    expect(body.funding.length).toBeGreaterThan(2000); // paged past the 500-per-call limit
  });
});

describe("POST /strategy from an agent tool", () => {
  it("keeps only rule settings from a flat body — never the injected passphrase", async () => {
    const resp = await route("POST /strategy")(post({
      type: "dca", coin: "ETH", sizeUsd: 25, paper: true, intervalMs: HOUR, direction: "short", masterSecret: "hunter2",
    }), agentCtx());
    expect(await resp.json()).toEqual({ id: "new-bot", paper: true, network: null, mode: "PAPER" });
    const saved = (store.createStrategy.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(saved).toMatchObject({ type: "dca", coin: "ETH", paper: true, params: { intervalMs: HOUR, direction: "short" } });
    expect(JSON.stringify(saved)).not.toContain("hunter2");

    await route("POST /strategy")(post({ type: "grid", coin: "BTC", sizeUsd: 25, paper: true, lowerPrice: 1, upperPrice: 2, levels: 4, masterSecret: "x", junk: 1 }), agentCtx());
    expect((store.createStrategy.mock.calls[1] as unknown[])[0]).toMatchObject({ params: { lowerPrice: 1, upperPrice: 2, levels: 4 } });
    expect(((store.createStrategy.mock.calls[1] as unknown[])[0] as { params: object }).params).not.toHaveProperty("junk");
  });

  it("starts a live bot on the agent's own wallet when none is sent", async () => {
    store.getInstantTrading.mockResolvedValue({ network: "mainnet", address: "0xabc" });
    await route("POST /strategy")(post({ type: "sniper", coin: "BTC", sizeUsd: 25, mode: "price-below", targetPrice: 50_000 }), agentCtx());
    expect((store.createStrategy.mock.calls[0] as unknown[])[0]).toMatchObject({ wallet: "0xabc", paper: false });
  });

  it("still refuses a live bot with no wallet anywhere", async () => {
    const resp = await route("POST /strategy")(post({ type: "dca", coin: "BTC", sizeUsd: 25, intervalMs: HOUR }), agentCtx());
    expect(resp.status).toBe(400);
    expect(store.createStrategy).not.toHaveBeenCalled();
  });
});

describe("bot toggle and evolution", () => {
  const bot = { id: "s1", orgId: "org1", agentId: "a1", type: "ai", coin: "ETH", paper: true, enabled: true, params: {}, evolution: null };

  it("lets an agent switch only its own bots", async () => {
    store.getStrategy.mockResolvedValue(bot);
    expect((await route("POST /strategy/:id/toggle")(post({ enabled: false }), agentCtx({ id: "s1" }, "a2"))).status).toBe(403);
    expect((await route("POST /strategy/:id/evolution")(post({ reset: true }), agentCtx({ id: "s1" }, "a2"))).status).toBe(403);
    expect(store.toggleStrategy).not.toHaveBeenCalled();
    expect(store.setStrategyEvolution).not.toHaveBeenCalled();

    expect((await route("POST /strategy/:id/toggle")(post({ enabled: "no" }), agentCtx({ id: "s1" }))).status).toBe(400);
    expect((await route("POST /strategy/:id/toggle")(post({ enabled: false }), agentCtx({ id: "s1" }))).status).toBe(200);
    expect(store.toggleStrategy).toHaveBeenCalledWith("s1", false);
  });
});

describe("agent tool manifest", () => {
  it("points every tool at a route that exists", async () => {
    const { tools } = await (await route("GET /agent/tools")(new Request("http://x/"), agentCtx())).json();
    const routes = Object.keys(mod.routes!).map((k) => {
      const [method, path] = k.split(" ");
      return { method, re: new RegExp(`^${path.replace(/:\w+/g, "[^/]+")}$`) };
    });
    for (const t of tools as { name: string; method: string; path: string }[]) {
      const concrete = "/" + t.path.replace(/\{\w+\}/g, "x");
      expect(routes.some((r) => r.method === t.method && r.re.test(concrete)), `${t.name} → ${t.method} ${t.path}`).toBe(true);
    }
    const names = (tools as { name: string }[]).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ["hyperliquid_bots", "hyperliquid_rule_bot", "hyperliquid_toggle_bot", "hyperliquid_backtest", "hyperliquid_paper_performance"]) {
      expect(names).toContain(n);
    }
  });
});

describe("hl-agent runtime", () => {
  const manifest = [
    { name: "hyperliquid_candles", method: "GET", path: "candles/{coin}" },
    { name: "hyperliquid_paper_reset", method: "POST", path: "paper/reset" },
    { name: "hyperliquid_trade", method: "POST", path: "trade" },
  ];
  function hub() {
    const calls: { url: URL; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: URL, init: RequestInit) => {
      calls.push({ url: new URL(String(u)), body: init.body ? JSON.parse(String(init.body)) : undefined });
      const path = new URL(String(u)).pathname;
      if (path.endsWith("/me")) return Response.json({ agentId: "a1", wallet: { instant: false } });
      if (path.endsWith("/agent/tools")) return Response.json({ tools: manifest });
      return Response.json({ ok: true });
    }));
    return calls;
  }
  const env = { AGENT_GUILD_URL: "http://hub", AGENT_GUILD_TOKEN: "agt_x", HL_MASTER_SECRET: "pass" } as unknown as NodeJS.ProcessEnv;

  it("sends GET inputs as the query and the passphrase only with trades", async () => {
    const calls = hub();
    const hl = await connect(env);
    await hl.call("hyperliquid_candles", { coin: "BTC", interval: "4h", bars: 200 });
    await hl.call("hyperliquid_paper_reset", { startBalance: 5000 });
    await hl.call("hyperliquid_trade", { coin: "BTC", isBuy: true, sizeUsd: 10 });
    const [candlesCall, resetCall, tradeCall] = calls.slice(2);
    expect(candlesCall.url.pathname).toBe("/api/mods/hyperliquid-trading/candles/BTC");
    expect(Object.fromEntries(candlesCall.url.searchParams)).toEqual({ interval: "4h", bars: "200" });
    expect(resetCall.body).toEqual({ startBalance: 5000 });
    expect(tradeCall.body).toMatchObject({ masterSecret: "pass" });
  });

  it("doesn't demand the passphrase for anything but trading", async () => {
    hub();
    const hl = await connect({ ...env, HL_MASTER_SECRET: undefined } as NodeJS.ProcessEnv);
    await expect(hl.call("hyperliquid_paper_reset", {})).resolves.toEqual({ ok: true });
    await expect(hl.call("hyperliquid_trade", { coin: "BTC", isBuy: true, sizeUsd: 10 })).rejects.toThrow(/HL_MASTER_SECRET/);
  });
});

describe("backtest verdict", () => {
  it("tells losing less than holding apart from beating it", async () => {
    const { judge } = await import("../../../../mods/hyperliquid-trading/agent-backtest");
    expect(judge({ edgePct: 3, returnPct: 2 }, { edgePct: 2, returnPct: 1 })).toMatch(/held/);
    expect(judge({ edgePct: 3, returnPct: 2 }, { edgePct: 3.5, returnPct: -0.8 })).toMatch(/lost less/);
    expect(judge({ edgePct: 3, returnPct: 2 }, { edgePct: -1, returnPct: 4 })).toMatch(/overfit/);
    expect(judge({ edgePct: -2, returnPct: 1 }, { edgePct: -1, returnPct: 4 })).toMatch(/didn't beat/);
  });
});
