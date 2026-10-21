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

/** `review_*` simulates an order, so it reads; `place_*` / `submit_*` move money. */
export function classifyTool(name: string): ToolKind {
  const n = name.toLowerCase();
  if (/^(get|list|search|review|find|lookup|fetch)(_|$)/.test(n) || n === "search") return "read";
  if (n.startsWith("cancel")) return "cancel";
  if (/^(place|submit|create|replace)_.*order/.test(n) || /^(buy|sell|trade)(_|$)/.test(n)) return "trade";
  return "write";
}

export function assetClassOf(toolName: string): AssetClass {
  const n = toolName.toLowerCase();
  if (n.includes("option")) return "option";
  if (n.includes("crypto")) return "crypto";
  return "equity";
}

/** The matching dry-run tool Robinhood exposes for an order tool, e.g. place_equity_order → review_equity_order. */
export const reviewToolFor = (toolName: string) => toolName.replace(/^(place|submit|create)_/, "review_");

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

/** A new connection trades nothing without the owner seeing it first. */
export const DEFAULT_POLICY: Policy = {
  tradingEnabled: true,
  approval: "always",
  approvalThresholdUsd: 50,
  maxOrderUsd: 250,
  maxDailyUsd: 1_000,
  maxDailyOrders: 10,
  allowedSymbols: [],
  blockedSymbols: [],
  allowOptions: false,
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

export interface OrderFacts {
  assetClass: AssetClass;
  symbol: string | null;
  side: "buy" | "sell" | null;
  quantity: number | null;
  /** A dollar-amount (fractional) order's size. */
  dollarAmount: number | null;
  /** Limit or stop price, whichever bounds the fill. */
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

/** Reads an order's facts from the arguments an agent passed to a Robinhood order tool. */
export function describeOrder(toolName: string, args: Record<string, unknown>): OrderFacts {
  const symbol = pick(args, ["symbol", "ticker", "instrument_symbol", "underlying_symbol", "chain_symbol", "currency_pair", "pair"]);
  const side = String(pick(args, ["side", "direction", "action"]) ?? "").toLowerCase();
  return {
    assetClass: assetClassOf(toolName),
    symbol: typeof symbol === "string" && symbol.trim() ? symbol.trim().toUpperCase() : null,
    side: side.startsWith("buy") ? "buy" : side.startsWith("sell") ? "sell" : null,
    quantity: num(pick(args, ["quantity", "qty", "shares", "contracts", "units"])),
    dollarAmount: num(pick(args, ["dollar_amount", "amount", "notional", "dollars", "amount_in_dollars", "dollar_based_amount"])),
    price: num(pick(args, ["limit_price", "price", "stop_price", "stop_limit_price"])),
    orderType: (pick(args, ["type", "order_type"]) as string | undefined)?.toString().toLowerCase() ?? null,
  };
}

/** Option contracts cover 100 shares, so a premium of $1.20 costs $120 a contract. */
const MULTIPLIER: Record<AssetClass, number> = { equity: 1, option: 100, crypto: 1 };

/**
 * The order's size in dollars: its dollar amount, else quantity × (limit price,
 * then the review's or quote's price). Null when none of those are known.
 */
export function estimateNotional(order: OrderFacts, marketPrice: number | null): number | null {
  if (order.dollarAmount != null) return order.dollarAmount;
  const price = order.price ?? marketPrice;
  if (order.quantity == null || price == null) return null;
  return Math.round(order.quantity * price * MULTIPLIER[order.assetClass] * 100) / 100;
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
  if (!order.symbol) deny.push("The order has no symbol the guard can read (pass `symbol`)");
  else {
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

// ── Reading Robinhood's replies ──────────────────────────────────────────

const PRICE_KEYS = ["estimated_price", "price", "last_trade_price", "last_price", "mark_price", "ask_price", "bid_price", "last_extended_hours_trade_price"];
const COST_KEYS = ["estimated_cost", "estimated_total", "total_cost", "notional", "estimated_notional", "total"];

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
