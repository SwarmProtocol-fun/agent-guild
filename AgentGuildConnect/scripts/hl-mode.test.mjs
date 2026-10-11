import test from "node:test";
import assert from "node:assert/strict";
import { resolveHlMode, liveModeLabel, formatPaperResult, closestCommand, summarizeHlStatus, formatHlStatus } from "./hl-mode.mjs";

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
  assert.throws(() => resolveHlMode(tool("hyperliquid_new_thing"), {}), /may trade real funds/);
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
  assert.deepEqual(s.bots, { running: 1, paper: 1, live: 0 });
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
  assert.throws(() => resolveHlMode(tool("hyperliquid_ai_answer"), { id: "r9" }), /can't be matched to a paper bot/);
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

test("liveModeLabel: mainnet orders need --mainnet; unknown network never trades", () => {
  assert.equal(liveModeLabel("testnet"), "LIVE (TESTNET)");
  assert.throws(() => liveModeLabel("mainnet"), /MAINNET.*--mainnet/);
  assert.equal(liveModeLabel("mainnet", { mainnet: true }), "LIVE (MAINNET)");
  assert.equal(liveModeLabel("mainnet", { trades: false }), "LIVE (MAINNET)");
  assert.throws(() => liveModeLabel(null), /Can't confirm which network/);
  assert.equal(liveModeLabel(null, { trades: false }), "LIVE (NETWORK UNKNOWN)");
});
