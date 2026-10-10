import { describe, it, expect } from "vitest";
import { buildAgentPrompt, MAX_PROMPT_CHARS, TASK_PRESETS } from "../../../../mods/polymarket-trading/agent-prompt";

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
});
