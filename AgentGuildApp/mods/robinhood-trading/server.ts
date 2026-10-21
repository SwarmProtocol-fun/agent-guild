import { defineServerMod, type RouteContext } from "@agent-guild/sdk";
import { enableModCapabilities, getAgent, getAgentCapabilities, getAgentsByOrg, getOrganizationsByWalletAdmin } from "@/lib/firestore-admin";
import { requireOrgMembershipByAddress } from "@/lib/auth-guard";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import { OAuthError, authorizeUrl, exchangeCode, pkcePair, randomState, registerClient } from "./oauth";
import { McpError } from "./mcp";
import { PolicyInputError, normalizePolicy } from "./policy";
import { NotConnectedError, ToolCallError, clearToolCache, invoke, isExpired, orderSummary, place, robinhoodTools, submitOrder } from "./robinhood";
import {
  ConfigError, activityFor, cachedClientId, claimPending, deleteConnection, getConnection, getDailyUsage, getOrder, getPolicy, listOrders,
  logActivity, saveConnection, saveOAuthState, setPolicy, takeOAuthState, updateOrder, type OrderRecord, type OrderStatus,
} from "./store";
import { AGENT_TOOLS, CAP, NOTES, type CapKey } from "./tools";

const MOD_ID = "robinhood-trading";
/** MOD_REGISTRY id for this mod (lib/skills.ts prefixes the SKILL_REGISTRY id). */
const REGISTRY_MOD_ID = `mod-${MOD_ID}`;
const PANEL_PATH = `/mods/${MOD_ID}/trading`;

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
async function resolveCaller(ctx: RouteContext, agentIdHint: string | null | undefined): Promise<Caller> {
  if (ctx.agent) return { agentId: ctx.agent.agentId, orgId: ctx.agent.orgId, via: "agent" };
  if (!ctx.session) throw new AccessError("Authentication required", 401);
  if (!agentIdHint) throw new AccessError("agentId is required for a browser session", 400);
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

/** Connecting a brokerage account, setting limits and approving orders is the owner's alone. */
async function requireOwner(ctx: RouteContext, orgId: string): Promise<string> {
  if (!ctx.session) throw new AccessError("Sign in as the org owner", 401);
  const org = (await getOrganizationsByWalletAdmin(ctx.session.address)).find((o) => o.id === orgId);
  const isOwner = !!org?.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === canonicalizeWalletAddress(ctx.session.address);
  if (!isOwner) throw new AccessError("Only the org owner can do this", 403);
  return ctx.session.address;
}

// ── OAuth helpers ────────────────────────────────────────────────────────

/** The public base URL Robinhood redirects back to: the configured one, else this request's origin. */
function redirectUri(req: Request): string {
  const base = (process.env.NEXT_PUBLIC_BASE_URL || new URL(req.url).origin).replace(/\/+$/, "");
  return `${base}/api/mods/${MOD_ID}/oauth/callback`;
}

function backToPanel(req: Request, params: Record<string, string>): Response {
  const base = (process.env.NEXT_PUBLIC_BASE_URL || new URL(req.url).origin).replace(/\/+$/, "");
  return Response.redirect(`${base}${PANEL_PATH}?${new URLSearchParams(params)}`, 302);
}

// ── Views ────────────────────────────────────────────────────────────────

async function connectionView(orgId: string) {
  const conn = await getConnection(orgId).catch((err) => {
    // A token that no longer decrypts (rotated key) reads as "reconnect", not a crash.
    if (err instanceof ConfigError) throw err;
    return { status: "needs_reconnect" as const, connectedBy: null, connectedAt: null, lastError: "Stored tokens can't be read — reconnect" };
  });
  if (!conn) return { connected: false as const };
  return { connected: true as const, status: conn.status, connectedBy: conn.connectedBy, connectedAt: conn.connectedAt, lastError: conn.lastError ?? null };
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
  id: o.id, status: o.status, summary: orderSummary(o), tool: o.tool, arguments: o.arguments, notionalUsd: o.notionalUsd,
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
        notes: NOTES,
        tools: AGENT_TOOLS,
      }),
    },

    /** GET /me — connection, upgrades, policy and today's usage for the calling agent. */
    "GET /me": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, ctx.agent?.agentId ?? query(req, "agentId"));
        const [capabilities, connection, policy, today] = await Promise.all([
          capabilityMap(caller.agentId, caller.orgId), connectionView(caller.orgId), getPolicy(caller.orgId), getDailyUsage(caller.orgId),
        ]);
        return { agentId: caller.agentId, orgId: caller.orgId, via: caller.via, capabilities, connection, policy, today };
      }),

    /** GET /tools — Robinhood's live tool list with schemas and the guard's classification. */
    "GET /tools": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, ctx.agent?.agentId ?? query(req, "agentId"));
        await requireCapability(caller, CAP.read);
        const tools = await robinhoodTools(caller.orgId, query(req, "fresh") === "true");
        return { tools: tools.map((t) => ({ name: t.name, kind: t.kind, description: t.description ?? t.title ?? "", inputSchema: t.inputSchema ?? null, viaTool: t.kind === "trade" ? "rh_order" : "rh_call" })) };
      }),

    /** POST /call — run one read / watchlist / cancel tool. Body: { tool, arguments } */
    "POST /call": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await resolveCaller(ctx, ctx.agent?.agentId ?? (b.agentId as string | undefined));
        const name = str(b.tool, "tool", 100);
        const args = objectArg(b.arguments);
        const tool = (await robinhoodTools(caller.orgId)).find((t) => t.name === name);
        if (!tool) throw new NotFoundError(`Robinhood has no tool named ${name} — see rh_tools`);
        if (tool.kind === "trade") throw new InputError(`${name} places an order — use rh_order so the owner's policy applies`);
        await requireCapability(caller, tool.kind === "read" ? CAP.read : tool.kind === "cancel" ? CAP.trade : CAP.watchlist);
        try {
          const result = await invoke(caller.orgId, name, args);
          if (tool.kind !== "read") logActivity({ orgId: caller.orgId, agentId: caller.agentId, via: caller.via, tool: name, ok: true, action: tool.kind, summary: `${name} ${JSON.stringify(args).slice(0, 200)}` });
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
        const caller = await resolveCaller(ctx, ctx.agent?.agentId ?? (b.agentId as string | undefined));
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

    /** GET /connection?orgId — connection status, policy and today's usage. Org members. */
    "GET /connection": (req, ctx) =>
      handle(async () => {
        const orgId = str(query(req, "orgId"), "orgId");
        await requireMember(ctx, orgId);
        const [connection, policy, today] = await Promise.all([connectionView(orgId), getPolicy(orgId), getDailyUsage(orgId)]);
        return { connection, policy, today };
      }),

    /** POST /connect — start Robinhood sign-in. Owner only. Body: { orgId } → { authorizeUrl } */
    "POST /connect": (req, ctx) =>
      handle(async () => {
        const { orgId: raw } = await body(req);
        const orgId = str(raw, "orgId");
        const address = await requireOwner(ctx, orgId);
        const uri = redirectUri(req);
        const clientId = await cachedClientId(uri, () => registerClient(uri));
        const { verifier, challenge } = pkcePair();
        const state = randomState();
        await saveOAuthState(state, { orgId, address, verifier, clientId, redirectUri: uri, createdAt: Date.now() });
        return { authorizeUrl: authorizeUrl({ clientId, redirectUri: uri, state, challenge }) };
      }),

    /**
     * GET /oauth/callback — Robinhood's redirect back. Public so a missing
     * session lands on the panel instead of a bare 401, but the browser must
     * still be signed in as the owner who started this sign-in: otherwise an
     * owner could send their authorize link to someone else and receive that
     * person's Robinhood account into their org.
     */
    "GET /oauth/callback": {
      public: true,
      handler: async (req, ctx) => {
        const url = new URL(req.url);
        const state = url.searchParams.get("state");
        const saved = state ? await takeOAuthState(state).catch(() => null) : null;
        if (!saved) return backToPanel(req, { robinhood: "error", reason: "Sign-in expired or was already used — start again" });
        if (!ctx.session || canonicalizeWalletAddress(ctx.session.address) !== canonicalizeWalletAddress(saved.address)) {
          return backToPanel(req, { robinhood: "error", reason: "Finish connecting in the same browser, signed in as the owner who started it" });
        }
        const denied = url.searchParams.get("error");
        if (denied) return backToPanel(req, { robinhood: "error", reason: url.searchParams.get("error_description") ?? denied });
        const code = url.searchParams.get("code");
        if (!code) return backToPanel(req, { robinhood: "error", reason: "Robinhood sent no authorization code" });
        try {
          const tokens = await exchangeCode({ clientId: saved.clientId, redirectUri: saved.redirectUri, code, verifier: saved.verifier });
          await saveConnection({ orgId: saved.orgId, connectedBy: saved.address, connectedAt: new Date().toISOString(), clientId: saved.clientId }, tokens);
          clearToolCache(saved.orgId);
          logActivity({ orgId: saved.orgId, agentId: null, via: "session", action: "connected", ok: true, summary: `Robinhood connected by ${saved.address}` });
          return backToPanel(req, { robinhood: "connected" });
        } catch (err) {
          return backToPanel(req, { robinhood: "error", reason: (err as Error).message.slice(0, 200) });
        }
      },
    },

    /** POST /disconnect — forget the org's Robinhood tokens. Owner only. Body: { orgId } */
    "POST /disconnect": (req, ctx) =>
      handle(async () => {
        const orgId = str((await body(req)).orgId, "orgId");
        const address = await requireOwner(ctx, orgId);
        await deleteConnection(orgId);
        clearToolCache(orgId);
        logActivity({ orgId, agentId: null, via: "session", action: "disconnected", ok: true, summary: `Robinhood disconnected by ${address}` });
        return { connected: false };
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

    /** POST /panel/call — the owner reading their account from the panel (read tools only). Body: { orgId, tool, arguments } */
    "POST /panel/call": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const orgId = str(b.orgId, "orgId");
        await requireOwner(ctx, orgId);
        const name = str(b.tool, "tool", 100);
        const tool = (await robinhoodTools(orgId)).find((t) => t.name === name);
        if (!tool) throw new NotFoundError(`Robinhood has no tool named ${name}`);
        if (tool.kind !== "read") throw new InputError("The panel only reads — trade in the Robinhood app, or through an agent");
        return { tool: name, result: await invoke(orgId, name, objectArg(b.arguments)) };
      }),

    /** GET /panel/tools?orgId — Robinhood's tool list for the panel. Owner only. */
    "GET /panel/tools": (req, ctx) =>
      handle(async () => {
        const orgId = str(query(req, "orgId"), "orgId");
        await requireOwner(ctx, orgId);
        const tools = await robinhoodTools(orgId, query(req, "fresh") === "true");
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
