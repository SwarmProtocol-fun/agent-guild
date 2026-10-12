// End to end: a fresh agent runs the CLI against a fake hub, finds the
// Hyperliquid tools, opens a paper trade and closes it. Nothing leaves
// localhost.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStandalone, OUT_PATH } from "./build-standalone.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// The Connect source, and the single file a fresh agent downloads from agent-guild.com.
const COPIES = {
  source: [here, ["agent-guild.mjs", "mod-tools.mjs", "hl-mode.mjs", "identity-vault-crypto.mjs", "solana-escrow.mjs", "agent-guild-idl.json"]],
  published: [join(here, "..", "..", "AgentGuildApp", "public"), ["agent-guild.mjs"]],
};

const TOOLS = [
  { name: "hyperliquid_price", method: "GET", path: "price/{coin}", input_schema: { type: "object", properties: { coin: {} }, required: ["coin"] } },
  { name: "hyperliquid_paper_account", method: "GET", path: "paper/{agentId}", input_schema: { type: "object", properties: {} } },
  { name: "hyperliquid_paper_trade", method: "POST", path: "paper/trade", input_schema: { type: "object", properties: { coin: {}, isBuy: {}, sizeUsd: {} }, required: ["coin", "isBuy", "sizeUsd"] } },
  { name: "hyperliquid_paper_close", method: "POST", path: "paper/close", input_schema: { type: "object", properties: { coin: {} }, required: ["coin"] } },
  { name: "hyperliquid_trade", method: "POST", path: "trade", input_schema: { type: "object", properties: { coin: {}, isBuy: {}, sizeUsd: {}, network: {} }, required: ["coin", "isBuy", "sizeUsd"] } },
];

/** What a hub with testnet support adds (mod 1.7). */
const TESTNET_TOOLS = [
  ...TOOLS,
  { name: "hyperliquid_close", method: "POST", path: "close", input_schema: { type: "object", properties: { coin: {}, network: {} }, required: ["coin"] } },
  { name: "hyperliquid_testnet_setup", method: "POST", path: "testnet/setup", input_schema: { type: "object", properties: {} } },
  { name: "hyperliquid_testnet_account", method: "GET", path: "testnet/{agentId}", input_schema: { type: "object", properties: {} } },
  { name: "hyperliquid_ai_requests", method: "GET", path: "ai/requests", input_schema: { type: "object", properties: {} } },
];

function fakeHub({ network = null, tools = TOOLS } = {}) {
  const calls = [];
  let position = null;
  let testnetPosition = null;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://hub");
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, path: url.pathname, body, signed: url.searchParams.has("sig") });
    const send = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    const p = url.pathname.replace("/api/mods/hyperliquid-trading/", "");
    if (url.pathname === "/api/v1/capabilities") return send(200, { capabilities: [{ key: "hyperliquid-trade", slug: "hyperliquid-trading" }, { key: "hyperliquid-close", slug: "hyperliquid-trading" }] });
    if (p === "agent/tools") return send(200, { tools });
    if (p === "me") {
      return send(200, {
        agentId: "agent-1", orgId: "org-1", via: "agent",
        capabilities: { "hyperliquid-trade": true, "hyperliquid-close": true },
        wallet: { configured: !!network, network, instant: !!network },
        risk: null, pendingStrategies: 0, readyToTrade: false, readyToPaperTrade: true,
      });
    }
    if (p === "strategy/agent-1") return send(200, { strategies: [] });
    if (p === "paper/agent-1") {
      const positions = position ? [{ coin: "ETH", szi: position.sz, entryPx: position.entryPx, markPx: 3850, leverage: 1, unrealizedPnl: 0.2 }] : [];
      return send(200, { network: "mainnet", startBalance: 10000, dailyPnl: 0, balance: 9999.99, equity: 10000.19, available: 9980, unrealizedPnl: 0.2, positions, orders: [] });
    }
    if (p === "trade" && body.network === "testnet") {
      if (network !== "testnet") return send(409, { error: "This agent's trading wallet is on MAINNET (real funds), not testnet" });
      testnetPosition = { sz: 0.0052, entryPx: 3812.4 };
      return send(200, {
        taskId: "tn-1", network: "testnet", mode: "TESTNET",
        fill: { network: "testnet", status: "filled", oid: 77, sz: 0.0052, avgPx: 3812.4, realizedPnl: null, txHash: "0xfeed01",
          explorerUrl: "https://app.hyperliquid-testnet.xyz/explorer/tx/0xfeed01", stopLossPx: 3621.8, takeProfitPx: 4193.6, protectionError: null },
      });
    }
    if (p === "trade") return send(200, { taskId: "live-1" });
    if (p === "close" && body.network === "testnet") {
      if (!testnetPosition) return send(404, { error: "No open ETH position" });
      testnetPosition = null;
      return send(200, {
        taskId: "tn-2", network: "testnet", mode: "TESTNET", closing: { coin: body.coin, side: "long", sizeUsd: 20 },
        fill: { network: "testnet", status: "filled", oid: 80, sz: 0.0052, avgPx: 3900, realizedPnl: 0.45, txHash: "0xfeed02",
          explorerUrl: "https://app.hyperliquid-testnet.xyz/explorer/tx/0xfeed02", stopLossPx: null, takeProfitPx: null, protectionError: null },
      });
    }
    if (p === "testnet/setup") {
      network = "testnet";
      return send(200, { ok: true, mode: "TESTNET", network: "testnet", address: "0xabc", enabled: true,
        funding: { status: "sent", amountUsd: 500, balance: 500, from: "0xhub" }, risk: { leverage: 3, maxPositionUsd: 100, maxDailyLossUsd: 50 } });
    }
    if (p === "testnet/agent-1") {
      if (network !== "testnet") return send(200, { mode: "TESTNET", enabled: false });
      const positions = testnetPosition
        ? [{ coin: "ETH", side: "long", sz: testnetPosition.sz, entryPx: testnetPosition.entryPx, notionalUsd: 20, unrealizedPnl: 1.5, stopLossPx: 3621.8, takeProfitPx: 4193.6, protected: true }]
        : [];
      return send(200, { mode: "TESTNET", enabled: true, network: "testnet", address: "0xabc", accountValue: 500, positions, recentFills: [] });
    }
    if (p === "ai/requests") {
      return send(200, { requests: testnetPosition
        ? [{ id: "q1", purpose: "trade", mode: "TESTNET", paper: false, coin: "ETH", system: "sys", prompt: "snapshot", expiresAt: "2026-10-12T10:16:00Z" }]
        : [] });
    }
    if (p === "paper/trade") {
      position = { sz: 0.0052, entryPx: 3812.4 };
      return send(200, { taskId: "pt-1", paper: true, filled: { sz: 0.0052, avgPx: 3812.4, fee: 0.0071, realizedPnl: 0 }, resting: null, balance: 9999.99 });
    }
    if (p === "paper/close") {
      if (!position) return send(404, { error: `No open ${body.coin} paper position` });
      position = null;
      return send(200, { taskId: "pt-2", paper: true, filled: { sz: 0.0052, avgPx: 3900, fee: 0.0073, realizedPnl: 0.44 }, resting: null, balance: 10000.42, closing: { coin: body.coin, side: "long", sz: 0.0052 } });
    }
    send(404, { error: `fake hub has no ${req.method} ${url.pathname}` });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

function freshAgent(hubUrl, copy = "source") {
  const [from, files] = COPIES[copy];
  // Under node_modules so the copy still resolves @coral-xyz/anchor (solana-escrow.mjs).
  const base = join(here, "..", "node_modules", ".tmp");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "ag-cli-"));
  mkdirSync(join(root, "skill", "scripts"), { recursive: true });
  for (const f of files) copyFileSync(join(from, f), join(root, "skill", "scripts", f));
  writeFileSync(join(root, "skill", "config.json"), JSON.stringify({ hubUrl, agentId: "agent-1", orgId: "org-1", agentName: "Rex" }));
  const script = join(root, "skill", "scripts", "agent-guild.mjs");
  const env = { ...process.env, HOME: root };
  const run = (...args) => new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
  // One MCP session over stdio: send each request, collect the responses by id.
  const mcp = (requests) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "mcp"], { env, stdio: ["pipe", "pipe", "inherit"] });
    const byId = {};
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id != null) byId[msg.id] = msg;
        if (Object.keys(byId).length === requests.length) { child.kill(); resolve(byId); }
      }
    });
    child.on("error", reject);
    for (const [i, r] of requests.entries()) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i + 1, ...r }) + "\n");
  });
  return { run, mcp, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

for (const copy of Object.keys(COPIES)) {
  test(`${copy}: fresh agent: capabilities → status → paper trade → close with paper P&L`, async (t) => {
    const hub = await fakeHub();
    const agent = freshAgent(hub.url, copy);
    t.after(() => { hub.server.close(); agent.cleanup(); });

    const caps = await agent.run("capabilities");
    assert.equal(caps.code, 0, caps.stderr);
    assert.match(caps.stdout, /hyperliquid-trade\s+\(hyperliquid-trading\)/);

    const tools = await agent.run("mod", "tools", "hyperliquid-trading");
    assert.equal(tools.code, 0, tools.stderr);
    assert.match(tools.stdout, /5 tool\(s\)/);
    for (const t of TOOLS) assert.ok(tools.stdout.includes(t.name), t.name);

    const status = await agent.run("mod", "status", "hyperliquid-trading");
    assert.equal(status.code, 0, status.stderr);
    assert.equal(status.stdout.split("\n")[0], "MODE: PAPER");
    assert.match(status.stdout, /Paper balance: \$9,999\.99/);
    assert.match(status.stdout, /Open positions: none/);
    assert.match(status.stdout, /Live: off \(no live wallet set\)/);
    assert.match(status.stdout, /Why it isn't trading:\n  - Idle: no open positions/);

    const open = await agent.run("hyperliquid", "trade", "--coin", "eth", "--side", "buy", "--size-usd", "20");
    assert.equal(open.code, 0, open.stderr);
    assert.match(open.stdout, /^MODE: PAPER$/m);
    assert.match(open.stdout, /Fill: BUY 0\.0052 ETH @ 3,812\.4/);

    const held = await agent.run("mod", "status", "hyperliquid-trading", "--json");
    assert.equal(held.code, 0, held.stderr);
    assert.deepEqual(JSON.parse(held.stdout).positions.map((p) => `${p.side} ${p.coin}`), ["long ETH"]);

    const close = await agent.run("mod", "call", "hyperliquid-trading", "hyperliquid_paper_close", '{"coin":"ETH"}');
    assert.equal(close.code, 0, close.stderr);
    assert.equal(close.stdout.split("\n")[0], "MODE: PAPER");
    assert.match(close.stdout, /Fill: CLOSE LONG 0\.0052 ETH @ 3,900/);
    assert.match(close.stdout, /Paper P&L \(realized\): \+\$0\.44/);

    const trades = hub.calls.filter((c) => c.method === "POST");
    assert.deepEqual(trades.map((c) => c.path), ["/api/mods/hyperliquid-trading/paper/trade", "/api/mods/hyperliquid-trading/paper/close"]);
    assert.deepEqual(trades[0].body, { coin: "ETH", isBuy: true, sizeUsd: 20 });
    assert.ok(hub.calls.every((c) => c.signed));
  });

  test(`${copy}: MCP: mod tools, status and a paper round trip with the agent's own key`, async (t) => {
    const hub = await fakeHub();
    const agent = freshAgent(hub.url, copy);
    t.after(() => { hub.server.close(); agent.cleanup(); });

    await agent.run("capabilities"); // keys exist after register; make them before the parallel MCP calls
    const call = (name, args) => ({ method: "tools/call", params: { name, arguments: args } });
    const r = await agent.mcp([
      { method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { method: "tools/list" },
      call("guild_capabilities", {}),
      call("guild_mod_status", { mod: "hyperliquid-trading" }),
      call("guild_mod_call", { mod: "hyperliquid-trading", tool: "hyperliquid_paper_trade", input: { coin: "ETH", isBuy: true, sizeUsd: 20 } }),
    ]);
    const names = r[2].result.tools.map((x) => x.name);
    for (const n of ["guild_capabilities", "guild_mod_tools", "guild_mod_call", "guild_mod_status", "guild_inbox"]) assert.ok(names.includes(n), n);
    const text = (id) => r[id].result.content.map((c) => c.text).join("");
    assert.match(text(3), /hyperliquid-trade/);
    assert.match(text(4), /^MODE: PAPER\n[\s\S]*Paper balance: \$9,999\.99/);
    assert.match(text(5), /^MODE: PAPER\nFill: BUY 0\.0052 ETH/);
    assert.ok(!r[5].result.isError);
  });

  test(`${copy}: live calls are refused without --live and never reach the hub`, async (t) => {
    const hub = await fakeHub();
    const agent = freshAgent(hub.url, copy);
    t.after(() => { hub.server.close(); agent.cleanup(); });

    const live = await agent.run("mod", "call", "hyperliquid-trading", "hyperliquid_trade", '{"coin":"ETH","isBuy":true,"sizeUsd":20}');
    assert.equal(live.code, 1);
    assert.match(live.stderr, /MODE: PAPER — refused\. hyperliquid_trade trades a wallet\. Paper is the default: .*--testnet/);

    const dca = await agent.run("hyperliquid", "strategy", "dca", "--coin", "ETH", "--size-usd", "20", "--interval-ms", "60000");
    assert.notEqual(dca.code, 0);
    assert.match(dca.stderr, /pass --live/);

    assert.equal(hub.calls.filter((c) => c.method === "POST").length, 0);
  });
}

for (const copy of Object.keys(COPIES)) {
  test(`${copy}: a live order names its network, and mainnet needs --mainnet`, async (t) => {
    const order = ["mod", "call", "hyperliquid-trading", "hyperliquid_trade", '{"coin":"ETH","isBuy":true,"sizeUsd":20}', "--live"];

    const main = await fakeHub({ network: "mainnet" });
    const a = freshAgent(main.url, copy);
    t.after(() => { main.server.close(); a.cleanup(); });
    const refused = await a.run(...order);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /MODE: LIVE — refused\. .*MAINNET \(real funds\)\. Pass --mainnet/);
    assert.equal(main.calls.filter((c) => c.method === "POST").length, 0);
    const sent = await a.run(...order, "--mainnet");
    assert.equal(sent.code, 0, sent.stderr);
    assert.match(sent.stdout, /^MODE: LIVE$/m);
    const posts = main.calls.filter((c) => c.method === "POST");
    assert.deepEqual(posts.map((c) => c.path), ["/api/mods/hyperliquid-trading/trade"]);
    assert.equal(posts[0].body.network, "mainnet", "the hub is told which network was meant");

    const test_ = await fakeHub({ network: "testnet" });
    const b = freshAgent(test_.url, copy);
    t.after(() => { test_.server.close(); b.cleanup(); });
    const r = await b.run(...order);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^MODE: TESTNET$/m);

    const none = await fakeHub();
    const c = freshAgent(none.url, copy);
    t.after(() => { none.server.close(); c.cleanup(); });
    const unknown = await c.run(...order);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Can't confirm which network/);
    assert.equal(none.calls.filter((x) => x.method === "POST").length, 0);
  });
}

for (const copy of Object.keys(COPIES)) {
  test(`${copy}: TESTNET: setup → trade (fill + testnet tx + SL/TP) → inbox → close with testnet P&L`, async (t) => {
    const hub = await fakeHub({ tools: TESTNET_TOOLS });
    const agent = freshAgent(hub.url, copy);
    t.after(() => { hub.server.close(); agent.cleanup(); });

    // Before setup, a testnet order is refused here and never sent.
    const early = await agent.run("mod", "call", "hyperliquid-trading", "hyperliquid_trade", '{"coin":"ETH","isBuy":true,"sizeUsd":20}', "--testnet");
    assert.equal(early.code, 1);
    assert.match(early.stderr, /MODE: TESTNET — refused\. No testnet wallet yet\. Run: .*hyperliquid_testnet_setup/);

    const setup = await agent.run("mod", "call", "hyperliquid-trading", "hyperliquid_testnet_setup");
    assert.equal(setup.code, 0, setup.stderr);
    assert.match(setup.stdout, /^MODE: TESTNET\nTestnet wallet: 0xabc \(testnet trading turned on\)\nFunded: \+\$500\.00 testnet USDC/);

    const open = await agent.run("mod", "call", "hyperliquid-trading", "hyperliquid_trade", '{"coin":"ETH","isBuy":true,"sizeUsd":20}', "--testnet");
    assert.equal(open.code, 0, open.stderr);
    assert.match(open.stdout, /^MODE: TESTNET\nFill \(TESTNET\): BUY 0\.0052 ETH @ 3,812\.4  order 77  task tn-1\nTestnet tx: 0xfeed01  https:\/\/app\.hyperliquid-testnet\.xyz\/explorer\/tx\/0xfeed01\nProtection: stop loss @ 3,621\.8 · take profit @ 4,193\.6/);

    const inbox = await agent.run("inbox");
    assert.equal(inbox.code, 0, inbox.stderr);
    assert.match(inbox.stdout, /1 AI trading question\(s\) waiting for your decision:\n  \[TESTNET\] ETH  id q1/);
    assert.match(inbox.stdout, /  \[TESTNET\] LONG 0\.0052 ETH @ 3,812\.4  uPnL \+\$1\.50/);
    const inboxJson = JSON.parse((await agent.run("inbox", "--json")).stdout);
    assert.equal(inboxJson.trading.questions[0].id, "q1");
    assert.match(inboxJson.trading.questions[0].answer, /hyperliquid_ai_answer '\{"id":"q1"/);

    const status = await agent.run("mod", "status", "hyperliquid-trading");
    assert.match(status.stdout, /Testnet: on \(0xabc\), pass --testnet/);
    assert.match(status.stdout, /  TESTNET LONG 0\.0052 ETH @ 3,812\.4  uPnL \+\$1\.50  SL 3,621\.8 TP 4,193\.6/);

    const close = await agent.run("hyperliquid", "close", "--testnet", "--coin", "ETH");
    assert.equal(close.code, 0, close.stderr);
    assert.match(close.stdout, /^MODE: TESTNET\nFill \(TESTNET\): CLOSE LONG 0\.0052 ETH @ 3,900  order 80  task tn-2\nTestnet tx: 0xfeed02/);
    assert.match(close.stdout, /Testnet P&L: \+\$0\.45/);

    const posts = hub.calls.filter((c) => c.method === "POST");
    assert.deepEqual(posts.map((c) => [c.path.replace("/api/mods/hyperliquid-trading/", ""), c.body?.network ?? null]), [
      ["testnet/setup", null], ["trade", "testnet"], ["close", "testnet"],
    ]);
    assert.ok(hub.calls.every((c) => c.signed));
  });

  test(`${copy}: MCP: guild_mod_call with testnet: true trades the testnet wallet`, async (t) => {
    const hub = await fakeHub({ tools: TESTNET_TOOLS, network: "testnet" });
    const agent = freshAgent(hub.url, copy);
    t.after(() => { hub.server.close(); agent.cleanup(); });
    await agent.run("capabilities");
    const r = await agent.mcp([
      { method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { method: "tools/call", params: { name: "guild_mod_call", arguments: { mod: "hyperliquid-trading", tool: "hyperliquid_trade", input: { coin: "ETH", isBuy: true, sizeUsd: 20 }, testnet: true } } },
    ]);
    const text = r[2].result.content.map((c) => c.text).join("");
    assert.match(text, /^MODE: TESTNET\nFill \(TESTNET\): BUY 0\.0052 ETH[\s\S]*Testnet tx: 0xfeed01/);
  });
}

test("unknown command names the closest match instead of printing help", async (t) => {
  const agent = freshAgent("http://127.0.0.1:9");
  t.after(() => agent.cleanup());
  const r = await agent.run("capabilites");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^Unknown command: capabilites\nDid you mean: agent-guild capabilities/);
  assert.doesNotMatch(r.stdout, /Commands:/);
});

test("the published single-file CLI is exactly the build of the source", () => {
  const published = readFileSync(OUT_PATH, "utf8");
  assert.ok(published === buildStandalone(), "AgentGuildApp/public/agent-guild.mjs is stale. Run: node AgentGuildConnect/scripts/build-standalone.mjs");
  assert.doesNotMatch(published, /^import .* from "\.\//m, "the published file must have no relative static imports");
});
