/**
 * The org's paper arena, ranked: every paper bot by the fills it placed
 * itself, and every agent by its paper account. Paper only — live trades
 * don't record which bot sent them, so a live bot's own result can't be
 * separated from its agent's manual trades. Pure and browser-safe.
 */

export interface LeaderboardBotInput {
  id: string;
  agentId: string;
  agentName: string;
  type: string;
  coin: string;
  sizeUsd: number;
  enabled: boolean;
  eliminated: boolean;
  goal: string | null;
}

export interface LeaderboardFill {
  strategyId: string | null;
  realizedPnl: number;
  fee: number;
  /** ms since epoch; null sorts first. */
  at: number | null;
}

export interface BotStanding extends LeaderboardBotInput {
  rank: number;
  status: "running" | "stopped" | "eliminated";
  fills: number;
  closed: number;
  winRate: number;
  /** Net of every fee the bot paid. */
  netPnl: number;
  /** netPnl over the bot's order size, in percent — puts a $25 bot and a $500 bot on one scale. */
  returnOnSizePct: number;
  profitFactor: number | null;
  /** Largest peak-to-trough fall of the bot's running net PnL, in USD. */
  maxDrawdownUsd: number;
  lastFillAt: number | null;
}

export interface AccountInput {
  agentId: string;
  agentName: string;
  startBalance: number;
  /** Balance plus unrealized PnL at current marks. */
  equity: number;
  openPositions: number;
}

export interface AccountStanding extends AccountInput {
  rank: number;
  returnPct: number;
}

/** Ranks bots by return on size, then smaller drawdown. Bots that haven't closed a trade go last, newest activity first. */
export function rankBots(bots: LeaderboardBotInput[], fills: LeaderboardFill[]): BotStanding[] {
  const byBot = new Map<string, LeaderboardFill[]>();
  for (const f of fills) {
    if (!f.strategyId) continue;
    byBot.set(f.strategyId, [...(byBot.get(f.strategyId) ?? []), f]);
  }

  const rows = bots.map((bot) => {
    const own = [...(byBot.get(bot.id) ?? [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    let running = 0, peak = 0, maxDrawdownUsd = 0, closed = 0, wins = 0, grossProfit = 0, grossLoss = 0;
    for (const f of own) {
      running += f.realizedPnl - f.fee;
      peak = Math.max(peak, running);
      maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - running);
      if (f.realizedPnl === 0) continue;
      closed++;
      const net = f.realizedPnl - f.fee;
      if (net > 0) {
        wins++;
        grossProfit += net;
      } else {
        grossLoss -= net;
      }
    }
    const standing: Omit<BotStanding, "rank"> = {
      ...bot,
      status: bot.eliminated ? "eliminated" : bot.enabled ? "running" : "stopped",
      fills: own.length,
      closed,
      winRate: closed ? wins / closed : 0,
      netPnl: running,
      returnOnSizePct: bot.sizeUsd > 0 ? (running / bot.sizeUsd) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      maxDrawdownUsd,
      lastFillAt: own.length ? own[own.length - 1].at : null,
    };
    return standing;
  });

  rows.sort((a, b) => {
    if (!a.closed !== !b.closed) return a.closed ? -1 : 1;
    if (!a.closed) return (b.lastFillAt ?? 0) - (a.lastFillAt ?? 0);
    return b.returnOnSizePct - a.returnOnSizePct || a.maxDrawdownUsd - b.maxDrawdownUsd;
  });
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Ranks agents' paper accounts by return on their starting balance. */
export function rankAccounts(accounts: AccountInput[]): AccountStanding[] {
  return accounts
    .map((a) => ({ ...a, returnPct: a.startBalance > 0 ? ((a.equity - a.startBalance) / a.startBalance) * 100 : 0 }))
    .sort((a, b) => b.returnPct - a.returnPct)
    .map((a, i) => ({ ...a, rank: i + 1 }));
}
