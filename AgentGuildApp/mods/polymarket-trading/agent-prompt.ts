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
] as const;

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
    "Bots: polymarket_bot_create (types ai, mid-price, streak-fade, price-trigger — always set maxLossUsd), polymarket_bot_toggle, polymarket_bots, polymarket_bot_log. If an AI Predictor bot is on, answer its rounds with polymarket_ai_requests and polymarket_ai_answer.",
    "",
    "Rules:",
    paper ? "- Stay in paper mode. Never switch to live or ask for it." : "- This is real money. Keep orders small and inside your limits.",
    "- If a call is refused (missing capability, risk limit, geoblock), stop and report the exact error. Never work around it.",
    "- Don't invent prices or fills — quote what the tools return.",
    "",
    `Your task now: ${task.trim() || "Check your account and tell me you're ready to trade."}`,
  ].join("\n");
}
