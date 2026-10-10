import { describe, it, expect } from "vitest";
import { rankAccounts, rankBots, type LeaderboardBotInput } from "../../../../mods/hyperliquid-trading/leaderboard";

const bot = (id: string, p: Partial<LeaderboardBotInput> = {}): LeaderboardBotInput => ({
  id, agentId: `agent-${id}`, agentName: id, type: "ai", coin: "ETH", sizeUsd: 100, enabled: true, eliminated: false, goal: null, ...p,
});

describe("paper leaderboard", () => {
  it("ranks by return on order size, so a small bot can beat a big one", () => {
    const ranked = rankBots(
      [bot("big", { sizeUsd: 1000 }), bot("small", { sizeUsd: 25 })],
      [
        { strategyId: "big", realizedPnl: 0, fee: 0.5, at: 1 },
        { strategyId: "big", realizedPnl: 50.5, fee: 0.5, at: 2 },   // +$49.50 on $1000 = 4.95%
        { strategyId: "small", realizedPnl: 0, fee: 0.1, at: 1 },
        { strategyId: "small", realizedPnl: 5.1, fee: 0.1, at: 2 },  // +$4.90 on $25 = 19.6%
      ],
    );
    expect(ranked.map((r) => [r.id, r.rank])).toEqual([["small", 1], ["big", 2]]);
    expect(ranked[0].netPnl).toBeCloseTo(4.9);
    expect(ranked[0].returnOnSizePct).toBeCloseTo(19.6);
    expect(ranked[1]).toMatchObject({ fills: 2, closed: 1, winRate: 1, profitFactor: null });
  });

  it("measures drawdown on the bot's running net PnL and breaks return ties with it", () => {
    const ranked = rankBots(
      [bot("choppy"), bot("smooth")],
      [
        { strategyId: "choppy", realizedPnl: 20, fee: 0, at: 1 },
        { strategyId: "choppy", realizedPnl: -30, fee: 0, at: 2 },
        { strategyId: "choppy", realizedPnl: 20, fee: 0, at: 3 },   // net +10, dipped 30 from the +20 peak
        { strategyId: "smooth", realizedPnl: 10, fee: 0, at: 1 },   // net +10, never dipped
      ],
    );
    expect(ranked.map((r) => r.id)).toEqual(["smooth", "choppy"]);
    expect(ranked[1]).toMatchObject({ maxDrawdownUsd: 30, closed: 3 });
    expect(ranked[1].profitFactor).toBeCloseTo(40 / 30);
  });

  it("puts bots with no closed trade last, ignores manual fills, and reports status", () => {
    const ranked = rankBots(
      [bot("idle", { enabled: false }), bot("out", { eliminated: true, enabled: false }), bot("loser")],
      [
        { strategyId: null, realizedPnl: 999, fee: 0, at: 1 },     // a manual trade belongs to no bot
        { strategyId: "loser", realizedPnl: -5, fee: 0, at: 1 },
        { strategyId: "out", realizedPnl: 0, fee: 1, at: 5 },
      ],
    );
    expect(ranked.map((r) => r.id)).toEqual(["loser", "out", "idle"]);
    expect(ranked.map((r) => r.status)).toEqual(["running", "eliminated", "stopped"]);
    expect(ranked[0].returnOnSizePct).toBeCloseTo(-5);
  });

  it("ranks paper accounts by return on their own starting balance", () => {
    const ranked = rankAccounts([
      { agentId: "a", agentName: "A", startBalance: 10_000, equity: 10_500, openPositions: 0 },
      { agentId: "b", agentName: "B", startBalance: 1_000, equity: 1_100, openPositions: 2 },
    ]);
    expect(ranked.map((a) => [a.agentId, a.rank])).toEqual([["b", 1], ["a", 2]]);
    expect(ranked[0].returnPct).toBeCloseTo(10);
  });
});
