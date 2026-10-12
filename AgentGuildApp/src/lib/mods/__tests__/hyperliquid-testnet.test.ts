import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recoverTypedDataAddress, serializeSignature } from "viem";
import { signUsdSend, usdSendAction } from "../../../../mods/hyperliquid-trading/signing";
import { entryProtection, DEFAULT_STOP_LOSS_PCT, DEFAULT_TAKE_PROFIT_PCT } from "../../../../mods/hyperliquid-trading/risk";
import usdSendVectors from "./fixtures/hyperliquid-usdsend-vectors.json";

// PRD addendum 3: TESTNET mode (the agent's own custodial wallet on
// Hyperliquid testnet), every fill with its testnet transaction, default
// SL/TP, the 16-minute answer window, idle safety and question labels.

const HARDHAT_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HARDHAT_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const store = {
  // Live orders in flight: none, so only the open position is checked.
  reserveLiveExposure: vi.fn(async ({ check }: { check: (pendingUsd: number) => string | null }) => {
    const error = check(0);
    return error ? { error } : { id: "res-1" };
  }),
  bindLiveExposure: vi.fn(async () => {}),
  releaseLiveExposure: vi.fn(async () => {}),
  getEnabledStrategies: vi.fn(async () => [] as unknown[]),
  getStrategy: vi.fn(),
  getStrategies: vi.fn(async () => [] as unknown[]),
  createStrategy: vi.fn(async () => "s-new"),
  touchStrategyRun: vi.fn(),
  toggleStrategy: vi.fn(),
  markStrategyPending: vi.fn(),
  clearStrategyPending: vi.fn(),
  recordAiDecision: vi.fn(),
  getAiDecisions: vi.fn(async () => [] as unknown[]),
  createAiRequest: vi.fn(async () => "req-new"),
  getAiRequest: vi.fn(),
  listOpenAiRequests: vi.fn(async () => [] as unknown[]),
  answerAiRequest: vi.fn(),
  expireAiRequest: vi.fn(async () => {}),
  getInstantTrading: vi.fn(async () => null as unknown),
  setInstantTrading: vi.fn(),
  getAgentWallet: vi.fn(async () => null),
  getRiskConfig: vi.fn(async () => null as unknown),
  setRiskConfig: vi.fn(),
  getDailyRealizedPnl: vi.fn(async () => 0),
  logBotOrder: vi.fn(),
  getTestnetTopUp: vi.fn(async () => ({ lastAt: null as Date | null, totalUsd: 0, count: 0 })),
  recordTestnetTopUp: vi.fn(),
  getPendingStrategies: vi.fn(async () => []),
};
const enqueueTask = vi.fn(async () => "task-queued");
const recordCompletedTask = vi.fn(async () => {});
const generateAgentWallet = vi.fn();
const listAgentWallets = vi.fn(async () => [] as unknown[]);

vi.mock("@/lib/mods/hyperliquid-store", () => store);
vi.mock("@/lib/agent-wallets", () => ({
  listAgentWallets,
  generateAgentWallet,
  getAgentWalletEvmPrivateKey: vi.fn(async () => HARDHAT_0),
}));
vi.mock("@/lib/gateway/store", () => ({ enqueueTask, getTask: vi.fn(), newTaskId: () => "task-native", recordCompletedTask }));
vi.mock("@/lib/settlement/registry", () => ({ settleOnChains: vi.fn(), hashJobResult: vi.fn() }));
vi.mock("@/lib/secrets", () => ({ encryptValue: vi.fn(), decryptValue: vi.fn() }));
vi.mock("@/lib/firestore-admin", () => ({
  enforceCapability: vi.fn(async () => ({})), getAgentCapabilities: vi.fn(async () => []), getAgent: vi.fn(),
  getAgentsByOrg: vi.fn(), getOrganizationsByWalletAdmin: vi.fn(),
}));
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
const get = () => new Request("http://x/");

const TESTNET_WALLET = { agentId: "a1", orgId: "org1", walletId: "w1", address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", network: "testnet" };
const MAINNET_WALLET = { ...TESTNET_WALLET, network: "mainnet" };

/** Every call this test's Hyperliquid stub received: which host, and the info type or exchange action. */
const calls: { host: string; path: string; type: string; body: Record<string, unknown> }[] = [];

/** A Hyperliquid testnet that fills market orders at 2000.5 (oid 77, tx 0xfeed) and rests triggers. */
function stubHyperliquid({ accountValue = 200, position = null as null | { szi: string; positionValue: string }, openOrders = [] as unknown[] } = {}) {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    const u = new URL(url);
    const body = JSON.parse(init.body);
    const isExchange = u.pathname === "/exchange";
    const type = isExchange ? `exchange:${body.action.type}` : body.type;
    calls.push({ host: u.host, path: u.pathname, type, body });
    const json = (d: unknown) => new Response(JSON.stringify(d));
    if (isExchange) {
      if (body.action.type === "usdSend") return json({ status: "ok", response: { type: "default" } });
      const orders = body.action.orders as { t: { trigger?: unknown } }[];
      if (orders.every((o) => o.t.trigger)) {
        return json({ status: "ok", response: { type: "order", data: { statuses: orders.map((_, i) => ({ resting: { oid: 78 + i } })) } } });
      }
      return json({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.01", avgPx: "2000.5", oid: 77 } }] } } });
    }
    switch (body.type) {
      case "allMids": return json({ ETH: "2000" });
      case "meta": return json({ universe: [{ name: "ETH", szDecimals: 4, maxLeverage: 25 }] });
      case "clearinghouseState":
        return json({
          marginSummary: { accountValue: String(accountValue), totalMarginUsed: "0", totalNtlPos: "0" },
          assetPositions: position ? [{ position: { coin: "ETH", entryPx: "2000", unrealizedPnl: "0", ...position } }] : [],
        });
      case "spotClearinghouseState": return json({ balances: [] });
      case "frontendOpenOrders": return json(openOrders);
      case "userFills": return json([{ oid: 77, hash: "0xfeed", closedPnl: position ? "1.25" : "0", coin: "ETH", side: "B", sz: "0.01", px: "2000.5", time: 1 }]);
      case "candleSnapshot":
        return json(Array.from({ length: 60 }, (_, i) => ({ t: i * 60_000, o: "2000", h: "2010", l: "1990", c: "2000", v: "1" })));
      case "l2Book": return json({ levels: [[{ px: "1999.9", sz: "5" }], [{ px: "2000.1", sz: "5" }]] });
      case "metaAndAssetCtxs": return json([{ universe: [] }, []]);
      default: return json({});
    }
  }));
}

function aiBot(params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    id: "s1", orgId: "org1", agentId: "a1", wallet: TESTNET_WALLET.address, type: "ai", coin: "ETH", sizeUsd: 25, enabled: true,
    params: { intervalMs: 60_000, maxDrawdownPct: 50, ...params },
    lastRunAt: null, createdAt: null, pendingSignal: false, pendingSince: null, pendingContext: null, webhookToken: null,
    paper: false, network: "testnet",
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.HYPERLIQUID_EXECUTION;
  delete process.env.HL_TESTNET_FUNDER_KEY;
  store.getInstantTrading.mockResolvedValue(TESTNET_WALLET);
  store.getRiskConfig.mockResolvedValue(null);
  store.getTestnetTopUp.mockResolvedValue({ lastAt: null, totalUsd: 0, count: 0 });
  listAgentWallets.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

describe("entryProtection — every paper and testnet entry gets a stop loss and take profit", () => {
  it("fills in the defaults only where nothing set one", () => {
    expect(entryProtection({}, null, true)).toEqual({ stopLossPct: DEFAULT_STOP_LOSS_PCT, takeProfitPct: DEFAULT_TAKE_PROFIT_PCT, defaulted: true });
    expect(entryProtection({ stopLossPct: 2 }, { defaultTakeProfitPct: 4 }, true)).toEqual({ stopLossPct: 2, takeProfitPct: 4, defaulted: false });
    expect(entryProtection({ trailingStopPct: 3 }, null, true)).toEqual({ takeProfitPct: DEFAULT_TAKE_PROFIT_PCT, defaulted: true });
  });
  it("mainnet keeps only what the order or risk config asks for, and closes carry none", () => {
    expect(entryProtection({}, null, false)).toEqual({ defaulted: false });
    expect(entryProtection({}, { defaultStopLossPct: 3 }, false)).toEqual({ stopLossPct: 3, defaulted: false });
    expect(entryProtection({ reduceOnly: true, stopLossPct: 2 }, null, true)).toEqual({ defaulted: false });
  });
});

describe("usdSend signing parity with the Python SDK", () => {
  // Fixture: hyperliquid-python-sdk sign_usd_transfer_action with Hardhat #0 (throwaway).
  for (const v of usdSendVectors) {
    it(`signs a ${v.mainnet ? "mainnet" : "testnet"} transfer identically`, async () => {
      const action = usdSendAction(v.destination, v.amount, v.time, v.mainnet);
      expect({ ...action }).toEqual({ ...v.action });
      const sig = await signUsdSend(HARDHAT_0, action);
      expect(BigInt(sig.r)).toBe(BigInt(v.signature.r));
      expect(BigInt(sig.s)).toBe(BigInt(v.signature.s));
      expect(sig.v).toBe(v.signature.v);
      const signer = await recoverTypedDataAddress({
        domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 0x66eee, verifyingContract: "0x0000000000000000000000000000000000000000" },
        types: { "HyperliquidTransaction:UsdSend": [
          { name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" },
          { name: "amount", type: "string" }, { name: "time", type: "uint64" },
        ] },
        primaryType: "HyperliquidTransaction:UsdSend",
        message: { hyperliquidChain: action.hyperliquidChain, destination: action.destination, amount: action.amount, time: BigInt(action.time) },
        signature: serializeSignature({ r: sig.r, s: sig.s, v: BigInt(sig.v) }),
      });
      expect(signer).toBe(TESTNET_WALLET.address);
    });
  }
});

describe("TESTNET trades — signed here, every fill with its testnet transaction", () => {
  it("a testnet trade fills natively and returns MODE TESTNET, the tx hash and the default SL/TP", async () => {
    stubHyperliquid();
    const resp = await route("POST /trade")(post({ coin: "ETH", isBuy: true, sizeUsd: 20, network: "testnet" }), agentCtx());
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data).toMatchObject({
      taskId: "task-native", network: "testnet", mode: "TESTNET",
      fill: {
        network: "testnet", status: "filled", oid: 77, sz: 0.01, avgPx: 2000.5, txHash: "0xfeed",
        explorerUrl: "https://app.hyperliquid-testnet.xyz/explorer/tx/0xfeed", protectionError: null,
      },
    });
    // 5% under and 10% over the 2000.5 entry.
    expect(data.fill.stopLossPx).toBeCloseTo(1900.5, 0);
    expect(data.fill.takeProfitPx).toBeCloseTo(2200.6, 0);
    expect(calls.every((c) => c.host === "api.hyperliquid-testnet.xyz")).toBe(true);
    const triggers = calls.filter((c) => c.type === "exchange:order").at(-1)!.body.action as { orders: { r: boolean; t: { trigger: { tpsl: string } } }[] };
    expect(triggers.orders.map((o) => [o.r, o.t.trigger.tpsl])).toEqual([[true, "sl"], [true, "tp"]]);
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(recordCompletedTask).toHaveBeenCalledWith("task-native", expect.objectContaining({
      payload: expect.objectContaining({ network: "testnet", execution: "native", stopLossPct: 5, takeProfitPct: 10 }),
    }));
  });

  it("closing reports the testnet P&L and transaction", async () => {
    stubHyperliquid({ position: { szi: "0.01", positionValue: "20" } });
    const resp = await route("POST /close")(post({ coin: "ETH", network: "testnet" }), agentCtx());
    const data = await resp.json();
    expect(data).toMatchObject({ mode: "TESTNET", closing: { coin: "ETH", side: "long" }, fill: { realizedPnl: 1.25, txHash: "0xfeed" } });
    // A close places no new protection.
    expect(calls.filter((c) => c.type === "exchange:order")).toHaveLength(1);
  });

  it("network: testnet is refused when the agent's wallet is on mainnet — nothing reaches Hyperliquid's exchange", async () => {
    store.getInstantTrading.mockResolvedValue(MAINNET_WALLET);
    stubHyperliquid();
    const resp = await route("POST /trade")(post({ coin: "ETH", isBuy: true, sizeUsd: 20, network: "testnet" }), agentCtx());
    expect(resp.status).toBe(409);
    expect((await resp.json()).error).toMatch(/MAINNET/);
    expect(calls.filter((c) => c.path === "/exchange")).toHaveLength(0);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("mainnet orders keep the worker queue unless HYPERLIQUID_EXECUTION says otherwise", async () => {
    store.getInstantTrading.mockResolvedValue(MAINNET_WALLET);
    stubHyperliquid();
    const resp = await route("POST /trade")(post({ coin: "ETH", isBuy: true, sizeUsd: 20 }), agentCtx());
    expect(await resp.json()).toMatchObject({ taskId: "task-queued", mode: "LIVE", network: "mainnet" });
    expect(calls.filter((c) => c.path === "/exchange")).toHaveLength(0);
  });
});

describe("POST /testnet/setup — the agent's own way onto testnet", () => {
  it("creates the custodial wallet, turns testnet on, and tops it up from the hub's funder", async () => {
    store.getInstantTrading.mockResolvedValue(null);
    generateAgentWallet.mockResolvedValue({ id: "w9", publicKey: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", chain: "evm" });
    process.env.HL_TESTNET_FUNDER_KEY = HARDHAT_1;
    stubHyperliquid({ accountValue: 0 });

    const resp = await route("POST /testnet/setup")(post({}), agentCtx());
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data).toMatchObject({ mode: "TESTNET", address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", enabled: true, funding: { status: "sent", amountUsd: 500 } });
    expect(store.setInstantTrading).toHaveBeenCalledWith("a1", expect.objectContaining({ network: "testnet", walletId: "w9", enabledBy: "agent:a1" }));
    expect(store.setRiskConfig).toHaveBeenCalled();
    const send = calls.find((c) => c.type === "exchange:usdSend")!;
    expect(send.host).toBe("api.hyperliquid-testnet.xyz");
    expect(send.body.action).toMatchObject({ destination: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", amount: "500", hyperliquidChain: "Testnet" });
    expect(store.recordTestnetTopUp).toHaveBeenCalledWith("a1", expect.objectContaining({ amountUsd: 500 }));
  });

  it("says where to claim testnet USDC when the hub has no funder", async () => {
    stubHyperliquid({ accountValue: 0 });
    const data = await (await route("POST /testnet/setup")(post({}), agentCtx())).json();
    expect(data.funding).toMatchObject({ status: "manual", message: expect.stringContaining("hyperliquid-testnet.xyz/drip") });
    expect(calls.some((c) => c.type === "exchange:usdSend")).toBe(false);
  });

  it("never touches an agent that already trades mainnet", async () => {
    store.getInstantTrading.mockResolvedValue(MAINNET_WALLET);
    stubHyperliquid();
    const resp = await route("POST /testnet/setup")(post({}), agentCtx());
    expect(resp.status).toBe(409);
    expect(store.setInstantTrading).not.toHaveBeenCalled();
  });

  it("GET /testnet/:agentId lists positions with their SL/TP and fills with tx hashes", async () => {
    stubHyperliquid({
      position: { szi: "0.01", positionValue: "20" },
      openOrders: [{ coin: "ETH", oid: 78, side: "A", sz: "0.01", isTrigger: true, triggerPx: "1900.5", orderType: "Stop Market", reduceOnly: true }],
    });
    const data = await (await route("GET /testnet/:agentId")(get(), agentCtx({ agentId: "a1" }))).json();
    expect(data).toMatchObject({
      mode: "TESTNET", enabled: true,
      positions: [{ coin: "ETH", side: "long", stopLossPx: 1900.5, takeProfitPx: null, protected: true }],
      recentFills: [{ txHash: "0xfeed", explorerUrl: "https://app.hyperliquid-testnet.xyz/explorer/tx/0xfeed" }],
    });
  });
});

describe("testnet bots", () => {
  it("paper/train with network testnet starts the trainer on the testnet wallet", async () => {
    stubHyperliquid();
    store.getStrategy.mockResolvedValue(null);
    const data = await (await route("POST /paper/train")(post({ coin: "ETH", goal: "Trade ETH trend breaks, stay flat in chop.", network: "testnet" }), agentCtx())).json();
    expect(data).toMatchObject({ paper: false, network: "testnet", mode: "TESTNET" });
    expect(store.createStrategy).toHaveBeenCalledWith(expect.objectContaining({ paper: false, network: "testnet", wallet: TESTNET_WALLET.address }));
  });

  it("paper/train with network testnet needs the testnet wallet first", async () => {
    store.getInstantTrading.mockResolvedValue(null);
    const resp = await route("POST /paper/train")(post({ coin: "ETH", goal: "Trade ETH trend breaks, stay flat in chop.", network: "testnet" }), agentCtx());
    expect(resp.status).toBe(409);
    expect((await resp.json()).error).toMatch(/hyperliquid_testnet_setup/);
    expect(store.createStrategy).not.toHaveBeenCalled();
  });

  it("a testnet bot's round stays open 16 minutes, even at a 1-minute cadence", async () => {
    stubHyperliquid();
    store.getEnabledStrategies.mockResolvedValue([aiBot({ discipline: false })]);
    const before = Date.now();
    await runAiTraderTick();
    const { expiresAt } = (store.createAiRequest.mock.calls[0] as unknown as [{ expiresAt: Date }])[0];
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(16 * 60_000 - 1000);
  });

  it("a mainnet bot's round stays short: real money doesn't trade on an old snapshot", async () => {
    store.getInstantTrading.mockResolvedValue(MAINNET_WALLET);
    stubHyperliquid();
    store.getEnabledStrategies.mockResolvedValue([aiBot({ intervalMs: 3_600_000, discipline: false }, { network: "mainnet" })]);
    const before = Date.now();
    await runAiTraderTick();
    const { expiresAt } = (store.createAiRequest.mock.calls[0] as unknown as [{ expiresAt: Date }])[0];
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(10 * 60_000 + 1000);
  });

  it("a testnet bot stops instead of trading when the wallet moved to mainnet", async () => {
    store.getInstantTrading.mockResolvedValue(MAINNET_WALLET);
    stubHyperliquid();
    store.getEnabledStrategies.mockResolvedValue([aiBot()]);
    await runAiTraderTick();
    expect(store.createAiRequest).not.toHaveBeenCalled();
    expect(store.recordAiDecision).toHaveBeenCalledWith("s1", expect.objectContaining({ error: expect.stringMatching(/pinned to TESTNET/) }));
  });
});

describe("idle safety — missed rounds never leave a position unattended", () => {
  const expired = { id: "req-old", agentId: "a1", purpose: "live", strategyId: "s1", status: "open", expiresAt: new Date(Date.now() - 1000) };

  it("counts a missed round and says how many are left before it acts", async () => {
    stubHyperliquid({ position: { szi: "0.01", positionValue: "20" } });
    store.getAiRequest.mockResolvedValue(expired);
    store.getEnabledStrategies.mockResolvedValue([aiBot({ openRequestId: "req-old", missedRounds: 0 })]);
    await runAiTraderTick();
    expect(store.expireAiRequest).toHaveBeenCalledWith("req-old");
    expect(store.touchStrategyRun).toHaveBeenCalledWith("s1", expect.objectContaining({ openRequestId: null, missedRounds: 1 }));
    expect(store.recordAiDecision).toHaveBeenCalledWith("s1", expect.objectContaining({ error: expect.stringContaining("1 of 3") }));
    expect(store.toggleStrategy).not.toHaveBeenCalled();
    expect(calls.some((c) => c.path === "/exchange")).toBe(false);
  });

  it("the third missed round in a row closes the bot's position on testnet and pauses it", async () => {
    stubHyperliquid({ position: { szi: "0.01", positionValue: "20" } });
    store.getAiRequest.mockResolvedValue(expired);
    store.getEnabledStrategies.mockResolvedValue([aiBot({ openRequestId: "req-old", missedRounds: 2 })]);
    await runAiTraderTick();
    const order = calls.find((c) => c.type === "exchange:order")!.body.action as { orders: { b: boolean; r: boolean }[] };
    expect(order.orders[0]).toMatchObject({ b: false, r: true });
    expect(store.toggleStrategy).toHaveBeenCalledWith("s1", false);
    expect(store.touchStrategyRun).toHaveBeenCalledWith("s1", expect.objectContaining({ missedRounds: 0, idlePausedAt: expect.any(Number) }));
    expect(store.recordAiDecision).toHaveBeenCalledWith("s1", expect.objectContaining({ action: "close", reasoning: expect.stringMatching(/Idle safety: 3 rounds/) }));
  });
});

describe("GET /ai/requests labels each question with what answering it trades", () => {
  it("paper, testnet and backtest questions say so — none of them claims to be live", async () => {
    store.listOpenAiRequests.mockResolvedValue([
      { id: "r1", purpose: "live", strategyId: "sp", coin: "ETH", system: "", prompt: "", expiresAt: new Date() },
      { id: "r2", purpose: "live", strategyId: "st", coin: "BTC", system: "", prompt: "", expiresAt: new Date() },
      { id: "r3", purpose: "backtest", strategyId: null, coin: "SOL", system: "", prompt: "", expiresAt: new Date() },
    ]);
    store.getStrategy.mockImplementation(async (id: string) => (id === "sp" ? aiBot({}, { id: "sp", paper: true, network: null }) : aiBot({}, { id: "st" })));
    const { requests } = await (await route("GET /ai/requests")(get(), agentCtx())).json();
    expect(requests.map((r: { id: string; purpose: string; mode: string; paper: boolean }) => [r.id, r.purpose, r.mode, r.paper])).toEqual([
      ["r1", "trade", "PAPER", true],
      ["r2", "trade", "TESTNET", false],
      ["r3", "backtest", "NONE", true],
    ]);
  });
});
