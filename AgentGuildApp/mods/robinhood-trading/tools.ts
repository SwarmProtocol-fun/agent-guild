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
    description: "Whether you have connected Robinhood (connection.connected — if not, ask your human to run rh-agent.mjs login), which Robinhood upgrades you have, the owner's trading policy (limits, approval mode, allowed symbols) and how much of today's org-wide limit is used. Call this first.",
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
    description: "Place a real-money order in the agent's Robinhood Agentic account. Robinhood reviews it first, then the owner's policy holds it, refuses it, or (only if the owner turned approval off) places it. Equity: symbol, side, type, and quantity or dollar_amount. Options: place_option_order with legs (option_id, side, position_effect), quantity, type limit, a positive price, and direction debit or credit when there are 2+ legs. Pass chain_symbol. Leave account_number off unless you already know the agentic account — this mod fills that in and rejects every other account. A fresh ref_id is added on place. Credit-spread size is max loss from the review, not the credit.",
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
  "You connect Robinhood yourself, once: run `node mods/robinhood-trading/agent/rh-agent.mjs login` on your machine and have your human sign in on the page it opens (Robinhood only signs in to localhost). Until then every Robinhood tool answers 409.",
  "Orders go only to the account with agentic_allowed. Other accounts are read-only. This mod fills account_number from get_accounts when there is exactly one agentic account, and refuses any other account number.",
  "Buying power is get_portfolio, not get_accounts. Pass the agentic account_number.",
  "Option orders are place_option_order: 1 to 4 legs on one underlying, each a different option_id from get_option_instruments. Multi-leg is limit only, price is the net premium and always positive, and direction is debit or credit. Pass chain_symbol and underlying_type equity so the review includes collateral. Market and stop-market option orders are rejected here.",
  "A debit risks the premium. A credit spread's size is the collateral from the review (width minus credit), not the credit. If that number is missing, the order waits for the owner.",
  "Nothing is placed while the owner's approval mode is always (the default), options or not. A held order expires after 24 hours. Caps are a hard ceiling: an order over them is refused, not queued.",
  "Always send idempotencyKey with rh_order, and reuse it when retrying after a timeout. The same key is sent to Robinhood as ref_id when it is a UUID.",
  "Start with rh_me, then rh_tools. Names and arguments come from Robinhood and change.",
];
