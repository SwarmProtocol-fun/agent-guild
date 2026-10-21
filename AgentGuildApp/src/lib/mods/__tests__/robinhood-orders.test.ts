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
  states: new Map<string, Record<string, unknown>>(),
  saved: [] as Record<string, unknown>[],
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
    connKey: (r: { orgId: string; agentId: string }) => `${r.orgId}_${r.agentId}`,
    cachedClientId: vi.fn(async (_uri: string, register: () => Promise<string>) => register()),
    saveOAuthState: vi.fn(async (state: string, v: Record<string, unknown>) => { mem.states.set(state, v); }),
    takeOAuthState: vi.fn(async (state: string) => { const v = mem.states.get(state) ?? null; mem.states.delete(state); return v; }),
    saveConnection: vi.fn(async (c: Record<string, unknown>) => { mem.saved.push(c); }),
    listConnections: vi.fn(async () => []),
    deleteConnection: vi.fn(), markNeedsReconnect: vi.fn(), updateTokens: vi.fn(),
  };
});
vi.mock("../../../../mods/robinhood-trading/oauth", async (orig) => ({
  ...(await orig<typeof import("../../../../mods/robinhood-trading/oauth")>()),
  registerClient: vi.fn(async () => "cid"),
  exchangeCode: vi.fn(async (o: { code: string }) => {
    if (o.code === "bad") throw new Error("invalid_grant");
    return { accessToken: "new-tok", refreshToken: "r", expiresAt: Date.now() + 3600_000 };
  }),
}));

const TOOLS = [
  { name: "get_accounts" }, { name: "get_portfolio" }, { name: "get_equity_quotes", inputSchema: { properties: { symbols: { type: "array" } } } },
  { name: "review_equity_order" }, { name: "place_equity_order" }, { name: "cancel_equity_order" }, { name: "add_to_watchlist" },
  { name: "review_option_order" }, { name: "place_option_order" },
];
const AGENTIC = { account_number: "00006632", agentic_allowed: true, rhs_account_number: "rhs6632", option_level: "option_level_3", nickname: "MCP" };
const calls = vi.hoisted(() => ({
  list: [] as { name: string; args: unknown }[],
  place: null as null | ((args: unknown) => unknown),
  accounts: null as null | Record<string, unknown>[],
  reviewError: false,
  optionReview: null as null | Record<string, unknown>,
}));
vi.mock("../../../../mods/robinhood-trading/mcp", async (orig) => {
  const real = await orig<typeof import("../../../../mods/robinhood-trading/mcp")>();
  return {
    ...real,
    listTools: vi.fn(async () => TOOLS),
    forgetSession: vi.fn(),
    callTool: vi.fn(async (_k: string, _t: string, name: string, args: unknown) => {
      calls.list.push({ name, args });
      if (name === "get_accounts") return { structuredContent: { accounts: calls.accounts ?? [AGENTIC, { account_number: "00008451", agentic_allowed: false, option_level: "option_level_3" }] } };
      if (name === "review_equity_order") {
        if (calls.reviewError) return { isError: true, content: [{ type: "text", text: "no buying power" }] };
        return { structuredContent: { warnings: ["Market is closed"] } };
      }
      if (name === "review_option_order") return calls.optionReview ?? { structuredContent: { collateral: { amount: "2040.00" } } };
      if (name === "get_equity_quotes") return { structuredContent: { quotes: [{ last_trade_price: "100" }] } };
      if (name === "place_equity_order" || name === "place_option_order") return calls.place ? calls.place(args) : { structuredContent: { id: "rh-1", state: "queued" } };
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
  calls.accounts = null;
  calls.reviewError = false;
  calls.optionReview = null;
  mem.states.clear();
  mem.saved = [];
  const { clearToolCache } = await import("../../../../mods/robinhood-trading/robinhood");
  clearToolCache({ orgId: "o1", agentId: "a1" });
});

describe("robinhood sign-in (per agent)", () => {
  const start = async (ctx: object, b: object = {}) => (await call("POST", "/connection/start", ctx, b)).json();

  it("an agent starts its own sign-in on a localhost redirect", async () => {
    const out = await start(AGENT);
    const url = new URL(out.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://robinhood.com/oauth");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:53682/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // The verifier never leaves the server.
    expect(JSON.stringify(out)).not.toContain(String(mem.states.get(out.state)?.verifier));
  });

  it("refuses a non-loopback redirect", async () => {
    const res = await call("POST", "/connection/start", AGENT, { redirectUri: "https://evil.example/cb" });
    expect(res.status).toBe(400);
  });

  it("only the owner can start one from the panel", async () => {
    expect((await call("POST", "/connection/start", SESSION("MEMBER"), { agentId: "a1" })).status).toBe(403);
    expect((await call("POST", "/connection/start", SESSION(), { agentId: "a1" })).status).toBe(200);
  });

  it("finishes from the pasted localhost URL, verifies the tokens, then saves them for that agent", async () => {
    const { state } = await start(SESSION(), { agentId: "a1" });
    const res = await call("POST", "/connection/finish", SESSION(), { callbackUrl: `http://localhost:53682/callback?code=abc&state=${state}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ connected: true, agentId: "a1", tools: TOOLS.length });
    expect(mem.saved[0]).toMatchObject({ orgId: "o1", agentId: "a1", connectedVia: "session", connectedBy: "OWNER", clientId: "cid" });
  });

  it("a sign-in can only be finished by whoever started it, once", async () => {
    const { state } = await start(AGENT);
    const other = { agent: { agentId: "a2", orgId: "o1" }, session: null };
    expect((await call("POST", "/connection/finish", other, { state, code: "abc" })).status).toBe(403);
    // The failed attempt consumed the state.
    expect((await call("POST", "/connection/finish", AGENT, { state, code: "abc" })).status).toBe(400);
    expect(mem.saved).toHaveLength(0);
  });

  it("passes Robinhood's refusal through", async () => {
    const res = await call("POST", "/connection/finish", AGENT, { callbackUrl: "http://localhost:53682/callback?error=access_denied&error_description=User+cancelled" });
    expect((await res.json()).error).toMatch(/User cancelled/);
  });
});

describe("robinhood orders", () => {
  it("needs rh-trade", async () => {
    granted.delete("rh-trade");
    expect((await order({ symbol: "AAPL", side: "buy", type: "market", dollar_amount: 10 })).status).toBe(403);
  });

  it("holds by default and places on owner approval", async () => {
    const res = await order({ symbol: "AAPL", side: "buy", type: "market", dollar_amount: 20 });
    const { order: held } = await res.json();
    expect(held.status).toBe("pending_approval");
    expect(held.warnings).toEqual(["Market is closed"]);
    expect(held.arguments.account_number).toBe("••••6632");
    expect(calls.list.map((c) => c.name)).toEqual(["get_accounts", "review_equity_order"]);
    expect(calls.list[1].args).not.toHaveProperty("ref_id");

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
    const { order: o } = await (await order({ symbol: "AAPL", side: "buy", type: "market", quantity: 2 })).json();
    expect(o.status).toBe("placed");
    expect(o.notionalUsd).toBe(200);
    expect(calls.list.map((c) => c.name)).toEqual(["get_accounts", "review_equity_order", "get_equity_quotes", "place_equity_order"]);
    const placed = calls.list.at(-1)!.args as Record<string, unknown>;
    expect(placed).toMatchObject({ symbol: "AAPL", type: "market", quantity: "2", account_number: "00006632" });
    expect(placed.ref_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("refuses over the limit without calling place", async () => {
    mem.policy = { approval: "never", maxOrderUsd: 100 };
    const { order: o } = await (await order({ symbol: "AAPL", side: "buy", type: "market", quantity: 2 })).json();
    expect(o.status).toBe("denied");
    expect(calls.list.some((c) => c.name === "place_equity_order")).toBe(false);
  });

  it("an idempotency key returns the first attempt", async () => {
    mem.policy = { approval: "never" };
    await order({ symbol: "AAPL", side: "buy", type: "market", dollar_amount: 10 }, { idempotencyKey: "k1" });
    const again = await (await order({ symbol: "AAPL", side: "buy", type: "market", dollar_amount: 10 }, { idempotencyKey: "k1" })).json();
    expect(again.duplicate).toBe(true);
    expect(calls.list.filter((c) => c.name === "place_equity_order")).toHaveLength(1);
  });

  it("a Robinhood rejection gives the daily reservation back", async () => {
    mem.policy = { approval: "never" };
    calls.place = () => ({ isError: true, content: [{ type: "text", text: "Insufficient buying power" }] });
    const { order: o } = await (await order({ symbol: "AAPL", side: "buy", type: "market", dollar_amount: 10 })).json();
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
    const { order: o } = await (await order({ symbol: "AAPL", side: "buy", type: "market", dollar_amount: 10 })).json();
    expect((await call("GET", `/orders/${o.id}`, { agent: { agentId: "a2", orgId: "o1" }, session: null })).status).toBe(404);
    expect((await call("GET", `/orders/${o.id}`, AGENT)).status).toBe(200);
  });

  it("only the owner sets policy", async () => {
    expect((await call("POST", "/policy", SESSION("MEMBER"), { orgId: "o1", policy: { approval: "never" } })).status).toBe(403);
    const res = await call("POST", "/policy", SESSION(), { orgId: "o1", policy: { approval: "never", allowedSymbols: "spy, qqq" } });
    expect((await res.json()).policy.allowedSymbols).toEqual(["SPY", "QQQ"]);
  });

  const spread = {
    chain_symbol: "HOOD", quantity: "8", price: "2.55", direction: "debit", type: "limit",
    legs: [
      { option_id: "11111111-1111-4111-8111-111111111111", side: "buy", position_effect: "open" },
      { option_id: "22222222-2222-4222-8222-222222222222", side: "sell", position_effect: "open" },
    ],
  };

  it("places a debit spread on the agentic account and keeps chain_symbol off the place call", async () => {
    mem.policy = { approval: "never", maxOrderUsd: 5000, maxDailyUsd: 5000 };
    const res = await order(spread, { tool: "place_option_order" });
    const { order: o } = await res.json();
    expect(res.status).toBe(200);
    expect(o.status).toBe("placed");
    expect(o.notionalUsd).toBe(2040);
    expect(o.arguments.account_number).toBe("••••6632");
    expect(o.arguments).not.toHaveProperty("chain_symbol");
    const review = calls.list.find((c) => c.name === "review_option_order")!.args as Record<string, unknown>;
    const placed = calls.list.find((c) => c.name === "place_option_order")!.args as Record<string, unknown>;
    expect(review).toMatchObject({ chain_symbol: "HOOD", underlying_type: "equity", account_number: "00006632" });
    expect(review).not.toHaveProperty("ref_id");
    expect(placed).toMatchObject({ account_number: "00006632", direction: "debit", quantity: "8" });
    expect(placed).not.toHaveProperty("chain_symbol");
    expect(String(placed.ref_id)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("holds a credit spread when the review has no collateral, even with approval off", async () => {
    mem.policy = { approval: "never", maxOrderUsd: 5000, maxDailyUsd: 5000 };
    calls.optionReview = { structuredContent: { estimated_cost: { amount: "600.00" } } };
    const { order: o } = await (await order({ ...spread, direction: "credit", price: "1.20", quantity: "5" }, { tool: "place_option_order" })).json();
    expect(o.status).toBe("pending_approval");
    expect(o.notionalUsd).toBeNull();
    expect(calls.list.some((c) => c.name === "place_option_order")).toBe(false);
  });

  it("refuses a non-agentic account and an option market order", async () => {
    mem.policy = { approval: "never", allowOptions: true, maxOrderUsd: 5000 };
    const wrong = await order({ ...spread, account_number: "00008451" }, { tool: "place_option_order" });
    expect(wrong.status).toBe(422);
    expect((await wrong.json()).error).toMatch(/••••8451/);
    calls.list = [];
    const market = await order({ ...spread, type: "market" }, { tool: "place_option_order" });
    expect(market.status).toBe(422);
    expect(calls.list).toEqual([]);
  });

  it("holds when Robinhood's review fails instead of placing blind", async () => {
    mem.policy = { approval: "never", maxOrderUsd: 500 };
    calls.reviewError = true;
    const { order: o } = await (await order({ symbol: "AAPL", side: "buy", type: "market", dollar_amount: 10 })).json();
    expect(o.status).toBe("pending_approval");
    expect(o.warnings.join(" ")).toMatch(/review failed/);
    expect(calls.list.some((c) => c.name === "place_equity_order")).toBe(false);
  });

  it("refuses a multi-leg spread on an options level 2 account", async () => {
    mem.policy = { approval: "never", maxOrderUsd: 5000 };
    calls.accounts = [{ ...AGENTIC, option_level: "option_level_2" }];
    const res = await order(spread, { tool: "place_option_order" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/level 3/);
  });
});
