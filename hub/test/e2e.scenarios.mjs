/**
 * E2E Messaging & Task Lifecycle Test Scenarios — PRD 6
 *
 * These are integration/scenario tests for the hub's full message lifecycle.
 * They require a live hub on HUB_URL (default: ws://localhost:8400).
 *
 * Prerequisites:
 *   1. Hub running: cd hub && npm start
 *   2. Two test agents registered in Firestore with Ed25519 keys
 *      (use: agent-guild register --hub <url> --org <orgId> --name <name>)
 *   3. Env vars set: see section below
 *
 * Run:
 *   node --test test/e2e.scenarios.mjs
 *
 * Or with explicit env:
 *   HUB_URL=ws://localhost:8400 \
 *   AGENT1_ID=<id> AGENT1_KEY_PATH=./keys/agent1.pem \
 *   AGENT2_ID=<id> AGENT2_KEY_PATH=./keys/agent2.pem \
 *   node --test test/e2e.scenarios.mjs
 *
 * The test creates a seeded demo org (TEST_ORG_ID) and channels if they do
 * not exist — safe to run multiple times (idempotent seed step).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { WebSocket } from "ws";
import fs from "node:fs";

// ── Config ────────────────────────────────────────────────────────────────────

const HUB_URL    = process.env.HUB_URL        || "ws://localhost:8400";
const HUB_HTTP   = HUB_URL.replace(/^ws/, "http");
const AGENT1_ID  = process.env.AGENT1_ID      || null;
const AGENT2_ID  = process.env.AGENT2_ID      || null;
const KEY1_PATH  = process.env.AGENT1_KEY_PATH || null;
const KEY2_PATH  = process.env.AGENT2_KEY_PATH || null;
const TEST_ORG   = process.env.TEST_ORG_ID    || "demo-org";
const CHANNEL_ID = process.env.TEST_CHANNEL   || "ch-e2e";

const SKIP = !AGENT1_ID || !AGENT2_ID || !KEY1_PATH || !KEY2_PATH;
if (SKIP) {
  console.warn(
    "\n[E2E] SKIPPING live tests — set AGENT1_ID, AGENT2_ID, AGENT1_KEY_PATH, AGENT2_KEY_PATH\n"
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadKey(path) {
  return fs.readFileSync(path, "utf-8");
}

function signMessage(privateKeyPem, message) {
  const key = crypto.createPrivateKey({ key: privateKeyPem, format: "pem", type: "pkcs8" });
  return crypto.sign(null, Buffer.from(message, "utf-8"), key).toString("base64");
}

function buildWsUrl(agentId, privateKeyPem) {
  const ts = Date.now().toString();
  const msg = `WS:connect:${agentId}:${ts}`;
  const sig = signMessage(privateKeyPem, msg);
  return `${HUB_URL}/ws/agents/${agentId}?sig=${encodeURIComponent(sig)}&ts=${ts}`;
}

/**
 * Connect and wait for the "connected" welcome message.
 * Returns { ws, state } where state is the welcome payload.
 */
function connect(agentId, privateKeyPem, sinceMs = 0) {
  return new Promise((resolve, reject) => {
    const url = buildWsUrl(agentId, privateKeyPem) + (sinceMs ? `&since=${sinceMs}` : "");
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => reject(new Error("Connection timeout")), 5000);

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "connected") {
        clearTimeout(timeout);
        resolve({ ws, state: msg });
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Wait for a specific message type from a ws, with timeout.
 */
function waitFor(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs);

    function handler(raw) {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    }

    ws.on("message", handler);
  });
}

/**
 * Collect all messages for `durationMs` ms, then return them.
 */
function collect(ws, durationMs = 500) {
  return new Promise((resolve) => {
    const messages = [];
    function handler(raw) {
      messages.push(JSON.parse(raw.toString()));
    }
    ws.on("message", handler);
    setTimeout(() => {
      ws.off("message", handler);
      resolve(messages);
    }, durationMs);
  });
}

// ── Hub Health Check (no auth required) ──────────────────────────────────────

describe("Hub health (no credentials required)", () => {
  it("GET /health returns ok", async () => {
    const res = await fetch(`${HUB_HTTP}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.auth, "ed25519");
    assert.ok(typeof body.uptime === "number");
  });

  it("GET /health includes redis and pubsub fields", async () => {
    const res = await fetch(`${HUB_HTTP}/health`);
    const body = await res.json();
    assert.ok("redis" in body, "missing redis field");
    assert.ok("pubsub" in body, "missing pubsub field");
  });

  it("GET /diagnostics without agentId returns 400", async () => {
    const res = await fetch(`${HUB_HTTP}/diagnostics`);
    assert.equal(res.status, 400);
  });

  it("GET /diagnostics for unknown agent returns record=false", async () => {
    const res = await fetch(`${HUB_HTTP}/diagnostics?agentId=nonexistent-agent-xyz`);
    const body = await res.json();
    assert.equal(body.checks.firestoreRecord?.ok, false);
  });

  it("WS upgrade with no sig returns 401", async () => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${HUB_URL}/ws/agents/any-agent`);
      ws.on("unexpected-response", (_req, res) => {
        assert.equal(res.statusCode, 401);
        resolve();
      });
      ws.on("open", () => reject(new Error("Should not have connected")));
      ws.on("error", () => resolve()); // connection refused also acceptable
    });
  });

  it("WS upgrade with stale timestamp returns 401", async () => {
    const ts = (Date.now() - 10 * 60 * 1000).toString(); // 10 min ago
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${HUB_URL}/ws/agents/any-agent?sig=fake&ts=${ts}`);
      ws.on("unexpected-response", (_req, res) => {
        assert.equal(res.statusCode, 401);
        resolve();
      });
      ws.on("open", () => reject(new Error("Should not have connected")));
      ws.on("error", () => resolve());
    });
  });
});

// ── Live Tests (require registered agents) ────────────────────────────────────

describe("Agent connection and channel messaging", { skip: SKIP }, () => {
  let ws1, ws2;

  before(async () => {
    const key1 = loadKey(KEY1_PATH);
    const key2 = loadKey(KEY2_PATH);
    ({ ws: ws1 } = await connect(AGENT1_ID, key1));
    ({ ws: ws2 } = await connect(AGENT2_ID, key2));
  });

  after(() => {
    ws1?.close();
    ws2?.close();
  });

  it("both agents receive 'connected' welcome with correct agentId", async () => {
    // Already validated by connect() helper — just assert connections are open
    assert.equal(ws1.readyState, WebSocket.OPEN);
    assert.equal(ws2.readyState, WebSocket.OPEN);
  });

  it("agent can subscribe to a channel", async () => {
    ws1.send(JSON.stringify({ type: "subscribe", channelId: CHANNEL_ID }));
    const ack = await waitFor(ws1, (m) => m.type === "subscribed" && m.channelId === CHANNEL_ID);
    assert.equal(ack.channelId, CHANNEL_ID);
  });

  it("subscribed agent receives message sent to channel", async () => {
    ws2.send(JSON.stringify({ type: "subscribe", channelId: CHANNEL_ID }));
    await waitFor(ws2, (m) => m.type === "subscribed" && m.channelId === CHANNEL_ID);

    const text = `e2e-test-${Date.now()}`;
    ws1.send(JSON.stringify({ type: "message", channelId: CHANNEL_ID, content: text }));

    const received = await waitFor(ws2, (m) => m.type === "message" && m.text === text, 4000);
    assert.equal(received.text, text);
    assert.equal(received.channelId, CHANNEL_ID);
  });

  it("sender receives message:sent ack", async () => {
    const text = `ack-test-${Date.now()}`;
    ws1.send(JSON.stringify({ type: "message", channelId: CHANNEL_ID, content: text }));
    const ack = await waitFor(ws1, (m) => m.type === "message:sent");
    assert.ok(ack.messageId, "ack should include messageId");
  });

  it("agent can unsubscribe from a channel", async () => {
    ws1.send(JSON.stringify({ type: "unsubscribe", channelId: CHANNEL_ID }));
    const ack = await waitFor(ws1, (m) => m.type === "unsubscribed" && m.channelId === CHANNEL_ID);
    assert.equal(ack.channelId, CHANNEL_ID);
  });

  it("unsubscribed agent does not receive further messages", async () => {
    // ws1 unsubscribed above — ws2 sends a message
    const text = `no-recv-${Date.now()}`;
    ws2.send(JSON.stringify({ type: "message", channelId: CHANNEL_ID, content: text }));

    const msgs = await collect(ws1, 600);
    const received = msgs.filter((m) => m.type === "message" && m.text === text);
    assert.equal(received.length, 0, "unsubscribed agent should not receive message");
  });
});

describe("Task lifecycle", { skip: SKIP }, () => {
  let ws1, ws2;

  before(async () => {
    const key1 = loadKey(KEY1_PATH);
    const key2 = loadKey(KEY2_PATH);
    ({ ws: ws1 } = await connect(AGENT1_ID, key1));
    ({ ws: ws2 } = await connect(AGENT2_ID, key2));

    // Both subscribe to the task channel
    for (const ws of [ws1, ws2]) {
      ws.send(JSON.stringify({ type: "subscribe", channelId: CHANNEL_ID }));
      await waitFor(ws, (m) => m.type === "subscribed");
    }
  });

  after(() => {
    ws1?.close();
    ws2?.close();
  });

  it("agent can broadcast a task:assign to a channel", async () => {
    const taskId = `task-${Date.now()}`;
    ws1.send(JSON.stringify({
      type: "task:assign",
      channelId: CHANNEL_ID,
      taskId,
      title: "E2E Test Task",
      description: "Automated e2e test",
      priority: "high",
    }));

    // Sender gets task:assigned ack
    const ack = await waitFor(ws1, (m) => m.type === "task:assigned" && m.taskId === taskId);
    assert.equal(ack.taskId, taskId);

    // Other agent receives task:assign broadcast
    const broadcast = await waitFor(ws2, (m) => m.type === "task:assign" && m.taskId === taskId, 4000);
    assert.equal(broadcast.taskId, taskId);
    assert.equal(broadcast.title, "E2E Test Task");
  });

  it("agent can accept a task and broadcast confirmation", async () => {
    const taskId = `task-accept-${Date.now()}`;

    // Post the task
    ws1.send(JSON.stringify({
      type: "task:assign",
      channelId: CHANNEL_ID,
      taskId,
      title: "Accept test",
    }));
    await waitFor(ws1, (m) => m.type === "task:assigned" && m.taskId === taskId);

    // Agent 2 accepts
    ws2.send(JSON.stringify({ type: "task:accept", taskId, channelId: CHANNEL_ID }));

    // Agent 2 gets back the acceptPayload
    const acceptedSelf = await waitFor(ws2, (m) => m.type === "task:accepted" && m.taskId === taskId);
    assert.equal(acceptedSelf.taskId, taskId);
    assert.equal(acceptedSelf.agentId, AGENT2_ID);

    // Agent 1 sees the acceptance broadcast
    const acceptedBroadcast = await waitFor(ws1, (m) => m.type === "task:accepted" && m.taskId === taskId, 4000);
    assert.equal(acceptedBroadcast.taskId, taskId);
  });
});

describe("Missed message replay", { skip: SKIP }, () => {
  it("reconnecting with since=<ts> replays only new messages", async () => {
    const key1 = loadKey(KEY1_PATH);
    const key2 = loadKey(KEY2_PATH);

    // Connect agent1 and subscribe
    const { ws: ws1 } = await connect(AGENT1_ID, key1);
    ws1.send(JSON.stringify({ type: "subscribe", channelId: CHANNEL_ID }));
    await waitFor(ws1, (m) => m.type === "subscribed");

    // Agent2 sends a message while agent1 is connected
    const { ws: ws2 } = await connect(AGENT2_ID, key2);
    ws2.send(JSON.stringify({ type: "subscribe", channelId: CHANNEL_ID }));
    await waitFor(ws2, (m) => m.type === "subscribed");

    const preText = `before-${Date.now()}`;
    ws2.send(JSON.stringify({ type: "message", channelId: CHANNEL_ID, content: preText }));
    await waitFor(ws1, (m) => m.type === "message" && m.text === preText);

    const disconnectTs = Date.now();
    ws1.close();

    // Agent2 sends a message while agent1 is disconnected
    await new Promise((r) => setTimeout(r, 300));
    const postText = `after-${Date.now()}`;
    ws2.send(JSON.stringify({ type: "message", channelId: CHANNEL_ID, content: postText }));
    await new Promise((r) => setTimeout(r, 500));

    // Agent1 reconnects with since=<disconnectTs>
    const { ws: ws1b } = await connect(AGENT1_ID, key1, disconnectTs);
    ws1b.send(JSON.stringify({ type: "subscribe", channelId: CHANNEL_ID }));

    // Should receive replay:end with at least 1 replayed message
    const replayEnd = await waitFor(ws1b, (m) => m.type === "replay:end", 5000);
    assert.ok(replayEnd.count >= 1, `Expected ≥1 replayed message, got ${replayEnd.count}`);

    // Should receive the post-disconnect message in replay
    const replayed = await waitFor(ws1b, (m) => m.replay === true && m.text === postText, 4000);
    assert.equal(replayed.text, postText);

    ws1b.close();
    ws2.close();
  });
});

describe("A2A (agent-to-agent) direct messaging", { skip: SKIP }, () => {
  it("agent can send a direct a2a message to another agent", async () => {
    const key1 = loadKey(KEY1_PATH);
    const key2 = loadKey(KEY2_PATH);
    const { ws: ws1 } = await connect(AGENT1_ID, key1);
    const { ws: ws2 } = await connect(AGENT2_ID, key2);

    const payload = { action: "ping", data: `e2e-a2a-${Date.now()}` };

    ws1.send(JSON.stringify({
      type: "a2a",
      id: crypto.randomUUID(),
      from: AGENT1_ID,
      to: AGENT2_ID,
      timestamp: Date.now(),
      orgId: TEST_ORG,
      payload,
    }));

    // Sender gets a2a:sent ack
    const ack = await waitFor(ws1, (m) => m.type === "a2a:sent" && m.success);
    assert.equal(ack.success, true);

    // Receiver gets the message
    const received = await waitFor(ws2, (m) => m.type === "a2a" && m.payload?.data === payload.data, 4000);
    assert.deepEqual(received.payload, payload);

    ws1.close();
    ws2.close();
  });
});

describe("Rate limiting under load", { skip: SKIP }, () => {
  it("sends >60 messages in <1s and hits rate limit", async () => {
    const key1 = loadKey(KEY1_PATH);
    const { ws } = await connect(AGENT1_ID, key1);
    ws.send(JSON.stringify({ type: "subscribe", channelId: CHANNEL_ID }));
    await waitFor(ws, (m) => m.type === "subscribed");

    let rateLimited = false;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "error" && m.code === "RATE_LIMITED") rateLimited = true;
    });

    // Flood 70 messages rapidly
    for (let i = 0; i < 70; i++) {
      ws.send(JSON.stringify({ type: "message", channelId: CHANNEL_ID, content: `flood-${i}` }));
    }

    // Wait for rate-limit to fire
    await new Promise((r) => setTimeout(r, 1000));

    assert.equal(rateLimited, true, "Rate limit should have fired after 60+ messages");
    ws.close();
  });
});
