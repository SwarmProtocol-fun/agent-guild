// Mode for hyperliquid-trading calls: PAPER | TESTNET | LIVE. Paper is the
// default. TESTNET trades the agent's own custodial wallet on Hyperliquid
// testnet (no real funds): --testnet, or network: "testnet" in the input.
// LIVE is mainnet, real funds: --live and --mainnet from the caller, and the
// hub still refuses unless the org owner turned on live trading for the agent
// (instant trading) or the agent holds a wallet passphrase. Pure helpers
// only; agent-guild.mjs does the signed fetch and prints MODE first.

export const HL_MOD = "hyperliquid-trading";

/** Wallet tools and the paper tool to use instead. */
const LIVE_TOOLS = {
  hyperliquid_trade: "hyperliquid_paper_trade",
  hyperliquid_close: "hyperliquid_paper_close",
};

/** Bot launchers with a `paper` switch (and a `network`) in their input. */
const BOT_TOOLS = new Set(["hyperliquid_pairs_bot", "hyperliquid_breakout_bot", "hyperliquid_basis_bot", "hyperliquid_rule_bot"]);

/** POST tools that never place an order themselves (bot settings, emergency stop, a backtest). */
const NO_ORDER_POSTS = new Set([
  "hyperliquid_edit_bot", "hyperliquid_delete_bot", "hyperliquid_stop_all_bots", "hyperliquid_toggle_bot", "hyperliquid_backtest",
]);

const LIVE_HINT = "Pass --testnet to trade your testnet wallet (no real funds), or --live --mainnet for real funds (the org owner must also have turned on live trading for this agent).";

/**
 * Decide the mode of one hyperliquid-trading tool call.
 * `opts.live` / `opts.testnet` are the caller's --live / --testnet flags.
 * `opts.aiRequestMode` is the mode the hub gives the question behind an
 * ai_answer ("PAPER" | "TESTNET" | "LIVE" | "NONE"); older hubs only send
 * `opts.aiRequestPaper`.
 * Returns { mode: "PAPER" | "TESTNET" | "LIVE", trades, input }: input may
 * gain `paper` / `network`; `trades` is true when the call can place an order
 * on a wallet. LIVE here means "a wallet, network to be confirmed": the
 * caller checks it with liveModeLabel(). Throws when the call would use a
 * wallet without a flag that allows it.
 */
export function resolveHlMode(tool, input = {}, opts = {}) {
  const live = Boolean(opts.live);
  const testnet = Boolean(opts.testnet) || input.network === "testnet";
  const name = tool?.name ?? "";
  const method = String(tool?.method || "GET").toUpperCase();
  const onTestnet = { ...input, network: "testnet" };

  if (name.startsWith("hyperliquid_testnet_")) return { mode: "TESTNET", trades: false, input };

  if (name === "hyperliquid_paper_train" && testnet) return { mode: "TESTNET", trades: true, input: onTestnet };
  if (name.startsWith("hyperliquid_paper_")) return { mode: "PAPER", trades: false, input };

  if (name in LIVE_TOOLS) {
    if (testnet) return { mode: "TESTNET", trades: true, input: onTestnet };
    if (!live) throw new Error(`${name} trades a wallet. Paper is the default: use ${LIVE_TOOLS[name]} instead. ${LIVE_HINT}`);
    return { mode: "LIVE", trades: true, input };
  }

  if (BOT_TOOLS.has(name)) {
    if (testnet) {
      if (input.paper === true) throw new Error(`${name}: paper: true and network testnet can't both be set — pick one.`);
      const { paper: _ignored, ...rest } = onTestnet;
      return { mode: "TESTNET", trades: true, input: rest };
    }
    const paper = input.paper ?? !live;
    if (paper === false && !live) throw new Error(`${name} with paper: false trades a wallet. ${LIVE_HINT}`);
    return { mode: paper ? "PAPER" : "LIVE", trades: !paper, input: { ...input, paper } };
  }

  if (name === "hyperliquid_ai_answer") {
    // Unknown (expired id, older hub) counts as live: never call a live answer paper.
    const mode = opts.aiRequestMode ?? (opts.aiRequestPaper === true ? "PAPER" : opts.aiRequestPaper === false ? "LIVE" : null);
    if (mode === "PAPER" || mode === "NONE") return { mode: "PAPER", trades: false, input };
    if (mode === "TESTNET") return { mode: "TESTNET", trades: true, input };
    if (!live) {
      const why = mode === "LIVE" ? "belongs to a live bot" : "can't be matched to a paper or testnet bot";
      throw new Error(`Request ${input.id} ${why}, so answering it may trade real funds. ${LIVE_HINT}`);
    }
    return { mode: "LIVE", trades: true, input };
  }

  if (method === "GET" || NO_ORDER_POSTS.has(name)) {
    return { mode: testnet ? "TESTNET" : live ? "LIVE" : "PAPER", trades: false, input };
  }

  // A POST this CLI doesn't know yet: assume it can trade.
  if (testnet) return { mode: "TESTNET", trades: true, input };
  if (!live) throw new Error(`${name} is not a known paper tool, so it may trade a wallet. ${LIVE_HINT}`);
  return { mode: "LIVE", trades: true, input };
}

/**
 * The MODE for a --live call, from the network of the wallet the hub would
 * trade with (GET /me wallet.network): "TESTNET" for a testnet wallet, "LIVE"
 * for mainnet. A mainnet order also needs --mainnet, so testnet consent never
 * carries over to real funds. An order whose network can't be confirmed is refused.
 * Returns "TESTNET" | "LIVE" | "LIVE (NETWORK UNKNOWN)".
 */
export function liveModeLabel(network, { trades = true, mainnet = false } = {}) {
  if (network === "testnet") return "TESTNET";
  if (network === "mainnet") {
    if (trades && !mainnet) {
      throw new Error("This agent's live wallet is on MAINNET (real funds). Pass --mainnet as well as --live to place this order.");
    }
    return "LIVE";
  }
  if (trades) throw new Error("Can't confirm which network this agent's live wallet is on (no wallet set, or the hub didn't say), so no live order was sent.");
  return "LIVE (NETWORK UNKNOWN)";
}

/**
 * A TESTNET call that places orders needs the agent's wallet on testnet.
 * Throws with the next step when it isn't; returns "TESTNET" when it is.
 */
export function testnetModeLabel(network, { trades = true } = {}) {
  if (!trades || network === "testnet") return "TESTNET";
  if (network === "mainnet") throw new Error("This agent's trading wallet is on MAINNET, not testnet, so nothing was sent.");
  throw new Error("No testnet wallet yet. Run: agent-guild mod call hyperliquid-trading hyperliquid_testnet_setup");
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
  if (data.protection) lines.push(`Protection: ${protectionText(data.protection)}`);
  if (data.balance != null) lines.push(`Paper balance: ${usd(data.balance)}`);
  return lines;
}

function protectionText(p) {
  const parts = [];
  if (p.trailingStopPct) parts.push(`trailing stop ${p.trailingStopPct}%`);
  else if (p.stopLossPct) parts.push(`stop loss ${p.stopLossPct}%`);
  if (p.takeProfitPct) parts.push(`take profit ${p.takeProfitPct}%`);
  return parts.join(" · ") || "none";
}

/**
 * Human lines for a wallet order (POST trade / close on TESTNET or LIVE):
 * the fill, its Hyperliquid transaction and explorer link, the SL/TP placed
 * with it, and realized P&L on a close. [] for any other shape.
 */
export function formatWalletResult(data, { side, coin = "" } = {}) {
  if (!data || data.paper === true || !data.taskId) return [];
  const lines = [];
  const f = data.fill;
  coin = data.closing?.coin ?? coin;
  const verb = data.closing ? `CLOSE ${String(data.closing.side).toUpperCase()}` : side ? side.toUpperCase() : "";
  if (!f) {
    lines.push(`Order sent: ${[verb, coin].filter(Boolean).join(" ")}  task ${data.taskId} (queued for a worker; poll hyperliquid_trade_status for the fill)`);
    return lines;
  }
  const net = String(f.network || data.network || "").toUpperCase();
  if (f.status === "filled") {
    lines.push(`Fill (${net}): ${[verb, f.sz, coin].filter((x) => x !== "" && x != null).join(" ")} @ ${px(f.avgPx)}  order ${f.oid}  task ${data.taskId}`);
  } else if (f.status === "resting") {
    lines.push(`Resting (${net}): ${[verb, f.sz, coin].filter((x) => x !== "" && x != null).join(" ")}  order ${f.oid}  task ${data.taskId}`);
  } else {
    lines.push(`Sent (${net}): ${[verb, coin].filter(Boolean).join(" ")}  task ${data.taskId} — fill not confirmed`);
  }
  if (f.txHash) lines.push(`${net === "TESTNET" ? "Testnet tx" : "Tx"}: ${f.txHash}  ${f.explorerUrl || ""}`.trimEnd());
  else if (f.status === "filled") lines.push("Tx: not found yet (check hyperliquid_testnet_account in a few seconds)");
  if (f.stopLossPx != null || f.takeProfitPx != null) {
    lines.push(`Protection: ${[f.stopLossPx != null ? `stop loss @ ${px(f.stopLossPx)}` : null, f.takeProfitPx != null ? `take profit @ ${px(f.takeProfitPx)}` : null].filter(Boolean).join(" · ")}`);
  }
  if (f.protectionError) lines.push(`WARNING: protection order failed: ${f.protectionError}`);
  if (f.realizedPnl != null) lines.push(`${net === "TESTNET" ? "Testnet" : "Realized"} P&L: ${signedUsd(f.realizedPnl)}`);
  return lines;
}

/** Human lines for POST testnet/setup or testnet/fund. */
export function formatTestnetSetup(data) {
  if (!data || !data.address) return [];
  const lines = [`Testnet wallet: ${data.address}${data.enabled ? " (testnet trading turned on)" : ""}`];
  const f = data.funding;
  if (f) {
    if (f.status === "sent") lines.push(`Funded: +${usd(f.amountUsd)} testnet USDC from the hub (${f.from}). Balance ~${usd(f.balance)}`);
    else if (f.status === "funded") lines.push(`Balance: ${usd(f.balance)} testnet USDC`);
    else lines.push(`Balance: ${usd(f.balance)} testnet USDC. ${f.message}`);
  }
  if (data.risk) lines.push(`Risk: maxPositionUsd ${data.risk.maxPositionUsd} · maxDailyLossUsd ${data.risk.maxDailyLossUsd} · leverage ${data.risk.leverage}`);
  lines.push(`Trade it: agent-guild mod call hyperliquid-trading hyperliquid_trade '{"coin":"BTC","isBuy":true,"sizeUsd":20}' --testnet`);
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
export function summarizeHlStatus({ me, paper, strategies, testnet, requests }, opts = {}) {
  const ok = (v) => v && !(v instanceof Error);
  const canTrade = ok(me) ? Boolean(me.capabilities?.["hyperliquid-trade"]) : null;
  const wallet = ok(me) ? me.wallet : null;
  const live = !ok(me)
    ? { available: false, reason: `unknown (${me?.message || "GET /me failed"})` }
    : !wallet?.configured
      ? { available: false, reason: "no live wallet set" }
      : { available: true, reason: `${wallet.network} wallet${wallet.instant ? ", instant trading on" : ", needs the wallet passphrase"}` };

  const allBots = Array.isArray(strategies) ? strategies : [];
  const bots = allBots.filter((s) => s.enabled);
  const paperBots = bots.filter((s) => s.paper);
  const testnetBots = bots.filter((s) => !s.paper && s.network === "testnet");
  const tn = ok(testnet) && testnet.enabled ? testnet : null;
  const questions = (Array.isArray(requests) ? requests : []).filter(isBotQuestion);
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
  for (const p of tn?.positions || []) {
    if (!p.protected) reasons.push(`Testnet ${p.side} ${p.coin} has no stop loss on Hyperliquid. Close it, or reopen it (new entries get one by default).`);
  }
  const idleCutoff = Date.now() - 24 * 60 * 60_000;
  for (const b of allBots) {
    const at = b.params?.idlePausedAt;
    if (!b.enabled && at && at > idleCutoff) {
      reasons.push(`Bot ${b.id} (${b.coin}) was paused by idle safety at ${new Date(at).toISOString()} after unanswered rounds. Answer rounds on time, then turn it back on: hyperliquid_toggle_bot.`);
    }
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
    bots: { running: bots.length, paper: paperBots.length, testnet: testnetBots.length, live: bots.length - paperBots.length - testnetBots.length },
    testnet: tn ? {
      address: tn.address,
      accountValue: tn.accountValue,
      positions: tn.positions || [],
      lastFill: tn.recentFills?.[0] ?? null,
    } : null,
    questions: questions.map((r) => ({ id: r.id, mode: r.mode ?? (r.paper ? "PAPER" : "LIVE"), coin: r.coin, coins: r.coins ?? null, expiresAt: r.expiresAt, strategyId: r.strategyId ?? null })),
    reasons,
  };
}

/** Human lines for summarizeHlStatus(). MODE is the first line. */
export function formatHlStatus(s) {
  const lines = [`MODE: ${s.mode}`];
  lines.push(`Testnet: ${s.testnet ? `on (${s.testnet.address}), pass --testnet` : "off (turn on: mod call hyperliquid-trading hyperliquid_testnet_setup)"}`);
  lines.push(`Live: ${s.live.available ? (s.live.reason.startsWith("mainnet") ? "available with --live --mainnet" : "no mainnet wallet") : "off"} (${s.live.reason})`);
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
  if (s.testnet) {
    lines.push(`Testnet balance: ${usd(s.testnet.accountValue)}`);
    for (const p of s.testnet.positions) {
      const prot = p.protected ? `SL ${px(p.stopLossPx)}${p.takeProfitPx != null ? ` TP ${px(p.takeProfitPx)}` : ""}` : "NO STOP LOSS";
      lines.push(`  TESTNET ${p.side.toUpperCase()} ${p.sz} ${p.coin} @ ${px(p.entryPx)}  uPnL ${signedUsd(p.unrealizedPnl)}  ${prot}`);
    }
    if (s.testnet.lastFill) lines.push(`  Last testnet fill: ${s.testnet.lastFill.side} ${s.testnet.lastFill.sz} ${s.testnet.lastFill.coin} @ ${px(s.testnet.lastFill.px)}  tx ${s.testnet.lastFill.txHash}`);
  }
  lines.push(`Bots running: ${s.bots.running} (${s.bots.paper} paper, ${s.bots.testnet ?? 0} testnet, ${s.bots.live} live)`);
  if (s.questions?.length) {
    lines.push(`AI questions waiting (${s.questions.length}):`);
    for (const q of s.questions) lines.push(`  ${q.mode} ${q.coins ? q.coins.join("/") : q.coin}  id ${q.id}  expires ${q.expiresAt}`);
  }
  if (s.reasons.length) {
    lines.push("Why it isn't trading:");
    for (const r of s.reasons) lines.push(`  - ${r}`);
  } else lines.push("Trading: yes — nothing is blocking this agent.");
  return lines;
}

/** A trading round from a bot (not a backtest bar or a review). Older hubs send purpose "live" and no mode. */
function isBotQuestion(r) {
  return r.mode ? r.mode !== "NONE" : r.purpose === "live" || r.purpose === "trade";
}

/** A position counts as a big move once its unrealized P&L passes this share of its notional, either way. */
export const BIG_MOVE_PCT = 5;

/**
 * The trading part of `inbox`: every open position (paper and testnet), the
 * ones that moved BIG_MOVE_PCT or more, unprotected testnet positions, AI
 * questions waiting for an answer, and bots idle safety paused. `paper`,
 * `testnet`, `requests` and `strategies` are the hub's replies (or Errors).
 * Null when there is nothing to report.
 */
export function summarizeTradingInbox({ paper, testnet, requests, strategies }) {
  const ok = (v) => v && !(v instanceof Error);
  const positions = [];
  for (const p of ok(paper) ? paper.positions || [] : []) {
    const notional = Math.abs(p.szi) * (p.markPx || p.entryPx);
    positions.push({
      mode: "PAPER", coin: p.coin, side: p.szi > 0 ? "long" : "short", sz: Math.abs(p.szi), entryPx: p.entryPx, markPx: p.markPx,
      unrealizedPnl: p.unrealizedPnl, movePct: notional ? (p.unrealizedPnl / notional) * 100 : 0, protected: true,
    });
  }
  for (const p of ok(testnet) && testnet.enabled ? testnet.positions || [] : []) {
    positions.push({
      mode: "TESTNET", coin: p.coin, side: p.side, sz: p.sz, entryPx: p.entryPx, markPx: null, unrealizedPnl: p.unrealizedPnl,
      movePct: p.notionalUsd ? (p.unrealizedPnl / p.notionalUsd) * 100 : 0, protected: !!p.protected,
      stopLossPx: p.stopLossPx ?? null, takeProfitPx: p.takeProfitPx ?? null,
    });
  }
  const bigMoves = positions.filter((p) => Math.abs(p.movePct) >= BIG_MOVE_PCT);
  const unprotected = positions.filter((p) => !p.protected);
  const questions = (ok(requests) ? requests.requests || [] : [])
    .filter(isBotQuestion)
    .map((r) => ({ id: r.id, mode: r.mode ?? (r.paper ? "PAPER" : "LIVE"), coin: r.coin, coins: r.coins ?? null, expiresAt: r.expiresAt, system: r.system, prompt: r.prompt }));
  const cutoff = Date.now() - 24 * 60 * 60_000;
  const idlePaused = (ok(strategies) ? strategies.strategies || [] : [])
    .filter((b) => !b.enabled && b.params?.idlePausedAt > cutoff)
    .map((b) => ({ id: b.id, coin: b.coin, pausedAt: new Date(b.params.idlePausedAt).toISOString() }));
  if (!positions.length && !questions.length && !idlePaused.length) return null;
  return { positions, bigMoves, unprotected, questions, idlePaused };
}

/** Human lines for summarizeTradingInbox(). `cli` is how to invoke this CLI. */
export function formatTradingInbox(t, cli = "agent-guild") {
  const lines = [];
  if (t.questions.length) {
    lines.push(`${t.questions.length} AI trading question(s) waiting for your decision:`);
    for (const q of t.questions) {
      lines.push(`  [${q.mode}] ${q.coins ? q.coins.join("/") : q.coin}  id ${q.id}  expires ${q.expiresAt}`);
      lines.push(`    read it:  ${cli} mod call hyperliquid-trading hyperliquid_ai_requests`);
      lines.push(`    answer:   ${cli} mod call hyperliquid-trading hyperliquid_ai_answer '{"id":"${q.id}","decision":"LONG|SHORT|CLOSE|NOTHING","reasoning":"..."}'`);
    }
  }
  if (t.positions.length) {
    lines.push(`Open positions (${t.positions.length}):`);
    for (const p of t.positions) {
      const flag = Math.abs(p.movePct) >= BIG_MOVE_PCT ? `  BIG MOVE ${p.movePct > 0 ? "+" : ""}${p.movePct.toFixed(1)}%` : "";
      const prot = p.protected ? "" : "  NO STOP LOSS";
      lines.push(`  [${p.mode}] ${p.side.toUpperCase()} ${p.sz} ${p.coin} @ ${px(p.entryPx)}  uPnL ${signedUsd(p.unrealizedPnl)}${flag}${prot}`);
    }
  }
  for (const b of t.idlePaused) {
    lines.push(`Bot ${b.id} (${b.coin}) was paused by idle safety at ${b.pausedAt}: it missed rounds in a row and its positions were closed. Turn it back on with hyperliquid_toggle_bot once you're checking on time.`);
  }
  return lines;
}
