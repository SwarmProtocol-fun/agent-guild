import { defineServerMod, type RouteContext } from "@agent-guild/sdk";
import { enableModCapabilities, getAgent, getAgentCapabilities, getAgentsByOrg, getOrganizationsByWalletAdmin } from "@/lib/firestore-admin";
import { requireOrgMembershipByAddress } from "@/lib/auth-guard";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import { OAuthError, authorizeUrl, exchangeCode, pkcePair, randomState, registerClient } from "./oauth";
import { McpError, forgetSession, listTools } from "./mcp";
import { PolicyInputError, maskAccountNumbers, normalizePolicy } from "./policy";
import { NotConnectedError, ToolCallError, clearToolCache, invoke, isExpired, orderSummary, place, robinhoodTools, submitOrder } from "./robinhood";
import {
  ConfigError, activityFor, cachedClientId, claimPending, connKey, deleteConnection, getConnection, getDailyUsage, getOrder, getPolicy,
  listConnections, listOrders, logActivity, saveConnection, saveOAuthState, setPolicy, takeOAuthState, updateOrder,
  type ConnRef, type OAuthState, type OrderRecord, type OrderStatus,
} from "./store";
import { AGENT_TOOLS, CAP, NOTES, type CapKey } from "./tools";

const MOD_ID = "robinhood-trading";
/** MOD_REGISTRY id for this mod (lib/skills.ts prefixes the SKILL_REGISTRY id). */
const REGISTRY_MOD_ID = `mod-${MOD_ID}`;

/**
 * Robinhood only sends a sign-in back to localhost (the "localhost
 * platforms" its docs list: Claude Code, Codex…), never to a hosted web app.
 * So each agent signs in from its own machine: rh-agent.mjs listens on this
 * port, or, for an agent with no browser, the operator pastes the localhost
 * URL the browser lands on into the panel.
 */
export const DEFAULT_REDIRECT_URI = "http://localhost:53682/callback";

// ── Request helpers ──────────────────────────────────────────────────────

class InputError extends Error {}
class NotFoundError extends Error {}
class AccessError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Auth → its status, bad input → 400, not found → 404, not connected → 409, missing config → 503, Robinhood → 502. */
function failure(err: unknown): Response {
  if (err instanceof AccessError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof NotFoundError) return Response.json({ error: err.message }, { status: 404 });
  if (err instanceof NotConnectedError) return Response.json({ error: err.message, connected: false }, { status: 409 });
  if (err instanceof ConfigError) return Response.json({ error: err.message }, { status: 503 });
  if (err instanceof InputError || err instanceof PolicyInputError || err instanceof SyntaxError) return Response.json({ error: err.message }, { status: 400 });
  if (err instanceof ToolCallError) return Response.json({ error: err.message, detail: err.value }, { status: 422 });
  if (err instanceof McpError || err instanceof OAuthError) return Response.json({ error: err.message }, { status: 502 });
  console.error("[robinhood-trading]", err);
  return Response.json({ error: "Internal error" }, { status: 500 });
}

async function handle(fn: () => Promise<unknown>): Promise<Response> {
  try {
    const out = await fn();
    return out instanceof Response ? out : Response.json(out);
  } catch (err) {
    return failure(err);
  }
}

const query = (req: Request, key: string) => new URL(req.url).searchParams.get(key);

async function body(req: Request): Promise<Record<string, unknown>> {
  const parsed = await req.json().catch(() => { throw new InputError("Request body must be JSON"); });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InputError("Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

const str = (v: unknown, field: string, max = 200): string => {
  if (typeof v !== "string" || !v.trim()) throw new InputError(`${field} is required`);
  return v.trim().slice(0, max);
};

const objectArg = (v: unknown): Record<string, unknown> => {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new InputError("arguments must be an object");
  return v as Record<string, unknown>;
};

// ── Who is calling ───────────────────────────────────────────────────────

interface Caller { agentId: string; orgId: string; via: "agent" | "session" }

/** An agent signature always wins; a browser session must name an agent in an org it belongs to. */
async function resolveCaller(ctx: RouteContext, agentIdHint: unknown): Promise<Caller> {
  if (ctx.agent) return { agentId: ctx.agent.agentId, orgId: ctx.agent.orgId, via: "agent" };
  if (!ctx.session) throw new AccessError("Authentication required", 401);
  if (typeof agentIdHint !== "string" || !agentIdHint) throw new AccessError("agentId is required for a browser session", 400);
  const agent = await getAgent(agentIdHint);
  if (!agent) throw new AccessError("Agent not found", 404);
  const membership = await requireOrgMembershipByAddress(ctx.session.address, agent.orgId);
  if (!membership.ok) throw new AccessError(membership.error ?? "Forbidden", membership.status ?? 403);
  return { agentId: agentIdHint, orgId: agent.orgId, via: "session" };
}

async function capabilityMap(agentId: string, orgId: string): Promise<Record<CapKey, boolean>> {
  const granted = new Set((await getAgentCapabilities(agentId, orgId)).map((c) => c.key));
  return Object.fromEntries(Object.values(CAP).map((k) => [k, granted.has(k)])) as Record<CapKey, boolean>;
}

async function requireCapability(caller: Caller, capability: CapKey): Promise<void> {
  if (!(await capabilityMap(caller.agentId, caller.orgId))[capability]) {
    throw new AccessError(`Agent ${caller.agentId} doesn't have the "${capability}" upgrade — the org owner enables it on the Robinhood panel`, 403);
  }
}

async function requireMember(ctx: RouteContext, orgId: string): Promise<string> {
  if (!ctx.session) throw new AccessError("Sign in first", 401);
  const membership = await requireOrgMembershipByAddress(ctx.session.address, orgId);
  if (!membership.ok) throw new AccessError(membership.error ?? "Forbidden", membership.status ?? 403);
  return ctx.session.address;
}

async function isOwner(address: string, orgId: string): Promise<boolean> {
  const org = (await getOrganizationsByWalletAdmin(address)).find((o) => o.id === orgId);
  return !!org?.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === canonicalizeWalletAddress(address);
}

/** Setting limits and approving orders is the owner's alone. */
async function requireOwner(ctx: RouteContext, orgId: string): Promise<string> {
  if (!ctx.session) throw new AccessError("Sign in as the org owner", 401);
  if (!(await isOwner(ctx.session.address, orgId))) throw new AccessError("Only the org owner can do this", 403);
  return ctx.session.address;
}

/**
 * Connecting or disconnecting an agent's Robinhood: the agent itself, or the
 * org owner from the panel on the agent's behalf.
 */
async function connectionActor(ctx: RouteContext, agentIdHint: unknown): Promise<Caller> {
  const caller = await resolveCaller(ctx, agentIdHint);
  if (caller.via === "session" && !(await isOwner(ctx.session!.address, caller.orgId))) {
    throw new AccessError("Only the org owner can connect Robinhood for an agent from the panel — or run rh-agent.mjs login as the agent", 403);
  }
  return caller;
}

// ── Sign-in ──────────────────────────────────────────────────────────────

/** Loopback only: a sign-in code can then only land on the machine that asked for it. */
export function parseRedirectUri(value: unknown): string {
  if (value == null || value === "") return DEFAULT_REDIRECT_URI;
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new InputError("redirectUri must be a URL"); }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new InputError("redirectUri must be a loopback address like http://localhost:53682/callback — Robinhood only signs in to localhost");
  }
  url.hash = "";
  url.search = "";
  return url.toString();
}

/** { state, code } directly, or the whole localhost URL the browser landed on. */
function codeAndState(b: Record<string, unknown>): { state: string; code: string } {
  if (typeof b.callbackUrl === "string" && b.callbackUrl.trim()) {
    let url: URL;
    try { url = new URL(b.callbackUrl.trim()); } catch { throw new InputError("callbackUrl must be the full address from the browser bar"); }
    const err = url.searchParams.get("error");
    if (err) throw new InputError(`Robinhood refused the sign-in: ${url.searchParams.get("error_description") ?? err}`);
    return { state: str(url.searchParams.get("state"), "state in callbackUrl", 100), code: str(url.searchParams.get("code"), "code in callbackUrl", 2000) };
  }
  return { state: str(b.state, "state", 100), code: str(b.code, "code", 2000) };
}

/** The sign-in must be finished by whoever started it. */
function mayFinish(saved: OAuthState, ctx: RouteContext): boolean {
  if (saved.startedBy.via === "agent") return ctx.agent?.agentId === saved.startedBy.agentId && ctx.agent.orgId === saved.orgId;
  return !!ctx.session && canonicalizeWalletAddress(ctx.session.address) === canonicalizeWalletAddress(saved.startedBy.address);
}

// ── Views ────────────────────────────────────────────────────────────────

async function connectionView(ref: ConnRef) {
  const conn = await getConnection(ref).catch((err) => {
    // A token that no longer decrypts (rotated key) reads as "reconnect", not a crash.
    if (err instanceof ConfigError) throw err;
    return { status: "needs_reconnect" as const, connectedBy: null, connectedVia: null, connectedAt: null, lastError: "Stored tokens can't be read — sign in again" };
  });
  if (!conn) return { connected: false as const };
  return { connected: true as const, status: conn.status, connectedBy: conn.connectedBy, connectedVia: conn.connectedVia, connectedAt: conn.connectedAt, lastError: conn.lastError ?? null };
}

/** Expired holds are marked as such when read, so nobody can approve a day-old decision. */
async function expireStale(orders: OrderRecord[]): Promise<OrderRecord[]> {
  return Promise.all(orders.map(async (o) => {
    if (!isExpired(o)) return o;
    await updateOrder(o.id, { status: "expired" }).catch(() => {});
    return { ...o, status: "expired" as const };
  }));
}

/** What an agent sees of its order: no raw review blob unless asked. */
const orderView = (o: OrderRecord, full = false) => ({
  id: o.id, status: o.status, summary: orderSummary(o), tool: o.tool, arguments: maskAccountNumbers(o.arguments), notionalUsd: o.notionalUsd,
  reason: o.reason, reasons: o.reasons, warnings: o.warnings, createdAt: o.createdAt, decidedAt: o.decidedAt ?? null,
  error: o.error ?? null, result: o.result ?? null, ...(full ? { review: o.review, agentId: o.agentId, decidedBy: o.decidedBy ?? null } : {}),
});

const STATUSES: OrderStatus[] = ["pending_approval", "placing", "placed", "denied", "rejected", "failed", "expired"];
const statusParam = (v: string | null): OrderStatus | undefined => {
  if (!v) return undefined;
  if (!STATUSES.includes(v as OrderStatus)) throw new InputError(`status must be one of ${STATUSES.join(", ")}`);
  return v as OrderStatus;
};

export default defineServerMod({
  setup(ctx) {
    ctx.log.info("robinhood-trading mod loaded");
  },

  routes: {
    // ── Agent surface ───────────────────────────────────────────────────

    /** GET /agent/tools — LLM tool definitions for every agent-facing route. Public: describes routes, grants nothing. */
    "GET /agent/tools": {
      public: true,
      handler: () => Response.json({
        mod: MOD_ID,
        basePath: `/api/mods/${MOD_ID}`,
        auth: "Authorization: Bearer agt_… (mods:call scope), Ed25519 agent/sig/ts, or agentId/apiKey",
        connect: "Run `node mods/robinhood-trading/agent/rh-agent.mjs login` on the agent's machine once: it opens Robinhood's sign-in and hands the result to the hub.",
        notes: NOTES,
        tools: AGENT_TOOLS,
      }),
    },

    /** GET /me — this agent's Robinhood connection, upgrades, the org's policy and today's usage. */
    "GET /me": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, ctx.agent?.agentId ?? query(req, "agentId"));
        const [capabilities, connection, policy, today] = await Promise.all([
          capabilityMap(caller.agentId, caller.orgId), connectionView(caller), getPolicy(caller.orgId), getDailyUsage(caller.orgId),
        ]);
        return { agentId: caller.agentId, orgId: caller.orgId, via: caller.via, capabilities, connection, policy, today };
      }),

    /**
     * POST /connection/start — begin a Robinhood sign-in for this agent.
     * Body: { redirectUri? (loopback, default http://localhost:53682/callback), agentId (panel only) }
     * → { authorizeUrl, state, redirectUri }. The PKCE verifier stays on the server.
     */
    "POST /connection/start": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await connectionActor(ctx, ctx.agent?.agentId ?? b.agentId);
        await requireCapability(caller, CAP.read);
        const redirectUri = parseRedirectUri(b.redirectUri);
        const clientId = await cachedClientId(redirectUri, () => registerClient(redirectUri));
        const { verifier, challenge } = pkcePair();
        const state = randomState();
        await saveOAuthState(state, {
          orgId: caller.orgId, agentId: caller.agentId, verifier, clientId, redirectUri, createdAt: Date.now(),
          startedBy: caller.via === "agent" ? { via: "agent", agentId: caller.agentId } : { via: "session", address: ctx.session!.address },
        });
        return { authorizeUrl: authorizeUrl({ clientId, redirectUri, state, challenge }), state, redirectUri, expiresInSeconds: 900 };
      }),

    /**
     * POST /connection/finish — trade the sign-in code for tokens, check them
     * against Robinhood, and store them for this agent.
     * Body: { state, code } or { callbackUrl } (the localhost URL the browser landed on).
     */
    "POST /connection/finish": (req, ctx) =>
      handle(async () => {
        const { state, code } = codeAndState(await body(req));
        const saved = await takeOAuthState(state);
        if (!saved) throw new InputError("This sign-in expired or was already used — start again");
        if (!mayFinish(saved, ctx)) throw new AccessError("Finish the sign-in as the same agent (or panel user) that started it", 403);
        const ref = { orgId: saved.orgId, agentId: saved.agentId };
        const tokens = await exchangeCode({ clientId: saved.clientId, redirectUri: saved.redirectUri, code, verifier: saved.verifier });
        // Prove the grant works before saving it, so "connected" means the agent can actually reach Robinhood.
        const verifyKey = `verify:${connKey(ref)}`;
        const tools = await listTools(verifyKey, tokens.accessToken).finally(() => forgetSession(verifyKey));
        const connectedBy = saved.startedBy.via === "agent" ? saved.startedBy.agentId : saved.startedBy.address;
        await saveConnection({ ...ref, clientId: saved.clientId, connectedBy, connectedVia: saved.startedBy.via, connectedAt: new Date().toISOString() }, tokens);
        clearToolCache(ref);
        logActivity({ ...ref, via: saved.startedBy.via, action: "connected", ok: true, summary: `Robinhood connected (${tools.length} tools) by ${connectedBy}` });
        return { connected: true, agentId: ref.agentId, tools: tools.length };
      }),

    /** POST /connection/disconnect — forget this agent's Robinhood tokens. The agent, or the owner with { agentId }. */
    "POST /connection/disconnect": (req, ctx) =>
      handle(async () => {
        const b = await body(req).catch(() => ({} as Record<string, unknown>));
        const caller = await connectionActor(ctx, ctx.agent?.agentId ?? b.agentId);
        await deleteConnection(caller);
        clearToolCache(caller);
        logActivity({ orgId: caller.orgId, agentId: caller.agentId, via: caller.via, action: "disconnected", ok: true, summary: "Robinhood disconnected" });
        return { connected: false };
      }),

    /** GET /tools — Robinhood's live tool list with schemas and the guard's classification. */
    "GET /tools": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, ctx.agent?.agentId ?? query(req, "agentId"));
        await requireCapability(caller, CAP.read);
        const tools = await robinhoodTools(caller, query(req, "fresh") === "true");
        return { tools: tools.map((t) => ({ name: t.name, kind: t.kind, description: t.description ?? t.title ?? "", inputSchema: t.inputSchema ?? null, viaTool: t.kind === "trade" ? "rh_order" : "rh_call" })) };
      }),

    /** POST /call — run one read / watchlist / cancel tool. Body: { tool, arguments } */
    "POST /call": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await resolveCaller(ctx, ctx.agent?.agentId ?? b.agentId);
        const name = str(b.tool, "tool", 100);
        const args = objectArg(b.arguments);
        const tool = (await robinhoodTools(caller)).find((t) => t.name === name);
        if (!tool) throw new NotFoundError(`Robinhood has no tool named ${name} — see rh_tools`);
        if (tool.kind === "trade") throw new InputError(`${name} places an order — use rh_order so the owner's policy applies`);
        await requireCapability(caller, tool.kind === "read" ? CAP.read : tool.kind === "cancel" ? CAP.trade : CAP.watchlist);
        try {
          const result = await invoke(caller, name, args);
          if (tool.kind !== "read") logActivity({ orgId: caller.orgId, agentId: caller.agentId, via: caller.via, tool: name, ok: true, action: tool.kind, summary: `${name} ${JSON.stringify(maskAccountNumbers(args)).slice(0, 200)}` });
          return { tool: name, result };
        } catch (err) {
          if (tool.kind !== "read") logActivity({ orgId: caller.orgId, agentId: caller.agentId, via: caller.via, tool: name, ok: false, action: tool.kind, summary: `${name} failed: ${(err as Error).message}`.slice(0, 300) });
          throw err;
        }
      }),

    /** POST /orders — submit an order through review + policy. Body: { tool?, arguments, reason, idempotencyKey? } */
    "POST /orders": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await resolveCaller(ctx, ctx.agent?.agentId ?? b.agentId);
        await requireCapability(caller, CAP.trade);
        const out = await submitOrder({
          orgId: caller.orgId, agentId: caller.agentId, via: caller.via,
          tool: typeof b.tool === "string" && b.tool.trim() ? b.tool.trim() : "place_equity_order",
          arguments: objectArg(b.arguments),
          reason: str(b.reason, "reason", 500),
          idempotencyKey: typeof b.idempotencyKey === "string" && b.idempotencyKey.trim() ? b.idempotencyKey.trim().slice(0, 200) : undefined,
        });
        return { duplicate: out.duplicate, order: orderView(out.order) };
      }),

    /** GET /orders — an agent's own orders, or (session + orgId, no agentId) the whole org's for the panel. */
    "GET /orders": (req, ctx) =>
      handle(async () => {
        const status = statusParam(query(req, "status"));
        const orgId = query(req, "orgId");
        if (!ctx.agent && orgId && !query(req, "agentId")) {
          await requireMember(ctx, orgId);
          return { orders: (await expireStale(await listOrders(orgId, { status }))).map((o) => orderView(o, true)) };
        }
        const caller = await resolveCaller(ctx, ctx.agent?.agentId ?? query(req, "agentId"));
        return { orders: (await expireStale(await listOrders(caller.orgId, { agentId: caller.agentId, status }))).map((o) => orderView(o)) };
      }),

    /** GET /orders/:id — one order; agents see only their own. */
    "GET /orders/:id": (req, ctx) =>
      handle(async () => {
        const order = await getOrder(ctx.params.id);
        if (!order) throw new NotFoundError("Order not found");
        if (ctx.agent) {
          if (ctx.agent.agentId !== order.agentId || ctx.agent.orgId !== order.orgId) throw new NotFoundError("Order not found");
        } else {
          await requireMember(ctx, order.orgId);
        }
        const [fresh] = await expireStale([order]);
        return { order: orderView(fresh, !ctx.agent) };
      }),

    // ── Owner surface (panel) ───────────────────────────────────────────

    /** GET /my-agents — the signed-in operator's orgs and agents with their Robinhood upgrades. */
    "GET /my-agents": (_req, ctx) =>
      handle(async () => {
        if (!ctx.session) throw new AccessError("Sign in to list your agents", 401);
        const address = ctx.session.address;
        const orgs = await getOrganizationsByWalletAdmin(address);
        return {
          orgs: await Promise.all(orgs.map(async (org) => {
            const agents = await getAgentsByOrg(org.id);
            return {
              orgId: org.id, orgName: org.name || org.id,
              isOwner: !!org.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === canonicalizeWalletAddress(address),
              agents: await Promise.all(agents.map(async (agent) => ({
                agentId: agent.id, name: agent.name,
                // One agent's lookup failing must not hide every agent.
                capabilities: await capabilityMap(agent.id, org.id).catch(() => ({}) as Record<CapKey, boolean>),
              }))),
            };
          })),
        };
      }),

    /** GET /connection?orgId — every agent's connection, the policy and today's usage. Org members. */
    "GET /connection": (req, ctx) =>
      handle(async () => {
        const orgId = str(query(req, "orgId"), "orgId");
        await requireMember(ctx, orgId);
        const [connections, policy, today] = await Promise.all([listConnections(orgId), getPolicy(orgId), getDailyUsage(orgId)]);
        return {
          connections: connections.map((c) => ({
            agentId: c.agentId, status: c.status, connectedBy: c.connectedBy, connectedVia: c.connectedVia, connectedAt: c.connectedAt, lastError: c.lastError ?? null,
          })),
          policy, today,
        };
      }),

    /** POST /policy — change the org's trading limits. Owner only. Body: { orgId, policy: Partial<Policy> } */
    "POST /policy": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const orgId = str(b.orgId, "orgId");
        const address = await requireOwner(ctx, orgId);
        const policy = normalizePolicy(objectArg(b.policy), await getPolicy(orgId));
        await setPolicy(orgId, policy, address);
        logActivity({ orgId, agentId: null, via: "session", action: "policy", ok: true, summary: `Policy updated: ${policy.tradingEnabled ? "trading on" : "trading off"}, approval ${policy.approval}, $${policy.maxOrderUsd}/order, $${policy.maxDailyUsd}/day` });
        return { policy };
      }),

    /** POST /orders/:id/decision — approve (places it now) or reject a held order. Owner only. Body: { decision } */
    "POST /orders/:id/decision": (req, ctx) =>
      handle(async () => {
        const decision = (await body(req)).decision;
        if (decision !== "approve" && decision !== "reject") throw new InputError("decision must be approve or reject");
        const order = await getOrder(ctx.params.id);
        if (!order) throw new NotFoundError("Order not found");
        const address = await requireOwner(ctx, order.orgId);
        if (isExpired(order)) {
          await updateOrder(order.id, { status: "expired" });
          throw new InputError("This order waited over 24 hours and expired — the agent can submit a fresh one");
        }
        const now = new Date().toISOString();
        if (decision === "reject") {
          const claimed = await claimPending(order.id, { status: "denied", reasons: [...order.reasons, "Rejected by the owner"], decidedAt: now, decidedBy: address });
          if (!claimed) throw new InputError(`This order is already ${order.status}`);
          logActivity({ orgId: order.orgId, agentId: order.agentId, via: "session", tool: order.tool, orderId: order.id, ok: false, action: "order_rejected_by_owner", summary: `${orderSummary(order)} — rejected by the owner` });
          return { order: orderView(claimed, true) };
        }
        // Claim first so a double-click (or two owners' tabs) can't place it twice.
        const claimed = await claimPending(order.id, { status: "placing" });
        if (!claimed) throw new InputError(`This order is already ${order.status}`);
        return { order: orderView(await place(claimed, { notionalUsd: claimed.notionalUsd }, "session", address), true) };
      }),

    /** POST /upgrade — enable Robinhood upgrades on the org's install. Owner only. Body: { orgId, capabilities? } */
    "POST /upgrade": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const orgId = str(b.orgId, "orgId");
        await requireOwner(ctx, orgId);
        const all = Object.values(CAP) as string[];
        const wanted = Array.isArray(b.capabilities) ? b.capabilities.filter((c): c is string => typeof c === "string" && all.includes(c)) : all;
        if (!wanted.length) throw new InputError(`capabilities must name at least one of ${all.join(", ")}`);
        const out = await enableModCapabilities(orgId, REGISTRY_MOD_ID, wanted);
        if (!out.installed) throw new NotFoundError("This org hasn't installed the Robinhood mod — install it from the Market first");
        return out;
      }),

    /** POST /panel/call — the owner reading an agent's connected account from the panel (read tools only). Body: { agentId, tool, arguments } */
    "POST /panel/call": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await resolveCaller(ctx, b.agentId);
        await requireOwner(ctx, caller.orgId);
        const name = str(b.tool, "tool", 100);
        const tool = (await robinhoodTools(caller)).find((t) => t.name === name);
        if (!tool) throw new NotFoundError(`Robinhood has no tool named ${name}`);
        if (tool.kind !== "read") throw new InputError("The panel only reads — trade in the Robinhood app, or through an agent");
        return { tool: name, result: await invoke(caller, name, objectArg(b.arguments)) };
      }),

    /** GET /panel/tools?agentId — Robinhood's tool list through an agent's connection. Owner only. */
    "GET /panel/tools": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, query(req, "agentId"));
        await requireOwner(ctx, caller.orgId);
        const tools = await robinhoodTools(caller, query(req, "fresh") === "true");
        return { tools: tools.map((t) => ({ name: t.name, kind: t.kind, description: t.description ?? t.title ?? "", inputSchema: t.inputSchema ?? null })) };
      }),

    /** GET /activity?orgId — everything agents and the owner did through the mod. Org members. */
    "GET /activity": (req, ctx) =>
      handle(async () => {
        const orgId = str(query(req, "orgId"), "orgId");
        await requireMember(ctx, orgId);
        return { activity: await activityFor(orgId) };
      }),
  },
});
