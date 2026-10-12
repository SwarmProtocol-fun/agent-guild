import { describe, it, expect } from "vitest";
import { COST_LINES, multiSystemPrompt, systemPrompt } from "../../../../mods/hyperliquid-trading/ai-trader-core";

const pos = { isLong: true, size: 0.01, entryPx: 2500, unrealizedPnl: 0.1 };

describe("AI trader prompts — trade only what covers its cost", () => {
  it("tells single-coin and basket bots what a round trip costs, flat or in a position", () => {
    for (const prompt of [
      systemPrompt("ETH", null),
      systemPrompt("ETH", pos, "Lets go make some money"),
      multiSystemPrompt(["BTC", "ETH"], {}, "Scan for setups"),
    ]) {
      expect(prompt).toContain("0.09% in taker fees");
      expect(prompt).toContain("hold through noise");
      expect(prompt).toContain("Funding is paid hourly");
    }
    expect(COST_LINES.join("\n")).toMatch(/several times that cost/);
  });

  it("no longer pushes a trade every round because a goal is set", () => {
    const prompt = systemPrompt("ETH", null, "Lets go bruh make some money you know what to do!");
    expect(prompt).not.toMatch(/instead of sitting flat/);
    expect(prompt).not.toMatch(/take the trade the goal calls for on this round/);
    expect(prompt).toContain("Staying flat is a legitimate choice.");
    expect(prompt).toContain("wait when it doesn't");
    expect(prompt).toContain("GOAL: Lets go bruh make some money you know what to do!");
    // The answer format still ends the prompt, after the cost and goal lines.
    expect(prompt.trim().endsWith("LONG, SHORT, CLOSE or NOTHING.")).toBe(true);
  });
});
