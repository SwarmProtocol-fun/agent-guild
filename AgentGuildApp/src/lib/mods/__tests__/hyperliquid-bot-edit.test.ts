import { describe, it, expect } from "vitest";
import { applyBotEdit, withRuntimeState } from "../../../../mods/hyperliquid-trading/bot-edit";

const aiBot = {
  type: "ai", coin: "ETH", paper: true, sizeUsd: 25,
  params: { intervalMs: 3_600_000, maxDrawdownPct: 10, goal: "Trend follow ETH", openRequestId: "req-1", startEquity: 10_000, flipTo: "long" },
};

describe("bot edits", () => {
  it("applies only the settings sent, and reports what changed", () => {
    const edit = applyBotEdit(aiBot, { sizeUsd: 50, params: { maxDrawdownPct: 15, goal: "Trend follow ETH" } });
    if ("error" in edit) throw new Error(edit.error);
    expect(edit.sizeUsd).toBe(50);
    expect(edit.changed.sort()).toEqual(["maxDrawdownPct", "sizeUsd"]);
    expect(edit.settings).toEqual({ intervalMs: 3_600_000, maxDrawdownPct: 15, goal: "Trend follow ETH" });
    expect(edit.settings).not.toHaveProperty("openRequestId"); // runtime state never goes through the edit
  });

  it("clears an optional setting sent as null or empty", () => {
    const edit = applyBotEdit({ ...aiBot, params: { ...aiBot.params, leverage: 3 } }, { params: { leverage: null, goal: "" } });
    if ("error" in edit) throw new Error(edit.error);
    expect(edit.settings).not.toHaveProperty("leverage");
    expect(edit.settings).not.toHaveProperty("goal");
  });

  it("refuses identity changes and settings the type doesn't have", () => {
    expect(applyBotEdit(aiBot, { coin: "BTC" })).toMatchObject({ error: expect.stringMatching(/coin can't be changed/) });
    expect(applyBotEdit(aiBot, { paper: false })).toMatchObject({ error: expect.stringMatching(/paper can't be changed/) });
    expect(applyBotEdit(aiBot, { type: "dca" })).toMatchObject({ error: expect.stringMatching(/type/) });
    expect(applyBotEdit(aiBot, { coin: "ETH", paper: true })).not.toHaveProperty("error"); // restating them is fine
    expect(applyBotEdit(aiBot, { params: { startEquity: 1 } })).toMatchObject({ error: expect.stringMatching(/Can't edit startEquity/) });
    expect(applyBotEdit(aiBot, { params: { coins: ["BTC"] } })).toMatchObject({ error: expect.stringMatching(/coins/) });
    expect(applyBotEdit(aiBot, { sizeUsd: -5 })).toMatchObject({ error: expect.stringMatching(/sizeUsd/) });
    expect(applyBotEdit({ ...aiBot, type: "mystery" }, {})).toMatchObject({ error: expect.stringMatching(/can't be edited/) });
  });

  it("keeps runtime state exactly as it was, whatever validation returned", () => {
    const validated = { intervalMs: 3_600_000, maxDrawdownPct: 15, flipTo: null, openRequestId: null };
    expect(withRuntimeState("ai", validated, aiBot.params)).toEqual({
      intervalMs: 3_600_000, maxDrawdownPct: 15, openRequestId: "req-1", startEquity: 10_000, flipTo: "long",
    });
    const pair = { coins: ["BTC", "ETH"], open: { longLeg: "BTC" }, lastZ: 2.4, entryZ: 2 };
    expect(withRuntimeState("pairs", { coins: ["BTC", "ETH"], entryZ: 2.5 }, pair)).toEqual({
      coins: ["BTC", "ETH"], entryZ: 2.5, open: { longLeg: "BTC" }, lastZ: 2.4,
    });
  });
});
