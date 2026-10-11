// End to end: a fresh agent registers with only the downloaded script (no
// grok-reply.mjs, no replyCommand), a human DMs it, and the agent — doing
// nothing but what the registration output told it to — answers in that DM.
// Runs against the Connect source and the copy served at
// agent-guild.com/agent-guild.mjs. Nothing leaves localhost.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const COPIES = {
  source: [here, ["agent-guild.mjs", "mod-tools.mjs", "hl-mode.mjs", "identity-vault-crypto.mjs", "solana-escrow.mjs", "agent-guild-idl.json"]],
  published: [join(here, "..", "..", "AgentGuildApp", "public"), ["agent-guild.mjs"]],
};

const DM = { id: "dm-1", name: "Rex", projectId: "dm" };
const HUB = { id: "hub-1", name: "Agent Hub", projectId: "org" };
const HUMAN_MSG = { id: "msg-1", channelId: DM.id, channelName: DM.name, from: "0xF35c...3D5A", fromType: "human", text: "what can you do?", timestamp: Date.now() };

function fakeHub() {
  const sends = [];
  const hub = { sends, dmOpen: false };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = req.url.split("?")[0];
    const send = (data) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (path === "/api/health") return send({ checks: { firestore: true } });
    if (path === "/api/v1/register") return send({ agentId: "agent-1", agentHubChannelId: HUB.id });
    if (path === "/api/v1/messages") {
      return send({ messages: hub.dmOpen ? [HUMAN_MSG] : [], channels: [HUB, DM] });
    }
    if (path === "/api/v1/send") {
      sends.push(JSON.parse(raw));
      return send({ messageId: `sent-${sends.length}` });
    }
    send({});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    hub.server = server;
    hub.url = `http://127.0.0.1:${server.address().port}`;
    resolve(hub);
  }));
}

function freshAgent(copy) {
  const [from, files] = COPIES[copy];
  // Under node_modules so the source copy still resolves @coral-xyz/anchor.
  const base = join(here, "..", "node_modules", ".tmp");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "ag-inbox-"));
  mkdirSync(join(root, "dl"), { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });
  for (const f of files) copyFileSync(join(from, f), join(root, "dl", f));
  const script = join(root, "dl", "agent-guild.mjs");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AGENT_GUILD_"))), HOME: join(root, "home") };
  const exec = (argv) => new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { env, timeout: 30000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
  const pidFile = join(root, "home", ".agent-guild", "agent-1", "daemon.pid");
  const statePath = join(root, "home", ".agent-guild", "agent-1", "state.json");
  return {
    script,
    run: (...args) => exec([process.execPath, script, ...args]),
    exec,
    state: () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {}),
    cleanup: () => {
      try { process.kill(parseInt(readFileSync(pidFile, "utf8"), 10)); } catch { /* daemon already gone */ }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function until(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** Split a printed shell line like `node /x/agent-guild.mjs reply a b "<your answer>"` into argv. */
function argvOf(line, answer) {
  return line.replace(/"<your answer>"$/, "").trim().split(/\s+/).concat(answer);
}

for (const copy of Object.keys(COPIES)) {
  test(`${copy}: a fresh agent that follows only the registration output answers its own DM`, { timeout: 60000 }, async (t) => {
    const hub = await fakeHub();
    const agent = freshAgent(copy);
    t.after(() => { agent.cleanup(); hub.server.close(); });

    const reg = await agent.run("register", "--hub", hub.url, "--org", "org-1", "--name", "Rex", "--type", "research");
    assert.equal(reg.code, 0, reg.stderr);
    assert.match(reg.stdout, /Status: online/);
    // The output itself tells the bot it has to poll and reply, and how.
    const next = reg.stdout.slice(reg.stdout.indexOf("Status: online"));
    assert.match(next, /Next step: set up a recurring check \(e\.g\. every 15m\) and reply to messages/);
    assert.match(next, /does NOT answer anyone/);
    const inboxLine = next.match(/^\s+1\. (node \S+ inbox)$/m);
    assert.ok(inboxLine, `no inbox command in:\n${next}`);
    assert.match(next, /reply <channelId> <messageId> "<your answer>"/);

    // A human DMs the agent. The daemon queues it instead of failing it.
    hub.dmOpen = true;
    await until(() => agent.state().inbox?.[HUMAN_MSG.id], 25000, "the DM to reach the inbox");
    // Several more polls return the same message; it stays queued once and nothing is sent for it.
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(hub.sends.filter((s) => s.channelId === DM.id).length, 0, "daemon must not answer (or apologise) on its own");

    // The bot's recurring check: exactly the command it was given.
    const inbox = await agent.exec([...inboxLine[1].split(/\s+/), "--json"]);
    assert.equal(inbox.code, 0, inbox.stderr);
    const listed = JSON.parse(inbox.stdout);
    assert.equal(listed.daemonRunning, true);
    assert.equal(listed.pending.length, 1);
    assert.equal(listed.pending[0].text, HUMAN_MSG.text);
    assert.equal(listed.pending[0].kind, "dm");

    const reply = await agent.exec(argvOf(listed.pending[0].reply, "I research things for this org."));
    assert.equal(reply.code, 0, reply.stderr);

    const dmSends = hub.sends.filter((s) => s.channelId === DM.id);
    assert.equal(dmSends.length, 1);
    assert.equal(dmSends[0].text, "I research things for this org.");
    assert.equal(dmSends[0].replyTo, HUMAN_MSG.id);

    const after = await agent.run("inbox");
    assert.match(after.stdout, /Inbox empty/);
    assert.equal(agent.state().repliedIds[HUMAN_MSG.id], true);

    // The daemon keeps polling the same message and never answers it a second time.
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(hub.sends.filter((s) => s.channelId === DM.id).length, 1);
    assert.equal(hub.sends.some((s) => /couldn't put together a reply/.test(s.text)), false);
  });
}

test("harness show, status and the MCP server all point at the inbox", async (t) => {
  const hub = await fakeHub();
  const agent = freshAgent("published");
  t.after(() => { agent.cleanup(); hub.server.close(); });
  const reg = await agent.run("register", "--hub", hub.url, "--org", "org-1", "--name", "Rex", "--type", "research");
  assert.equal(reg.code, 0, reg.stderr);

  const status = await agent.run("status");
  assert.match(status.stdout, /Replies:\s+you — 0 waiting in `inbox`, check every 15m/);

  const harness = await agent.run("harness", "show");
  assert.match(harness.stdout, /Messages: you answer them yourself — the daemon does not\./);
  assert.match(harness.stdout, /Keep a recurring check \(every 15m\): node \S+ inbox/);

  const mcp = await new Promise((resolve) => {
    const child = execFile(process.execPath, [agent.script, "mcp"], { env: { ...process.env, HOME: join(dirname(dirname(agent.script)), "home") } });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.split("\n").filter(Boolean).length >= 2) { child.kill(); resolve(out); }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  });
  const [init, list] = mcp.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.match(init.result.instructions, /recurring check \(e\.g\. every 15 minutes\) that calls guild_inbox/);
  assert.ok(list.result.tools.some((tool) => tool.name === "guild_inbox"));
});
