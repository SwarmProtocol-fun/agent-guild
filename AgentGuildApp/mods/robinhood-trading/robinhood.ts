/**
 * The org's live link to Robinhood: a fresh access token, the tool list, and
 * the one path every order takes (review → policy → approval or placement).
 * Server-only.
 */
import { OAuthError, refreshTokens } from "./oauth";
import { McpAuthError, callTool, forgetSession, listTools, resultValue, type McpTool } from "./mcp";
import {
  classifyTool, costIn, describeOrder, estimateNotional, evaluateOrder, priceIn, reviewToolFor, warningsIn,
  type ToolKind, type Verdict,
} from "./policy";
import {
  APPROVAL_TTL_MS, createOrder, getConnection, getDailyUsage, getPolicy, logActivity, markNeedsReconnect, releaseDaily,
  reserveDaily, updateOrder, updateTokens, type OrderRecord,
} from "./store";

export class NotConnectedError extends Error {}

// ── Tokens ───────────────────────────────────────────────────────────────

// Concurrent requests share one refresh: Robinhood may rotate the refresh
// token, and a second refresh with the spent one would kill the grant.
const refreshing = new Map<string, Promise<string>>();

async function accessToken(orgId: string, force = false): Promise<string> {
  const conn = await getConnection(orgId);
  if (!conn) throw new NotConnectedError("This org hasn't connected Robinhood yet — the owner connects it on the Robinhood panel");
  if (conn.status === "needs_reconnect") throw new NotConnectedError(`The Robinhood connection needs the owner to reconnect (${conn.lastError ?? "grant expired"})`);
  if (!force && conn.tokens.expiresAt - Date.now() > 60_000) return conn.tokens.accessToken;
  if (!conn.tokens.refreshToken) {
    await markNeedsReconnect(orgId, "Access token expired and Robinhood issued no refresh token");
    throw new NotConnectedError("The Robinhood session expired — the owner needs to reconnect");
  }
  let pending = refreshing.get(orgId);
  if (!pending) {
    pending = refreshTokens(conn.clientId, conn.tokens.refreshToken)
      .then(async (tokens) => { await updateTokens(orgId, tokens); return tokens.accessToken; })
      .catch(async (err) => {
        if (err instanceof OAuthError && err.reconnect) {
          await markNeedsReconnect(orgId, err.message);
          throw new NotConnectedError("Robinhood ended the session — the owner needs to reconnect");
        }
        throw err;
      })
      .finally(() => refreshing.delete(orgId));
    refreshing.set(orgId, pending);
  }
  return pending;
}

/** Runs fn with a valid token, refreshing and retrying once when Robinhood rejects it. */
async function withToken<T>(orgId: string, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await accessToken(orgId));
  } catch (err) {
    if (!(err instanceof McpAuthError)) throw err;
    forgetSession(orgId);
    return fn(await accessToken(orgId, true));
  }
}

// ── Tools ────────────────────────────────────────────────────────────────

export interface ToolInfo extends McpTool { kind: ToolKind }

const TOOLS_TTL_MS = 5 * 60_000;
const toolCache = new Map<string, { at: number; tools: ToolInfo[] }>();

export async function robinhoodTools(orgId: string, fresh = false): Promise<ToolInfo[]> {
  const hit = toolCache.get(orgId);
  if (hit && !fresh && Date.now() - hit.at < TOOLS_TTL_MS) return hit.tools;
  const tools = (await withToken(orgId, (t) => listTools(orgId, t))).map((tool) => ({ ...tool, kind: classifyTool(tool.name) }));
  toolCache.set(orgId, { at: Date.now(), tools });
  return tools;
}

export class ToolCallError extends Error {
  constructor(message: string, readonly value: unknown) { super(message); }
}

/** Calls one Robinhood tool and returns its value; a tool-level error (isError) throws with Robinhood's message. */
export async function invoke(orgId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await withToken(orgId, (t) => callTool(orgId, t, name, args));
  const value = resultValue(result);
  if (result.isError) throw new ToolCallError(`Robinhood ${name}: ${typeof value === "string" ? value : JSON.stringify(value).slice(0, 300)}`, value);
  return value;
}

export function clearToolCache(orgId: string): void {
  toolCache.delete(orgId);
  forgetSession(orgId);
}

/** The argument object for a quote tool, built from its schema: a `symbols` array or a single `symbol`. */
export function quoteArgs(tool: McpTool | undefined, symbol: string): Record<string, unknown> {
  const props = tool?.inputSchema?.properties ?? {};
  const key = Object.keys(props).find((k) => /symbol|ticker/i.test(k)) ?? "symbols";
  const isArray = (props[key] as { type?: string } | undefined)?.type === "array" || /s$/.test(key);
  return { [key]: isArray ? [symbol] : symbol };
}

// ── Orders ───────────────────────────────────────────────────────────────

export interface OrderRequest {
  orgId: string;
  agentId: string;
  via: "agent" | "session";
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
  idempotencyKey?: string;
}

export interface OrderOutcome {
  order: OrderRecord;
  /** True when this idempotency key was already used: `order` is the first attempt. */
  duplicate: boolean;
}

/**
 * Robinhood's own dry run first (its warnings travel with the order), then
 * the owner's policy, then either a held order for the owner, a refusal, or
 * the real placement.
 */
export async function submitOrder(req: OrderRequest): Promise<OrderOutcome> {
  const tools = await robinhoodTools(req.orgId);
  const tool = tools.find((t) => t.name === req.tool);
  if (!tool) throw new ToolCallError(`Robinhood has no tool named ${req.tool}`, null);
  if (tool.kind !== "trade") throw new ToolCallError(`${req.tool} isn't an order tool — use rh_call`, null);

  const facts = describeOrder(req.tool, req.arguments);

  // The dry run: a failed review is itself a warning, not a reason to place blind.
  let review: unknown = null;
  let warnings: string[] = [];
  const reviewName = reviewToolFor(req.tool);
  if (tools.some((t) => t.name === reviewName)) {
    try {
      review = await invoke(req.orgId, reviewName, req.arguments);
      warnings = warningsIn(review);
    } catch (err) {
      warnings = [`Robinhood's review failed: ${(err as Error).message}`];
      review = err instanceof ToolCallError ? err.value : null;
    }
  }

  let marketPrice = priceIn(review);
  if (facts.dollarAmount == null && facts.price == null && marketPrice == null && facts.symbol && facts.assetClass === "equity") {
    const quoteTool = tools.find((t) => t.name === "get_equity_quotes") ?? tools.find((t) => t.kind === "read" && /quote/.test(t.name));
    if (quoteTool) marketPrice = priceIn(await invoke(req.orgId, quoteTool.name, quoteArgs(quoteTool, facts.symbol)).catch(() => null));
  }
  const notional = costIn(review) ?? estimateNotional(facts, marketPrice);

  const [policy, today] = await Promise.all([getPolicy(req.orgId), getDailyUsage(req.orgId)]);
  const verdict = evaluateOrder(policy, facts, notional, today);

  const base: Omit<OrderRecord, "id" | "status"> = {
    orgId: req.orgId, agentId: req.agentId, tool: req.tool, arguments: req.arguments, facts, notionalUsd: notional,
    reason: req.reason, reasons: verdict.reasons, warnings, review, createdAt: new Date().toISOString(),
    ...(req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : {}),
  };
  const status = verdict.outcome === "deny" ? "denied" : verdict.outcome === "approve" ? "pending_approval" : "placing";
  const created = await createOrder({ ...base, status });
  if (created.duplicate) return created;

  const summary = orderSummary(created.order);
  if (verdict.outcome !== "allow") {
    logActivity({
      orgId: req.orgId, agentId: req.agentId, via: req.via, tool: req.tool, orderId: created.order.id, ok: verdict.outcome === "approve",
      action: verdict.outcome === "deny" ? "order_denied" : "order_queued",
      summary: `${summary} — ${verdict.outcome === "deny" ? "refused" : "waiting for the owner"}: ${verdict.reasons.join("; ")}`.slice(0, 300),
    });
    return created;
  }
  return { order: await place(created.order, verdict, req.via, null), duplicate: false };
}

/**
 * Places an order with Robinhood. Owner approval skips the per-order and
 * approval rules (they saw it) but not the daily caps, which are re-checked
 * at placement since other orders may have filled in the meantime.
 */
export async function place(order: OrderRecord, verdict: Pick<Verdict, "notionalUsd">, via: "agent" | "session", approvedBy: string | null): Promise<OrderRecord> {
  const usd = verdict.notionalUsd ?? 0;
  const policy = await getPolicy(order.orgId);
  const at = new Date();
  const refusal = await reserveDaily(order.orgId, usd, (today) => {
    if (!policy.tradingEnabled) return "The owner has turned trading off";
    if (today.orders + 1 > policy.maxDailyOrders) return `Daily order limit reached (${policy.maxDailyOrders})`;
    if (today.usd + usd > policy.maxDailyUsd) return `Would pass the daily limit of $${policy.maxDailyUsd.toFixed(2)} ($${today.usd.toFixed(2)} used)`;
    return null;
  });
  const decided = approvedBy ? { decidedAt: at.toISOString(), decidedBy: approvedBy } : {};
  if (refusal) {
    const patch = { status: "denied" as const, reasons: [refusal], ...decided };
    await updateOrder(order.id, patch);
    logActivity({ orgId: order.orgId, agentId: order.agentId, via, tool: order.tool, orderId: order.id, ok: false, action: "order_denied", summary: `${orderSummary(order)} — refused at placement: ${refusal}` });
    return { ...order, ...patch };
  }

  try {
    const result = await invoke(order.orgId, order.tool, order.arguments);
    const patch = { status: "placed" as const, result, ...decided };
    await updateOrder(order.id, patch);
    logActivity({ orgId: order.orgId, agentId: order.agentId, via, tool: order.tool, orderId: order.id, ok: true, action: "order_placed", summary: `${orderSummary(order)} — placed${approvedBy ? " after owner approval" : ""}` });
    return { ...order, ...patch };
  } catch (err) {
    // A Robinhood-side rejection (isError) never reached the market; give the reservation back.
    // A transport failure might have, so its reservation stays counted.
    const rejected = err instanceof ToolCallError;
    if (rejected) await releaseDaily(order.orgId, usd, at).catch(() => {});
    const patch = { status: rejected ? ("rejected" as const) : ("failed" as const), error: (err as Error).message.slice(0, 500), ...decided };
    await updateOrder(order.id, patch);
    logActivity({
      orgId: order.orgId, agentId: order.agentId, via, tool: order.tool, orderId: order.id, ok: false, action: rejected ? "order_rejected" : "order_failed",
      summary: `${orderSummary(order)} — ${rejected ? "Robinhood rejected it" : "result unknown, check the order history"}: ${patch.error}`.slice(0, 300),
    });
    return { ...order, ...patch };
  }
}

export const isExpired = (order: OrderRecord, now = Date.now()) => order.status === "pending_approval" && now - Date.parse(order.createdAt) > APPROVAL_TTL_MS;

export function orderSummary(order: Pick<OrderRecord, "facts" | "notionalUsd" | "tool">): string {
  const f = order.facts;
  const size = f.dollarAmount != null ? `$${f.dollarAmount}` : f.quantity != null ? `${f.quantity}${f.assetClass === "option" ? " contracts" : ""}` : "?";
  const px = f.price != null ? ` @ ${f.price}` : "";
  const est = order.notionalUsd != null && f.dollarAmount == null ? ` (~$${order.notionalUsd.toFixed(2)})` : "";
  return `${(f.side ?? "trade").toUpperCase()} ${size} ${f.symbol ?? "?"}${px}${est} via ${order.tool}`;
}
