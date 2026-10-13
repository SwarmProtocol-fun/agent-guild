/**
 * Live end-to-end test of the Ethereum mod's signing routes on Sepolia (and
 * Base Sepolia when funded). Skipped unless ETH_LIVE_KEY_FILE points at a
 * file holding a funded throwaway private key:
 *
 *   ETH_LIVE_KEY_FILE=/path/to/key npx vitest run ethereum-live
 *
 * Only storage is stubbed (agent record, capabilities, wallet lookup,
 * policy, activity log). Routes, signing, RPC, receipts and revert
 * handling are the production code against the real chain. Spends a few
 * thousandths of test ETH per run.
 */
import fs from "node:fs";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { createPublicClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, baseSepolia } from "viem/chains";
import type { ServerMod, RouteContext } from "../sdk";

const KEY_FILE = process.env.ETH_LIVE_KEY_FILE;
const KEY = KEY_FILE && fs.existsSync(KEY_FILE) ? (fs.readFileSync(KEY_FILE, "utf8").trim() as `0x${string}`) : null;
const DEV = KEY ? privateKeyToAccount(KEY).address : "0x0000000000000000000000000000000000000000";

vi.mock("@/lib/firebase-admin", () => ({
  adminDb: () => ({
    collection: () => ({
      doc: () => ({ set: async () => {} }),
      where: () => ({ orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) }),
    }),
  }),
}));
vi.mock("@/lib/firestore-admin", () => ({
  getAgentCapabilities: vi.fn(async () => ["eth-inspect", "eth-simulate", "eth-testnet", "eth-trade"].map((key) => ({ key }))),
  enableModCapabilities: vi.fn(),
  getAgent: vi.fn(async () => ({ id: "live", orgId: "o1", name: "live" })),
  getAgentsByOrg: vi.fn(async () => []),
  getOrganizationsByWalletAdmin: vi.fn(async () => []),
}));
vi.mock("@/lib/auth-guard", () => ({ requireOrgMembershipByAddress: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/wallet-address", () => ({ canonicalizeWalletAddress: (a: string) => a.toLowerCase() }));
vi.mock("../../../../mods/ethereum/paper-store", async () => {
  const { DEFAULT_POLICY } = await import("../../../../mods/ethereum/paper");
  return {
    getPolicy: vi.fn(async () => ({ ...DEFAULT_POLICY })), setPolicy: vi.fn(), getPaperWallet: vi.fn(), resetPaperWallet: vi.fn(),
    listOrgPaperWallets: vi.fn(async () => []), listPaperTrades: vi.fn(async () => []), bookPaperTrade: vi.fn(),
  };
});
vi.mock("@/lib/agent-wallets", () => ({
  listAgentWallets: vi.fn(async () => [{ id: "live-wallet", chain: "evm", label: "eth-dev", orgId: "o1", publicKey: DEV }]),
  generateAgentWallet: vi.fn(),
  getAgentWalletEvmPrivateKey: vi.fn(async () => KEY),
}));

const AGENT = { agent: { agentId: "live", orgId: "o1" }, session: null };
const DEAD = "0x000000000000000000000000000000000000dEaD";
const WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"; // Sepolia WETH9
/** Hand-assembled counter: constructor(uint256) stores the arg; 32 bytes of calldata set it; empty calldata returns it. */
const COUNTER = "0x6020602038036000396000516000556018601b60003960186000f33615600c57600035600055005b60005460005260206000f3";

async function call(method: string, path: string, body?: unknown) {
  const { default: mod } = (await import("../../../../mods/ethereum/server")) as { default: ServerMod };
  const { matchRoute } = await import("../router");
  const url = new URL(`http://x/api/mods/ethereum${path}`);
  const m = matchRoute(mod.routes!, method, url.pathname.split("/").slice(4))!;
  const handler = typeof m.def === "function" ? m.def : m.def.handler;
  const res = (await handler(new Request(url, { method, body: body ? JSON.stringify(body) : undefined }), { params: m.params, ...AGENT } as unknown as RouteContext)) as Response;
  const data = await res.json();
  if (res.status !== 200) throw new Error(`${method} ${path} → ${res.status}: ${data.error}`);
  return data;
}

const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

describe.skipIf(!KEY)("live Sepolia signing", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const bal = await createPublicClient({ chain: sepolia, transport: http(process.env.ETH_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com") }).getBalance({ address: DEV });
    if (bal < parseEther("0.003")) throw new Error(`${DEV} holds ${bal} wei on Sepolia — fund it with ~0.01 ETH first`);
  });

  it("eth_me sees the wallet and its balance", async () => {
    const me = await call("GET", "/me");
    expect(me.devWallet.address).toBe(DEV);
    expect(Number(me.devWallet.balances.sepolia)).toBeGreaterThan(0);
  });

  let transferHash = "";
  it("transfers ETH and waits for the receipt", async () => {
    const out = await call("POST", "/dev/transfer", { network: "sepolia", to: DEAD, amount: "0.0001" });
    expect(out.status).toBe("success");
    expect(out.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number(out.feeEth)).toBeGreaterThan(0);
    transferHash = out.hash;
  });

  it("inspects the transfer it just made", async () => {
    const { tx } = await call("GET", `/dev/tx/${transferHash}?network=sepolia`);
    expect(tx.status).toBe("success");
    expect(tx.from).toBe(DEV);
    expect(tx.valueEth).toBe("0.0001");
  });

  it("calls a payable function with value (WETH deposit)", async () => {
    const out = await call("POST", "/dev/send", { network: "sepolia", to: WETH, signature: "deposit()", value: "0.0005" });
    expect(out.status).toBe("success");
  });

  let tokenHash = "";
  it("transfers an ERC-20 it holds, with decimals read on-chain", async () => {
    const out = await call("POST", "/dev/transfer", { network: "sepolia", to: DEAD, amount: "0.0002", token: WETH });
    expect(out.status).toBe("success");
    expect(out.symbol).toBe("WETH");
    expect(out.amountUi).toBe("0.0002");
    tokenHash = out.hash;
  });

  it("decodes the token transfer's Transfer log", async () => {
    const { tx } = await call("GET", `/dev/tx/${tokenHash}?network=sepolia`);
    expect(tx.call.functionName).toBe("transfer");
    expect(tx.logs.find((l: { event: string }) => l.event === "Transfer")).toMatchObject({ symbol: "WETH", amount: "0.0002" });
  });

  it("refuses a call that would revert, without sending or paying", async () => {
    const out = await call("POST", "/dev/send", { network: "sepolia", to: WETH, signature: "withdraw(uint256)", args: [parseEther("1000").toString()] });
    expect(out.status).toBe("rejected");
    expect(out.hash).toBeNull();
    expect(out.revert.kind).toBe("empty"); // WETH9's bare require()
  });

  it("refuses a send it can't pay for, before signing", async () => {
    await expect(call("POST", "/dev/send", { network: "sepolia", to: DEAD, value: "0.9" })).rejects.toThrow(/not enough|can't cover|insufficient/i);
  });

  it("deploys a contract with a constructor arg, then writes and reads it", async () => {
    const out = await call("POST", "/dev/deploy", { network: "sepolia", bytecode: COUNTER, constructorSignature: "constructor(uint256 start)", args: ["42"] });
    expect(out.status).toBe("success");
    expect(out.contractAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Public RPCs load-balance, so the node answering a read can be a block behind the one that saw the write: poll.
    const read = async (want: bigint) => {
      for (let i = 0; i < 15; i++) {
        const ret = (await call("POST", "/dev/simulate", { network: "sepolia", to: out.contractAddress })).simulation.returnData;
        if (ret && ret !== "0x" && BigInt(ret) === want) return want;
        await new Promise((r) => setTimeout(r, 2000));
      }
      return null;
    };
    expect(await read(42n)).toBe(42n);
    const set = await call("POST", "/dev/send", { network: "sepolia", to: out.contractAddress, data: word(7n) });
    expect(set.status).toBe("success");
    expect(await read(7n)).toBe(7n);
  });
});

describe.skipIf(!KEY)("live Base Sepolia signing", { timeout: 120_000 }, () => {
  it("transfers ETH when the wallet is funded there", async (ctx) => {
    const bal = await createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") }).getBalance({ address: DEV });
    if (bal < parseEther("0.0005")) ctx.skip();
    const out = await call("POST", "/dev/transfer", { network: "base-sepolia", to: DEAD, amount: "0.0001" });
    expect(out.status).toBe("success");
  });
});
