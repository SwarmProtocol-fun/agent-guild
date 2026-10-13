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

const caps = vi.hoisted(() => ({ list: [{ key: "solana-dev-trade" }, { key: "solana-dev-inspect" }] }));
vi.mock("@/lib/firestore-admin", () => ({
  getAgent: vi.fn(), getAgentsByOrg: vi.fn(), getOrganizationsByWalletAdmin: vi.fn(), enableModCapabilities: vi.fn(),
  getAgentCapabilities: vi.fn(async () => caps.list),
}));
vi.mock("@/lib/auth-guard", () => ({ requireOrgMembershipByAddress: vi.fn() }));
vi.mock("@/lib/agent-wallets", () => ({ listAgentWallets: vi.fn(async () => []), generateAgentWallet: vi.fn(), getAgentWalletKeypair: vi.fn() }));
vi.mock("@/lib/gateway/store", () => ({ enqueueTask: vi.fn(), getTask: vi.fn(), getAvailableWorkers: vi.fn() }));
vi.mock("@/lib/settlement/registry", () => ({ settleOnChains: vi.fn(), hashJobResult: vi.fn(), getBalance: vi.fn(), verifyReceipt: vi.fn() }));
vi.mock("@/lib/solana/platform", () => ({ agentAlreadyRegistered: vi.fn(), getAgentSlashingHistoryOnChain: vi.fn(), mintIdentityToken: vi.fn() }));
vi.mock("@/lib/solana/client", () => ({ getScoreEventHistoryForAsn: vi.fn() }));
vi.mock("@/lib/jobs-admin", () => ({ getJob: vi.fn() }));
vi.mock("@/lib/mods/solana-settlement-store", () => ({}));

const payment = vi.hoisted(() => ({ verdict: { verified: false, reason: "No transactions carry this reference yet" as string | null, signature: null as string | null, payer: null as string | null, received: "0", finalized: false } }));
vi.mock("../../../../mods/solana-settlement/chainchecks", async (orig) => ({
  ...(await orig<typeof import("../../../../mods/solana-settlement/chainchecks")>()),
  findPayment: vi.fn(async () => payment.verdict),
}));

import { runSolanaTick } from "../../../../mods/solana-settlement/server";
import { listAlerts, listOrders, createOrder, createPaymentRequest, listPaymentRequests, createWatch, listWatches } from "../../../../mods/solana-settlement/automation-store";
import { USDC_MINT } from "../../../../mods/solana-settlement/paper";

const SOL = "So11111111111111111111111111111111111111112";
const price = { sol: 95 };

// Jupiter: prices and quotes at `price.sol`.
vi.stubGlobal("fetch", vi.fn(async (url: string) => {
  const u = new URL(url);
  let body: unknown;
  if (u.pathname.startsWith("/price/v3")) {
    body = Object.fromEntries(u.searchParams.get("ids")!.split(",").map((m) => [m, m === SOL ? { usdPrice: price.sol, decimals: 9 } : m === USDC_MINT ? { usdPrice: 1, decimals: 6 } : null]));
  } else if (u.pathname.startsWith("/swap/v1/quote")) {
    const amount = BigInt(u.searchParams.get("amount")!);
    const usdcIn = u.searchParams.get("inputMint") === USDC_MINT;
    const out = usdcIn ? (amount * 1000n) / BigInt(price.sol) : (amount * BigInt(price.sol)) / 1000n;
    body = { inAmount: amount.toString(), outAmount: out.toString(), otherAmountThreshold: out.toString(), priceImpactPct: "0.0001", routePlan: [{ swapInfo: { label: "Orca" } }] };
  } else {
    return new Response("nope", { status: 404 });
  }
  return new Response(JSON.stringify(body), { status: 200 });
}));

const day = 86_400_000;
const order = (over: Record<string, unknown> = {}) => createOrder({
  agentId: "a1", orgId: "o1", status: "open", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + day).toISOString(),
  inputMint: USDC_MINT, outputMint: SOL, amount: "190", slippageBps: null, note: "buy the dip",
  trigger: { mint: SOL, op: "below", usd: 100 }, ...over,
});

beforeEach(() => {
  rows.clear();
  price.sol = 95;
  caps.list = [{ key: "solana-dev-trade" }, { key: "solana-dev-inspect" }];
});

describe("runSolanaTick", () => {
  it("fills a triggered order into the paper wallet and leaves an alert", async () => {
    const o = await order();
    const res = await runSolanaTick();
    expect(res).toMatchObject({ orders: 1, filled: 1, failed: 0, errors: 0 });
    const [after] = await listOrders("a1", "o1");
    expect(after).toMatchObject({ id: o.id, status: "filled", firedPriceUsd: 95 });
    expect(after.result).toMatch(/190 USDC → 2 SOL/);
    const [alert] = await listAlerts("a1", "o1");
    expect(alert).toMatchObject({ source: "order", refId: o.id, read: false });
    expect(alert.detail).toMatch(/buy the dip/);
    // A second tick doesn't fill it again.
    expect((await runSolanaTick()).filled).toBe(0);
  });

  it("leaves an untriggered order open and advances a trailing high", async () => {
    price.sol = 120;
    await order();
    const trail = await order({ inputMint: SOL, outputMint: USDC_MINT, amount: "all", trigger: { mint: SOL, op: "trail", trailPct: 10, peakUsd: 110 } });
    expect(await runSolanaTick()).toMatchObject({ filled: 0, failed: 0 });
    const orders = await listOrders("a1", "o1");
    expect(orders.every((x) => x.status === "open")).toBe(true);
    expect(orders.find((x) => x.id === trail.id)?.trigger).toMatchObject({ peakUsd: 120 });
  });

  it("fails the order with a reason when the upgrade was revoked", async () => {
    caps.list = [];
    await order();
    expect(await runSolanaTick()).toMatchObject({ failed: 1 });
    const [after] = await listOrders("a1", "o1");
    expect(after.status).toBe("failed");
    expect(after.result).toMatch(/upgrade was turned off/);
  });

  it("expires stale orders, and fires a one-shot price watch once", async () => {
    await order({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await createWatch({ agentId: "a1", orgId: "o1", status: "active", createdAt: "", expiresAt: new Date(Date.now() + day).toISOString(), note: null, repeat: false, fireCount: 0, kind: "price", armed: true, trigger: { mint: SOL, op: "below", usd: 99 } });
    const res = await runSolanaTick();
    expect(res.expired).toBe(1);
    const [w] = await listWatches("a1", "o1");
    expect(w).toMatchObject({ status: "done", fireCount: 1 });
    const titles = (await listAlerts("a1", "o1")).map((a) => a.title);
    expect(titles).toEqual(expect.arrayContaining(["Order expired unfilled", expect.stringMatching(/^Price alert: SOL ≤ \$99/)]));
  });

  it("marks a payment request paid once the reference shows a verified payment", async () => {
    const req = await createPaymentRequest({ agentId: "a1", orgId: "o1", status: "pending", createdAt: "", expiresAt: new Date(Date.now() + day).toISOString(), cluster: "devnet", recipient: "R", mint: null, amount: "1", reference: "REF", label: "Logo design", message: null, memo: null, url: "solana:R" });
    await runSolanaTick();
    expect((await listPaymentRequests("a1", "o1"))[0].status).toBe("pending");
    payment.verdict = { verified: true, reason: null, signature: "SIG", payer: "PAYER", received: "1", finalized: true };
    expect(await runSolanaTick()).toMatchObject({ paid: 1 });
    expect((await listPaymentRequests("a1", "o1"))[0]).toMatchObject({ id: req.id, status: "paid", paidSignature: "SIG", payer: "PAYER" });
    expect((await listAlerts("a1", "o1"))[0].title).toMatch(/Paid: 1 SOL for Logo design/);
  });

  it("is a no-op while another tick holds the lock", async () => {
    rows.set("solanaTick/lock", { holder: "other", until: Date.now() + 30_000 });
    await order();
    expect(await runSolanaTick()).toMatchObject({ locked: true, filled: 0 });
  });
});
