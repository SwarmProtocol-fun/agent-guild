import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory Firestore: enough of the admin SDK for the automation and paper stores.
const rows = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("@/lib/firebase-admin", () => {
  const ref = (col: string, id: string) => ({
    id,
    get: async () => ({ data: () => rows.get(`${col}/${id}`) }),
    set: async (d: Record<string, unknown>, opts?: { merge?: boolean }) => {
      const prev = opts?.merge ? rows.get(`${col}/${id}`) ?? {} : {};
      rows.set(`${col}/${id}`, structuredClone({ ...prev, ...d }));
    },
  });
  const query = (col: string, filters: Array<[string, unknown]>, n = Infinity) => {
    const match = () => [...rows.entries()]
      .filter(([k, d]) => k.startsWith(`${col}/`) && filters.every(([f, v]) => d[f] === v))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, n)
      .map(([, d]) => ({ data: () => d }));
    const q = {
      where: (f: string, _op: string, v: unknown) => query(col, [...filters, [f, v]], n),
      orderBy: () => q,
      limit: (m: number) => query(col, filters, m),
      get: async () => ({ docs: match() }),
    };
    return q;
  };
  const db = {
    collection: (col: string) => ({ doc: (id: string) => ref(col, id), where: (f: string, op: string, v: unknown) => query(col, []).where(f, op, v) }),
    runTransaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
      const writes: Array<() => Promise<void>> = [];
      const out = await fn({ get: (r: ReturnType<typeof ref>) => r.get(), set: (r: ReturnType<typeof ref>, d: Record<string, unknown>) => writes.push(() => r.set(d)) });
      for (const w of writes) await w();
      return out;
    },
  };
  return { adminDb: () => db };
});

const caps = vi.hoisted(() => ({ list: [{ key: "eth-trade" }, { key: "eth-inspect" }] }));
vi.mock("@/lib/firestore-admin", () => ({
  getAgent: vi.fn(), getAgentsByOrg: vi.fn(), getOrganizationsByWalletAdmin: vi.fn(), enableModCapabilities: vi.fn(),
  getAgentCapabilities: vi.fn(async () => caps.list),
}));
vi.mock("@/lib/auth-guard", () => ({ requireOrgMembershipByAddress: vi.fn() }));
vi.mock("@/lib/agent-wallets", () => ({ listAgentWallets: vi.fn(async () => []), generateAgentWallet: vi.fn(), getAgentWalletEvmPrivateKey: vi.fn() }));

// A chain that's at `chain.block`; the wallet's nonce/balance and Transfer logs come from `chain`.
const chain = vi.hoisted(() => ({ block: 1000n, nonce: 3, balance: 10n ** 18n, logs: [] as unknown[] }));
vi.mock("../../../../mods/ethereum/agent", async (orig) => {
  const real = await orig<typeof import("../../../../mods/ethereum/agent")>();
  const client = {
    getBlockNumber: async () => chain.block,
    getTransactionCount: async () => chain.nonce,
    getBalance: async () => chain.balance,
    getLogs: async (q: { args?: { to?: string; from?: string } }) => (q.args?.to ? chain.logs : []),
    multicall: async () => [{ status: "success", result: "USD Coin" }, { status: "success", result: "USDC" }, { status: "success", result: 6 }, { status: "success", result: 0n }],
  };
  return { ...real, clientFor: () => client };
});

const pay = vi.hoisted(() => ({ hit: null as null | { hash: string; payer: string; block: bigint } }));
vi.mock("../../../../mods/ethereum/chainchecks", async (orig) => ({
  ...(await orig<typeof import("../../../../mods/ethereum/chainchecks")>()),
  findTokenPayment: vi.fn(async () => pay.hit),
  findEthPayment: vi.fn(async () => pay.hit),
}));

import { runEthTick } from "../../../../mods/ethereum/server";
import { createOrder, createPaymentRequest, createWatch, listAlerts, listOrders, listPaymentRequests, listWatches } from "../../../../mods/ethereum/automation-store";
import { NATIVE, USDC } from "../../../../mods/ethereum/market";

const price = { eth: 2000 };
const ME = "0x1111111111111111111111111111111111111111";

// DefiLlama prices and KyberSwap quotes at `price.eth`.
vi.stubGlobal("fetch", vi.fn(async (url: string) => {
  const u = new URL(url);
  if (u.host === "coins.llama.fi" && u.pathname.startsWith("/prices")) {
    const ids = decodeURIComponent(u.pathname.split("/").pop()!).split(",");
    const coins = Object.fromEntries(ids.map((id) => [id, id.endsWith("0x0000000000000000000000000000000000000000")
      ? { price: price.eth, symbol: "ETH", decimals: 18 } : { price: 1, symbol: "USDC", decimals: 6 }]));
    return new Response(JSON.stringify({ coins }));
  }
  if (u.host === "coins.llama.fi") return new Response(JSON.stringify({ coins: {} }));
  if (u.host === "aggregator-api.kyberswap.com") {
    const amountIn = BigInt(u.searchParams.get("amountIn")!);
    const usdcIn = u.searchParams.get("tokenIn")!.toLowerCase() === USDC.toLowerCase();
    const amountOut = usdcIn ? (amountIn * 10n ** 12n) / BigInt(price.eth) : (amountIn * BigInt(price.eth)) / 10n ** 12n;
    const usd = usdcIn ? Number(amountIn) / 1e6 : (Number(amountIn) / 1e18) * price.eth;
    return new Response(JSON.stringify({ code: 0, message: "ok", data: { routeSummary: { amountIn: amountIn.toString(), amountInUsd: String(usd), amountOut: amountOut.toString(), amountOutUsd: String(usd), gasUsd: "0.5", route: [[{ exchange: "uniswap-v3" }]] } } }));
  }
  return new Response("nope", { status: 404 });
}));

const day = 86_400_000;
const later = () => new Date(Date.now() + day).toISOString();
const order = (over: Record<string, unknown> = {}) => createOrder({
  agentId: "a1", orgId: "o1", status: "open", createdAt: new Date().toISOString(), expiresAt: later(),
  inputToken: USDC, outputToken: NATIVE, amount: "1000", slippageBps: null, note: "buy the dip",
  trigger: { token: NATIVE, op: "below", usd: 2100 }, ...over,
});
const watchBase = { agentId: "a1", orgId: "o1", status: "active" as const, createdAt: "", expiresAt: later(), note: null, fireCount: 0 };

beforeEach(() => {
  rows.clear();
  price.eth = 2000;
  caps.list = [{ key: "eth-trade" }, { key: "eth-inspect" }];
  Object.assign(chain, { block: 1000n, nonce: 3, balance: 10n ** 18n, logs: [] });
  pay.hit = null;
});

describe("runEthTick", () => {
  it("fills a triggered order into the paper wallet and leaves an alert", async () => {
    const o = await order();
    expect(await runEthTick()).toMatchObject({ orders: 1, filled: 1, failed: 0, errors: 0 });
    const [after] = await listOrders("a1", "o1");
    expect(after).toMatchObject({ id: o.id, status: "filled", firedPriceUsd: 2000 });
    expect(after.result).toMatch(/1000 USDC → 0\.5 ETH/);
    const [alert] = await listAlerts("a1", "o1");
    expect(alert).toMatchObject({ source: "order", refId: o.id, read: false });
    expect(alert.detail).toMatch(/buy the dip/);
    expect((await runEthTick()).filled).toBe(0);
  });

  it("leaves an untriggered order open and fails one whose upgrade was revoked", async () => {
    price.eth = 2500;
    await order();
    expect(await runEthTick()).toMatchObject({ filled: 0, failed: 0 });
    expect((await listOrders("a1", "o1"))[0].status).toBe("open");
    price.eth = 2000;
    caps.list = [];
    expect(await runEthTick()).toMatchObject({ failed: 1 });
    expect((await listOrders("a1", "o1"))[0].result).toMatch(/upgrade was turned off/);
  });

  it("alerts on address activity: a send, an ETH change and an incoming USDC transfer", async () => {
    await createWatch({ ...watchBase, repeat: true, kind: "activity", network: "sepolia", address: ME, lastBlock: "990", lastNonce: 2, lastBalanceWei: (2n * 10n ** 18n).toString() });
    chain.logs = [{
      address: USDC, blockNumber: 995n, transactionHash: `0x${"ab".repeat(32)}`, logIndex: 0,
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", `0x${"0".repeat(24)}${"22".repeat(20)}`, `0x${"0".repeat(24)}${ME.slice(2)}`],
      data: `0x${(25_000_000n).toString(16).padStart(64, "0")}`,
    }];
    expect(await runEthTick()).toMatchObject({ alerts: 1, errors: 0 });
    const [alert] = await listAlerts("a1", "o1");
    expect(alert.title).toMatch(/sent 1 transaction, ETH −1, USDC \+25 \(1 transfer\)/);
    const [w] = await listWatches("a1", "o1");
    expect(w).toMatchObject({ status: "active", fireCount: 1, lastBlock: "1000", lastNonce: 3 });
    // Nothing new: no second alert.
    chain.block = 1005n;
    chain.logs = [];
    expect((await runEthTick()).alerts).toBe(0);
  });

  it("marks a payment request paid when the exact amount lands", async () => {
    const req = await createPaymentRequest({
      agentId: "a1", orgId: "o1", status: "pending", createdAt: "", expiresAt: later(), network: "base", recipient: ME, token: USDC, symbol: "USDC", decimals: 6,
      requestedUi: "25", amountUi: "25.000042", amountRaw: "25000042", startBlock: "990", scannedThrough: "989", label: "Logo design", url: "ethereum:…",
    });
    await runEthTick();
    expect((await listPaymentRequests("a1", "o1"))[0]).toMatchObject({ status: "pending", scannedThrough: "1000" });
    chain.block = 1010n;
    pay.hit = { hash: `0x${"cd".repeat(32)}`, payer: "0x2222222222222222222222222222222222222222", block: 1007n };
    expect(await runEthTick()).toMatchObject({ paid: 1 });
    expect((await listPaymentRequests("a1", "o1"))[0]).toMatchObject({ id: req.id, status: "paid", paidTx: pay.hit.hash });
    expect((await listAlerts("a1", "o1"))[0].title).toBe("Paid: 25.000042 USDC for Logo design");
  });

  it("expires stale orders and is a no-op while another tick holds the lock", async () => {
    await order({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await runEthTick()).expired).toBe(1);
    rows.set("ethTick/lock", { holder: "other", until: Date.now() + 30_000 });
    await order();
    expect(await runEthTick()).toMatchObject({ locked: true, filled: 0 });
  });
});
