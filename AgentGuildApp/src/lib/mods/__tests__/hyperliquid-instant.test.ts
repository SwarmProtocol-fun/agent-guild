import { describe, it, expect, vi, beforeEach } from "vitest";

const store = {
  getInstantTrading: vi.fn(),
  setInstantTrading: vi.fn(),
  deleteInstantTrading: vi.fn(),
  getRiskConfig: vi.fn(),
  setRiskConfig: vi.fn(),
  getAgentWallet: vi.fn(),
  getDailyRealizedPnl: vi.fn(async () => 0),
};
const wallets = {
  listAgentWallets: vi.fn(),
  generateAgentWallet: vi.fn(),
  getAgentWalletEvmPrivateKey: vi.fn(async () => "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"),
};
const enqueueTask = vi.fn(async () => "task-1");

vi.mock("@/lib/mods/hyperliquid-store", () => store);
vi.mock("@/lib/agent-wallets", () => wallets);
vi.mock("@/lib/gateway/store", () => ({ enqueueTask, getTask: vi.fn() }));
vi.mock("@/lib/settlement/registry", () => ({ settleOnChains: vi.fn(), hashJobResult: vi.fn() }));
vi.mock("@/lib/secrets", () => ({ encryptValue: vi.fn(), decryptValue: vi.fn() }));
vi.mock("@/lib/firestore-admin", () => ({
  enforceCapability: vi.fn(async () => ({})),
  getAgentCapabilities: vi.fn(async () => []),
  getAgent: vi.fn(async (id: string) => ({ id, orgId: "org1", name: "Trader" })),
  getAgentsByOrg: vi.fn(),
  getOrganizationsByWalletAdmin: vi.fn(),
}));
vi.mock("@/lib/auth-guard", () => ({
  requireOrgMembershipByAddress: vi.fn(async (address: string) =>
    ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"].includes(address)
      ? { ok: true, org: { id: "org1", ownerAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }
      : { ok: false, error: "Not a member", status: 403 }),
}));

const { default: mod } = await import("../../../../mods/hyperliquid-trading/server");

type Handler = (req: Request, ctx: unknown) => Promise<Response>;
function route(key: string): Handler {
  const def = mod.routes![key] as Handler | { handler: Handler };
  return typeof def === "function" ? def : def.handler;
}
function ctx(extra: Record<string, unknown>) {
  return { modId: "hyperliquid-trading", log: { info() {}, warn() {}, error() {} }, emit: async () => {}, params: {}, session: null, agent: null, ...extra };
}
const post = (body: unknown) => new Request("http://x/", { method: "POST", body: JSON.stringify(body) });

// The live risk gate reads the agent's open position off Hyperliquid before
// sending. Tests answer it here and never touch the network.
let openPositions: { coin: string; szi: string; positionValue: string }[] = [];
let clearinghouseFails = false;
const infoFetch = vi.fn(async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  if (body.type !== "clearinghouseState") throw new Error(`unexpected ${body.type}`);
  if (clearinghouseFails) return { ok: false, status: 502, text: async () => "bad gateway", json: async () => ({}) };
  return {
    ok: true,
    json: async () => ({
      assetPositions: openPositions.map((p) => ({ position: { ...p, unrealizedPnl: "0", entryPx: "2000" } })),
      marginSummary: { accountValue: "1000", totalMarginUsed: "0", totalNtlPos: "0" },
    }),
  };
});
vi.stubGlobal("fetch", infoFetch);
const KEY_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("hyperliquid instant trading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.getInstantTrading.mockResolvedValue(null);
    store.getRiskConfig.mockResolvedValue(null);
    openPositions = [];
    clearinghouseFails = false;
    wallets.listAgentWallets.mockResolvedValue([]);
    wallets.generateAgentWallet.mockResolvedValue({ id: "w1", chain: "evm", publicKey: "0xabc" });
  });

  it("only the org owner can turn it on — not a member, not the agent itself", async () => {
    const on = route("POST /instant-trading");
    expect((await on(post({ agentId: "a1" }), ctx({ session: { address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", role: "operator" } }))).status).toBe(403);
    expect((await on(post({ agentId: "a1" }), ctx({ agent: { agentId: "a1", orgId: "org1" }, session: { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", role: "operator" } }))).status).toBe(403);
    expect(store.setInstantTrading).not.toHaveBeenCalled();
  });

  it("owner turning it on creates a wallet and default risk limits when missing", async () => {
    const resp = await route("POST /instant-trading")(post({ agentId: "a1" }), ctx({ session: { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", role: "operator" } }));
    expect(resp.status).toBe(200);
    expect(wallets.generateAgentWallet).toHaveBeenCalledWith("a1", "org1", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", expect.objectContaining({ chain: "evm" }));
    expect(store.setInstantTrading).toHaveBeenCalledWith("a1", expect.objectContaining({ walletId: "w1", address: "0xabc", network: "testnet" }));
    expect(store.setRiskConfig).toHaveBeenCalledWith("a1", expect.objectContaining({ maxPositionUsd: 100, maxDailyLossUsd: 50 }));
  });

  it("a trade needs no passphrase once instant trading is on, and signs with the custodial key", async () => {
    const trade = route("POST /trade");
    const agentCtx = ctx({ agent: { agentId: "a1", orgId: "org1" } });
    const body = { coin: "ETH", isBuy: true, sizeUsd: 10 };

    const before = await trade(post(body), agentCtx);
    expect(before.status).toBe(400);
    expect((await before.json()).error).toMatch(/masterSecret is required/);

    store.getInstantTrading.mockResolvedValue({ agentId: "a1", orgId: "org1", walletId: "w1", address: "0xabc", network: "testnet" });
    const after = await trade(post(body), agentCtx);
    expect(after.status).toBe(200);
    expect(enqueueTask).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", network: "testnet", coin: "ETH" }),
    }));
  });
});

describe("live risk gate", () => {
  const instantOn = { agentId: "a1", orgId: "org1", walletId: "w1", address: KEY_ADDRESS, network: "testnet" };
  const agentCtx = () => ctx({ agent: { agentId: "a1", orgId: "org1" } });
  const trade = (body: Record<string, unknown>) => route("POST /trade")(post({ coin: "ETH", ...body }), agentCtx());

  beforeEach(() => {
    vi.clearAllMocks();
    store.getInstantTrading.mockResolvedValue(instantOn);
    store.getRiskConfig.mockResolvedValue({ leverage: 3, maxPositionUsd: 100, maxDailyLossUsd: 50 });
    store.getDailyRealizedPnl.mockResolvedValue(0);
    openPositions = [];
    clearinghouseFails = false;
  });

  it("limits the whole position, not each order: a second $60 long on a $60 long is refused", async () => {
    openPositions = [{ coin: "ETH", szi: "0.03", positionValue: "60" }];
    const resp = await trade({ isBuy: true, sizeUsd: 60 });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/\$60\.00 long already open.*\$120\.00 position, over maxPositionUsd 100/);
    expect(enqueueTask).not.toHaveBeenCalled();
    // It read the position of the wallet the order would be signed with.
    expect(JSON.parse((infoFetch.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toMatchObject({ type: "clearinghouseState", user: KEY_ADDRESS });
  });

  it("lets an order through that stays inside the limit, or shrinks an over-limit position", async () => {
    openPositions = [{ coin: "ETH", szi: "0.02", positionValue: "40" }];
    expect((await trade({ isBuy: true, sizeUsd: 60 })).status).toBe(200);

    // Already $150 long (limit since lowered): selling $50 brings it down, so it goes.
    openPositions = [{ coin: "ETH", szi: "0.075", positionValue: "150" }];
    expect((await trade({ isBuy: false, sizeUsd: 50 })).status).toBe(200);
    expect(enqueueTask).toHaveBeenCalledTimes(2);
  });

  it("counts a short as negative: buying $80 against a $60 short leaves a $20 long", async () => {
    openPositions = [{ coin: "ETH", szi: "-0.03", positionValue: "60" }];
    expect((await trade({ isBuy: true, sizeUsd: 80 })).status).toBe(200);
    // ...but selling $60 more on that short makes it $120.
    const more = await trade({ isBuy: false, sizeUsd: 60 });
    expect((await more.json()).error).toMatch(/short already open/);
  });

  it("only counts the order's own coin", async () => {
    openPositions = [{ coin: "BTC", szi: "0.001", positionValue: "95" }];
    expect((await trade({ isBuy: true, sizeUsd: 90 })).status).toBe(200);
  });

  it("fails closed: no order goes if the open position can't be read", async () => {
    clearinghouseFails = true;
    const resp = await trade({ isBuy: true, sizeUsd: 20 });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/Couldn't read the open ETH position/);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("holds an agent with no limits configured to the defaults", async () => {
    store.getRiskConfig.mockResolvedValue(null);
    const big = await trade({ isBuy: true, sizeUsd: 500 });
    expect((await big.json()).error).toMatch(/exceeds default maxPositionUsd 100/);
    store.getDailyRealizedPnl.mockResolvedValue(-60);
    const lossy = await trade({ isBuy: true, sizeUsd: 20 });
    expect((await lossy.json()).error).toMatch(/Daily loss limit reached/);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("queues a live order with no automatic retry, so a timeout can never send it twice", async () => {
    expect((await trade({ isBuy: true, sizeUsd: 20 })).status).toBe(200);
    expect(enqueueTask).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
  });
});
