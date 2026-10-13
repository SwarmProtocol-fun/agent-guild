import { describe, it, expect, vi, beforeEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { ServerMod, RouteContext } from "../sdk";

// Capabilities granted to the test agent; tests flip entries on and off.
const granted = new Set<string>();

vi.mock("@/lib/firebase-admin", () => ({
  adminDb: () => ({
    collection: () => ({
      doc: () => ({ set: async () => {} }),
      where: () => ({ orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) }),
    }),
  }),
}));
vi.mock("@/lib/firestore-admin", () => ({
  getAgentCapabilities: vi.fn(async () => [...granted].map((key) => ({ key }))),
  enableModCapabilities: vi.fn(async (_o: string, modId: string, caps: string[]) => ({ installed: modId === "mod-ethereum", enabled: caps })),
  getAgent: vi.fn(async (id: string) => (id === "a1" ? { id: "a1", orgId: "o1", name: "chef" } : null)),
  getAgentsByOrg: vi.fn(async () => []),
  getOrganizationsByWalletAdmin: vi.fn(async (addr: string) => [{ id: "o1", name: "Org", ownerAddress: "OWNER" }].filter(() => addr !== "STRANGER")),
}));
vi.mock("@/lib/auth-guard", () => ({
  requireOrgMembershipByAddress: vi.fn(async (addr: string) => (addr === "OUTSIDER" ? { ok: false, status: 403, error: "Not a member" } : { ok: true })),
}));
vi.mock("@/lib/wallet-address", () => ({ canonicalizeWalletAddress: (a: string) => a.toLowerCase() }));
const policy = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../../../../mods/ethereum/paper-store", async () => {
  const { DEFAULT_POLICY } = await import("../../../../mods/ethereum/paper");
  return {
    getPolicy: vi.fn(async () => ({ ...DEFAULT_POLICY, ...(policy.current ?? {}) })),
    setPolicy: vi.fn(async (_a: string, _o: string, p: Record<string, unknown>) => { policy.current = p; }),
    getPaperWallet: vi.fn(), resetPaperWallet: vi.fn(), listOrgPaperWallets: vi.fn(async () => []),
    listPaperTrades: vi.fn(async () => []), bookPaperTrade: vi.fn(),
  };
});
const DEV = "0x1111111111111111111111111111111111111111";
const listAgentWallets = vi.hoisted(() => vi.fn());
const getKey = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-wallets", () => ({
  listAgentWallets,
  generateAgentWallet: vi.fn(async () => ({ publicKey: DEV })),
  getAgentWalletEvmPrivateKey: getKey,
}));

const AGENT_CTX = { agent: { agentId: "a1", orgId: "o1" }, session: null };
const SESSION_CTX = (address = "OWNER") => ({ agent: null, session: { address, role: "operator" } });

async function call(method: string, path: string, ctxBase: object, body?: unknown) {
  const { default: mod } = (await import("../../../../mods/ethereum/server")) as { default: ServerMod };
  const { matchRoute } = await import("../router");
  const url = new URL(`http://x/api/mods/ethereum${path}`);
  const m = matchRoute(mod.routes!, method, url.pathname.split("/").slice(4));
  if (!m) throw new Error(`no route ${method} ${path}`);
  const handler = typeof m.def === "function" ? m.def : m.def.handler;
  const req = new Request(url, { method, body: body ? JSON.stringify(body) : undefined });
  return (await handler(req, { params: m.params, ...ctxBase } as unknown as RouteContext)) as Response;
}

beforeEach(() => {
  granted.clear();
  policy.current = null;
  getKey.mockReset();
  listAgentWallets.mockImplementation(async () => [{ id: "w1", chain: "evm", label: "eth-dev", orgId: "o1", publicKey: DEV }]);
});

describe("discovery", () => {
  it("serves tool definitions publicly, all pointing at real routes", async () => {
    const { default: mod } = (await import("../../../../mods/ethereum/server")) as { default: ServerMod };
    const { matchRoute } = await import("../router");
    const res = await call("GET", "/agent/tools", { agent: null, session: null });
    const { tools } = await res.json();
    expect(tools.length).toBeGreaterThan(15);
    for (const t of tools) {
      const segs = t.path.replace(/\{(\w+)\}/g, "x").split("/");
      expect(matchRoute(mod.routes!, t.method, segs), `${t.name} → ${t.method} ${t.path}`).toBeTruthy();
    }
  });

  it("GET /me works with no capabilities and reports what is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const res = await call("GET", "/me", AGENT_CTX);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.capabilities).toEqual({ "eth-inspect": false, "eth-simulate": false, "eth-testnet": false, "eth-trade": false });
    expect(d.devWallet.address).toBe(DEV);
    vi.unstubAllGlobals();
  });
});

describe("capability gating", () => {
  it("an agent needs eth-inspect for reads, a session doesn't", async () => {
    const data = "0x4e487b710000000000000000000000000000000000000000000000000000000000000011";
    expect((await call("POST", "/dev/decode", AGENT_CTX, { data })).status).toBe(403);
    granted.add("eth-inspect");
    expect((await call("POST", "/dev/decode", AGENT_CTX, { data })).status).toBe(200);
    granted.clear();
    const res = await call("POST", "/dev/decode", SESSION_CTX(), { data });
    expect((await res.json()).revert.message).toMatch(/overflow/);
  });

  it("signing needs eth-testnet and an org the session belongs to", async () => {
    expect((await call("POST", "/dev/send", AGENT_CTX, { network: "sepolia", to: DEV, value: "0.01" })).status).toBe(403);
    granted.add("eth-testnet");
    expect((await call("POST", "/dev/send", SESSION_CTX("OUTSIDER"), { agentId: "a1", network: "sepolia", to: DEV })).status).toBe(403);
    expect((await call("POST", "/dev/send", SESSION_CTX(), { network: "sepolia", to: DEV })).status).toBe(400); // no agentId
  });

  it("a session simulating without an agent must say who to simulate as", async () => {
    const res = await call("POST", "/dev/simulate", SESSION_CTX(), { network: "mainnet", to: DEV });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/from/);
  });
});

describe("testnet-only signing", () => {
  beforeEach(() => granted.add("eth-testnet"));

  it.each(["mainnet", "base"])("never signs on %s — and never decrypts the key", async (network) => {
    for (const [path, body] of [
      ["/dev/send", { network, to: DEV, value: "0.01" }],
      ["/dev/transfer", { network, to: DEV, amount: "0.01" }],
      ["/dev/deploy", { network, bytecode: "0x6080" }],
    ] as const) {
      const res = await call("POST", path, AGENT_CTX, body);
      expect(res.status, path).toBe(400);
      expect((await res.json()).error).toMatch(/only signs on sepolia\/base-sepolia/);
    }
    expect(getKey).not.toHaveBeenCalled();
  });

  it("rejects an RPC URL in place of a network", async () => {
    const res = await call("POST", "/dev/send", AGENT_CTX, { network: "http://169.254.169.254", to: DEV });
    expect(res.status).toBe(400);
  });
});

describe("owner policy", () => {
  beforeEach(() => granted.add("eth-testnet"));

  it("refuses sends over the ETH cap or off the allowlist before signing", async () => {
    let res = await call("POST", "/dev/send", AGENT_CTX, { network: "sepolia", to: DEV, value: "5" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/1 ETH/);
    policy.current = { transferAllowlist: ["0x2222222222222222222222222222222222222222"] };
    res = await call("POST", "/dev/transfer", AGENT_CTX, { network: "sepolia", to: DEV, amount: "0.1" });
    expect(res.status).toBe(403);
    policy.current = { paused: true };
    res = await call("POST", "/dev/deploy", AGENT_CTX, { network: "sepolia", bytecode: "0x6080" });
    expect((await res.json()).error).toMatch(/paused/);
    expect(getKey).not.toHaveBeenCalled();
  });

  it("only the org owner edits limits or resets the paper wallet", async () => {
    expect((await call("POST", "/policy", AGENT_CTX, { maxTradeUsd: 1 })).status).toBe(401);
    expect((await call("POST", "/policy", SESSION_CTX("member"), { agentId: "a1", maxTradeUsd: 1 })).status).toBe(403);
    const ok = await call("POST", "/policy", SESSION_CTX(), { agentId: "a1", maxTradeUsd: 100, allowedTokens: ["LINK"] });
    expect(ok.status).toBe(200);
    expect((await ok.json()).policy.allowedTokens).toEqual(["0x514910771af9ca656af840dff83e8264ecf986ca"]);
    expect((await call("POST", "/paper/reset", AGENT_CTX, {})).status).toBe(401);
  });

  it("POST /upgrade enables all four capabilities for the owner", async () => {
    const res = await call("POST", "/upgrade", SESSION_CTX(), { orgId: "o1" });
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toEqual(["eth-inspect", "eth-simulate", "eth-testnet", "eth-trade"]);
    expect((await call("POST", "/upgrade", SESSION_CTX("member"), { orgId: "o1" })).status).toBe(403);
  });
});

describe("tools the agent doesn't have alone", () => {
  // Throwaway test key; holds nothing anywhere.
  const KEY = `0x${"11".repeat(32)}` as const;
  const KEY_ADDR = privateKeyToAccount(KEY).address;

  it("eth_util needs eth-inspect for an agent and works for a session", async () => {
    expect((await call("POST", "/dev/util", AGENT_CTX, { op: "selector", signature: "transfer(address,uint256)" })).status).toBe(403);
    granted.add("eth-inspect");
    const res = await call("POST", "/dev/util", AGENT_CTX, { op: "selector", signature: "transfer(address,uint256)" });
    expect(await res.json()).toMatchObject({ op: "selector", selector: "0xa9059cbb" });
    expect((await call("POST", "/dev/util", SESSION_CTX(), { op: "keccak256", text: "" })).status).toBe(200);
  });

  it("signs a message with the dev wallet, and refuses typed data for a mainnet domain", async () => {
    granted.add("eth-testnet");
    getKey.mockResolvedValue(KEY);
    const msg = await call("POST", "/dev/sign", AGENT_CTX, { message: "hello" });
    expect(msg.status).toBe(200);
    const signed = await msg.json();
    expect(signed).toMatchObject({ address: KEY_ADDR, kind: "message" });
    const { verifyMessage } = await import("viem");
    expect(await verifyMessage({ address: KEY_ADDR, message: "hello", signature: signed.signature })).toBe(true);

    const typed = (chainId: number) => ({
      typedData: {
        domain: { name: "Permit", version: "1", chainId, verifyingContract: DEV },
        types: { Mail: [{ name: "contents", type: "string" }] }, primaryType: "Mail", message: { contents: "hi" },
      },
    });
    const refused = await call("POST", "/dev/sign", AGENT_CTX, typed(1));
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/testnet/);
    expect((await call("POST", "/dev/sign", AGENT_CTX, typed(11155111))).status).toBe(200);
  });

  it("deploy-source returns compile errors and sends nothing", async () => {
    granted.add("eth-testnet");
    const res = await call("POST", "/dev/deploy-source", AGENT_CTX, { source: "pragma solidity ^0.8.20; contract X { function f() public { nope(); } }" });
    expect(res.status).toBe(400);
    const out = await res.json();
    expect(out.status).toBe("compile-failed");
    expect(out.errors[0].message).toMatch(/Undeclared identifier/);
    expect(getKey).not.toHaveBeenCalled();
  }, 60_000);

  it("compile needs eth-simulate for an agent", async () => {
    const src = { source: "pragma solidity ^0.8.20; contract X { uint public n; }" };
    expect((await call("POST", "/dev/compile", AGENT_CTX, src)).status).toBe(403);
    granted.add("eth-simulate");
    const out = await (await call("POST", "/dev/compile", AGENT_CTX, src)).json();
    expect(out).toMatchObject({ ok: true, contracts: [{ name: "X", functions: ["n() view returns (uint256)"] }] });
    expect(out.contracts[0].bytecode).toBeUndefined();
  }, 60_000);
});
