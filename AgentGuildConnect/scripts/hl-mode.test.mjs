import test from "node:test";
import assert from "node:assert/strict";
import { resolveHlMode, liveModeLabel, testnetModeLabel, formatPaperResult, formatWalletResult, formatTestnetSetup, closestCommand, summarizeHlStatus, formatHlStatus, summarizeTradingInbox, formatTradingInbox } from "./hl-mode.mjs";

const tool = (name, method = "POST") => ({ name, method, path: "x" });

test("paper tools are PAPER, with or without --live", () => {
  assert.equal(resolveHlMode(tool("hyperliquid_paper_trade"), { coin: "ETH" }).mode, "PAPER");
  assert.equal(resolveHlMode(tool("hyperliquid_paper_close"), {}, { live: true }).mode, "PAPER");
});

test("live tools refuse without --live and point at the paper twin", () => {
  assert.throws(() => resolveHlMode(tool("hyperliquid_trade"), {}), /use hyperliquid_paper_trade instead.*--live/);
  assert.throws(() => resolveHlMode(tool("hyperliquid_close"), {}), /hyperliquid_paper_close/);
  assert.equal(resolveHlMode(tool("hyperliquid_trade"), {}, { live: true }).mode, "LIVE");
});

test("bot launchers default to paper: true and need --live for paper: false", () => {
  const r = resolveHlMode(tool("hyperliquid_breakout_bot"), { coin: "BTC" });
  assert.deepEqual(r, { mode: "PAPER", trades: false, input: { coin: "BTC", paper: true } });
  assert.throws(() => resolveHlMode(tool("hyperliquid_pairs_bot"), { paper: false }), /--live/);
  assert.equal(resolveHlMode(tool("hyperliquid_pairs_bot"), {}, { live: true }).input.paper, false);
});

test("ai_answer follows the bot behind the request", () => {
  assert.equal(resolveHlMode(tool("hyperliquid_ai_answer"), { id: "r1" }, { aiRequestPaper: true }).mode, "PAPER");
  assert.throws(() => resolveHlMode(tool("hyperliquid_ai_answer"), { id: "r1" }, { aiRequestPaper: false }), /live bot/);
});

test("reads take the caller's mode; unknown POSTs are treated as live", () => {
  assert.equal(resolveHlMode(tool("hyperliquid_price", "GET"), {}).mode, "PAPER");
  assert.equal(resolveHlMode(tool("hyperliquid_price", "GET"), {}, { live: true }).mode, "LIVE");
  assert.equal(resolveHlMode(tool("hyperliquid_stop_all_bots"), {}).mode, "PAPER");
  assert.throws(() => resolveHlMode(tool("hyperliquid_new_thing"), {}), /may trade a wallet.*--testnet/);
});

test("formatPaperResult prints the fill, paper P&L and balance", () => {
  const open = formatPaperResult(
    { taskId: "t1", paper: true, filled: { sz: 0.0052, avgPx: 3812.4, fee: 0.0071, realizedPnl: 0 }, resting: null, balance: 9999.99 },
    { side: "buy", coin: "ETH" },
  );
  assert.deepEqual(open, [
    "Fill: BUY 0.0052 ETH @ 3,812.4  fee $0.01  trade t1",
    "Paper P&L (realized): $0.00",
    "Paper balance: $9,999.99",
  ]);
  const close = formatPaperResult({
    taskId: "t2", paper: true, filled: { sz: 0.0052, avgPx: 3900, fee: 0.0073, realizedPnl: -0.45 }, resting: null, balance: 9999.5,
    closing: { coin: "ETH", side: "long", sz: 0.0052 },
  });
  assert.equal(close[0], "Fill: CLOSE LONG 0.0052 ETH @ 3,900  fee $0.01  trade t2");
  assert.equal(close[1], "Paper P&L (realized): -$0.45");
  assert.deepEqual(formatPaperResult({ taskId: "x" }), []);
});

test("closestCommand suggests near misses only", () => {
  const cmds = ["capabilities", "claim", "mod", "evolve", "hyperliquid"];
  assert.equal(closestCommand("capabilites", cmds), "capabilities");
  assert.equal(closestCommand("evovle", cmds), "evolve");
  assert.equal(closestCommand("hyper", cmds), "hyperliquid");
  assert.equal(closestCommand("zzzzzzzz", cmds), null);
});

const me = (over = {}) => ({
  capabilities: { "hyperliquid-trade": true }, wallet: { configured: false, network: null, instant: false },
  risk: null, pendingStrategies: 0, ...over,
});
const paper = (over = {}) => ({ balance: 10000, equity: 10000, available: 10000, unrealizedPnl: 0, dailyPnl: 0, positions: [], orders: [], ...over });

test("status: an idle paper agent is told how to place its first order", () => {
  const s = summarizeHlStatus({ me: me(), paper: paper(), strategies: [] });
  assert.equal(s.mode, "PAPER");
  assert.deepEqual(s.live, { available: false, reason: "no live wallet set" });
  assert.equal(s.reasons.length, 1);
  assert.match(s.reasons[0], /^Idle: .*hyperliquid trade --coin BTC/);
  const lines = formatHlStatus(s);
  assert.equal(lines[0], "MODE: PAPER");
  assert.ok(lines.includes("Paper balance: $10,000.00  equity $10,000.00  available $10,000.00  today $0.00"));
});

test("status: names each blocker", () => {
  const s = summarizeHlStatus({
    me: me({ capabilities: {}, risk: { maxDailyLossUsd: 50 }, pendingStrategies: 2 }),
    paper: paper({ dailyPnl: -60, available: -5 }),
    strategies: [{ type: "ai", enabled: true, paper: true }, { type: "dca", enabled: false, paper: false }],
  }, { autoReply: false });
  const all = s.reasons.join("\n");
  assert.match(all, /not granted hyperliquid-trade/);
  assert.match(all, /Daily paper loss limit hit \(-\$60\.00 of -\$50\.00\)/);
  assert.match(all, /No free margin/);
  assert.match(all, /AI bots ask your own model/);
  assert.match(all, /2 bot signal\(s\) waiting/);
  assert.deepEqual(s.bots, { running: 1, paper: 1, testnet: 0, live: 0 });
  assert.equal(s.canTrade, false);
});

test("status: an open position with nothing blocking reads as trading; failed reads are reported", () => {
  const pos = { coin: "ETH", szi: -0.5, entryPx: 3000, markPx: 2900, unrealizedPnl: 50 };
  const s = summarizeHlStatus({ me: me({ wallet: { configured: true, network: "testnet", instant: true } }), paper: paper({ positions: [pos] }), strategies: [] });
  assert.deepEqual(s.reasons, []);
  assert.equal(s.live.available, true);
  assert.ok(formatHlStatus(s).includes("  SHORT 0.5 ETH @ 3,000  mark 2,900  uPnL +$50.00"));

  const down = summarizeHlStatus({ me: new Error("401 bad sig"), paper: new Error("502"), strategies: [] });
  assert.equal(down.balance, null);
  assert.match(down.live.reason, /401 bad sig/);
  assert.match(down.reasons.join("\n"), /Paper account unreadable: 502/);
});

test("ai_answer with no known bot counts as live", () => {
  assert.throws(() => resolveHlMode(tool("hyperliquid_ai_answer"), { id: "r9" }), /can't be matched to a paper or testnet bot/);
  assert.deepEqual(
    { mode: resolveHlMode(tool("hyperliquid_ai_answer"), { id: "r9" }, { live: true }).mode, trades: resolveHlMode(tool("hyperliquid_ai_answer"), { id: "r9" }, { live: true }).trades },
    { mode: "LIVE", trades: true },
  );
});

test("trades is true only for calls that can place a live order", () => {
  assert.equal(resolveHlMode(tool("hyperliquid_trade"), {}, { live: true }).trades, true);
  assert.equal(resolveHlMode(tool("hyperliquid_price", "GET"), {}, { live: true }).trades, false);
  assert.equal(resolveHlMode(tool("hyperliquid_breakout_bot"), {}).trades, false);
  assert.equal(resolveHlMode(tool("hyperliquid_breakout_bot"), {}, { live: true }).trades, true);
});

test("liveModeLabel: a testnet wallet is TESTNET; mainnet orders need --mainnet; unknown network never trades", () => {
  assert.equal(liveModeLabel("testnet"), "TESTNET");
  assert.throws(() => liveModeLabel("mainnet"), /MAINNET.*--mainnet/);
  assert.equal(liveModeLabel("mainnet", { mainnet: true }), "LIVE");
  assert.equal(liveModeLabel("mainnet", { trades: false }), "LIVE");
  assert.throws(() => liveModeLabel(null), /Can't confirm which network/);
  assert.equal(liveModeLabel(null, { trades: false }), "LIVE (NETWORK UNKNOWN)");
});

test("TESTNET: --testnet or network: testnet, never paper and never mainnet", () => {
  const trade = resolveHlMode(tool("hyperliquid_trade"), { coin: "ETH" }, { testnet: true });
  assert.deepEqual(trade, { mode: "TESTNET", trades: true, input: { coin: "ETH", network: "testnet" } });
  assert.equal(resolveHlMode(tool("hyperliquid_close"), { coin: "ETH", network: "testnet" }).mode, "TESTNET");
  const train = resolveHlMode(tool("hyperliquid_paper_train"), { goal: "x" }, { testnet: true });
  assert.deepEqual([train.mode, train.input.network], ["TESTNET", "testnet"]);
  assert.equal(resolveHlMode(tool("hyperliquid_paper_train"), { goal: "x" }).mode, "PAPER");
  const bot = resolveHlMode(tool("hyperliquid_rule_bot"), { type: "dca" }, { testnet: true });
  assert.deepEqual(bot.input, { type: "dca", network: "testnet" });
  assert.throws(() => resolveHlMode(tool("hyperliquid_rule_bot"), { paper: true, network: "testnet" }), /pick one/);
  assert.equal(resolveHlMode(tool("hyperliquid_testnet_setup"), {}).mode, "TESTNET");
  assert.equal(resolveHlMode(tool("hyperliquid_testnet_account", "GET"), {}).mode, "TESTNET");
  // A testnet bot's question is answered without a flag; a live bot's still needs --live.
  assert.equal(resolveHlMode(tool("hyperliquid_ai_answer"), { id: "r1" }, { aiRequestMode: "TESTNET" }).mode, "TESTNET");
  assert.throws(() => resolveHlMode(tool("hyperliquid_ai_answer"), { id: "r1" }, { aiRequestMode: "LIVE" }), /live bot/);
  assert.equal(resolveHlMode(tool("hyperliquid_ai_answer"), { id: "r1" }, { aiRequestMode: "NONE" }).mode, "PAPER");
});

test("1.6 tools that place no order work on paper without flags", () => {
  assert.equal(resolveHlMode(tool("hyperliquid_rule_bot"), { type: "dca" }).input.paper, true);
  assert.equal(resolveHlMode(tool("hyperliquid_toggle_bot"), { id: "s1" }).mode, "PAPER");
  assert.equal(resolveHlMode(tool("hyperliquid_backtest"), { type: "dca" }).mode, "PAPER");
});

test("testnetModeLabel: a testnet order needs the testnet wallet", () => {
  assert.equal(testnetModeLabel("testnet"), "TESTNET");
  assert.throws(() => testnetModeLabel("mainnet"), /MAINNET/);
  assert.throws(() => testnetModeLabel(null), /hyperliquid_testnet_setup/);
  assert.equal(testnetModeLabel(null, { trades: false }), "TESTNET");
});

test("formatWalletResult: the fill, its testnet tx, protection and P&L", () => {
  const fill = { network: "testnet", status: "filled", oid: 77, sz: 0.01, avgPx: 2000.5, realizedPnl: null, txHash: "0xfeed",
    explorerUrl: "https://app.hyperliquid-testnet.xyz/explorer/tx/0xfeed", stopLossPx: 1900.5, takeProfitPx: 2200.6, protectionError: null };
  assert.deepEqual(formatWalletResult({ taskId: "t1", network: "testnet", fill }, { side: "buy", coin: "ETH" }), [
    "Fill (TESTNET): BUY 0.01 ETH @ 2,000.5  order 77  task t1",
    "Testnet tx: 0xfeed  https://app.hyperliquid-testnet.xyz/explorer/tx/0xfeed",
    "Protection: stop loss @ 1,900.5 · take profit @ 2,200.6",
  ]);
  const closed = formatWalletResult({ taskId: "t2", closing: { coin: "ETH", side: "long" }, fill: { ...fill, stopLossPx: null, takeProfitPx: null, realizedPnl: 1.25 } });
  assert.equal(closed[0], "Fill (TESTNET): CLOSE LONG 0.01 ETH @ 2,000.5  order 77  task t2");
  assert.equal(closed.at(-1), "Testnet P&L: +$1.25");
  assert.match(formatWalletResult({ taskId: "t3" })[0], /queued for a worker/);
  assert.deepEqual(formatWalletResult({ paper: true, taskId: "x" }), []);
});

test("formatTestnetSetup: the wallet and how it was funded", () => {
  const lines = formatTestnetSetup({ address: "0xabc", enabled: true, funding: { status: "sent", amountUsd: 500, balance: 500, from: "0xhub" } });
  assert.equal(lines[0], "Testnet wallet: 0xabc (testnet trading turned on)");
  assert.match(lines[1], /^Funded: \+\$500\.00 testnet USDC/);
  assert.match(formatTestnetSetup({ address: "0xabc", funding: { status: "manual", balance: 0, message: "Claim at drip" } })[1], /Claim at drip/);
});

test("status: testnet positions, idle pauses and waiting questions", () => {
  const s = summarizeHlStatus({
    me: me({ wallet: { configured: true, network: "testnet", instant: true } }),
    paper: paper(),
    strategies: [
      { id: "s1", coin: "ETH", type: "ai", enabled: true, paper: false, network: "testnet" },
      { id: "s2", coin: "BTC", type: "ai", enabled: false, paper: true, params: { idlePausedAt: Date.now() - 1000 } },
    ],
    testnet: { enabled: true, address: "0xabc", accountValue: 480, positions: [{ coin: "SOL", side: "long", sz: 1, entryPx: 150, unrealizedPnl: -2, protected: false }], recentFills: [] },
    requests: [{ id: "r1", mode: "TESTNET", coin: "ETH", expiresAt: "2026-10-12T10:00:00Z" }, { id: "r2", mode: "NONE", coin: "ETH" }],
  }, { autoReply: true });
  assert.deepEqual(s.bots, { running: 1, paper: 0, testnet: 1, live: 0 });
  assert.equal(s.questions.length, 1);
  const all = s.reasons.join("\n");
  assert.match(all, /Testnet long SOL has no stop loss/);
  assert.match(all, /Bot s2 \(BTC\) was paused by idle safety/);
  const lines = formatHlStatus(s);
  assert.ok(lines.includes("Testnet: on (0xabc), pass --testnet"));
  assert.ok(lines.some((l) => l.startsWith("  TESTNET LONG 1 SOL @ 150") && l.endsWith("NO STOP LOSS")));
  assert.ok(lines.includes("  TESTNET ETH  id r1  expires 2026-10-12T10:00:00Z"));
});

test("inbox trading: positions, big moves, unprotected positions and questions", () => {
  const t = summarizeTradingInbox({
    paper: paper({ positions: [{ coin: "ETH", szi: 0.1, entryPx: 2000, markPx: 2200, unrealizedPnl: 20 }] }),
    testnet: { enabled: true, positions: [{ coin: "BTC", side: "short", sz: 0.001, entryPx: 60000, notionalUsd: 60, unrealizedPnl: -0.5, protected: true, stopLossPx: 63000 }] },
    requests: { requests: [{ id: "r1", mode: "TESTNET", coin: "BTC", expiresAt: "2026-10-12T10:00:00Z" }, { id: "b1", mode: "NONE", coin: "SOL" }] },
    strategies: { strategies: [] },
  });
  assert.equal(t.positions.length, 2);
  assert.deepEqual(t.bigMoves.map((p) => p.coin), ["ETH"]);
  assert.deepEqual(t.questions.map((q) => q.id), ["r1"]);
  const lines = formatTradingInbox(t, "ag");
  assert.equal(lines[0], "1 AI trading question(s) waiting for your decision:");
  assert.ok(lines.some((l) => l.includes(`ag mod call hyperliquid-trading hyperliquid_ai_answer '{"id":"r1"`)));
  assert.ok(lines.some((l) => l.startsWith("  [PAPER] LONG 0.1 ETH") && l.includes("BIG MOVE +9.1%")));
  assert.ok(lines.some((l) => l.startsWith("  [TESTNET] SHORT 0.001 BTC")));
  assert.equal(summarizeTradingInbox({ paper: paper(), testnet: { enabled: false }, requests: { requests: [] }, strategies: { strategies: [] } }), null);
});
