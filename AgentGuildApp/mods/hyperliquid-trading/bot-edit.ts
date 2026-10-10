/**
 * What an operator may change on a running bot, and what an edit must never
 * touch. Settings are editable; identity (type, coin or basket, paper/live,
 * wallet, agent) is not — that's a different bot, so delete and create one.
 * Runtime state the bot needs to finish what it started (an open pair, a
 * half-done flip, the AI round out with the agent, the drawdown baseline,
 * an elimination) carries over untouched. Pure; validation of the merged
 * settings is the same per-type check POST /strategy runs (server.ts).
 */

/** Settings an edit may set, per bot type. */
export const EDITABLE_PARAMS: Record<string, readonly string[]> = {
  dca: ["intervalMs", "direction", "stopLossPct", "takeProfitPct", "smart"],
  grid: ["lowerPrice", "upperPrice", "levels", "direction", "stopLossPct", "takeProfitPct"],
  signal: ["direction"],
  sniper: ["mode", "targetPrice", "direction", "stopLossPct", "takeProfitPct"],
  ai: ["intervalMs", "maxDrawdownPct", "leverage", "goal"],
  pairs: ["interval", "lookbackBars", "entryZ", "exitZ", "stopZ", "maxHoldBars", "minCorrelation"],
  breakout: ["interval", "bbLength", "bbMult", "squeezeLookback", "squeezeWithin", "adxLength", "minAdx", "allowShort", "exitOnMid", "stopLossPct", "takeProfitPct", "leverage"],
  basis: ["entryAprPct", "exitAprPct", "minBasisPct", "maxHoldHours"],
};

/** Runtime state kept from the bot as it is, whatever the edit says. */
export const RUNTIME_PARAMS: Record<string, readonly string[]> = {
  dca: [],
  grid: ["visitedLevels"],
  signal: [],
  sniper: [],
  ai: ["openRequestId", "startEquity", "eliminated", "flipTo", "flips", "coins", "scanTop", "owned"],
  pairs: ["coins", "open", "lastZ", "lastNote"],
  breakout: ["lastNote"],
  basis: ["coin", "open", "lastNote", "lastAprPct"],
};

const LOCKED_FIELDS = ["type", "coin", "paper", "wallet", "agentId", "orgId"] as const;

export interface BotEdit {
  sizeUsd?: number;
  /** The bot's settings with the edit applied, before per-type validation. Runtime state is not in here. */
  settings: Record<string, unknown>;
  /** Names of the settings the edit actually changed. */
  changed: string[];
}

/**
 * Applies an edit body to a bot's current params. Refuses a body that tries
 * to change the bot's identity or sets a setting this type doesn't have.
 */
export function applyBotEdit(
  bot: { type: string; coin: string; paper: boolean; sizeUsd: number; params: Record<string, unknown> },
  body: Record<string, unknown>,
): BotEdit | { error: string } {
  for (const field of LOCKED_FIELDS) {
    if (body[field] === undefined) continue;
    const current = field === "type" ? bot.type : field === "coin" ? bot.coin : field === "paper" ? bot.paper : undefined;
    if (current === undefined || body[field] !== current) {
      return { error: `A bot's ${field} can't be changed — delete it and create a new bot` };
    }
  }

  const editable = EDITABLE_PARAMS[bot.type];
  if (!editable) return { error: `${bot.type} bots can't be edited` };
  const patch = (body.params ?? {}) as Record<string, unknown>;
  if (typeof patch !== "object" || Array.isArray(patch)) return { error: "params must be an object" };
  const unknown = Object.keys(patch).filter((k) => !editable.includes(k));
  if (unknown.length) {
    return { error: `Can't edit ${unknown.join(", ")} on a ${bot.type} bot. Editable: ${editable.join(", ")}` };
  }

  const settings: Record<string, unknown> = {};
  for (const k of editable) if (bot.params[k] !== undefined) settings[k] = bot.params[k];
  const changed: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (settings[k] !== v) changed.push(k);
    if (v === null || v === "") delete settings[k];
    else settings[k] = v;
  }

  let sizeUsd: number | undefined;
  if (body.sizeUsd !== undefined) {
    sizeUsd = Number(body.sizeUsd);
    if (!(sizeUsd > 0)) return { error: "sizeUsd must be a positive number" };
    if (sizeUsd !== bot.sizeUsd) changed.push("sizeUsd");
  }
  return { sizeUsd, settings, changed };
}

/** The params to store: the validated settings plus the bot's runtime state, as it was. */
export function withRuntimeState(type: string, validated: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...validated };
  for (const k of RUNTIME_PARAMS[type] ?? []) {
    if (current[k] !== undefined) out[k] = current[k];
    else delete out[k];
  }
  return out;
}
