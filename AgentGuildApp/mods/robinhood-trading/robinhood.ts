/**
 * An agent's live link to Robinhood: a fresh access token, the tool list, and
 * the one path every order takes (review → policy → approval or placement).
 * Each agent has its own connection (see store.ts ConnRef); the policy, daily
 * limits and approvals are the org's. Server-only.
 */
import { OAuthError, refreshTokens } from "./oauth";
import { McpAuthError, callTool, forgetSession, listTools, resultValue, type McpTool } from "./mcp";
import {
  assetClassOf, classifyTool, costIn, describeOrder, estimateNotional, evaluateOrder, findAgenticAccounts, maskAccount, priceIn, reviewToolFor, riskIn, shapeOrder, warningsIn,
  type ShapedOrder, type ToolKind, type Verdict,
} from "./policy";
import {
  APPROVAL_TTL_MS, connKey, createOrder, getConnection, getDailyUsage, getPolicy, logActivity, markNeedsReconnect, releaseDaily,
  reserveDaily, updateOrder, updateTokens, type ConnRef, type OrderRecord,
} from "./store";

export class NotConnectedError extends Error {}

const RECONNECT_HINT = "run `node rh-agent.mjs login` on the agent's machine, or connect it from the Robinhood panel";

// ── Tokens ───────────────────────────────────────────────────────────────

// Concurrent requests share one refresh: Robinhood may rotate the refresh
// token, and a second refresh with the spent one would kill the grant.
const refreshing = new Map<string, Promise<string>>();

async function accessToken(ref: ConnRef, force = false): Promise<string> {
  const conn = await getConnection(ref);
  if (!conn) throw new NotConnectedError(`Agent ${ref.agentId} hasn't connected Robinhood yet — ${RECONNECT_HINT}`);
  if (conn.status === "needs_reconnect") throw new NotConnectedError(`Agent ${ref.agentId}'s Robinhood connection needs a fresh sign-in (${conn.lastError ?? "grant expired"}) — ${RECONNECT_HINT}`);
  if (!force && conn.tokens.expiresAt - Date.now() > 60_000) return conn.tokens.accessToken;
  if (!conn.tokens.refreshToken) {
    await markNeedsReconnect(ref, "Access token expired and Robinhood issued no refresh token");
    throw new NotConnectedError(`The Robinhood session expired — ${RECONNECT_HINT}`);
  }
  const key = connKey(ref);
  let pending = refreshing.get(key);
  if (!pending) {
    pending = refreshTokens(conn.clientId, conn.tokens.refreshToken)
      .then(async (tokens) => { await updateTokens(ref, tokens); return tokens.accessToken; })
      .catch(async (err) => {
        if (err instanceof OAuthError && err.reconnect) {
          await markNeedsReconnect(ref, err.message);
          throw new NotConnectedError(`Robinhood ended the session — ${RECONNECT_HINT}`);
        }
        throw err;
      })
      .finally(() => refreshing.delete(key));
    refreshing.set(key, pending);
  }
  return pending;
}

/** Runs fn with a valid token, refreshing and retrying once when Robinhood rejects it. */
async function withToken<T>(ref: ConnRef, fn: (token: string, key: string) => Promise<T>): Promise<T> {
  const key = connKey(ref);
  try {
    return await fn(await accessToken(ref), key);
  } catch (err) {
    if (!(err instanceof McpAuthError)) throw err;
    forgetSession(key);
    return fn(await accessToken(ref, true), key);
  }
}

// ── Tools ────────────────────────────────────────────────────────────────

export interface ToolInfo extends McpTool { kind: ToolKind }

const TOOLS_TTL_MS = 5 * 60_000;
const toolCache = new Map<string, { at: number; tools: ToolInfo[] }>();

export async function robinhoodTools(ref: ConnRef, fresh = false): Promise<ToolInfo[]> {
  const hit = toolCache.get(connKey(ref));
  if (hit && !fresh && Date.now() - hit.at < TOOLS_TTL_MS) return hit.tools;
  const tools = (await withToken(ref, (t, key) => listTools(key, t))).map((tool) => ({ ...tool, kind: classifyTool(tool.name) }));
  toolCache.set(connKey(ref), { at: Date.now(), tools });
  return tools;
}

export class ToolCallError extends Error {
  constructor(message: string, readonly value: unknown) { super(message); }
}

/** Calls one Robinhood tool and returns its value; a tool-level error (isError) throws with Robinhood's message. */
export async function invoke(ref: ConnRef, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await withToken(ref, (t, key) => callTool(key, t, name, args));
  const value = resultValue(result);
  if (result.isError) throw new ToolCallError(`Robinhood ${name}: ${typeof value === "string" ? value : JSON.stringify(value).slice(0, 300)}`, value);
  return value;
}

export function clearToolCache(ref: ConnRef): void {
  toolCache.delete(connKey(ref));
  forgetSession(connKey(ref));
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
/** Writes the one agentic account onto both argument sets. Refuses every other account. */
async function pinAccount(ref: ConnRef, tool: string, shaped: ShapedOrder): Promise<void> {
  const cls = assetClassOf(tool);
  let accounts;
  try {
    accounts = findAgenticAccounts(await invoke(ref, "get_accounts", {}));
  } catch (err) {
    if (shaped.placeArgs.account_number || shaped.placeArgs.rhs_account_number) return;
    throw new ToolCallError(`Couldn't read accounts to find the agentic one: ${(err as Error).message}`, null);
  }
  if (!accounts.length) throw new ToolCallError("This login has no agentic account. Robinhood only accepts orders on the account with agentic_allowed", null);

  if (cls === "crypto") {
    const given = typeof shaped.placeArgs.rhs_account_number === "string" ? shaped.placeArgs.rhs_account_number : "";
    const match = given
      ? accounts.find((a) => a.rhsAccountNumber === given || a.accountNumber === given)
      : accounts.length === 1 ? accounts[0] : undefined;
    if (!match) {
      throw new ToolCallError(given
        ? `${maskAccount(given)} is not an agentic crypto account`
        : "More than one agentic account. Pass rhs_account_number", null);
    }
    if (!match.rhsAccountNumber) throw new ToolCallError(`Account ${maskAccount(match.accountNumber)} has no crypto account number`, null);
    shaped.reviewArgs.rhs_account_number = match.rhsAccountNumber;
    shaped.placeArgs.rhs_account_number = match.rhsAccountNumber;
    return;
  }

  const given = typeof shaped.placeArgs.account_number === "string" ? shaped.placeArgs.account_number : "";
  const match = given ? accounts.find((a) => a.accountNumber === given) : accounts.length === 1 ? accounts[0] : undefined;
  if (!match) {
    const hint = accounts.map((a) => maskAccount(a.accountNumber)).join(", ");
    throw new ToolCallError(given
      ? `${maskAccount(given)} is not agent-tradable. The agentic account is ${hint}`
      : `More than one agentic account (${hint}). Pass account_number`, null);
  }
  if (cls === "option" && match.optionLevel) {
    const legs = Array.isArray(shaped.placeArgs.legs) ? shaped.placeArgs.legs.length : 1;
    if (match.optionLevel === "option_level_0") throw new ToolCallError(`Account ${maskAccount(match.accountNumber)} cannot trade options`, null);
    if (legs >= 2 && !match.optionLevel.includes("3")) throw new ToolCallError(`Multi-leg spreads need options level 3. Account ${maskAccount(match.accountNumber)} is ${match.optionLevel}`, null);
  }
  shaped.reviewArgs.account_number = match.accountNumber;
  shaped.placeArgs.account_number = match.accountNumber;
}

export async function submitOrder(req: OrderRequest): Promise<OrderOutcome> {
  const ref = { orgId: req.orgId, agentId: req.agentId };
  const tools = await robinhoodTools(ref);
  const tool = tools.find((t) => t.name === req.tool);
  if (!tool) throw new ToolCallError(`Robinhood has no tool named ${req.tool}`, null);
  if (tool.kind !== "trade") throw new ToolCallError(`${req.tool} isn't an order tool — use rh_call`, null);

  const shaped = shapeOrder(req.tool, req.arguments, req.idempotencyKey);
  if (shaped.issues.length) throw new ToolCallError(shaped.issues.join("; "), null);
  await pinAccount(ref, req.tool, shaped);
  const facts = describeOrder(req.tool, { ...shaped.placeArgs, ...shaped.reviewArgs });

  // Review uses the review field set (chain_symbol, no ref_id). A failed review never auto-places.
  let review: unknown = null;
  let warnings: string[] = [];
  let reviewFailed = false;
  const reviewName = reviewToolFor(req.tool);
  const reviewTool = tools.find((t) => t.name === reviewName);
  if (reviewTool) {
    try {
      review = await invoke(ref, reviewName, shaped.reviewArgs);
      warnings = warningsIn(review);
    } catch (err) {
      reviewFailed = true;
      warnings = [`Robinhood's review failed: ${(err as Error).message}`];
      review = err instanceof ToolCallError ? err.value : null;
    }
  } else {
    reviewFailed = true;
    warnings = [reviewName ? `Robinhood has no ${reviewName} dry-run, so this waits for the owner` : "This order has no dry-run, so it waits for the owner"];
  }

  let marketPrice = priceIn(review);
  if (facts.dollarAmount == null && facts.price == null && marketPrice == null && facts.symbol && facts.assetClass === "equity") {
    const quoteTool = tools.find((t) => t.name === "get_equity_quotes") ?? tools.find((t) => t.kind === "read" && /quote/.test(t.name));
    if (quoteTool) marketPrice = priceIn(await invoke(ref, quoteTool.name, quoteArgs(quoteTool, facts.symbol)).catch(() => null));
  }
  const notional = facts.assetClass === "option"
    ? (riskIn(review) ?? estimateNotional(facts, null))
    : (costIn(review) ?? estimateNotional(facts, marketPrice));

  const [policy, today] = await Promise.all([getPolicy(req.orgId), getDailyUsage(req.orgId)]);
  let verdict = evaluateOrder(policy, facts, notional, today);
  if (reviewFailed && verdict.outcome === "allow") {
    verdict = { outcome: "approve", reasons: ["Robinhood's review did not succeed, so this waits for the owner", ...verdict.reasons], notionalUsd: verdict.notionalUsd };
  }

  const base: Omit<OrderRecord, "id" | "status"> = {
    orgId: req.orgId, agentId: req.agentId, tool: req.tool, arguments: shaped.placeArgs, facts, notionalUsd: notional,
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
    // Placed through the agent that asked for it: its own Robinhood connection.
    const result = await invoke({ orgId: order.orgId, agentId: order.agentId }, order.tool, order.arguments);
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
  const est = order.notionalUsd != null && f.dollarAmount == null ? ` (~$${order.notionalUsd.toFixed(2)})` : "";
  if (f.assetClass === "option") {
    const dir = f.direction ? f.direction.toUpperCase() : (f.side ?? "option").toUpperCase();
    const size = f.quantity != null ? `${f.quantity}` : "?";
    const legs = f.legs && f.legs.length > 1 ? ` ${f.legs.length}-leg` : "";
    const px = f.price != null ? ` @ ${f.price}` : "";
    const risk = order.notionalUsd != null ? ` (max loss ~$${order.notionalUsd.toFixed(2)})` : "";
    return `${dir} ${size}${legs} ${f.symbol ?? "option"}${px}${risk} via ${order.tool}`;
  }
  const size = f.dollarAmount != null ? `$${f.dollarAmount}` : f.quantity != null ? `${f.quantity}` : "?";
  const px = f.price != null ? ` @ ${f.price}` : "";
  return `${(f.side ?? "trade").toUpperCase()} ${size} ${f.symbol ?? "?"}${px}${est} via ${order.tool}`;
}
