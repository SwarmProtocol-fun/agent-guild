import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerMod, RouteContext } from "../sdk";

// The order path end to end with Firestore and Robinhood faked: the store is
// an in-memory map, the MCP server a tools/call stub.

const granted = new Set<string>();
vi.mock("@/lib/firestore-admin", () => ({
  getAgentCapabilities: vi.fn(async () => [...granted].map((key) => ({ key }))),
  enableModCapabilities: vi.fn(async (_o: string, modId: string, caps: string[]) => ({ installed: modId === "mod-robinhood-trading", enabled: caps })),
  getAgent: vi.fn(async (id: string) => (id === "a1" ? { id: "a1", orgId: "o1", name: "trader" } : null)),
  getAgentsByOrg: vi.fn(async () => []),
  getOrganizationsByWalletAdmin: vi.fn(async (addr: string) => (addr === "OWNER" || addr === "MEMBER" ? [{ id: "o1", name: "Org", ownerAddress: "OWNER" }] : [])),
}));
vi.mock("@/lib/auth-guard", () => ({
  requireOrgMembershipByAddress: vi.fn(async (addr: string) => (addr === "OWNER" || addr === "MEMBER" ? { ok: true } : { ok: false, status: 403, error: "Not a member" })),
}));
vi.mock("@/lib/wallet-address", () => ({ canonicalizeWalletAddress: (a: string) => a.toLowerCase() }));

const mem = vi.hoisted(() => ({
  orders: new Map<string, Record<string, unknown>>(),
  daily: { orders: 0, usd: 0 },
  policy: null as Record<string, unknown> | null,
  seq: 0,
}));
vi.mock("../../../../mods/robinhood-trading/store", async () => {
  const { DEFAULT_POLICY, normalizePolicy } = await import("../../../../mods/robinhood-trading/policy");
  const pending = (id: string) => (mem.orders.get(id)?.status === "pending_approval" ? mem.orders.get(id) : null);
  return {
    APPROVAL_TTL_MS: 24 * 3600_000,
    ConfigError: class extends Error {},
    getConnection: vi.fn(async () => ({ orgId: "o1", status: "connected", clientId: "c", tokens: { accessToken: "tok", refreshToken: "r", expiresAt: Date.now() + 3600_000 } })),
    getPolicy: vi.fn(async () => normalizePolicy(mem.policy ?? {}, DEFAULT_POLICY)),
    setPolicy: vi.fn(async (_o: string, p: Record<string, unknown>) => { mem.policy = p; }),
    getDailyUsage: vi.fn(async () => ({ ...mem.daily })),
    reserveDaily: vi.fn(async (_o: string, usd: number, check: (t: { orders: number; usd: number }) => string | null) => {
      const r = check({ ...mem.daily });
      if (!r) { mem.daily.orders += 1; mem.daily.usd += usd; }
      return r;
    }),
    releaseDaily: vi.fn(async (_o: string, usd: number) => { mem.daily.orders -= 1; mem.daily.usd -= usd; }),
    createOrder: vi.fn(async (rec: Record<string, unknown>) => {
      const id = rec.idempotencyKey ? `k:${rec.idempotencyKey}` : `o${++mem.seq}`;
      if (mem.orders.has(id)) return { order: mem.orders.get(id), duplicate: true };
      const order = { ...rec, id };
      mem.orders.set(id, order);
      return { order, duplicate: false };
    }),
    getOrder: vi.fn(async (id: string) => mem.orders.get(id) ?? null),
    updateOrder: vi.fn(async (id: string, patch: Record<string, unknown>) => { mem.orders.set(id, { ...mem.orders.get(id), ...patch }); }),
    claimPending: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const o = pending(id);
      if (!o) return null;
      const next = { ...o, ...patch };
      mem.orders.set(id, next);
      return next;
    }),
    listOrders: vi.fn(async (_o: string, opts: { agentId?: string }) => [...mem.orders.values()].filter((o) => !opts.agentId || o.agentId === opts.agentId)),
    logActivity: vi.fn(),
    activityFor: vi.fn(async () => []),
    cachedClientId: vi.fn(), saveOAuthState: vi.fn(), takeOAuthState: vi.fn(), saveConnection: vi.fn(), deleteConnection: vi.fn(),
    markNeedsReconnect: vi.fn(), updateTokens: vi.fn(),
  };
});

const TOOLS = [
  { name: "get_portfolio" }, { name: "get_equity_quotes", inputSchema: { properties: { symbols: { type: "array" } } } },
  { name: "review_equity_order" }, { name: "place_equity_order" }, { name: "cancel_equity_order" }, { name: "add_to_watchlist" },
];
const calls = vi.hoisted(() => ({ list: [] as { name: string; args: unknown }[], place: null as null | ((args: unknown) => unknown) }));
vi.mock("../../../../mods/robinhood-trading/mcp", async (orig) => {
  const real = await orig<typeof import("../../../../mods/robinhood-trading/mcp")>();
  return {
    ...real,
    listTools: vi.fn(async () => TOOLS),
    forgetSession: vi.fn(),
    callTool: vi.fn(async (_k: string, _t: string, name: string, args: unknown) => {
      calls.list.push({ name, args });
      if (name === "review_equity_order") return { structuredContent: { warnings: ["Market is closed"] } };
      if (name === "get_equity_quotes") return { structuredContent: { quotes: [{ last_trade_price: "100" }] } };
      if (name === "place_equity_order") return calls.place ? calls.place(args) : { structuredContent: { id: "rh-1", state: "queued" } };
      return { structuredContent: { ok: true } };
    }),
  };
});

const AGENT = { agent: { agentId: "a1", orgId: "o1" }, session: null };
const SESSION = (address = "OWNER") => ({ agent: null, session: { address, role: "operator" } });

async function call(method: string, path: string, ctxBase: object, body?: unknown) {
  const { default: mod } = (await import("../../../../mods/robinhood-trading/server")) as { default: ServerMod };
  const { matchRoute } = await import("../router");
  const url = new URL(`http://x/api/mods/robinhood-trading${path}`);
  const m = matchRoute(mod.routes!, method, url.pathname.split("/").slice(4));
  if (!m) throw new Error(`no route ${method} ${path}`);
  const handler = typeof m.def === "function" ? m.def : m.def.handler;
  const req = new Request(url, { method, body: body ? JSON.stringify(body) : undefined });
  return (await handler(req, { params: m.params, ...ctxBase } as unknown as RouteContext)) as Response;
}

const order = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  call("POST", "/orders", AGENT, { arguments: args, reason: "test", ...extra });

beforeEach(async () => {
  granted.clear();
  ["rh-read", "rh-watchlist", "rh-trade"].forEach((c) => granted.add(c));
  mem.orders.clear();
  mem.daily = { orders: 0, usd: 0 };
  mem.policy = null;
  calls.list = [];
  calls.place = null;
  const { clearToolCache } = await import("../../../../mods/robinhood-trading/robinhood");
  clearToolCache("o1");
});

describe("robinhood orders", () => {
  it("needs rh-trade", async () => {
    granted.delete("rh-trade");
    expect((await order({ symbol: "AAPL", side: "buy", dollar_amount: 10 })).status).toBe(403);
  });

  it("holds by default and places on owner approval", async () => {
    const res = await order({ symbol: "AAPL", side: "buy", dollar_amount: 20 });
    const { order: held } = await res.json();
    expect(held.status).toBe("pending_approval");
    expect(held.warnings).toEqual(["Market is closed"]);
    expect(calls.list.map((c) => c.name)).toEqual(["review_equity_order"]);

    expect((await call("POST", `/orders/${held.id}/decision`, SESSION("MEMBER"), { decision: "approve" })).status).toBe(403);
    const approved = await (await call("POST", `/orders/${held.id}/decision`, SESSION(), { decision: "approve" })).json();
    expect(approved.order.status).toBe("placed");
    expect(mem.daily).toEqual({ orders: 1, usd: 20 });

    // A second approval can't place it again.
    expect((await call("POST", `/orders/${held.id}/decision`, SESSION(), { decision: "approve" })).status).toBe(400);
    expect(calls.list.filter((c) => c.name === "place_equity_order")).toHaveLength(1);
  });

  it("places straight through when approval is off, sized from the quote", async () => {
    mem.policy = { approval: "never", maxOrderUsd: 500 };
    const { order: o } = await (await order({ symbol: "AAPL", side: "buy", quantity: 2 })).json();
    expect(o.status).toBe("placed");
    expect(o.notionalUsd).toBe(200);
    expect(calls.list.map((c) => c.name)).toEqual(["review_equity_order", "get_equity_quotes", "place_equity_order"]);
  });

  it("refuses over the limit without calling place", async () => {
    mem.policy = { approval: "never", maxOrderUsd: 100 };
    const { order: o } = await (await order({ symbol: "AAPL", side: "buy", quantity: 2 })).json();
    expect(o.status).toBe("denied");
    expect(calls.list.some((c) => c.name === "place_equity_order")).toBe(false);
  });

  it("an idempotency key returns the first attempt", async () => {
    mem.policy = { approval: "never" };
    await order({ symbol: "AAPL", side: "buy", dollar_amount: 10 }, { idempotencyKey: "k1" });
    const again = await (await order({ symbol: "AAPL", side: "buy", dollar_amount: 10 }, { idempotencyKey: "k1" })).json();
    expect(again.duplicate).toBe(true);
    expect(calls.list.filter((c) => c.name === "place_equity_order")).toHaveLength(1);
  });

  it("a Robinhood rejection gives the daily reservation back", async () => {
    mem.policy = { approval: "never" };
    calls.place = () => ({ isError: true, content: [{ type: "text", text: "Insufficient buying power" }] });
    const { order: o } = await (await order({ symbol: "AAPL", side: "buy", dollar_amount: 10 })).json();
    expect(o.status).toBe("rejected");
    expect(o.error).toMatch(/Insufficient buying power/);
    expect(mem.daily).toEqual({ orders: 0, usd: 0 });
  });

  it("rh_call refuses order tools and gates by kind", async () => {
    expect((await call("POST", "/call", AGENT, { tool: "place_equity_order", arguments: {} })).status).toBe(400);
    expect((await call("POST", "/call", AGENT, { tool: "get_portfolio" })).status).toBe(200);
    granted.delete("rh-watchlist");
    expect((await call("POST", "/call", AGENT, { tool: "add_to_watchlist", arguments: { symbol: "AAPL" } })).status).toBe(403);
    granted.delete("rh-trade");
    expect((await call("POST", "/call", AGENT, { tool: "cancel_equity_order", arguments: { id: "x" } })).status).toBe(403);
  });

  it("an agent can't read another agent's order", async () => {
    const { order: o } = await (await order({ symbol: "AAPL", side: "buy", dollar_amount: 10 })).json();
    expect((await call("GET", `/orders/${o.id}`, { agent: { agentId: "a2", orgId: "o1" }, session: null })).status).toBe(404);
    expect((await call("GET", `/orders/${o.id}`, AGENT)).status).toBe(200);
  });

  it("only the owner sets policy", async () => {
    expect((await call("POST", "/policy", SESSION("MEMBER"), { orgId: "o1", policy: { approval: "never" } })).status).toBe(403);
    const res = await call("POST", "/policy", SESSION(), { orgId: "o1", policy: { approval: "never", allowedSymbols: "spy, qqq" } });
    expect((await res.json()).policy.allowedSymbols).toEqual(["SPY", "QQQ"]);
  });
});
