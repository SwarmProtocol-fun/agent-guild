import { describe, it, expect } from "vitest";
import { buildAgentPrompt, buildMarketTask, MARKET_ASKS, MAX_PROMPT_CHARS, parseTemplate, TASK_PRESETS } from "../../../../mods/polymarket-trading/agent-prompt";

const agent = { agentId: "zPPe", name: "Grok" };
const paper = { mode: "paper" as const, cash: 1000, risk: { maxOrderUsd: 25, maxExposureUsd: 100, maxDailyLossUsd: 50 } };

describe("polymarket agent prompt", () => {
  it("tells the agent its mode, cash, limits and how to call the tools as itself", () => {
    const p = buildAgentPrompt(agent, paper, "Buy $10 of something");
    expect(p).toContain("Mode: PAPER");
    expect(p).toContain("Cash: $1,000.");
    expect(p).toContain("$25 per order, $100 total exposure, $50 daily loss");
    expect(p).toContain("agent-guild --as zPPe mod tools polymarket-trading");
    expect(p).toContain("agent-guild --as zPPe mod call polymarket-trading <tool> '<json>'");
    expect(p).toContain("guild_mod_call");
    expect(p).toMatch(/Never switch to live/);
    expect(p).toMatch(/Never work around it/);
    expect(p.trim().endsWith("Your task now: Buy $10 of something")).toBe(true);
  });

  it("live mode drops the paper-only rule and warns about real money", () => {
    const p = buildAgentPrompt(agent, { ...paper, mode: "live" }, "x");
    expect(p).toContain("Mode: LIVE");
    expect(p).not.toMatch(/Never switch to live/);
    expect(p).toMatch(/real money/);
  });

  it("handles a missing account and an empty task", () => {
    const p = buildAgentPrompt(agent, { mode: "paper", cash: null, risk: null }, "  ");
    expect(p).toContain("Cash: unknown.");
    expect(p).toContain("per-order, exposure and daily-loss limits");
    expect(p).toContain("Your task now: Check your account");
  });

  it("every preset fits well under the send limit", () => {
    for (const t of TASK_PRESETS) expect(buildAgentPrompt(agent, paper, t.task).length).toBeLessThan(MAX_PROMPT_CHARS / 2);
  });

  it("a market ask names the exact conditionId, outcome index and ask so the agent trades the right token", () => {
    const m = { conditionId: "0xabc", question: "Will BTC hit 200k?", outcome: "No", outcomeIndex: 1, ask: 0.355, endDate: "2026-12-31T00:00:00Z" };
    const t = buildMarketTask(m, "  Your view?  ");
    expect(t).toBe('Market "Will BTC hit 200k?" — conditionId 0xabc, outcome "No" = outcomeIndex 1 (ask 35.5¢), ends 2026-12-31. Your view?');
    expect(buildMarketTask({ ...m, ask: 0.4, endDate: null }, "x")).toContain("(ask 40¢). x");
    expect(buildMarketTask({ ...m, ask: null }, "")).toMatch(new RegExp(`outcomeIndex 1, ends 2026-12-31\\. ${MARKET_ASKS[0].ask.replace(/[?.]/g, "\\$&")}$`));
    for (const a of MARKET_ASKS) expect(buildAgentPrompt(agent, paper, buildMarketTask(m, a.ask)).length).toBeLessThan(MAX_PROMPT_CHARS / 2);
  });

  it("saved prompts need a name and text within limits", () => {
    expect(parseTemplate({ name: "  Fade hype ", text: " Bet against spikes. " })).toEqual({ name: "Fade hype", text: "Bet against spikes." });
    expect(parseTemplate({ name: " ", text: "x" })).toMatch(/name/);
    expect(parseTemplate({ name: "x".repeat(61), text: "x" })).toMatch(/60/);
    expect(parseTemplate({ name: "n", text: 5 })).toMatch(/empty/);
    expect(parseTemplate({ name: "n", text: "x".repeat(2001) })).toMatch(/2000/);
  });

  it("preset ids are unique", () => {
    expect(new Set(TASK_PRESETS.map((p) => p.id)).size).toBe(TASK_PRESETS.length);
    expect(new Set(MARKET_ASKS.map((p) => p.id)).size).toBe(MARKET_ASKS.length);
  });
});
