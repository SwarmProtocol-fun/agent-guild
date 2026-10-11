// Paper/live mode for hyperliquid-trading calls. Paper is the default. A
// call that can move real money needs --live from the caller (and --mainnet
// when the agent's live wallet is on mainnet), and the hub still refuses it
// unless the org owner has turned live trading on for the agent (instant
// trading) or the agent holds a wallet passphrase. Pure
// helpers only; agent-guild.mjs does the signed fetch and prints MODE first.

export const HL_MOD = "hyperliquid-trading";

/** Live tools and the paper tool to use instead. */
const LIVE_TOOLS = {
  hyperliquid_trade: "hyperliquid_paper_trade",
  hyperliquid_close: "hyperliquid_paper_close",
};

/** Bot launchers with a `paper` switch in their input. */
const BOT_TOOLS = new Set(["hyperliquid_pairs_bot", "hyperliquid_breakout_bot", "hyperliquid_basis_bot"]);

/** POST tools that never place an order themselves (bot settings, emergency stop). */
const NO_ORDER_POSTS = new Set(["hyperliquid_edit_bot", "hyperliquid_delete_bot", "hyperliquid_stop_all_bots"]);

const LIVE_HINT = "Pass --live to trade real funds. The org owner must also have turned on live trading for this agent.";

/**
 * Decide the mode of one hyperliquid-trading tool call.
 * `opts.live` is the caller's --live flag. `opts.aiRequestPaper` is the
 * paper flag of the bot behind an ai_answer, when known.
 * Returns { mode: "PAPER" | "LIVE", trades, input } (input may gain
 * `paper: true`; `trades` is true when the call can place a live order), or
 * throws when the call would go live without --live.
 */
export function resolveHlMode(tool, input = {}, opts = {}) {
  const live = Boolean(opts.live);
  const name = tool?.name ?? "";
  const method = String(tool?.method || "GET").toUpperCase();

  if (name.startsWith("hyperliquid_paper_")) return { mode: "PAPER", trades: false, input };

  if (name in LIVE_TOOLS) {
    if (!live) throw new Error(`${name} trades real funds. Paper is the default: use ${LIVE_TOOLS[name]} instead. ${LIVE_HINT}`);
    return { mode: "LIVE", trades: true, input };
  }

  if (BOT_TOOLS.has(name)) {
    const paper = input.paper ?? !live;
    if (paper === false && !live) throw new Error(`${name} with paper: false trades real funds. ${LIVE_HINT}`);
    return { mode: paper ? "PAPER" : "LIVE", trades: !paper, input: { ...input, paper } };
  }

  if (name === "hyperliquid_ai_answer") {
    // Unknown (expired id, older hub) counts as live: never call a live answer paper.
    const paper = opts.aiRequestPaper === true;
    if (!paper && !live) {
      const why = opts.aiRequestPaper === false ? "belongs to a live bot" : "can't be matched to a paper bot";
      throw new Error(`Request ${input.id} ${why}, so answering it may trade real funds. ${LIVE_HINT}`);
    }
    return { mode: paper ? "PAPER" : "LIVE", trades: !paper, input };
  }

  if (method === "GET" || NO_ORDER_POSTS.has(name)) return { mode: live ? "LIVE" : "PAPER", trades: false, input };

  // A POST this CLI doesn't know yet: assume it can trade.
  if (!live) throw new Error(`${name} is not a known paper tool, so it may trade real funds. ${LIVE_HINT}`);
  return { mode: "LIVE", trades: true, input };
}

/**
 * The MODE line for a live call, from the network of the wallet the hub
 * would trade with (GET /me wallet.network). A live order on mainnet also
 * needs --mainnet, so testnet consent never carries over to real funds. An
 * order whose network can't be confirmed is refused.
 * Returns "LIVE (TESTNET)" | "LIVE (MAINNET)" | "LIVE (NETWORK UNKNOWN)".
 */
export function liveModeLabel(network, { trades = true, mainnet = false } = {}) {
  if (network === "testnet") return "LIVE (TESTNET)";
  if (network === "mainnet") {
    if (trades && !mainnet) {
      throw new Error("This agent's live wallet is on MAINNET (real funds). Pass --mainnet as well as --live to place this order.");
    }
    return "LIVE (MAINNET)";
  }
  if (trades) throw new Error("Can't confirm which network this agent's live wallet is on (no wallet set, or the hub didn't say), so no live order was sent.");
  return "LIVE (NETWORK UNKNOWN)";
}

const usd = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedUsd = (n) => `${n > 0 ? "+" : ""}${usd(n)}`;
const px = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 6 });

/**
 * Human lines for a paper order result (POST paper/trade or paper/close):
 * the fill, the realized paper P&L, and the balance after. [] for any other shape.
 * `side` (buy/sell) and `coin` come from the request; the hub's reply has neither.
 */
export function formatPaperResult(data, { side, coin = "" } = {}) {
  if (!data || data.paper !== true) return [];
  const lines = [];
  coin = data.closing?.coin ?? coin;
  const verb = data.closing ? `CLOSE ${data.closing.side.toUpperCase()}` : side ? side.toUpperCase() : "";
  if (data.filled) {
    const f = data.filled;
    lines.push(`Fill: ${[verb, f.sz, coin].filter((s) => s !== "").join(" ")} @ ${px(f.avgPx)}  fee ${usd(f.fee)}  trade ${data.taskId}`);
    lines.push(`Paper P&L (realized): ${signedUsd(f.realizedPnl)}`);
  }
  if (data.resting) {
    lines.push(`Resting: ${data.resting.sz} ${coin} limit @ ${px(data.resting.limitPx)}  order ${data.resting.orderId}`);
  }
  if (data.balance != null) lines.push(`Paper balance: ${usd(data.balance)}`);
  return lines;
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** The known command closest to `input`, or null when nothing is near. */
export function closestCommand(input, commands) {
  const word = String(input || "").toLowerCase();
  if (!word) return null;
  let best = null;
  let bestScore = Infinity;
  for (const c of commands) {
    const score = c.startsWith(word) || word.startsWith(c) ? 0.5 : editDistance(word, c);
    if (score < bestScore) { best = c; bestScore = score; }
  }
  return bestScore <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

const TRY_TRADE = "agent-guild hyperliquid trade --coin BTC --side buy --size-usd 10";

/**
 * `mod status hyperliquid-trading`: the agent's mode, paper account and the
 * reasons it is not trading, from GET /me, GET /paper/{agentId} and
 * GET /strategy/{agentId}. Each input may be an Error when that read failed.
 * `opts.autoReply` is whether the daemon can answer AI-bot rounds itself.
 */
export function summarizeHlStatus({ me, paper, strategies }, opts = {}) {
  const ok = (v) => v && !(v instanceof Error);
  const canTrade = ok(me) ? Boolean(me.capabilities?.["hyperliquid-trade"]) : null;
  const wallet = ok(me) ? me.wallet : null;
  const live = !ok(me)
    ? { available: false, reason: `unknown (${me?.message || "GET /me failed"})` }
    : !wallet?.configured
      ? { available: false, reason: "no live wallet set" }
      : { available: true, reason: `${wallet.network} wallet${wallet.instant ? ", instant trading on" : ", needs the wallet passphrase"}` };

  const bots = (Array.isArray(strategies) ? strategies : []).filter((s) => s.enabled);
  const paperBots = bots.filter((s) => s.paper);
  const positions = ok(paper) ? paper.positions || [] : [];
  const orders = ok(paper) ? paper.orders || [] : [];

  const reasons = [];
  if (canTrade === false) {
    reasons.push("The org has not granted hyperliquid-trade to this agent. A human installs the Hyperliquid mod for it from the dashboard (Mods).");
  }
  if (!ok(paper)) reasons.push(`Paper account unreadable: ${paper?.message || "GET /paper failed"}`);
  const maxLoss = ok(me) ? me.risk?.maxDailyLossUsd : null;
  if (ok(paper) && maxLoss > 0 && paper.dailyPnl <= -maxLoss) {
    reasons.push(`Daily paper loss limit hit (${usd(paper.dailyPnl)} of -${usd(maxLoss)}): new orders are refused until tomorrow (UTC).`);
  }
  if (ok(paper) && paper.available <= 0) reasons.push(`No free margin (available ${usd(paper.available)}). Close a position or reset the paper account.`);
  if (bots.some((s) => s.type === "ai") && !opts.autoReply) {
    reasons.push("AI bots ask your own model each round, and this agent has no replyCommand, so their rounds wait for you: mod call hyperliquid-trading hyperliquid_ai_requests, then hyperliquid_ai_answer.");
  }
  const pending = ok(me) ? me.pendingStrategies || 0 : 0;
  if (pending > 0) reasons.push(`${pending} bot signal(s) waiting on you: agent-guild hyperliquid pending`);
  if (canTrade !== false && !reasons.length && !positions.length && !orders.length && !bots.length) {
    reasons.push(`Idle: no open positions, resting orders or running bots. Nothing trades until you place an order, e.g. ${TRY_TRADE}`);
  }

  return {
    mode: "PAPER",
    live,
    canTrade,
    balance: ok(paper) ? paper.balance : null,
    equity: ok(paper) ? paper.equity : null,
    available: ok(paper) ? paper.available : null,
    unrealizedPnl: ok(paper) ? paper.unrealizedPnl : null,
    dailyPnl: ok(paper) ? paper.dailyPnl : null,
    positions: positions.map((p) => ({ coin: p.coin, side: p.szi > 0 ? "long" : "short", sz: Math.abs(p.szi), entryPx: p.entryPx, markPx: p.markPx, unrealizedPnl: p.unrealizedPnl })),
    restingOrders: orders.length,
    bots: { running: bots.length, paper: paperBots.length, live: bots.length - paperBots.length },
    reasons,
  };
}

/** Human lines for summarizeHlStatus(). MODE is the first line. */
export function formatHlStatus(s) {
  const lines = [`MODE: ${s.mode}`];
  lines.push(`Live: ${s.live.available ? "available with --live" : "off"} (${s.live.reason})`);
  if (s.canTrade != null) lines.push(`Capability hyperliquid-trade: ${s.canTrade ? "granted" : "NOT granted"}`);
  if (s.balance != null) {
    lines.push(`Paper balance: ${usd(s.balance)}  equity ${usd(s.equity)}  available ${usd(s.available)}  today ${signedUsd(s.dailyPnl ?? 0)}`);
  }
  if (s.positions.length) {
    lines.push(`Open positions (${s.positions.length}):`);
    for (const p of s.positions) {
      lines.push(`  ${p.side.toUpperCase()} ${p.sz} ${p.coin} @ ${px(p.entryPx)}  mark ${px(p.markPx)}  uPnL ${signedUsd(p.unrealizedPnl)}`);
    }
  } else if (s.balance != null) lines.push("Open positions: none");
  if (s.restingOrders) lines.push(`Resting paper orders: ${s.restingOrders}`);
  lines.push(`Bots running: ${s.bots.running} (${s.bots.paper} paper, ${s.bots.live} live)`);
  if (s.reasons.length) {
    lines.push("Why it isn't trading:");
    for (const r of s.reasons) lines.push(`  - ${r}`);
  } else lines.push("Trading: yes — nothing is blocking this agent.");
  return lines;
}
