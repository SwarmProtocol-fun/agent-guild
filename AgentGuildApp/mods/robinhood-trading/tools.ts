/**
 * The agent-facing surface of the Robinhood mod as LLM tool definitions
 * (`input_schema` is the Anthropic tool shape; OpenAI takes it as
 * `parameters`), served by GET /agent/tools. `method`/`path` tell the
 * agent's runtime which route to call: `{x}` path segments come from the
 * input field of the same name, the remaining fields go in the query string
 * (GET) or JSON body (POST). agentId/orgId are absent everywhere — the
 * agent's signature or token supplies them.
 *
 * Robinhood's own tools (get_portfolio, get_equity_quotes, place_equity_order…)
 * aren't copied here: they change on Robinhood's side. rh_tools lists them
 * with their live schemas; rh_call runs the read/watchlist ones and rh_order
 * the order ones, behind the owner's policy.
 */

/** Capability keys = the agentSkills ids on this mod's SKILL_REGISTRY entry (lib/skills.ts). */
export const CAP = {
  read: "rh-read",
  watchlist: "rh-watchlist",
  trade: "rh-trade",
} as const;
export type CapKey = (typeof CAP)[keyof typeof CAP];

export interface AgentTool {
  name: string;
  description: string;
  method: "GET" | "POST";
  /** Relative to /api/mods/robinhood-trading/. */
  path: string;
  capability: CapKey | null;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "rh_me",
    description: "Whether your org has connected Robinhood, which Robinhood upgrades you have, the owner's trading policy (limits, approval mode, allowed symbols) and how much of today's limit is used. Call this first.",
    method: "GET", path: "me", capability: null,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "rh_tools",
    description: "Robinhood's live tool list with each tool's input schema and kind: read (portfolio, positions, quotes, orders, search, review_* dry runs), write (watchlists), trade (place_* orders → use rh_order) or cancel. Read the schema before calling a tool.",
    method: "GET", path: "tools", capability: CAP.read,
    input_schema: { type: "object", properties: { fresh: { type: "boolean", description: "Skip the 5-minute cache." } } },
  },
  {
    name: "rh_call",
    description: "Run one Robinhood read, watchlist or cancel tool, e.g. { tool: \"get_portfolio\", arguments: {} } or { tool: \"get_equity_quotes\", arguments: { symbols: [\"AAPL\"] } }. Order tools are refused here — place orders with rh_order.",
    method: "POST", path: "call", capability: CAP.read,
    input_schema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "A tool name from rh_tools." },
        arguments: { type: "object", description: "Arguments matching that tool's input schema." },
      },
      required: ["tool"],
    },
  },
  {
    name: "rh_order",
    description: "Place a real-money order in the owner's Robinhood Agentic account. Robinhood reviews it first (warnings come back), then the owner's policy decides: placed now, held for the owner's approval (status pending_approval — check back with rh_orders), or refused with reasons. Pass the same arguments the order tool's schema asks for, including `symbol` and `side`.",
    method: "POST", path: "orders", capability: CAP.trade,
    input_schema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Order tool from rh_tools, default place_equity_order." },
        arguments: { type: "object", description: "The order tool's arguments (symbol, side, quantity or dollar amount, type, limit price…)." },
        reason: { type: "string", description: "One sentence on why — the owner reads it when approving." },
        idempotencyKey: { type: "string", description: "Any unique string for this decision. Retrying with the same key returns the first attempt instead of ordering twice." },
      },
      required: ["arguments", "reason"],
    },
  },
  {
    name: "rh_orders",
    description: "Your orders through this mod, newest first, with status (pending_approval, placing, placed, denied, rejected, failed, expired), the policy reasons and Robinhood's review warnings. For fills and Robinhood-side order state, rh_call get_equity_orders.",
    method: "GET", path: "orders", capability: null,
    input_schema: { type: "object", properties: { status: { type: "string", enum: ["pending_approval", "placing", "placed", "denied", "rejected", "failed", "expired"] } } },
  },
  {
    name: "rh_order_status",
    description: "One of your orders by id, as returned by rh_order.",
    method: "GET", path: "orders/{id}", capability: null,
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

export const NOTES = [
  "Every order is real money in the owner's Robinhood Agentic account. Paper-trade elsewhere first.",
  "Start with rh_me: it tells you if trading is on, the limits and whether the owner approves each order.",
  "Use rh_tools for the live schema of every Robinhood tool before calling it; names and arguments come from Robinhood and change.",
  "Before an order, check buying power (get_accounts / get_portfolio) and the quote (get_equity_quotes).",
  "Always send idempotencyKey with rh_order, and reuse it when retrying after a timeout.",
  "A held order isn't placed until the owner approves it on the panel; held orders expire after 24 hours.",
];
