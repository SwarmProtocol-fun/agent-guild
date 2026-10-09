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
  getAgentWalletEvmPrivateKey: vi.fn(async () => "0xcustodial"),
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

describe("hyperliquid instant trading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.getInstantTrading.mockResolvedValue(null);
    store.getRiskConfig.mockResolvedValue(null);
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
      payload: expect.objectContaining({ privateKey: "0xcustodial", network: "testnet", coin: "ETH" }),
    }));
  });
});
