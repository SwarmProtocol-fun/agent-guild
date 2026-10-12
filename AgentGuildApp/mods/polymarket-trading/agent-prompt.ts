// The instruction briefing the panel sends to (or copies for) an agent so it
// can trade Polymarket through the Connect CLI or MCP. Pure: the panel fills
// it from the live account; tests pin what it promises the agent.

export interface PromptAccount {
  mode: "paper" | "live";
  cash: number | null;
  risk: { maxOrderUsd: number; maxExposureUsd: number; maxDailyLossUsd: number } | null;
}

export const TASK_PRESETS = [
  { id: "trade", label: "One paper trade", task: "Make one $10 trade on an active bitcoin market where you think the price is wrong. Explain why before you buy." },
  { id: "bot", label: "Start a bot", task: "Create a streak-fade bot with sizeUsd 5 and maxLossUsd 20, start it, then show me its first log lines." },
  { id: "checkin", label: "Check-in", task: "Show your open positions, today's PnL, your last 5 trades, and whether any bot is waiting on you." },
  { id: "research", label: "Research", task: "Find three markets closing within a week where you think the price is off by 10 points or more. For each: the market, your probability, the ask, and why. Don't trade yet." },
  { id: "review", label: "Review bots", task: "For each of your bots, report entries, win rate and realized PnL from polymarket_bots, read its last 10 log lines, and recommend keep, tighten maxLossUsd, or stop. Change nothing yet." },
  { id: "cut", label: "Cut losers", task: "List open positions that are down more than 30% from your average price. Sell any where the reason you bought no longer holds, and explain each one you keep." },
] as const;

/** One-tap questions for the market the operator is looking at; buildMarketTask wraps them with the market's details. */
export const MARKET_ASKS = [
  { id: "view", label: "Your view", ask: "What's your probability for this outcome, and is the ask a buy? Don't trade." },
  { id: "buy", label: "Buy if mispriced", ask: "If you think this outcome is underpriced by 10 points or more, buy $10 of it with a limit at the current ask. Otherwise say why not." },
  { id: "watch", label: "Set a trigger", ask: "Set up a price-trigger bot on this outcome at a price you'd be happy to buy, sizeUsd 5, maxLossUsd 15, and tell me the level you chose." },
] as const;

export interface MarketContext {
  conditionId: string;
  question: string;
  outcome: string;
  outcomeIndex: number;
  /** Best ask in 0–1, if the book is loaded. */
  ask: number | null;
  endDate: string | null;
}

/** The task line for a question about one market: names it exactly so the agent looks up the same conditionId and outcome. */
export function buildMarketTask(m: MarketContext, ask: string): string {
  const price = m.ask != null ? ` (ask ${(m.ask * 100).toFixed(1).replace(/\.0$/, "")}¢)` : "";
  const ends = m.endDate ? `, ends ${m.endDate.slice(0, 10)}` : "";
  return `Market "${m.question}" — conditionId ${m.conditionId}, outcome "${m.outcome}" = outcomeIndex ${m.outcomeIndex}${price}${ends}. ${ask.trim() || MARKET_ASKS[0].ask}`;
}

/** Saved AI Predictor instructions, shared across an org. Same length cap as a bot's instructions. */
export const TEMPLATE_NAME_MAX = 60;
export const TEMPLATE_TEXT_MAX = 2000;
export const TEMPLATES_PER_ORG = 50;

/** Trimmed { name, text }, or the reason it can't be saved. */
export function parseTemplate(raw: { name?: unknown; text?: unknown }): { name: string; text: string } | string {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!name) return "Give the prompt a name";
  if (name.length > TEMPLATE_NAME_MAX) return `Keep the name under ${TEMPLATE_NAME_MAX} characters`;
  if (!text) return "The prompt is empty";
  if (text.length > TEMPLATE_TEXT_MAX) return `Keep the prompt under ${TEMPLATE_TEXT_MAX} characters`;
  return { name, text };
}

export const MAX_PROMPT_CHARS = 8000;

const money = (n: number | null | undefined) => (n == null ? "unknown" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

export function buildAgentPrompt(agent: { agentId: string; name: string }, account: PromptAccount, task: string): string {
  const paper = account.mode === "paper";
  const risk = account.risk;
  const run = `agent-guild --as ${agent.agentId} mod call polymarket-trading`;
  return [
    `${agent.name}, you have a Polymarket trading account on Agent Guild.`,
    `Mode: ${paper ? "PAPER — simulated money, filled against the real Polymarket order book with real fees" : "LIVE — real funds from your own wallet"}. Cash: ${money(account.cash)}.`,
    risk
      ? `Limits the hub enforces: ${money(risk.maxOrderUsd)} per order, ${money(risk.maxExposureUsd)} total exposure, ${money(risk.maxDailyLossUsd)} daily loss.`
      : "The hub enforces per-order, exposure and daily-loss limits on every order.",
    "",
    "How to call it — run in your shell:",
    `  agent-guild --as ${agent.agentId} mod tools polymarket-trading     (lists every tool and its arguments)`,
    `  ${run} <tool> '<json>'`,
    `MCP clients: guild_mod_tools / guild_mod_call with mod "polymarket-trading".`,
    "",
    "For every trade:",
    "1. polymarket_account — confirm mode and cash.",
    `2. polymarket_markets '{"q":"<topic>"}' — pick a market that is accepting orders; note its conditionId.`,
    "3. polymarket_market and polymarket_book — read the resolution rules and the live bids/asks.",
    `4. polymarket_order '{"conditionId":"…","outcomeIndex":0,"side":"buy","usd":10}' — outcomeIndex 0 is usually Yes, 1 is No. Add "limitPrice" (0–1) to cap slippage.`,
    "5. Report the market, outcome, shares, average price, and your reasoning in two or three sentences.",
    "",
    "Bots: polymarket_bot_create (types ai, mid-price, streak-fade, price-trigger, and Moon Dev's BTC fleet: corridor, flip-harvest, box-builder, spread-maker, liq-cascade, small-liq, near-liq — always set maxLossUsd), polymarket_bot_toggle, polymarket_bots, polymarket_bot_log, polymarket_orders (resting paper orders). If an AI Predictor bot is on, answer its rounds with polymarket_ai_requests and polymarket_ai_answer.",
    "",
    "Rules:",
    paper ? "- Stay in paper mode. Never switch to live or ask for it." : "- This is real money. Keep orders small and inside your limits.",
    "- If a call is refused (missing capability, risk limit, geoblock), stop and report the exact error. Never work around it.",
    "- Don't invent prices or fills — quote what the tools return.",
    "",
    `Your task now: ${task.trim() || "Check your account and tell me you're ready to trade."}`,
  ].join("\n");
}
