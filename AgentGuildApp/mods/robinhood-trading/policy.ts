/**
 * The guard between an agent and real money. Pure: no I/O, so every rule is
 * unit-tested (src/lib/mods/__tests__/robinhood-policy.test.ts).
 *
 * Robinhood's MCP server owns the tool list and schemas and adds tools over
 * time (options, crypto…), so nothing here hard-codes a tool's arguments.
 * Tools are classified by name, and an order's symbol / side / size are read
 * from whichever common field names the call used. When the size in dollars
 * can't be worked out, the order goes to the owner instead of guessing.
 */

export type ToolKind = "read" | "write" | "trade" | "cancel";
export type AssetClass = "equity" | "option" | "crypto";

/** `review_*` and `preview_*` simulate an order, so they read. `place_*` moves money. `exercise_option` does too. */
export function classifyTool(name: string): ToolKind {
  const n = name.toLowerCase();
  if (/^(get|list|search|review|preview|find|lookup|fetch)(_|$)/.test(n) || n === "search") return "read";
  if (n.startsWith("cancel")) return "cancel";
  if (/^(place|submit|create|replace)_.*order/.test(n) || /^(buy|sell|trade)(_|$)/.test(n) || n.startsWith("exercise_")) return "trade";
  return "write";
}

export function assetClassOf(toolName: string): AssetClass {
  const n = toolName.toLowerCase();
  if (n.includes("option")) return "option";
  if (n.includes("crypto")) return "crypto";
  return "equity";
}

/**
 * The matching dry-run. Equity and options use review_*. Crypto uses preview_crypto_order.
 * replace_* is not rewritten: its arguments are not the review tool's arguments.
 */
export function reviewToolFor(toolName: string): string {
  if (!/^(place|submit|create)_/.test(toolName)) return "";
  if (/crypto/.test(toolName)) return toolName.replace(/^(place|submit|create)_/, "preview_");
  return toolName.replace(/^(place|submit|create)_/, "review_");
}

// ── Policy ───────────────────────────────────────────────────────────────

export type ApprovalMode = "always" | "over_threshold" | "never";

export interface Policy {
  /** Master switch: off = agents can read but every order is refused. */
  tradingEnabled: boolean;
  /** always: every order waits for the owner. over_threshold: orders above approvalThresholdUsd (or of unknown size) wait. never: within limits, orders go straight through. */
  approval: ApprovalMode;
  approvalThresholdUsd: number;
  maxOrderUsd: number;
  maxDailyUsd: number;
  maxDailyOrders: number;
  /** Upper-case tickers; empty = any symbol. */
  allowedSymbols: string[];
  blockedSymbols: string[];
  allowOptions: boolean;
  allowCrypto: boolean;
}

/**
 * A new connection still places nothing until the owner approves it.
 * Options are on because that is the Robinhood agent surface (defined-risk
 * spreads). Crypto stays off. $5,000 is a hard ceiling on max loss, per
 * order and per day — an order over it is refused, not queued.
 */
export const DEFAULT_POLICY: Policy = {
  tradingEnabled: true,
  approval: "always",
  approvalThresholdUsd: 50,
  maxOrderUsd: 5_000,
  maxDailyUsd: 5_000,
  maxDailyOrders: 10,
  allowedSymbols: [],
  blockedSymbols: [],
  allowOptions: true,
  allowCrypto: false,
};

export class PolicyInputError extends Error {}

const symbols = (v: unknown): string[] => {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : [];
  return [...new Set(list.map((s) => String(s).trim().toUpperCase()).filter(Boolean))].slice(0, 200);
};

function money(v: unknown, field: string, max = 10_000_000): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new PolicyInputError(`${field} must be a dollar amount between 0 and ${max.toLocaleString()}`);
  return Math.round(n * 100) / 100;
}

/** Merges an owner's edit onto the current policy, validating every field it touches. */
export function normalizePolicy(input: Record<string, unknown>, base: Policy = DEFAULT_POLICY): Policy {
  const p: Policy = { ...base };
  if (input.tradingEnabled !== undefined) p.tradingEnabled = input.tradingEnabled === true;
  if (input.approval !== undefined) {
    if (!["always", "over_threshold", "never"].includes(String(input.approval))) throw new PolicyInputError("approval must be always, over_threshold or never");
    p.approval = input.approval as ApprovalMode;
  }
  if (input.approvalThresholdUsd !== undefined) p.approvalThresholdUsd = money(input.approvalThresholdUsd, "approvalThresholdUsd");
  if (input.maxOrderUsd !== undefined) p.maxOrderUsd = money(input.maxOrderUsd, "maxOrderUsd");
  if (input.maxDailyUsd !== undefined) p.maxDailyUsd = money(input.maxDailyUsd, "maxDailyUsd");
  if (input.maxDailyOrders !== undefined) {
    const n = Number(input.maxDailyOrders);
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw new PolicyInputError("maxDailyOrders must be a whole number from 0 to 1000");
    p.maxDailyOrders = n;
  }
  if (input.allowedSymbols !== undefined) p.allowedSymbols = symbols(input.allowedSymbols);
  if (input.blockedSymbols !== undefined) p.blockedSymbols = symbols(input.blockedSymbols);
  if (input.allowOptions !== undefined) p.allowOptions = input.allowOptions === true;
  if (input.allowCrypto !== undefined) p.allowCrypto = input.allowCrypto === true;
  return p;
}

// ── Reading an order ─────────────────────────────────────────────────────

export interface OrderLeg {
  optionId: string;
  side: "buy" | "sell";
  positionEffect: "open" | "close";
  ratio: number;
}

export interface OrderFacts {
  assetClass: AssetClass;
  symbol: string | null;
  side: "buy" | "sell" | null;
  /** Net premium direction on a multi-leg option order. Not a buy/sell. */
  direction: "debit" | "credit" | null;
  legs: OrderLeg[];
  quantity: number | null;
  /** A dollar-amount (fractional) order's size. */
  dollarAmount: number | null;
  /** Limit or stop price, whichever bounds the fill. Option price is the net premium per share, always positive. */
  price: number | null;
  orderType: string | null;
}

const pick = (args: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (args[k] != null && args[k] !== "") return args[k];
  return undefined;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(/[$,]/g, "")) : Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

function parseLegs(args: Record<string, unknown>): OrderLeg[] {
  if (!Array.isArray(args.legs)) return [];
  const out: OrderLeg[] = [];
  for (const leg of args.legs) {
    if (!leg || typeof leg !== "object") continue;
    const l = leg as Record<string, unknown>;
    const side = String(l.side ?? "").toLowerCase();
    const effect = String(l.position_effect ?? "").toLowerCase();
    const ratio = Number(l.ratio_quantity);
    out.push({
      optionId: typeof l.option_id === "string" ? l.option_id : "",
      side: side === "sell" ? "sell" : "buy",
      positionEffect: effect === "close" ? "close" : "open",
      ratio: Number.isInteger(ratio) && ratio > 0 ? ratio : 1,
    });
  }
  return out;
}

/** Reads an order's facts from the arguments an agent passed to a Robinhood order tool. */
export function describeOrder(toolName: string, args: Record<string, unknown>): OrderFacts {
  const symbol = pick(args, ["symbol", "ticker", "instrument_symbol", "underlying_symbol", "chain_symbol", "currency_pair", "pair"]);
  const legs = parseLegs(args);
  // `direction` is debit|credit on a spread. It is not a side.
  const sideRaw = String(pick(args, ["side", "action"]) ?? "").toLowerCase();
  const dirRaw = String(args.direction ?? "").toLowerCase();
  const side = sideRaw.startsWith("buy") ? "buy" : sideRaw.startsWith("sell") ? "sell" : legs.length === 1 ? legs[0].side : null;
  return {
    assetClass: assetClassOf(toolName),
    symbol: typeof symbol === "string" && symbol.trim() ? symbol.trim().toUpperCase() : null,
    side,
    direction: dirRaw === "debit" || dirRaw === "credit" ? dirRaw : null,
    legs,
    quantity: num(pick(args, ["quantity", "qty", "shares", "contracts", "units"])),
    dollarAmount: num(pick(args, ["dollar_amount", "amount", "notional", "dollars", "amount_in_dollars", "dollar_based_amount"])),
    price: num(pick(args, ["limit_price", "price", "stop_price", "stop_limit_price"])),
    orderType: (pick(args, ["type", "order_type"]) as string | undefined)?.toString().toLowerCase() ?? null,
  };
}

/** Option contracts cover 100 shares, so a premium of $1.20 costs $120 a contract. */
const MULTIPLIER: Record<AssetClass, number> = { equity: 1, option: 100, crypto: 1 };

/**
 * Dollars at risk. Equity is quantity × price, or the dollar amount.
 * A long option or a debit spread risks the premium (price × 100 × contracts).
 * A credit spread's max loss is the width minus the credit, which this cannot
 * see — that stays null until the review reports collateral. A short option
 * with no long leg is the same: unknown, so the owner has to approve it.
 */
export function estimateNotional(order: OrderFacts, marketPrice: number | null): number | null {
  if (order.dollarAmount != null && order.assetClass !== "option") return order.dollarAmount;
  if (order.assetClass === "option") return optionRiskUsd(order);
  const price = order.price ?? marketPrice;
  if (order.quantity == null || price == null) return null;
  return Math.round(order.quantity * price * MULTIPLIER[order.assetClass] * 100) / 100;
}

function optionRiskUsd(order: OrderFacts): number | null {
  const price = order.price;
  if (order.quantity == null || price == null) return null;
  const premium = Math.round(order.quantity * price * MULTIPLIER.option * 100) / 100;
  const legs = order.legs;
  if (legs.length >= 2) return order.direction === "debit" ? premium : null;
  const side = legs[0]?.side ?? order.side;
  const effect = legs[0]?.positionEffect;
  if (side === "sell" && effect !== "close") return null;
  if (side === "buy" || order.direction === "debit") return premium;
  return null;
}

// ── Verdict ──────────────────────────────────────────────────────────────

export interface DailyUsage { orders: number; usd: number }

export interface Verdict {
  outcome: "allow" | "approve" | "deny";
  /** Why it was refused or held, phrased for the agent and the owner. */
  reasons: string[];
  notionalUsd: number | null;
}

export function evaluateOrder(policy: Policy, order: OrderFacts, notionalUsd: number | null, today: DailyUsage): Verdict {
  const deny: string[] = [];
  const hold: string[] = [];

  if (!policy.tradingEnabled) deny.push("The owner has turned trading off");
  if (order.assetClass === "option" && !policy.allowOptions) deny.push("Options trading isn't allowed by the owner's policy");
  if (order.assetClass === "crypto" && !policy.allowCrypto) deny.push("Crypto trading isn't allowed by the owner's policy");
  if (!order.symbol) {
    if (order.assetClass === "option" && order.legs.length && (policy.allowedSymbols.length || policy.blockedSymbols.length)) {
      deny.push("Option orders need chain_symbol so the symbol list can be checked");
    } else if (!(order.assetClass === "option" && order.legs.length)) {
      deny.push("The order has no symbol the guard can read (pass `symbol`, or `chain_symbol` on an option order)");
    }
  } else {
    if (policy.blockedSymbols.includes(order.symbol)) deny.push(`${order.symbol} is on the owner's blocked list`);
    if (policy.allowedSymbols.length && !policy.allowedSymbols.includes(order.symbol)) deny.push(`${order.symbol} isn't on the owner's allowed list (${policy.allowedSymbols.join(", ")})`);
  }
  if (today.orders + 1 > policy.maxDailyOrders) deny.push(`Daily order limit reached (${policy.maxDailyOrders})`);

  if (notionalUsd == null) {
    hold.push("The order's dollar size couldn't be determined, so the owner must approve it");
  } else {
    if (notionalUsd > policy.maxOrderUsd) deny.push(`$${notionalUsd.toFixed(2)} is over the per-order limit of $${policy.maxOrderUsd.toFixed(2)}`);
    if (today.usd + notionalUsd > policy.maxDailyUsd) deny.push(`$${notionalUsd.toFixed(2)} would take today's total past the daily limit of $${policy.maxDailyUsd.toFixed(2)} ($${today.usd.toFixed(2)} used)`);
    if (policy.approval === "over_threshold" && notionalUsd > policy.approvalThresholdUsd) hold.push(`Over the $${policy.approvalThresholdUsd.toFixed(2)} approval threshold`);
  }
  if (policy.approval === "always") hold.push("The owner approves every order");

  if (deny.length) return { outcome: "deny", reasons: deny, notionalUsd };
  // An order of unknown size can't skip the owner, even under approval: never.
  if (hold.length) return { outcome: "approve", reasons: hold, notionalUsd };
  return { outcome: "allow", reasons: [], notionalUsd };
}

// ── Shaping a live order ─────────────────────────────────────────────────
// Robinhood's order tools set additionalProperties: false. Review and place
// do not take the same fields: chain_symbol is review-only (it turns on
// collateral), ref_id is place-only. Sending either one to the wrong tool
// rejects the order.

export interface ShapedOrder {
  reviewArgs: Record<string, unknown>;
  placeArgs: Record<string, unknown>;
  issues: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const asUuid = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v.trim()) ? v.trim() : null);

function newRefId(): string {
  const uuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (!uuid) throw new PolicyInputError("crypto.randomUUID is unavailable");
  return uuid();
}

const strField = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
};

function refId(args: Record<string, unknown>, idempotencyKey?: string): string {
  return asUuid(args.ref_id) ?? asUuid(idempotencyKey) ?? newRefId();
}

function shapeOption(args: Record<string, unknown>, idempotencyKey?: string): ShapedOrder {
  const issues: string[] = [];
  const rawLegs = args.legs;
  if (!Array.isArray(rawLegs) || rawLegs.length < 1 || rawLegs.length > 4) {
    return { reviewArgs: {}, placeArgs: {}, issues: ["Option orders need 1 to 4 legs, each with option_id, side, and position_effect"] };
  }
  const legs: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const leg of rawLegs) {
    if (!leg || typeof leg !== "object") { issues.push("Each leg must be an object"); continue; }
    const l = leg as Record<string, unknown>;
    const option_id = typeof l.option_id === "string" ? l.option_id.trim() : "";
    const side = String(l.side ?? "").toLowerCase();
    const position_effect = String(l.position_effect ?? "").toLowerCase();
    if (!option_id) issues.push("Each leg needs option_id from get_option_instruments");
    if (side !== "buy" && side !== "sell") issues.push("Each leg side must be buy or sell");
    if (position_effect !== "open" && position_effect !== "close") issues.push("Each leg needs position_effect open or close");
    if (option_id && seen.has(option_id)) issues.push("Each leg must be a different contract");
    if (option_id) seen.add(option_id);
    const ratio = l.ratio_quantity == null || l.ratio_quantity === "" ? 1 : Number(l.ratio_quantity);
    if (!Number.isInteger(ratio) || ratio < 1) issues.push("ratio_quantity must be a positive whole number");
    legs.push({ option_id, side, position_effect, ratio_quantity: ratio });
  }
  if (legs.length === 1 && legs[0]?.ratio_quantity !== 1) issues.push("A single-leg order's ratio_quantity must be 1");

  const quantity = strField(args.quantity);
  if (!quantity || !/^[1-9]\d*$/.test(quantity)) issues.push("quantity must be a positive whole number of contracts");

  const type = typeof args.type === "string" && args.type.trim() ? args.type.trim().toLowerCase() : "limit";
  if (!["limit", "market", "stop_limit", "stop_market"].includes(type)) issues.push("type must be limit, market, stop_limit, or stop_market");
  if (legs.length >= 2 && type !== "limit") issues.push("Multi-leg option orders are limit only");
  if (type === "market" || type === "stop_market") issues.push("Use a limit. Robinhood rejects option market and stop-market orders");

  let direction: string | undefined;
  if (legs.length >= 2) {
    direction = String(args.direction ?? "").toLowerCase();
    if (direction !== "debit" && direction !== "credit") issues.push("Multi-leg orders need direction debit or credit. Price is the net premium and is always positive");
  } else if (args.direction != null && String(args.direction).trim()) {
    direction = String(args.direction).toLowerCase();
    if (direction !== "debit" && direction !== "credit") issues.push("direction must be debit or credit");
  }

  const price = strField(args.price);
  if ((type === "limit" || type === "stop_limit") && !(price && Number(price) > 0)) issues.push("A limit option order needs a positive price");
  const stopPrice = strField(args.stop_price);
  if (type === "stop_limit" && !stopPrice) issues.push("stop_limit needs stop_price");

  const chain = typeof args.chain_symbol === "string" && args.chain_symbol.trim() ? args.chain_symbol.trim().toUpperCase() : undefined;
  let underlying = typeof args.underlying_type === "string" && args.underlying_type.trim() ? args.underlying_type.trim().toLowerCase() : undefined;
  if (chain && !underlying) underlying = "equity";
  if (underlying && underlying !== "equity" && underlying !== "index") issues.push("underlying_type must be equity or index");

  const tif = typeof args.time_in_force === "string" && args.time_in_force.trim() ? args.time_in_force.trim().toLowerCase() : "gfd";
  if (tif !== "gfd" && tif !== "gtc") issues.push("time_in_force must be gfd or gtc");

  const common: Record<string, unknown> = { legs, type, quantity, time_in_force: tif };
  if (direction && (direction === "debit" || direction === "credit")) common.direction = direction;
  if (price && (type === "limit" || type === "stop_limit")) common.price = price;
  if (stopPrice && type === "stop_limit") common.stop_price = stopPrice;
  if (typeof args.market_hours === "string" && args.market_hours.trim()) common.market_hours = args.market_hours.trim();
  if (typeof args.account_number === "string" && args.account_number.trim()) common.account_number = args.account_number.trim();

  const reviewArgs: Record<string, unknown> = { ...common };
  if (chain) reviewArgs.chain_symbol = chain;
  if (chain && underlying) reviewArgs.underlying_type = underlying;
  const placeArgs: Record<string, unknown> = { ...common, ref_id: refId(args, idempotencyKey) };
  return { reviewArgs, placeArgs, issues };
}

function shapeEquity(args: Record<string, unknown>, idempotencyKey?: string): ShapedOrder {
  const issues: string[] = [];
  const symbol = typeof args.symbol === "string" ? args.symbol.trim().toUpperCase() : "";
  const side = String(args.side ?? "").toLowerCase();
  const type = String(args.type ?? "").toLowerCase();
  if (!symbol) issues.push("Equity orders need symbol");
  if (side !== "buy" && side !== "sell") issues.push("Equity orders need side buy or sell");
  if (!["market", "limit", "stop_market", "stop_limit"].includes(type)) issues.push("Equity orders need type: market, limit, stop_market, or stop_limit");
  const quantity = strField(args.quantity);
  const dollar = strField(args.dollar_amount);
  if (quantity && dollar) issues.push("Pass quantity or dollar_amount, not both");
  if (!quantity && !dollar) issues.push("Pass quantity or dollar_amount");
  if (dollar && type !== "market") issues.push("dollar_amount is only valid with type market");
  const limitPrice = strField(args.limit_price);
  const stopPrice = strField(args.stop_price);
  if ((type === "limit" || type === "stop_limit") && !limitPrice) issues.push("This order type needs limit_price");
  if ((type === "stop_market" || type === "stop_limit") && !stopPrice) issues.push("This order type needs stop_price");
  const common: Record<string, unknown> = { symbol, side, type };
  if (quantity) common.quantity = quantity;
  if (dollar) common.dollar_amount = dollar;
  if (limitPrice && (type === "limit" || type === "stop_limit")) common.limit_price = limitPrice;
  if (stopPrice && (type === "stop_market" || type === "stop_limit")) common.stop_price = stopPrice;
  if (typeof args.time_in_force === "string" && args.time_in_force.trim()) common.time_in_force = args.time_in_force.trim().toLowerCase();
  if (typeof args.market_hours === "string" && args.market_hours.trim()) common.market_hours = args.market_hours.trim();
  if (args.tax_lots != null) common.tax_lots = args.tax_lots;
  if (typeof args.account_number === "string" && args.account_number.trim()) common.account_number = args.account_number.trim();
  return { reviewArgs: { ...common }, placeArgs: { ...common, ref_id: refId(args, idempotencyKey) }, issues };
}

function shapeCrypto(args: Record<string, unknown>, idempotencyKey?: string): ShapedOrder {
  const issues: string[] = [];
  const symbol = typeof args.symbol === "string" ? args.symbol.trim().toUpperCase() : "";
  const side = String(args.side ?? "").toLowerCase();
  const type = String(args.type ?? "").toLowerCase();
  if (!symbol) issues.push("Crypto orders need symbol");
  if (side !== "buy" && side !== "sell") issues.push("Crypto orders need side buy or sell");
  if (!["market", "limit", "stop_loss", "stop_limit"].includes(type)) issues.push("Crypto type must be market, limit, stop_loss, or stop_limit");
  const quantity = strField(args.quantity);
  const dollar = strField(args.dollar_amount);
  if (quantity && dollar) issues.push("Pass quantity or dollar_amount, not both");
  if (!quantity && !dollar) issues.push("Pass quantity or dollar_amount");
  const common: Record<string, unknown> = { symbol, side, type };
  if (quantity) common.quantity = quantity;
  if (dollar) common.dollar_amount = dollar;
  const limitPrice = strField(args.limit_price);
  const stopPrice = strField(args.stop_price);
  if (limitPrice) common.limit_price = limitPrice;
  if (stopPrice) common.stop_price = stopPrice;
  if (typeof args.time_in_force === "string" && args.time_in_force.trim()) common.time_in_force = args.time_in_force.trim();
  if (args.tax_lots != null) common.tax_lots = args.tax_lots;
  const rhs = typeof args.rhs_account_number === "string" ? args.rhs_account_number.trim() : "";
  if (rhs) common.rhs_account_number = rhs;
  return { reviewArgs: { ...common }, placeArgs: { ...common, ref_id: refId(args, idempotencyKey) }, issues };
}

/** Review args and place args for a Robinhood order tool. Issues are for the agent to fix before any review. */
export function shapeOrder(toolName: string, args: Record<string, unknown>, idempotencyKey?: string): ShapedOrder {
  const kind = assetClassOf(toolName);
  if (kind === "option" && toolName.includes("order")) return shapeOption(args, idempotencyKey);
  if (kind === "crypto" && toolName.includes("order")) return shapeCrypto(args, idempotencyKey);
  if (kind === "equity" && toolName.includes("order")) return shapeEquity(args, idempotencyKey);
  const ref = asUuid(args.ref_id) ?? asUuid(idempotencyKey);
  return { reviewArgs: { ...args }, placeArgs: ref ? { ...args, ref_id: ref } : { ...args }, issues: [] };
}

// ── The agentic account ──────────────────────────────────────────────────

export interface AgenticAccount {
  accountNumber: string;
  rhsAccountNumber: string | null;
  optionLevel: string | null;
}

/** Every account object in a get_accounts payload with agentic_allowed true. */
export function findAgenticAccounts(value: unknown): AgenticAccount[] {
  const found: AgenticAccount[] = [];
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 6) return;
    if (Array.isArray(v)) { for (const item of v) visit(item, depth + 1); return; }
    const o = v as Record<string, unknown>;
    if (o.agentic_allowed === true && typeof o.account_number === "string" && o.account_number.trim()) {
      found.push({
        accountNumber: o.account_number.trim(),
        rhsAccountNumber: typeof o.rhs_account_number === "string" && o.rhs_account_number.trim() ? o.rhs_account_number.trim() : null,
        optionLevel: typeof o.option_level === "string" ? o.option_level : null,
      });
    }
    for (const child of Object.values(o)) if (child && typeof child === "object") visit(child, depth + 1);
  };
  visit(value, 0);
  return [...new Map(found.map((a) => [a.accountNumber, a])).values()];
}

export const maskAccount = (n: string) => {
  const t = n.trim();
  return t.length <= 4 ? "••••" : `••••${t.slice(-4)}`;
};

const ACCOUNT_KEYS = new Set(["account_number", "rhs_account_number", "rhc_account_number"]);

/** Copy that hides brokerage account numbers. The stored order keeps the real ones for placement. */
export function maskAccountNumbers(value: unknown): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = ACCOUNT_KEYS.has(k) && typeof val === "string" ? maskAccount(val) : walk(val);
    }
    return out;
  };
  return walk(value);
}

// ── Reading Robinhood's replies ──────────────────────────────────────────

const PRICE_KEYS = ["estimated_price", "price", "last_trade_price", "last_price", "mark_price", "ask_price", "bid_price", "last_extended_hours_trade_price"];
const COST_KEYS = ["estimated_cost", "estimated_total", "total_cost", "notional", "estimated_notional", "total"];
/** Max loss / collateral. Preferred over the premium on a credit spread. */
const RISK_KEYS = ["max_loss", "maximum_loss", "collateral", "collateral_required", "buying_power_required", "margin_requirement"];

/** First positive number under any of `keys`, searching nested objects/arrays breadth-first. */
function findNumber(value: unknown, keys: string[]): number | null {
  const queue: unknown[] = [value];
  for (let seen = 0; queue.length && seen < 500; seen++) {
    const v = queue.shift();
    if (!v || typeof v !== "object") continue;
    if (Array.isArray(v)) { queue.push(...v); continue; }
    const obj = v as Record<string, unknown>;
    for (const k of keys) {
      const n = num(obj[k] && typeof obj[k] === "object" ? (obj[k] as Record<string, unknown>).amount : obj[k]);
      if (n != null) return n;
    }
    queue.push(...Object.values(obj));
  }
  return null;
}

/** A per-share price from a quote or review result, if it carries one. */
export const priceIn = (result: unknown) => findNumber(result, PRICE_KEYS);
/** An order's estimated dollar cost from a review result, if it carries one. */
export const costIn = (result: unknown) => findNumber(result, COST_KEYS);
/** Collateral or max loss from an option review, when Robinhood sends it. */
export const riskIn = (result: unknown) => findNumber(result, RISK_KEYS);

/** The pre-trade warnings in a review result, as plain strings. */
export function warningsIn(result: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 4) return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/warning|alert|error/i.test(k)) {
        for (const w of Array.isArray(val) ? val : [val]) {
          const text = typeof w === "string" ? w : (w as Record<string, unknown>)?.message ?? (w as Record<string, unknown>)?.detail;
          if (typeof text === "string" && text.trim()) out.push(text.trim());
        }
      } else visit(val, depth + 1);
    }
  };
  visit(result, 0);
  return [...new Set(out)].slice(0, 10);
}
