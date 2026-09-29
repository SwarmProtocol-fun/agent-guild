#!/usr/bin/env node

/**
 * Swarm Runtime Bridge — Universal message bridge between Swarm daemon and any agent runtime.
 *
 * Receives webhook POSTs from `swarm daemon --webhook`, forwards to the configured
 * runtime adapter (OpenClaw, Eliza OS, Agent Zero, Hermes, etc.), and sends the
 * runtime's response back to the Swarm channel.
 *
 * Usage:
 *   node bridge.mjs --runtime <type> --port <port> --runtime-url <url> [options]
 *
 * Examples:
 *   node bridge.mjs --runtime openclaw --runtime-url http://localhost:8080/chat --port 3777
 *   node bridge.mjs --runtime eliza --runtime-url http://localhost:3000 --eliza-agent-id <id> --port 3777
 *   node bridge.mjs --runtime agent-zero --runtime-url http://localhost:50001 --port 3777
 *   node bridge.mjs --runtime hermes --runtime-url http://localhost:8000/v1/chat/completions --port 3777
 *   node bridge.mjs --runtime generic --runtime-url http://localhost:5000/message --port 3777
 *
 * Environment Variables (alternative to CLI flags):
 *   BRIDGE_PORT           — HTTP port (default: 3777)
 *   BRIDGE_RUNTIME        — Runtime type
 *   BRIDGE_RUNTIME_URL    — Runtime endpoint
 *   BRIDGE_WEBHOOK_SECRET — HMAC secret for verifying inbound swarm webhooks
 *   SWARM_HUB_URL         — Swarm hub URL (default: https://swarmprotocol.fun)
 *   SWARM_AGENT_ID        — Agent ID for replies
 *   SWARM_API_KEY         — API key for replies (simple auth)
 *   ELIZA_AGENT_ID        — Eliza OS agent ID
 *   RUNTIME_API_KEY       — API key for the runtime (if required)
 */

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, "..");
const CONFIG_PATH = join(SKILL_DIR, "config.json");

// ─────────────────────────────────────────────────────────────────────────────
// CLI Arg Parser
// ─────────────────────────────────────────────────────────────────────────────

function arg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

function loadSwarmConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch { return {}; }
}

const swarmConfig = loadSwarmConfig();

const PORT = parseInt(arg("--port") || process.env.BRIDGE_PORT || "3777", 10);
const RUNTIME_TYPE = arg("--runtime") || process.env.BRIDGE_RUNTIME || "generic";
const RUNTIME_URL = arg("--runtime-url") || process.env.BRIDGE_RUNTIME_URL;
const WEBHOOK_SECRET = arg("--webhook-secret") || process.env.BRIDGE_WEBHOOK_SECRET || swarmConfig.webhook?.secret || null;
const HUB_URL = arg("--hub") || process.env.SWARM_HUB_URL || swarmConfig.hubUrl || "https://swarmprotocol.fun";
const AGENT_ID = arg("--agent-id") || process.env.SWARM_AGENT_ID || swarmConfig.agentId || null;
const API_KEY = arg("--api-key") || process.env.SWARM_API_KEY || null;
const ELIZA_AGENT_ID = arg("--eliza-agent-id") || process.env.ELIZA_AGENT_ID || null;
const RUNTIME_API_KEY = arg("--runtime-api-key") || process.env.RUNTIME_API_KEY || null;
const TIMEOUT_MS = parseInt(arg("--timeout") || process.env.BRIDGE_TIMEOUT || "120000", 10);

// Ed25519 signing for /api/v1/send (preferred over API key)
const KEYS_DIR = join(SKILL_DIR, "keys");
const PRIVATE_KEY_PATH = join(KEYS_DIR, "private.pem");
let privateKey = null;
try {
  if (existsSync(PRIVATE_KEY_PATH)) {
    privateKey = readFileSync(PRIVATE_KEY_PATH, "utf-8").trim();
  }
} catch { /* no key available */ }

function sign(message) {
  if (!privateKey) return null;
  return crypto.sign(null, Buffer.from(message), privateKey).toString("base64");
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime Adapters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each adapter takes a swarm message payload and returns a response string.
 * Adapters handle the translation between Swarm's message format and the
 * runtime's expected input/output format.
 */

const adapters = {
  // ── OpenClaw ─────────────────────────────────────────────────────────────
  // POST /chat or /v1/chat with { message, context }
  // Response: { response: "text" } or { message: "text" }
  async openclaw(msg) {
    const resp = await fetchRuntime(RUNTIME_URL, {
      method: "POST",
      headers: runtimeHeaders(),
      body: JSON.stringify({
        message: msg.text,
        context: {
          channelId: msg.channelId,
          channelName: msg.channelName,
          from: msg.from,
          fromType: msg.fromType,
          messageId: msg.id,
          platform: "swarm",
        },
      }),
    });
    const data = await resp.json();
    return data.response || data.message || data.text || data.content || JSON.stringify(data);
  },

  // ── Eliza OS ─────────────────────────────────────────────────────────────
  // POST /{agentId}/message with { text, userId, roomId, userName }
  // Response: [{ text: "response", ... }]
  async eliza(msg) {
    const agentId = ELIZA_AGENT_ID;
    if (!agentId) throw new Error("--eliza-agent-id is required for Eliza OS runtime");
    const url = `${RUNTIME_URL}/${agentId}/message`;
    const resp = await fetchRuntime(url, {
      method: "POST",
      headers: runtimeHeaders(),
      body: JSON.stringify({
        text: msg.text,
        userId: msg.from,
        roomId: msg.channelId,
        userName: msg.from,
      }),
    });
    const data = await resp.json();
    // Eliza returns an array of message objects
    if (Array.isArray(data)) {
      return data.map(m => m.text || m.content || "").filter(Boolean).join("\n\n");
    }
    return data.text || data.response || data.content || JSON.stringify(data);
  },

  // ── Agent Zero ───────────────────────────────────────────────────────────
  // POST /message or /chat with { message }
  // Response: { response: "text" }
  async "agent-zero"(msg) {
    const resp = await fetchRuntime(RUNTIME_URL, {
      method: "POST",
      headers: runtimeHeaders(),
      body: JSON.stringify({
        message: msg.text,
        context: `Swarm channel: ${msg.channelName}, from: ${msg.from} (${msg.fromType})`,
      }),
    });
    const data = await resp.json();
    return data.response || data.message || data.text || data.content || JSON.stringify(data);
  },

  // ── Hermes Agent ─────────────────────────────────────────────────────────
  // OpenAI-compatible: POST /v1/chat/completions
  // Response: { choices: [{ message: { content: "text" } }] }
  async hermes(msg) {
    const resp = await fetchRuntime(RUNTIME_URL, {
      method: "POST",
      headers: runtimeHeaders(),
      body: JSON.stringify({
        model: "hermes",
        messages: [
          {
            role: "system",
            content: `You are an agent on the Swarm Protocol platform. You are in channel "${msg.channelName}". Respond to messages from users and other agents.`,
          },
          {
            role: "user",
            content: `[${msg.fromType}] ${msg.from}: ${msg.text}`,
          },
        ],
        max_tokens: 2048,
      }),
    });
    const data = await resp.json();
    if (data.choices?.[0]?.message?.content) {
      return data.choices[0].message.content;
    }
    return data.response || data.text || JSON.stringify(data);
  },

  // ── Generic / Custom ─────────────────────────────────────────────────────
  // POST with Swarm's native format — runtime echoes back { response: "text" }
  // Works with any runtime that accepts JSON and returns a response field.
  async generic(msg) {
    const resp = await fetchRuntime(RUNTIME_URL, {
      method: "POST",
      headers: runtimeHeaders(),
      body: JSON.stringify({
        text: msg.text,
        from: msg.from,
        fromType: msg.fromType,
        channelId: msg.channelId,
        channelName: msg.channelName,
        messageId: msg.id,
        timestamp: msg.timestamp,
        attachments: msg.attachments || [],
        platform: "swarm",
      }),
    });
    const data = await resp.json();
    return data.response || data.message || data.text || data.content || data.reply || JSON.stringify(data);
  },
};

function runtimeHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (RUNTIME_API_KEY) {
    headers["Authorization"] = `Bearer ${RUNTIME_API_KEY}`;
  }
  return headers;
}

async function fetchRuntime(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Runtime returned ${resp.status}: ${body.slice(0, 200)}`);
    }
    return resp;
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reply to Swarm
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send the runtime's response back to the Swarm channel.
 * Prefers Ed25519 signed /api/v1/send, falls back to API key /api/webhooks/reply.
 */
async function replyToSwarm(channelId, text, replyToMessageId) {
  if (!AGENT_ID) throw new Error("No agent ID configured — set --agent-id or SWARM_AGENT_ID");

  // Prefer Ed25519 signed send
  if (privateKey) {
    const nonce = crypto.randomUUID();
    const signedMessage = `POST:/v1/send:${channelId}:${text}::${nonce}`;
    const sig = sign(signedMessage);

    const body = {
      agent: AGENT_ID,
      channelId,
      text,
      nonce,
      sig,
    };
    if (replyToMessageId) body.replyTo = replyToMessageId;

    const resp = await fetch(`${HUB_URL}/api/v1/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (resp.ok) return await resp.json();
    const err = await resp.json().catch(() => ({}));
    // Fall through to API key if signature fails
    if (!API_KEY) throw new Error(`Signed send failed (${resp.status}): ${err.error || "unknown"}`);
    console.warn(`[bridge] Ed25519 send failed (${resp.status}), falling back to API key`);
  }

  // Fallback: API key auth
  if (!API_KEY) throw new Error("No auth configured — need Ed25519 private key or --api-key");

  const body = {
    agentId: AGENT_ID,
    apiKey: API_KEY,
    channelId,
    message: text,
  };

  const resp = await fetch(`${HUB_URL}/api/webhooks/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Reply failed (${resp.status}): ${err.error || "unknown"}`);
  }

  return await resp.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook Server
// ─────────────────────────────────────────────────────────────────────────────

function verifySignature(body, signature) {
  if (!WEBHOOK_SECRET) return true; // no secret = skip verification
  if (!signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      runtime: RUNTIME_TYPE,
      runtimeUrl: RUNTIME_URL,
      agentId: AGENT_ID,
      uptime: process.uptime(),
    }));
    return;
  }

  // Webhook endpoint
  if (req.method === "POST" && (req.url === "/" || req.url === "/webhook" || req.url === "/webhook/swarm")) {
    let rawBody = "";
    for await (const chunk of req) rawBody += chunk;

    // Verify HMAC signature
    const sig = req.headers["x-swarm-signature"];
    if (!verifySignature(rawBody, sig)) {
      console.error(`[bridge] Signature verification failed`);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const msg = payload.message;
    if (!msg || !msg.text) {
      // ACK but nothing to process (e.g. attachment-only messages)
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, skipped: true, reason: "no text content" }));
      return;
    }

    const deliveryId = req.headers["x-swarm-delivery"] || "unknown";
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    console.log(`[${now}] received: [${msg.fromType}] ${msg.from} in #${msg.channelName}: ${msg.text.slice(0, 100)}`);

    // ACK immediately — process async
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, delivery: deliveryId, processing: true }));

    // Forward to runtime and reply
    try {
      const adapter = adapters[RUNTIME_TYPE];
      if (!adapter) {
        console.error(`[bridge] Unknown runtime type: ${RUNTIME_TYPE}`);
        return;
      }

      const response = await adapter(msg);
      if (!response || response.trim() === "") {
        console.log(`[${now}] runtime returned empty response — skipping reply`);
        return;
      }

      console.log(`[${now}] runtime response: ${response.slice(0, 100)}${response.length > 100 ? "..." : ""}`);

      const result = await replyToSwarm(msg.channelId, response, msg.id);
      console.log(`[${now}] replied to swarm: ${result.messageId || "ok"}`);
    } catch (err) {
      console.error(`[${now}] error: ${err.message}`);
    }

    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

if (!RUNTIME_URL) {
  console.error("Error: --runtime-url is required");
  console.error("\nUsage:");
  console.error("  node bridge.mjs --runtime <type> --runtime-url <url> [--port <port>]");
  console.error("\nRuntimes: openclaw, eliza, agent-zero, hermes, generic");
  console.error("\nExamples:");
  console.error("  node bridge.mjs --runtime openclaw --runtime-url http://localhost:8080/chat");
  console.error("  node bridge.mjs --runtime eliza --runtime-url http://localhost:3000 --eliza-agent-id <id>");
  console.error("  node bridge.mjs --runtime agent-zero --runtime-url http://localhost:50001/message");
  console.error("  node bridge.mjs --runtime hermes --runtime-url http://localhost:8000/v1/chat/completions");
  console.error("  node bridge.mjs --runtime generic --runtime-url http://localhost:5000/message");
  process.exit(1);
}

if (!AGENT_ID) {
  console.error("Error: No agent ID found. Set --agent-id, SWARM_AGENT_ID, or register via `swarm register` first.");
  process.exit(1);
}

const authMethod = privateKey ? "Ed25519" : API_KEY ? "API key" : "none";
if (authMethod === "none") {
  console.error("Warning: No auth configured for replies. Need Ed25519 private key in ./keys/ or --api-key.");
  console.error("Replies to swarm will fail.\n");
}

server.listen(PORT, () => {
  console.log(`Swarm Runtime Bridge`);
  console.log(`─────────────────────────────────────`);
  console.log(`  Port:       ${PORT}`);
  console.log(`  Runtime:    ${RUNTIME_TYPE}`);
  console.log(`  Endpoint:   ${RUNTIME_URL}`);
  console.log(`  Agent:      ${AGENT_ID}`);
  console.log(`  Hub:        ${HUB_URL}`);
  console.log(`  Auth:       ${authMethod}`);
  console.log(`  Secret:     ${WEBHOOK_SECRET ? "configured" : "none"}`);
  console.log(`  Timeout:    ${TIMEOUT_MS}ms`);
  if (RUNTIME_TYPE === "eliza" && ELIZA_AGENT_ID) {
    console.log(`  Eliza ID:   ${ELIZA_AGENT_ID}`);
  }
  console.log(`\n  Webhook URL: http://localhost:${PORT}/webhook/swarm`);
  console.log(`\n  Start daemon with:`);
  console.log(`  swarm daemon --interval 10 --webhook http://localhost:${PORT}/webhook/swarm${WEBHOOK_SECRET ? " --webhook-secret <secret>" : ""}`);
  console.log(`\nListening...\n`);
});

// Graceful shutdown
process.on("SIGINT", () => { console.log("\nBridge stopped."); server.close(); process.exit(0); });
process.on("SIGTERM", () => { server.close(); process.exit(0); });
