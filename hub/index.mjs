import "dotenv/config";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import crypto from "crypto";
import {
  initPubSub,
  subscribeToMessages,
  broadcastToChannel as pubsubBroadcastToChannel,
  sendToAgent as pubsubSendToAgent,
  closePubSub,
  isPubSubHealthy,
  isPubSubEnabled,
  INSTANCE_ID,
} from "./pubsub-client.mjs";
import { routeMessage } from "./message-router.mjs";
import {
  initRedis,
  getRedis,
  trackAgentConnection,
  untrackAgentConnection,
  refreshAgentPresence,
  getAgentInstance,
  subscribeChannel as redisSubscribeChannel,
  unsubscribeChannel as redisUnsubscribeChannel,
  unsubscribeAllChannels,
  getChannelSubscribers,
  checkRateLimit as redisCheckRateLimit,
  getInstanceId,
  checkRedisHealth,
  trackGatewayConnection,
  untrackGatewayConnection,
  refreshGatewayPresence,
  getOrgGateways,
  publishJobLogs,
  consumeAuthNonce,
} from "./redis-state.mjs";

// Firebase Admin SDK — server-side Firestore access with service account credentials.
import admin from "firebase-admin";

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * Load and validate a required environment variable.
 * Exits the process with a clear message if missing.
 */
function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[FATAL] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

/**
 * Load an optional env var with a default.
 */
function optionalEnv(name, fallback) {
  return process.env[name] || fallback;
}

const PORT = parseInt(optionalEnv("PORT", "8400"), 10);
const RATE_LIMIT_WINDOW = parseInt(optionalEnv("RATE_LIMIT_WINDOW_MS", "60000"), 10);
const RATE_LIMIT_MAX = parseInt(optionalEnv("RATE_LIMIT_MAX", "60"), 10);
const MAX_CONNECTIONS_PER_AGENT = parseInt(optionalEnv("MAX_CONNECTIONS_PER_AGENT", "5"), 10);
const AUTH_WINDOW_MS = parseInt(optionalEnv("AUTH_WINDOW_MS", String(5 * 60 * 1000)), 10);
const WS_MAX_PAYLOAD_BYTES = parseInt(optionalEnv("WS_MAX_PAYLOAD_BYTES", String(1_000_000)), 10);
const MAX_LOG_LINES_PER_MESSAGE = parseInt(optionalEnv("MAX_LOG_LINES_PER_MESSAGE", "1000"), 10);
// Number of trusted reverse-proxy hops in front of this process (e.g. the
// nginx `load-balancer` service in docker-compose.yml). 0 (default) means
// "not behind a trusted proxy" — X-Forwarded-For is attacker-spoofable and
// ignored, and req.socket.remoteAddress is used as-is. Only raise this when
// the deployment topology actually puts that many trusted proxies in front.
const TRUST_PROXY_HOPS = parseInt(optionalEnv("TRUST_PROXY_HOPS", "0"), 10);

/**
 * Resolve the real client IP, honoring TRUST_PROXY_HOPS trusted proxy hops.
 * Without this, any code behind a reverse proxy (nginx in docker-compose.yml)
 * sees the proxy's own IP for every connection via req.socket.remoteAddress,
 * silently breaking IP-based checks like the Tailscale whitelist below.
 */
function getClientIP(req) {
  const remote = req.socket.remoteAddress || "";
  if (TRUST_PROXY_HOPS <= 0) return remote;
  const xff = req.headers["x-forwarded-for"];
  if (!xff) return remote;
  const chain = xff.split(",").map((s) => s.trim()).filter(Boolean);
  // Each proxy hop appends its own view of the peer IP, so the chain reads
  // client, hop1, hop2, ... nearest-hop. Trusting N hops means taking the
  // Nth entry from the end (the earliest hop we still trust).
  const idx = chain.length - TRUST_PROXY_HOPS;
  return idx >= 0 ? chain[idx] : chain[0];
}

// Multi-region gateway configuration
const HUB_REGION = optionalEnv("HUB_REGION", "us-east");
const HUB_GATEWAY_ID = optionalEnv("HUB_GATEWAY_ID", "");
const GATEWAY_HEARTBEAT_INTERVAL = parseInt(optionalEnv("GATEWAY_HEARTBEAT_INTERVAL_MS", "60000"), 10);

// Firebase Admin — uses service account for server-side auth
const _serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString())
  : undefined;

admin.initializeApp({
  credential: _serviceAccountJson
    ? admin.credential.cert(_serviceAccountJson)
    : admin.credential.applicationDefault(),
});

const db = admin.firestore();

// ── Logging ─────────────────────────────────────────────────────────────────
function log(level, msg, meta = {}) {
  const ts = new Date().toISOString();
  const extra = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}${extra}`);
}

/** Constant-time secret comparison — avoids a timing side channel on the length/content of the guess. */
function safeSecretEqual(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── State ───────────────────────────────────────────────────────────────────
// agentId → Set<ws>
const agentConnections = new Map();
// channelId → Set<ws>
const channelSubscribers = new Map();
// ws → { agentId, orgId, agentName, agentType, channels: Set, unsubs: Function[] }
const wsState = new Map();
// agentId → { timestamps: number[] }
const rateLimits = new Map();

// ── Invoke State ─────────────────────────────────────────────────────────────
// requestId → { resolve, reject, timeout }
const pendingInvocations = new Map();

// ── Gateway State ────────────────────────────────────────────────────────────
// gatewayId → Set<ws>
const gatewayConnections = new Map();
// ws → { gatewayId, orgId, workerName }
const gwState = new Map();
// channel → subscriber count, so the shared `sub` client is only unsubscribed
// once the last gateway listening on that org's job-dispatch channel disconnects
const gatewayChannelRefs = new Map();

// ── Selective WebSocket Batching ────────────────────────────────────────────
// High-frequency event types get batched; status/message events go immediate.

const BATCH_INTERVAL_HF = parseInt(optionalEnv("WS_BATCH_INTERVAL_HF", "250"), 10);   // 250ms for typing/presence
const BATCH_INTERVAL_MF = parseInt(optionalEnv("WS_BATCH_INTERVAL_MF", "150"), 10);    // 150ms for position/vitals

/** Message types that should be batched (high-frequency, loss-tolerant) */
const BATCHED_TYPES = new Set([
  "typing",
  "agent:online",
  "agent:offline",
  "message:ack",
  "vitals",
  "position",
]);

/** Per-ws batch buffer: ws → Map<batchKey, latestMessage> */
const wsBatchBuffers = new Map();

/** Accumulate a message for batched delivery. Latest-wins per key. */
function enqueueBatched(ws, msg) {
  if (!wsBatchBuffers.has(ws)) {
    wsBatchBuffers.set(ws, new Map());
  }
  const buf = wsBatchBuffers.get(ws);
  // Key: type + source identifier (dedupes same-type from same agent)
  const key = `${msg.type}:${msg.agentId || msg.channelId || ""}`;
  buf.set(key, msg);
}

/** Flush all batch buffers to their respective WebSockets */
function flushBatches() {
  for (const [ws, buf] of wsBatchBuffers) {
    if (buf.size === 0) continue;
    if (ws.readyState !== 1) {
      wsBatchBuffers.delete(ws);
      continue;
    }
    // Send as a single "batch" envelope
    const items = Array.from(buf.values());
    ws.send(JSON.stringify({ type: "batch", items, ts: Date.now() }));
    buf.clear();
  }
}

// Flush interval — use the faster of the two intervals
const batchFlushInterval = setInterval(flushBatches, Math.min(BATCH_INTERVAL_HF, BATCH_INTERVAL_MF));

/** Send a message to a ws, using batching for high-freq types */
function sendToWs(ws, msg) {
  if (ws.readyState !== 1) return;
  const msgType = typeof msg === "object" ? msg.type : undefined;
  if (msgType && BATCHED_TYPES.has(msgType)) {
    enqueueBatched(ws, msg);
  } else {
    ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
}

/** Clean up batch buffer when a ws disconnects */
function cleanupBatchBuffer(ws) {
  wsBatchBuffers.delete(ws);
}

// ── Heartbeat ───────────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 30_000; // ping every 30s

setInterval(() => {
  for (const [ws, state] of wsState) {
    if (ws._pongPending) {
      // Previous ping never got a pong — connection is dead
      log("warn", "Heartbeat timeout — terminating connection", { agentId: state.agentId });
      ws.terminate();
      continue;
    }
    ws._pongPending = true;
    // Send ping with request for vitals
    ws.ping(JSON.stringify({ request_vitals: true }));
  }
}, HEARTBEAT_INTERVAL_MS);

// ── Ed25519 Auth ────────────────────────────────────────────────────────────

/**
 * Verify an Ed25519 signature against a PEM public key stored in Firestore.
 * Returns agent data on success, null on failure.
 */
async function verifyEd25519(agentId, message, signatureBase64) {
  if (!agentId || !signatureBase64) return null;

  try {
    const agentSnap = await db.collection("agents").doc(agentId).get();
    if (!agentSnap.exists) return null;

    const data = agentSnap.data();
    const publicKeyPem = data.publicKey;
    if (!publicKeyPem) return null;

    const publicKey = crypto.createPublicKey({
      key: publicKeyPem,
      format: "pem",
      type: "spki",
    });

    const valid = crypto.verify(
      null, // Ed25519 doesn't use a separate hash
      Buffer.from(message, "utf-8"),
      publicKey,
      Buffer.from(signatureBase64, "base64")
    );

    if (!valid) return null;

    return {
      agentId,
      agentName: data.name || agentId,
      orgId: data.orgId || data.organizationId || "",
      agentType: data.type || "agent",
      projectIds: data.projectIds || [],
    };
  } catch (err) {
    log("error", "Ed25519 verify failed", { agentId, error: err.message });
    return null;
  }
}

/**
 * Verify an Ed25519 signature for a gateway worker.
 * Looks up public key from gatewayWorkers collection.
 * Returns gateway data on success, null on failure.
 */
async function verifyGatewayEd25519(gatewayId, message, signatureBase64) {
  if (!gatewayId || !signatureBase64) return null;

  try {
    const gwSnap = await db.collection("gatewayWorkers").doc(gatewayId).get();
    if (!gwSnap.exists) return null;

    const data = gwSnap.data();
    const publicKeyPem = data.publicKey;
    if (!publicKeyPem) return null;

    const publicKey = crypto.createPublicKey({
      key: publicKeyPem,
      format: "pem",
      type: "spki",
    });

    const valid = crypto.verify(
      null,
      Buffer.from(message, "utf-8"),
      publicKey,
      Buffer.from(signatureBase64, "base64")
    );

    if (!valid) return null;

    return {
      gatewayId,
      workerName: data.name || gatewayId,
      orgId: data.orgId || "",
      region: data.region || "",
      capabilities: data.capabilities || {},
    };
  } catch (err) {
    log("error", "Gateway Ed25519 verify failed", { gatewayId, error: err.message });
    return null;
  }
}

/**
 * Check if IP address is whitelisted in Tailscale devices
 */
async function checkTailscaleWhitelist(orgId, ip) {
  if (!orgId || !ip) return false;

  try {
    // Normalize IP (remove ::ffff: prefix if present)
    const normalizedIP = ip.startsWith("::ffff:") ? ip.substring(7) : ip;

    const q = db.collection("tailscaleDevices")
      .where("orgId", "==", orgId)
      .where("status", "==", "active");

    const snapshot = await q.get();

    return snapshot.docs.some((doc) => {
      const device = doc.data();
      return device.tailscaleIp === normalizedIP || device.publicIp === normalizedIP;
    });
  } catch (err) {
    log("error", "Tailscale whitelist check failed", { orgId, ip, error: err.message });
    return false;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function checkRateLimit(agentId) {
  try {
    // Redis-backed rate limiting with in-memory fallback (never fail-open)
    const result = await redisCheckRateLimit(agentId, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
    return result.allowed;
  } catch (err) {
    log("warn", "Rate limit check failed", { agentId, error: err.message });
    return false; // Deny on unexpected errors (defense-in-depth)
  }
}

function broadcastToChannel(channelId, message, excludeWs = null) {
  // Local broadcast to all subscribers on this instance
  const subs = channelSubscribers.get(channelId);
  const msgObj = typeof message === "string" ? JSON.parse(message) : message;

  if (subs) {
    for (const ws of subs) {
      if (ws !== excludeWs) {
        sendToWs(ws, msgObj);
      }
    }
  }

  // Cross-instance broadcast via Pub/Sub (fire-and-forget)
  pubsubBroadcastToChannel(channelId, typeof message === "string" ? JSON.parse(message) : message)
    .catch(err => log("warn", "Pub/Sub broadcast failed", { channelId, error: err.message }));
}

/**
 * Broadcast a message to a specific agent (all their active WebSocket connections).
 * Used for direct notifications like assignment alerts.
 * If agent is not on this instance, routes via Redis pub/sub.
 */
async function broadcastToAgent(agentId, message) {
  const sockets = agentConnections.get(agentId);
  const data = typeof message === "string" ? message : JSON.stringify(message);
  let sent = false;

  // Local broadcast to agent connections on this instance
  if (sockets) {
    for (const ws of sockets) {
      if (ws.readyState === 1) {
        ws.send(data);
        sent = true;
      }
    }
  }

  // Cross-instance delivery via GCP Pub/Sub (at-least-once, ordered per agent).
  // If agent is on another instance, that instance receives and delivers locally.
  // Even if sent locally, we publish to Pub/Sub so that all instances tracking
  // this agent's state stay aware (e.g. for logging, analytics).
  if (!sent) {
    try {
      await pubsubSendToAgent(agentId, typeof message === "string" ? JSON.parse(message) : message);
    } catch (err) {
      log("warn", "Pub/Sub sendToAgent failed", { agentId, error: err.message });

      // Fallback: check Redis for agent instance location and log warning
      try {
        const agentInstance = await getAgentInstance(agentId);
        if (agentInstance && agentInstance !== getInstanceId()) {
          log("warn", "Agent on another instance but Pub/Sub delivery failed", {
            agentId,
            targetInstance: agentInstance,
          });
        }
      } catch {
        // Redis also down — agent message dropped
      }
    }
  }

  return sent;
}

async function subscribeToChannel(ws, channelId) {
  const state = wsState.get(ws);
  if (!state) return;

  // Track locally
  if (!channelSubscribers.has(channelId)) {
    channelSubscribers.set(channelId, new Set());
  }
  channelSubscribers.get(channelId).add(ws);
  state.channels.add(channelId);

  // Track in Redis for distributed state
  try {
    await redisSubscribeChannel(channelId, state.agentId);
  } catch (err) {
    log("warn", "Failed to track channel subscription in Redis", {
      agentId: state.agentId,
      channelId,
      error: err.message,
    });
  }
}

async function unsubscribeFromChannel(ws, channelId) {
  const state = wsState.get(ws);
  if (!state) return;

  // Untrack locally
  const subs = channelSubscribers.get(channelId);
  if (subs) {
    subs.delete(ws);

    // Untrack from Redis
    try {
      await redisUnsubscribeChannel(channelId, state.agentId);
    } catch (err) {
      log("warn", "Failed to untrack channel subscription from Redis", {
        agentId: state.agentId,
        channelId,
        error: err.message,
      });
    }
    if (subs.size === 0) channelSubscribers.delete(channelId);
  }
  state.channels.delete(channelId);
}

/**
 * Verify `channelId` belongs to `orgId` before a legacy WS message handler
 * (subscribe/message/typing/message:ack/task:assign/task:accept) acts on a
 * client-supplied channelId. routeMessage's structured path (a2a/coord/
 * broadcast/session, via message-router.mjs routeBroadcast) already does
 * this check — these older inline handlers predate it and never got the
 * same guard, which let any authenticated agent read or write into another
 * org's channel by supplying its channelId. Fails closed on a lookup error.
 */
async function channelBelongsToOrg(channelId, orgId) {
  try {
    const channelDoc = await db.collection("channels").doc(channelId).get();
    return channelDoc.exists && channelDoc.data().orgId === orgId;
  } catch (err) {
    log("error", "Failed to verify channel ownership", { channelId, orgId, error: err.message });
    return false;
  }
}

/**
 * Handle cross-instance Pub/Sub messages.
 * When another hub instance broadcasts a message, this handler
 * relays it to local WebSocket connections.
 */
function handleCrossInstanceMessage(payload) {
  const { type, channelId, targetAgentId, message } = payload;

  if (type === "broadcast" && channelId) {
    // Relay channel broadcast to local subscribers (without triggering another Pub/Sub publish)
    const subs = channelSubscribers.get(channelId);
    if (!subs || subs.size === 0) return; // No local subscribers

    const data = JSON.stringify(message);
    for (const ws of subs) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }

    log("debug", "Relayed cross-instance channel broadcast", { channelId, sourceInstance: payload.sourceInstance });
  } else if (type === "direct" && targetAgentId) {
    // Relay direct message to local agent connections (without triggering another Pub/Sub publish)
    const sockets = agentConnections.get(targetAgentId);
    if (!sockets || sockets.size === 0) return; // Agent not connected to this instance

    const data = JSON.stringify(message);
    for (const ws of sockets) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }

    log("debug", "Relayed cross-instance agent message", { targetAgentId, sourceInstance: payload.sourceInstance });
  }
}

// ── Auto-capture: agent daily journal ─────────────────────────────────────
// Duplicated (not imported) from AgentGuildApp/src/lib/agent-memory-server.ts's
// appendDailyNote — this is a separate .mjs deploy unit that can't import
// TypeScript. Keep the doc shape (fixed ID, subtype, structuredData) and
// append behavior in sync with that file if either changes.

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function dailyNoteTemplate(date, agentName) {
  const dayName = new Date(date).toLocaleDateString("en-US", { weekday: "long" });
  return `# Daily Note — ${dayName}, ${date}\n## ${agentName}\n\n### Summary\n<!-- What did I accomplish today? -->\n\n### Tasks Completed\n-\n\n### Tasks Started\n-\n\n### Learnings\n<!-- What did I learn today? -->\n\n### Tomorrow's Focus\n<!-- What should I prioritize tomorrow? -->\n\n### Notes\n<!-- Additional observations -->\n\n---\n*Created: ${new Date().toISOString()}*\n`;
}

/** Same append-before-footer logic as memory-templates.ts's appendToMemoryMd. */
function appendToDailyNote(existingContent, newEntry) {
  const entry = `\n#### ${new Date().toISOString()}\n${newEntry}\n`;
  const footerRegex = /---\n\*Created:/;
  if (footerRegex.test(existingContent)) {
    return existingContent.replace(footerRegex, `${entry}\n---\n*Created:`);
  }
  return existingContent + entry;
}

/**
 * Auto-capture: append this agent's own sent-message activity to its daily
 * journal, fire-and-forget, so context accumulates without the agent (or
 * its framework) having to call the memory API itself. Never throws —
 * callers treat this as best-effort.
 */
async function autoCaptureDailyActivity(agentId, agentName, orgId, entry) {
  if (!orgId || !entry) return;
  const date = todayUTC();
  const docId = `${agentId}__daily_${date}`;
  const ref = db.collection("agentMemories").doc(docId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const base = snap.exists ? snap.data().content : dailyNoteTemplate(date, agentName || agentId);
      const content = appendToDailyNote(base, entry);
      tx.set(ref, {
        orgId,
        agentId,
        agentName: agentName || agentId,
        type: "journal",
        title: `Daily Note — ${date}`,
        content,
        subtype: "daily_note",
        structuredData: { date },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(snap.exists ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
      }, { merge: true });
    });
  } catch (err) {
    log("warn", "Auto-capture daily activity failed", { agentId, error: err.message });
  }
}

async function persistMessage(agentId, agentName, orgId, channelId, content) {
  try {
    const ref = await db.collection("messages").add({
      channelId,
      senderId: agentId,
      senderName: agentName || agentId,
      senderType: "agent",
      content,
      orgId,
      verified: true,
      // Caller (index.mjs message handler) already pushes this message live via
      // broadcastToChannel — mark it so streamChannel's onSnapshot listener
      // doesn't deliver a second copy to every other subscriber.
      deliveredViaHub: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Dual-write to agentComms for the Agent Comms dashboard feed
    let channelName = `#${channelId}`;
    try {
      const chSnap = await db.collection("channels").doc(channelId).get();
      if (chSnap.exists) channelName = `#${chSnap.data().name || channelId}`;
    } catch { /* use default */ }

    await db.collection("agentComms").add({
      orgId,
      fromAgentId: agentId,
      fromAgentName: agentName,
      toAgentId: channelId,
      toAgentName: channelName,
      type: "message",
      content,
      metadata: { channelId, messageId: ref.id, verified: true, source: "websocket" },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch((err) => {
      // Log dual-write failure (non-blocking)
      log("warn", "Failed to dual-write to agentComms", {
        channelId,
        messageId: ref.id,
        error: err.message,
      });
    });

    // Auto-capture into the sender's daily journal (non-blocking)
    autoCaptureDailyActivity(agentId, agentName, orgId, `Sent in ${channelName}: ${content}`);

    return ref.id;
  } catch (err) {
    log("error", "Failed to persist message", { channelId, error: err.message });
    return null;
  }
}

// Short-lived cache to avoid a Firestore read on every single inbound WS message.
// A few seconds of staleness on pause/resume is an acceptable tradeoff for the read savings.
const PAUSED_CACHE_TTL_MS = 5000;
const pausedCache = new Map(); // agentId -> { paused, expiresAt }

async function isAgentPaused(agentId) {
  const cached = pausedCache.get(agentId);
  if (cached && cached.expiresAt > Date.now()) return cached.paused;

  try {
    const agentSnap = await db.collection("agents").doc(agentId).get();
    const paused = agentSnap.exists && agentSnap.data().status === "paused";
    pausedCache.set(agentId, { paused, expiresAt: Date.now() + PAUSED_CACHE_TTL_MS });
    return paused;
  } catch (err) {
    log("error", "Failed to check agent pause status", { agentId, error: err.message });
    // Pause exists as an incident-response control, so a transient read
    // error shouldn't silently let a just-paused agent keep operating —
    // but failing every agent closed on any Firestore hiccup is its own
    // availability risk. Split the difference: trust the last known state
    // (even past its TTL) over an uninformed guess, and only fall back to
    // "not paused" when there's truly no prior signal for this agent at all
    // (first contact during an outage — rare, and bounded to one message).
    if (cached) return cached.paused;
    return false; // Fail open — don't block if can't check
  }
}

async function getAgentChannels(agentId) {
  try {
    const agentSnap = await db.collection("agents").doc(agentId).get();
    if (!agentSnap.exists) return [];
    const agentData = agentSnap.data();
    const projectIds = agentData.projectIds || [];
    const orgId = agentData.orgId || agentData.organizationId || "";

    const channels = [];
    const seenIds = new Set();

    // 1. Fetch project-specific channels
    for (let i = 0; i < projectIds.length; i += 10) {
      const batch = projectIds.slice(i, i + 10);
      const channelsQuery = db.collection("channels")
        .where("projectId", "in", batch);
      const snap = await channelsQuery.get();
      for (const d of snap.docs) {
        if (!seenIds.has(d.id)) {
          seenIds.add(d.id);
          channels.push({ id: d.id, name: d.data().name || "Channel", projectId: d.data().projectId });
        }
      }
    }

    // 2. Always include the org-wide "Agent Hub" channel so all agents
    //    in the same org can communicate regardless of project assignment.
    if (orgId) {
      const hubQuery = db.collection("channels")
        .where("orgId", "==", orgId)
        .where("name", "==", "Agent Hub");
      const hubSnap = await hubQuery.get();
      for (const d of hubSnap.docs) {
        if (!seenIds.has(d.id)) {
          seenIds.add(d.id);
          channels.push({ id: d.id, name: "Agent Hub", projectId: "org" });
        }
      }
    }

    return channels;
  } catch (err) {
    log("error", "Failed to fetch agent channels", { agentId, error: err.message });
    return [];
  }
}

// ── Firestore Real-Time Streaming ───────────────────────────────────────────

/**
 * Subscribe to real-time Firestore changes for a channel and push
 * new messages to the WebSocket client.
 */
function streamChannel(ws, channelId, channelName, agentId) {
  const state = wsState.get(ws);
  if (!state) return null;

  const q = db.collection("messages")
    .where("channelId", "==", channelId)
    .orderBy("createdAt", "asc");

  // Track whether we've seen the initial snapshot (skip initial docs)
  let initialLoad = true;

  const unsub = q.onSnapshot((snap) => {
    if (initialLoad) {
      initialLoad = false;
      return; // Skip initial snapshot — replay handles history
    }

    snap.docChanges().forEach((change) => {
      if (change.type === "added") {
        const m = change.doc.data();
        // Don't echo the agent's own messages back
        if (m.senderId === agentId) return;
        // Already delivered live via broadcastToChannel/Pub-Sub by the writer
        // (persistMessage / routeBroadcast) — skip to avoid a duplicate copy.
        // Docs written outside the hub (e.g. AgentGuildApp's /api/v1/send) won't
        // carry this marker and still get delivered here as before.
        if (m.deliveredViaHub) return;

        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: "message",
            channelId,
            channelName,
            messageId: change.doc.id,
            from: m.senderName || m.senderId || "unknown",
            fromType: m.senderType || "user",
            text: m.content || m.text || "",
            ts: m.createdAt?.toMillis?.() || Date.now(),
          }));
        }
      }
    });
  }, (err) => {
    log("error", "onSnapshot error", { channelId, error: err.message });
  });

  // Store unsub so we can clean up on disconnect
  state.unsubs.push(unsub);
  return unsub;
}

/**
 * Replay messages since a given timestamp for a specific channel.
 */
async function replayChannel(ws, channelId, channelName, agentId, sinceMs) {
  try {
    const sinceTs = admin.firestore.Timestamp.fromMillis(sinceMs);
    const q = db.collection("messages")
      .where("channelId", "==", channelId)
      .where("createdAt", ">", sinceTs)
      .orderBy("createdAt", "asc");
    const snap = await q.get();
    let count = 0;

    for (const d of snap.docs) {
      const m = d.data();
      if (m.senderId === agentId) continue; // skip own messages

      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: "message",
          channelId,
          channelName,
          messageId: d.id,
          from: m.senderName || m.senderId || "unknown",
          fromType: m.senderType || "user",
          text: m.content || m.text || "",
          ts: m.createdAt?.toMillis?.() || 0,
          replay: true,
        }));
        count++;
      }
    }
    return count;
  } catch (err) {
    log("error", "Replay failed", { channelId, error: err.message });
    return 0;
  }
}

// ── Express ─────────────────────────────────────────────────────────────────
const app = express();

// Security headers (anti-clickjacking, XSS, MIME sniffing, HTTPS enforcement)
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Security: Lock down CORS to only allow requests from the main app
const ALLOWED_ORIGINS = optionalEnv("ALLOWED_ORIGINS", "https://agent-guild.com,http://localhost:3000")
  .split(",")
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      log("warn", "CORS blocked origin", { origin });
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));

// Security: Limit request body size to prevent DoS attacks (1MB max)
app.use(express.json({ limit: "1mb" }));

// GET /health
app.get("/health", async (_req, res) => {
  let totalConnections = 0;
  for (const conns of agentConnections.values()) totalConnections += conns.size;

  // Check Pub/Sub health (primary cross-instance messaging)
  const pubsubHealth = await isPubSubHealthy();

  // Check Redis health (state store: presence, subscriptions, rate limits)
  const redisHealth = await checkRedisHealth();

  res.json({
    status: "ok",
    auth: "ed25519",
    uptime: process.uptime(),
    agents: agentConnections.size,
    gateways: gatewayConnections.size,
    connections: totalConnections,
    channels: channelSubscribers.size,
    pubsub: typeof pubsubHealth === "object"
      ? pubsubHealth
      : { enabled: !!pubsubHealth, instanceId: INSTANCE_ID },
    redis: {
      healthy: redisHealth.healthy,
      instanceId: getInstanceId(),
      error: redisHealth.error || undefined,
    },
    ts: new Date().toISOString(),
  });
});

/**
 * GET /diagnostics
 *
 * PRD 5 — Hub-side registration diagnostics.
 * Checks whether an agentId is known to the hub and provides actionable
 * messages for common first-run failures.
 *
 * Usage: GET /diagnostics?agentId=<id>
 */
app.get("/diagnostics", async (req, res) => {
  const agentId = req.query.agentId;

  if (!agentId) {
    return res.status(400).json({
      ok: false,
      error: "agentId query param required",
      hint: "GET /diagnostics?agentId=<your-agent-id>",
    });
  }

  // Unauthenticated by design (first-run diagnostics), but still does
  // several Firestore/Redis reads per call — rate-limit by IP (not agentId,
  // which the caller fully controls) so it can't be used as an unbounded
  // agentId-existence/pause-status oracle or Firestore-read amplifier.
  if (!await checkRateLimit(`diag:${getClientIP(req)}`)) {
    return res.status(429).json({ ok: false, error: "Rate limit exceeded" });
  }

  const result = {
    agentId,
    ts: new Date().toISOString(),
    checks: {},
  };

  // 1. ID format
  const validFormat = /^[a-zA-Z0-9_-]{1,128}$/.test(agentId);
  result.checks.idFormat = {
    ok: validFormat,
    detail: validFormat
      ? "ID format is valid"
      : "ID must be 1-128 chars: a-z A-Z 0-9 _ -",
  };

  // 2. Firestore record exists
  let agentData = null;
  try {
    const snap = await db.collection("agents").doc(agentId).get();
    if (snap.exists) {
      agentData = snap.data();
      result.checks.firestoreRecord = { ok: true, detail: "Agent document found in Firestore" };
    } else {
      result.checks.firestoreRecord = {
        ok: false,
        detail: "No agent document found — run `agent-guild register` first",
        hint: "agent-guild register --hub <url> --org <orgId> --name <name>",
      };
    }
  } catch (err) {
    result.checks.firestoreRecord = {
      ok: false,
      detail: `Firestore lookup failed: ${err.message}`,
      hint: "Check FIREBASE_SERVICE_ACCOUNT env var on the hub",
    };
  }

  // 3. Public key present
  if (agentData) {
    const hasKey = !!agentData.publicKey;
    result.checks.publicKey = {
      ok: hasKey,
      detail: hasKey
        ? "Public key is stored in Firestore"
        : "No publicKey field — registration may be incomplete",
      hint: hasKey ? null : "Re-run `agent-guild register` to re-upload your public key",
    };
  }

  // 4. Currently connected
  const connected = agentConnections.has(agentId) && agentConnections.get(agentId).size > 0;
  result.checks.connected = {
    ok: connected,
    detail: connected
      ? `Agent is currently connected (${agentConnections.get(agentId).size} socket(s))`
      : "Agent is not connected to this hub instance",
    hint: connected ? null : "Run `agent-guild daemon` or reconnect via WebSocket",
  };

  // 5. Status (paused / active)
  if (agentData) {
    const status = agentData.status || "active";
    result.checks.status = {
      ok: status !== "paused",
      detail: `Agent status: ${status}`,
      hint: status === "paused"
        ? "Agent is paused — resume from the dashboard or via API before sending messages"
        : null,
    };
  }

  // 6. Redis presence
  try {
    const instance = await getAgentInstance(agentId);
    result.checks.redisPresence = {
      ok: !!instance,
      detail: instance
        ? `Agent tracked in Redis on instance ${instance}`
        : "No Redis presence entry — agent is not actively connected",
    };
  } catch (err) {
    result.checks.redisPresence = {
      ok: false,
      detail: `Redis check failed: ${err.message}`,
      hint: "Check REDIS_URL env var",
    };
  }

  // Overall
  const allOk = Object.values(result.checks).every((c) => c.ok !== false);
  result.ok = allOk;
  result.summary = allOk
    ? "All checks passed — agent is registered and ready"
    : "One or more checks failed — see individual checks for hints";

  res.json(result);
});

// ── POST /agents/:agentId/invoke ──────────────────────────────────────────────
// Synchronous request→response: sends a prompt to a connected agent and waits
// for the agent to reply with { type: "invoke:response", requestId, result }.
// The agent can use any tools available to it to fulfill the prompt.
//
// Auth: Ed25519 signature of "POST:/agents/invoke:{agentId}:{ts}"
//       passed as query params ?sig=<base64>&ts=<epochMs>
//       OR header x-internal-secret matching INTERNAL_SERVICE_SECRET (for same-origin calls)
//
const INVOKE_TIMEOUT_MS = parseInt(optionalEnv("INVOKE_TIMEOUT_MS", "120000"), 10);

app.post("/agents/:agentId/invoke", async (req, res) => {
  const { agentId } = req.params;
  const { prompt, timeout } = req.body || {};

  if (!prompt) {
    return res.status(400).json({ error: "prompt is required" });
  }

  // ── Auth: internal secret OR Ed25519 signature ──
  const internalSecret = process.env.INTERNAL_SERVICE_SECRET;
  const headerSecret = req.headers["x-internal-secret"];

  if (internalSecret && safeSecretEqual(headerSecret, internalSecret)) {
    // Trusted internal call — skip signature verification
  } else {
    const sig = req.query.sig;
    const ts = req.query.ts;
    if (!sig || !ts) {
      return res.status(401).json({ error: "Missing auth — provide sig+ts query params or x-internal-secret header" });
    }
    const tsMs = parseInt(ts, 10);
    if (Math.abs(Date.now() - tsMs) > AUTH_WINDOW_MS) {
      return res.status(401).json({ error: "Timestamp expired" });
    }
    const signedMessage = `POST:/agents/invoke:${agentId}:${ts}`;
    const agentData = await verifyEd25519(agentId, signedMessage, sig);
    if (!agentData) {
      return res.status(401).json({ error: "Invalid signature" });
    }
    // sig+ts travel in the URL query string (visible in proxy/access logs) —
    // make each (agentId, ts) pair single-use so a leaked log line can't be
    // replayed for the rest of the auth window.
    const fresh = await consumeAuthNonce(`invoke:${agentId}`, tsMs, AUTH_WINDOW_MS + 10000);
    if (!fresh) {
      return res.status(401).json({ error: "Signature already used (replay rejected)" });
    }
  }

  // Every other authenticated path (WS messages, gateway WS messages) is
  // rate-limited; this one wasn't — each accepted call holds a
  // `pendingInvocations` entry (with its own timer) for up to
  // INVOKE_TIMEOUT_MS, so an unrated flood grows that map unbounded.
  if (!await checkRateLimit(agentId)) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  }

  // ── Check agent is online ──
  const sockets = agentConnections.get(agentId);
  if (!sockets || sockets.size === 0) {
    return res.status(503).json({ error: "Agent is not connected" });
  }

  const requestId = crypto.randomUUID();
  const effectiveTimeout = Math.min(timeout || INVOKE_TIMEOUT_MS, INVOKE_TIMEOUT_MS);

  // ── Send invoke request to agent ──
  const invokePayload = JSON.stringify({
    type: "invoke",
    requestId,
    prompt,
    ts: Date.now(),
  });

  let sent = false;
  for (const ws of sockets) {
    if (ws.readyState === 1) {
      ws.send(invokePayload);
      sent = true;
      break; // Send to one socket only
    }
  }

  if (!sent) {
    return res.status(503).json({ error: "Agent connected but no healthy socket" });
  }

  // ── Wait for agent response ──
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingInvocations.delete(requestId);
        reject(new Error("Agent did not respond in time"));
      }, effectiveTimeout);

      pendingInvocations.set(requestId, { resolve, reject, timeout: timer });
    });

    res.json({ ok: true, requestId, result });
  } catch (err) {
    res.status(504).json({ error: err.message, requestId });
  }
});

// GET /agents/online (no auth required — public info)
app.get("/agents/online", (_req, res) => {
  const online = [];
  for (const [agentId, conns] of agentConnections) {
    if (conns.size > 0) {
      const first = conns.values().next().value;
      const state = wsState.get(first);
      online.push({
        agentId,
        agentName: state?.agentName || agentId,
        agentType: state?.agentType || "agent",
        connections: conns.size,
      });
    }
  }
  res.json({ agents: online });
});

// ── HTTP + WS Server ────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

/**
 * WebSocket upgrade handler.
 * URL: /ws/agents/{agentId}?sig={base64}&ts={ms}&since={ms}
 * Auth: Ed25519.sign("WS:connect:{agentId}:{ts}")
 */
server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathParts = url.pathname.split("/").filter(Boolean);

  // Expect: /ws/{type}/{id} where type is "agents" or "gateways"
  if (pathParts.length !== 3 || pathParts[0] !== "ws") {
    log("warn", "WS upgrade rejected — invalid path", { path: url.pathname });
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const wsType = pathParts[1]; // "agents" or "gateways"
  const entityId = pathParts[2];

  if (wsType !== "agents" && wsType !== "gateways") {
    log("warn", "WS upgrade rejected — unknown type", { path: url.pathname });
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  // Validate ID format (alphanumeric, hyphens, underscores, max 128 chars)
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(entityId)) {
    log("warn", "WS upgrade rejected — invalid ID format", { entityId, wsType });
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const sig = url.searchParams.get("sig");
  const ts = url.searchParams.get("ts");

  if (!sig || !ts) {
    log("warn", "WS upgrade rejected — missing sig or ts", { entityId, wsType });
    socket.write("HTTP/1.1 401 Unauthorized\r\nX-Agent-Guild-Error: missing-auth-params\r\nX-Agent-Guild-Hint: URL must include ?sig=<base64>&ts=<epoch-ms>\r\n\r\n");
    socket.destroy();
    return;
  }

  // Check timestamp freshness (prevent replay of connection URLs)
  const tsMs = parseInt(ts, 10);
  if (Math.abs(Date.now() - tsMs) > AUTH_WINDOW_MS) {
    log("warn", "WS upgrade rejected — stale timestamp", { entityId, wsType, ageMs: Math.abs(Date.now() - tsMs) });
    socket.write("HTTP/1.1 401 Unauthorized\r\nX-Agent-Guild-Error: stale-timestamp\r\nX-Agent-Guild-Hint: Clock drift detected — ensure system clock is accurate; auth window is " + AUTH_WINDOW_MS + "ms\r\n\r\n");
    socket.destroy();
    return;
  }

  // ── Gateway WebSocket ────────────────────────────────────────────────────
  if (wsType === "gateways") {
    const gatewayId = entityId;
    const signedMessage = `WS:connect:${gatewayId}:${ts}`;
    const gatewayData = await verifyGatewayEd25519(gatewayId, signedMessage, sig);

    if (!gatewayData) {
      log("warn", "WS upgrade rejected — invalid gateway signature", { gatewayId });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // sig+ts travel in the connect URL (visible in proxy/access logs) — make
    // each (gatewayId, ts) pair single-use so a leaked log line can't be
    // replayed to open a second session as this gateway within the window.
    const gwFresh = await consumeAuthNonce(`ws-gw:${gatewayId}`, tsMs, AUTH_WINDOW_MS + 10000);
    if (!gwFresh) {
      log("warn", "WS upgrade rejected — replayed signature", { gatewayId });
      socket.write("HTTP/1.1 401 Unauthorized\r\nX-Agent-Guild-Error: replay-rejected\r\n\r\n");
      socket.destroy();
      return;
    }

    // Check max connections (1 per gateway is typical)
    const existingGw = gatewayConnections.get(gatewayId);
    if (existingGw && existingGw.size >= 2) {
      log("warn", "WS upgrade rejected — gateway max connections", { gatewayId });
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._gatewayData = gatewayData;
      ws._isGateway = true;
      wss.emit("connection", ws, req);
    });
    return;
  }

  // ── Agent WebSocket ──────────────────────────────────────────────────────
  const agentId = entityId;
  const sinceParam = url.searchParams.get("since") || "0";

  // Verify Ed25519 signature: agent signed "WS:connect:{agentId}:{ts}"
  const signedMessage = `WS:connect:${agentId}:${ts}`;
  const agentData = await verifyEd25519(agentId, signedMessage, sig);
  if (!agentData) {
    log("warn", "WS upgrade rejected — invalid signature", { agentId,
      hint: "Verify agent is registered (GET /diagnostics?agentId=<id>) and keys match Firestore" });
    socket.write("HTTP/1.1 401 Unauthorized\r\nX-Agent-Guild-Error: invalid-signature\r\nX-Agent-Guild-Hint: Run GET /diagnostics?agentId=" + agentId + " for diagnosis\r\n\r\n");
    socket.destroy();
    return;
  }

  // sig+ts travel in the connect URL (visible in proxy/access logs) — make
  // each (agentId, ts) pair single-use so a leaked log line can't be
  // replayed to open a second session as this agent within the window.
  const agentFresh = await consumeAuthNonce(`ws-agent:${agentId}`, tsMs, AUTH_WINDOW_MS + 10000);
  if (!agentFresh) {
    log("warn", "WS upgrade rejected — replayed signature", { agentId });
    socket.write("HTTP/1.1 401 Unauthorized\r\nX-Agent-Guild-Error: replay-rejected\r\n\r\n");
    socket.destroy();
    return;
  }

  // Tailscale IP whitelisting (if enabled)
  const TAILSCALE_WHITELIST_MODE = optionalEnv("TAILSCALE_WHITELIST_MODE", "disabled");
  if (TAILSCALE_WHITELIST_MODE !== "disabled") {
    const clientIP = getClientIP(req);
    const isWhitelisted = await checkTailscaleWhitelist(agentData.orgId, clientIP);

    if (!isWhitelisted) {
      if (TAILSCALE_WHITELIST_MODE === "enforce") {
        log("warn", "WS upgrade rejected — IP not whitelisted", { agentId, clientIP });
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      } else if (TAILSCALE_WHITELIST_MODE === "warn") {
        log("warn", "WS connection from non-whitelisted IP", { agentId, clientIP });
      }
    }
  }

  // Check max connections per agent
  const existing = agentConnections.get(agentId);
  if (existing && existing.size >= MAX_CONNECTIONS_PER_AGENT) {
    log("warn", "WS upgrade rejected — max connections", { agentId });
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    socket.destroy();
    return;
  }

  // Authenticated — upgrade to WebSocket
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._agentData = agentData;
    ws._sinceMs = parseInt(sinceParam, 10);
    wss.emit("connection", ws, req);
  });
});

// ── WebSocket Connection Handler ────────────────────────────────────────────

wss.on("connection", async (ws, _req) => {
  // ── Gateway Connection Handler ──────────────────────────────────────────
  if (ws._isGateway) {
    const { gatewayId, orgId, workerName } = ws._gatewayData;
    delete ws._gatewayData;
    delete ws._isGateway;

    // Track connection locally
    if (!gatewayConnections.has(gatewayId)) gatewayConnections.set(gatewayId, new Set());
    gatewayConnections.get(gatewayId).add(ws);
    gwState.set(ws, { gatewayId, orgId, workerName });

    // Track in Redis
    try {
      await trackGatewayConnection(gatewayId, orgId, workerName);
    } catch (err) {
      log("warn", "Failed to track gateway in Redis", { gatewayId, error: err.message });
    }

    log("info", "Gateway connected (Ed25519)", { gatewayId, workerName, orgId });

    // Send welcome
    ws.send(JSON.stringify({ type: "connected", gatewayId, workerName, ts: Date.now() }));

    // Heartbeat pong
    ws._pongPending = false;
    ws.on("pong", async () => {
      ws._pongPending = false;
      try { await refreshGatewayPresence(gatewayId); } catch { /* ignore */ }
    });

    // ── Gateway Message Handler ───────────────────────────────────────────
    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch {
        ws.send(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      // Unlike the agent WS path (checkRateLimit(agentId) above), gateway
      // job:status/job:log handlers had no rate limit at all — a compromised
      // or misbehaving gateway could spam Firestore writes without bound.
      if (!await checkRateLimit(`gw:${gatewayId}`)) {
        ws.send(JSON.stringify({ error: "Rate limit exceeded", type: "error", code: "RATE_LIMITED" }));
        return;
      }

      const { type } = msg;

      // job:status — gateway reports task lifecycle
      if (type === "job:status" && msg.taskId) {
        try {
          const taskRef = db.collection("gatewayTaskQueue").doc(msg.taskId);
          const taskSnap = await taskRef.get();
          if (!taskSnap.exists) {
            ws.send(JSON.stringify({ type: "error", error: "Task not found" }));
            return;
          }
          const task = taskSnap.data();
          if (task.claimedBy !== gatewayId) {
            ws.send(JSON.stringify({ type: "error", error: "Task not claimed by this gateway" }));
            return;
          }

          const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
          if (msg.status === "running") {
            updates.status = "running";
          } else if (msg.status === "completed") {
            updates.status = "completed";
            updates.completedAt = admin.firestore.FieldValue.serverTimestamp();
            if (msg.result !== undefined) updates.result = msg.result;
          } else if (msg.status === "failed") {
            const retriesUsed = (task.retriesUsed || 0) + 1;
            if (retriesUsed < (task.maxRetries || 0)) {
              updates.status = "queued";
              updates.claimedBy = null;
              updates.retriesUsed = retriesUsed;
            } else {
              updates.status = "failed";
              updates.completedAt = admin.firestore.FieldValue.serverTimestamp();
            }
            if (msg.error) updates.error = msg.error;
          }

          await taskRef.update(updates);

          // Decrement active tasks on completion/failure
          if (msg.status === "completed" || msg.status === "failed") {
            try {
              const workerRef = db.collection("gatewayWorkers").doc(gatewayId);
              const workerSnap = await workerRef.get();
              if (workerSnap.exists) {
                const w = workerSnap.data();
                const activeTasks = Math.max(0, (w.resources?.activeTasks || 1) - 1);
                await workerRef.update({
                  "resources.activeTasks": activeTasks,
                  lastHeartbeat: admin.firestore.FieldValue.serverTimestamp(),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
              }
            } catch { /* non-fatal */ }

            // Fire callback if configured
            if (task.callbackUrl) {
              try {
                await fetch(task.callbackUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    taskId: msg.taskId,
                    status: msg.status,
                    result: msg.result,
                    error: msg.error,
                    completedAt: Date.now(),
                  }),
                  signal: AbortSignal.timeout(5000),
                });
              } catch { /* callback failure is non-fatal */ }
            }
          }

          ws.send(JSON.stringify({ type: "job:status:ack", taskId: msg.taskId, status: msg.status, ts: Date.now() }));
          log("info", "Gateway job status", { gatewayId, taskId: msg.taskId, status: msg.status });
        } catch (err) {
          log("error", "Gateway job:status handling failed", { gatewayId, taskId: msg.taskId, error: err.message });
          ws.send(JSON.stringify({ type: "error", error: err.message }));
        }
        return;
      }

      // job:log — gateway streams execution logs
      if (type === "job:log" && msg.taskId && Array.isArray(msg.lines)) {
        // Cap batch size — msg.lines had no size limit before a Firestore
        // write, letting one message balloon storage/cost.
        if (msg.lines.length > MAX_LOG_LINES_PER_MESSAGE) {
          ws.send(JSON.stringify({ type: "error", error: `Too many log lines in one message (max ${MAX_LOG_LINES_PER_MESSAGE})` }));
          return;
        }
        try {
          // Persist to Firestore
          await db.collection("gatewayJobLogs").add({
            taskId: msg.taskId,
            workerId: gatewayId,
            orgId,
            lines: msg.lines,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          });

          // Publish to Redis for live SSE streaming
          try {
            await publishJobLogs(msg.taskId, msg.lines);
          } catch { /* Redis failure is non-fatal */ }

          ws.send(JSON.stringify({ type: "job:log:ack", taskId: msg.taskId, ts: Date.now() }));
        } catch (err) {
          log("error", "Gateway job:log persist failed", { gatewayId, taskId: msg.taskId, error: err.message });
        }
        return;
      }

      // heartbeat — gateway reports system metrics
      if (type === "heartbeat" && msg.resources) {
        try {
          const workerRef = db.collection("gatewayWorkers").doc(gatewayId);
          await workerRef.update({
            resources: msg.resources,
            lastHeartbeat: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: msg.resources.activeTasks > 0 ? "busy" : "idle",
          });
        } catch (err) {
          log("warn", "Gateway heartbeat update failed", { gatewayId, error: err.message });
        }
        return;
      }

      ws.send(JSON.stringify({ error: "Unknown gateway message type", type: "error" }));
    });

    // ── Gateway Disconnect ────────────────────────────────────────────────
    ws.on("close", async () => {
      log("info", "Gateway disconnected", { gatewayId, workerName });
      cleanupBatchBuffer(ws);

      // Remove this connection's job-dispatch listener from the shared Redis
      // subscriber; unsubscribe the channel only once no gateway in this org
      // is still listening on it.
      const gw = gwState.get(ws);
      if (gw?.jobDispatchHandler) {
        try {
          const { sub } = getRedis();
          sub.removeListener("message", gw.jobDispatchHandler);
          const remaining = (gatewayChannelRefs.get(gw.jobDispatchChannel) || 1) - 1;
          if (remaining <= 0) {
            gatewayChannelRefs.delete(gw.jobDispatchChannel);
            await sub.unsubscribe(gw.jobDispatchChannel);
          } else {
            gatewayChannelRefs.set(gw.jobDispatchChannel, remaining);
          }
        } catch (err) {
          log("warn", "Failed to clean up job dispatch subscription", { gatewayId, error: err.message });
        }
      }

      const conns = gatewayConnections.get(gatewayId);
      if (conns) {
        conns.delete(ws);
        if (conns.size === 0) {
          gatewayConnections.delete(gatewayId);
          try { await untrackGatewayConnection(gatewayId); } catch { /* ignore */ }

          // Mark worker as offline
          try {
            const workerRef = db.collection("gatewayWorkers").doc(gatewayId);
            await workerRef.update({ status: "offline", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          } catch { /* ignore */ }
        }
      }
      gwState.delete(ws);
    });

    ws.on("error", (err) => {
      log("error", "Gateway WebSocket error", { gatewayId, error: err.message });
    });

    // ── Subscribe to job dispatch for this org ───────────────────────────
    // Listen for new tasks via Redis and push to gateway
    try {
      const { sub } = getRedis();
      const channel = `gateway:new-task:${orgId}`;
      await sub.subscribe(channel);
      gatewayChannelRefs.set(channel, (gatewayChannelRefs.get(channel) || 0) + 1);

      const jobDispatchHandler = async (ch, message) => {
        if (ch !== channel) return;
        try {
          const { taskId, taskType } = JSON.parse(message);

          // Fetch full task details
          const taskSnap = await db.collection("gatewayTaskQueue").doc(taskId).get();
          if (!taskSnap.exists) return;
          const task = taskSnap.data();
          if (task.status !== "queued") return;

          // Check if this gateway can handle the task type
          const gw = gwState.get(ws);
          if (!gw) return;
          const workerSnap = await db.collection("gatewayWorkers").doc(gatewayId).get();
          if (!workerSnap.exists) return;
          const worker = workerSnap.data();
          if (!worker.capabilities?.taskTypes?.includes(taskType)) return;
          if ((worker.resources?.activeTasks || 0) >= (worker.resources?.maxConcurrent || 4)) return;

          // Push job to gateway
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: "job:dispatch",
              taskId,
              taskType: task.taskType,
              payload: task.payload,
              priority: task.priority,
              timeoutMs: task.timeoutMs || 60000,
              resources: task.resources || {},
              ts: Date.now(),
            }));
            log("info", "Job dispatched to gateway via WS", { gatewayId, taskId });
          }
        } catch (err) {
          log("warn", "Gateway job dispatch failed", { gatewayId, error: err.message });
        }
      };

      sub.on("message", jobDispatchHandler);
      const gw = gwState.get(ws);
      if (gw) { gw.jobDispatchChannel = channel; gw.jobDispatchHandler = jobDispatchHandler; }
    } catch (err) {
      log("warn", "Failed to subscribe to job dispatch channel", { gatewayId, orgId, error: err.message });
    }

    return; // Gateway connection fully handled
  }

  // ── Agent Connection Handler ────────────────────────────────────────────
  const { agentId, orgId, agentName, agentType } = ws._agentData;
  const sinceMs = ws._sinceMs || 0;
  delete ws._agentData;
  delete ws._sinceMs;

  // Track connection locally
  if (!agentConnections.has(agentId)) agentConnections.set(agentId, new Set());
  agentConnections.get(agentId).add(ws);

  const state = { agentId, orgId, agentName, agentType, channels: new Set(), unsubs: [] };
  wsState.set(ws, state);

  // Track connection in Redis for distributed state
  try {
    await trackAgentConnection(agentId, orgId, agentName, agentType);
  } catch (err) {
    log("warn", "Failed to track agent in Redis", { agentId, error: err.message });
  }

  log("info", "Agent connected (Ed25519)", { agentId, agentName });

  // Send welcome message
  ws.send(JSON.stringify({
    type: "connected",
    agentId,
    agentName,
    ts: Date.now(),
  }));

  // Auto-subscribe to agent's project channels
  const channels = await getAgentChannels(agentId);
  let totalReplayed = 0;

  for (const ch of channels) {
    await subscribeToChannel(ws, ch.id);

    // Replay missed messages if since > 0
    if (sinceMs > 0) {
      const count = await replayChannel(ws, ch.id, ch.name, agentId, sinceMs);
      totalReplayed += count;
    }

    // Start real-time Firestore streaming for this channel
    streamChannel(ws, ch.id, ch.name, agentId);

    // Broadcast online status to channel (exclude self)
    broadcastToChannel(ch.id, {
      type: "agent:online",
      agentId,
      agentName,
      ts: Date.now(),
    }, ws);
  }

  // Send replay summary
  if (sinceMs > 0) {
    ws.send(JSON.stringify({
      type: "replay:end",
      count: totalReplayed,
      channels: channels.length,
      ts: Date.now(),
    }));
  }

  // Send channel list
  ws.send(JSON.stringify({
    type: "channels",
    channels: channels.map(c => ({ id: c.id, name: c.name })),
    ts: Date.now(),
  }));

  // ── Heartbeat pong handler ──────────────────────────────────────────────
  ws._pongPending = false;
  ws.on("pong", async (data) => {
    ws._pongPending = false;

    // Refresh agent presence in Redis
    const state = wsState.get(ws);
    if (state) {
      try {
        await refreshAgentPresence(state.agentId);
      } catch (err) {
        // Ignore errors silently to avoid log spam
      }
    }

    // Parse vitals from pong data if provided
    if (data && data.length > 0) {
      try {
        const vitals = JSON.parse(data.toString());

        // SECURITY: Validate vitals schema and types before storing
        const isValidNumber = (val) => typeof val === 'number' && !isNaN(val) && isFinite(val);
        const isValidPercent = (val) => isValidNumber(val) && val >= 0 && val <= 100;

        if (
          isValidPercent(vitals.cpu) &&
          isValidPercent(vitals.memory) &&
          isValidPercent(vitals.disk)
        ) {
          // Sanitize optional fields
          const memoryUsedMB = isValidNumber(vitals.memoryUsedMB) && vitals.memoryUsedMB >= 0 ? vitals.memoryUsedMB : undefined;
          const memoryTotalMB = isValidNumber(vitals.memoryTotalMB) && vitals.memoryTotalMB >= 0 ? vitals.memoryTotalMB : undefined;
          const diskUsedGB = isValidNumber(vitals.diskUsedGB) && vitals.diskUsedGB >= 0 ? vitals.diskUsedGB : undefined;
          const diskTotalGB = isValidNumber(vitals.diskTotalGB) && vitals.diskTotalGB >= 0 ? vitals.diskTotalGB : undefined;

          // Record validated vitals to Firestore
          await db.collection("agentVitals").add({
            orgId,
            agentId,
            agentName,
            vitals: {
              cpu: vitals.cpu,
              memory: vitals.memory,
              disk: vitals.disk,
              memoryUsedMB,
              memoryTotalMB,
              diskUsedGB,
              diskTotalGB,
            },
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      } catch (err) {
        // Ignore vitals parsing errors
      }
    }
  });

  // ── Message Handler ─────────────────────────────────────────────────────

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // Rate limit (checkRateLimit is async — must await or the Promise is always truthy)
    if (!await checkRateLimit(agentId)) {
      ws.send(JSON.stringify({ error: "Rate limit exceeded", type: "error", code: "RATE_LIMITED" }));
      return;
    }

    // Check if agent is paused
    const paused = await isAgentPaused(agentId);
    if (paused) {
      ws.send(JSON.stringify({ error: "Agent is paused", type: "error", code: "AGENT_PAUSED" }));
      return;
    }

    const { type, channelId, content } = msg;

    // ── Structured Agent Messages (a2a, coord, broadcast, session) ──────────
    if (["a2a", "coord", "broadcast", "session"].includes(type)) {
      try {
        // orgId/from/fromName must come from the authenticated connection,
        // never the client-supplied payload — otherwise any agent could tag
        // a message with another org's orgId or impersonate another agent
        // as the sender (routeMessage persists these into Firestore records
        // other orgs' dashboards read).
        msg.orgId = orgId;
        msg.from = agentId;
        msg.fromName = agentName;
        msg.id = msg.id || crypto.randomUUID();
        msg.timestamp = msg.timestamp || Date.now();

        const result = await routeMessage(
          db,
          msg,
          broadcastToAgent,
          broadcastToChannel,
          log
        );

        ws.send(JSON.stringify({
          type: `${type}:sent`,
          messageId: msg.id,
          success: result.success,
          deliveredVia: result.deliveredVia,
          ts: Date.now(),
        }));

        log("info", `Structured message ${type}`, {
          messageId: msg.id,
          from: agentId,
          deliveredVia: result.deliveredVia,
        });

        return;
      } catch (err) {
        ws.send(JSON.stringify({
          type: "error",
          error: `Failed to route ${type} message: ${err.message}`,
          code: "ROUTING_FAILED",
        }));
        log("error", `Structured message routing failed`, {
          type,
          from: agentId,
          error: err.message,
        });
        return;
      }
    }

    // Subscribe/unsubscribe
    if (type === "subscribe" && channelId) {
      if (!await channelBelongsToOrg(channelId, orgId)) {
        ws.send(JSON.stringify({ type: "error", error: "Channel not found in this org", code: "CHANNEL_FORBIDDEN" }));
        return;
      }
      // Idempotent: repeated "subscribe" messages for a channel this
      // connection already streams used to open a brand new Firestore
      // onSnapshot listener every time (only cleaned up on full
      // disconnect) — an authenticated connection re-subscribing
      // repeatedly over its lifetime could pile up unbounded redundant
      // listeners. state.channels already tracks what this ws streams.
      const state = wsState.get(ws);
      const alreadySubscribed = state?.channels.has(channelId);
      await subscribeToChannel(ws, channelId);
      if (!alreadySubscribed) streamChannel(ws, channelId, channelId, agentId);
      log("info", "Subscribed", { agentId, channelId, alreadySubscribed });
      ws.send(JSON.stringify({ type: "subscribed", channelId }));
      return;
    }

    if (type === "unsubscribe" && channelId) {
      await unsubscribeFromChannel(ws, channelId);
      log("info", "Unsubscribed", { agentId, channelId });
      ws.send(JSON.stringify({ type: "unsubscribed", channelId }));
      return;
    }

    // Send message
    if (type === "message" && channelId && content) {
      if (!await channelBelongsToOrg(channelId, orgId)) {
        ws.send(JSON.stringify({ type: "error", error: "Channel not found in this org", code: "CHANNEL_FORBIDDEN" }));
        return;
      }
      const messageId = await persistMessage(agentId, agentName, orgId, channelId, content);

      // Warn if persistence failed
      if (!messageId) {
        log("warn", "Message persistence failed, using fallback ID", { agentId, channelId });
      }

      const outgoing = {
        type: "message",
        channelId,
        messageId: messageId || crypto.randomUUID(),
        from: agentName,
        fromType: "agent",
        text: content,
        ts: Date.now(),
      };

      // Broadcast to other WS clients in the channel (not via onSnapshot — immediate)
      broadcastToChannel(channelId, outgoing, ws);

      // Confirm delivery to sender
      ws.send(JSON.stringify({
        type: "message:sent",
        messageId: outgoing.messageId,
        channelId,
        ts: Date.now(),
      }));

      log("info", "Message sent", { agentId, channelId });
      return;
    }

    // Typing indicator
    if (type === "typing" && channelId) {
      if (!await channelBelongsToOrg(channelId, orgId)) {
        ws.send(JSON.stringify({ type: "error", error: "Channel not found in this org", code: "CHANNEL_FORBIDDEN" }));
        return;
      }
      broadcastToChannel(channelId, {
        type: "typing",
        agentId,
        agentName,
        channelId,
        ts: Date.now(),
      }, ws);
      return;
    }

    // Message acknowledgment — receiver confirms they got a message
    if (type === "message:ack" && msg.messageId) {
      if (channelId && !await channelBelongsToOrg(channelId, orgId)) {
        ws.send(JSON.stringify({ type: "error", error: "Channel not found in this org", code: "CHANNEL_FORBIDDEN" }));
        return;
      }
      broadcastToChannel(channelId || "", {
        type: "message:ack",
        messageId: msg.messageId,
        agentId,
        agentName,
        ts: Date.now(),
      }, ws);
      return;
    }

    // Task broadcast — agent assigns work to others via a channel
    if (type === "task:assign" && channelId) {
      if (!await channelBelongsToOrg(channelId, orgId)) {
        ws.send(JSON.stringify({ type: "error", error: "Channel not found in this org", code: "CHANNEL_FORBIDDEN" }));
        return;
      }
      const taskPayload = {
        type: "task:assign",
        channelId,
        from: agentName,
        fromId: agentId,
        taskId: msg.taskId || crypto.randomUUID(),
        title: msg.title || "",
        description: msg.description || content || "",
        priority: msg.priority || "normal",
        requiredSkills: msg.requiredSkills || [],
        ts: Date.now(),
      };

      // Persist as a message so polling agents also see it
      await persistMessage(agentId, agentName, orgId, channelId,
        `[TASK] ${msg.title || "New task"}: ${msg.description || content || ""}`);

      broadcastToChannel(channelId, taskPayload, ws);

      ws.send(JSON.stringify({
        type: "task:assigned",
        taskId: taskPayload.taskId,
        channelId,
        ts: Date.now(),
      }));

      log("info", "Task broadcast", { agentId, channelId, taskId: taskPayload.taskId });
      return;
    }

    // Task acceptance — agent confirms they're working on a broadcast task
    if (type === "task:accept" && msg.taskId) {
      const acceptPayload = {
        type: "task:accepted",
        taskId: msg.taskId,
        agentId,
        agentName,
        channelId: channelId || "",
        ts: Date.now(),
      };

      if (channelId) {
        if (!await channelBelongsToOrg(channelId, orgId)) {
          ws.send(JSON.stringify({ type: "error", error: "Channel not found in this org", code: "CHANNEL_FORBIDDEN" }));
          return;
        }
        broadcastToChannel(channelId, acceptPayload, ws);
        await persistMessage(agentId, agentName, orgId, channelId,
          `[ACK] ${agentName} accepted task ${msg.taskId}`);
      }

      ws.send(JSON.stringify(acceptPayload));
      log("info", "Task accepted", { agentId, taskId: msg.taskId });
      return;
    }

    // Invoke response — agent returning result for a synchronous invoke request
    if (type === "invoke:response" && msg.requestId) {
      const pending = pendingInvocations.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingInvocations.delete(msg.requestId);
        pending.resolve(msg.result || msg.data || null);
        log("info", "Invoke response received", { agentId, requestId: msg.requestId });
      } else {
        log("warn", "Invoke response for unknown/expired requestId", { agentId, requestId: msg.requestId });
      }
      return;
    }

    // Invoke error — agent failed to process the invoke
    if (type === "invoke:error" && msg.requestId) {
      const pending = pendingInvocations.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingInvocations.delete(msg.requestId);
        pending.reject(new Error(msg.error || "Agent invoke failed"));
        log("warn", "Invoke error received", { agentId, requestId: msg.requestId, error: msg.error });
      }
      return;
    }

    ws.send(JSON.stringify({ error: "Invalid message type or missing fields", type: "error" }));
  });

  // ── Disconnect Handler ──────────────────────────────────────────────────

  ws.on("close", async () => {
    log("info", "Agent disconnected", { agentId, agentName });

    // Clean up batch buffer for this ws
    cleanupBatchBuffer(ws);

    // Clean up Firestore listeners
    for (const unsub of state.unsubs) {
      try { unsub(); } catch { /* ignore */ }
    }
    state.unsubs = [];

    // Broadcast offline to all subscribed channels
    for (const chId of state.channels) {
      broadcastToChannel(chId, {
        type: "agent:offline",
        agentId,
        agentName,
        ts: Date.now(),
      }, ws);
      const subs = channelSubscribers.get(chId);
      if (subs) {
        subs.delete(ws);
        if (subs.size === 0) channelSubscribers.delete(chId);
      }
    }

    // Remove from local agent pool
    const conns = agentConnections.get(agentId);
    if (conns) {
      conns.delete(ws);
      if (conns.size === 0) {
        agentConnections.delete(agentId);

        // Untrack from Redis (only when last connection closes)
        try {
          await untrackAgentConnection(agentId);
          await unsubscribeAllChannels(agentId);
        } catch (err) {
          log("warn", "Failed to untrack agent from Redis", { agentId, error: err.message });
        }
      }
    }
    wsState.delete(ws);
  });

  ws.on("error", (err) => {
    log("error", "WebSocket error", { agentId, error: err.message });
  });
});

// ── Gateway Heartbeat ───────────────────────────────────────────────────────

/**
 * Report gateway metrics to Firestore (if HUB_GATEWAY_ID is configured)
 */
async function reportGatewayHeartbeat() {
  if (!HUB_GATEWAY_ID) {
    return; // Heartbeat disabled (gateway not registered)
  }

  try {
    // Calculate metrics
    const totalAgentConnections = agentConnections.size;
    let activeConnections = 0;
    for (const conns of agentConnections.values()) {
      activeConnections += conns.size;
    }

    // Calculate average latency (simplified - use ping times if available)
    const avgLatencyMs = 50; // Placeholder - would need to track actual ping times

    // Calculate requests per minute (simplified)
    const requestsPerMinute = 0; // Placeholder - would need to track request counts

    // Calculate error rate (simplified)
    const errorRate = 0; // Placeholder - would need to track error counts

    // Get system metrics
    const cpuUsage = process.cpuUsage();
    const memUsage = process.memoryUsage();

    const metrics = {
      activeConnections,
      avgLatencyMs,
      requestsPerMinute,
      errorRate,
      uptime: 99.9, // Placeholder - would track actual uptime
    };

    const capacity = {
      maxConnections: 1000, // Configurable
      cpuUsage: 0, // Would calculate from cpuUsage
      memoryUsage: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100),
    };

    // Update Firestore
    const gatewayRef = db.collection("gateways").doc(HUB_GATEWAY_ID);
    const gatewayDoc = await gatewayRef.get();

    if (gatewayDoc.exists) {
      await gatewayRef.update({
        metrics,
        capacity,
        lastHeartbeat: admin.firestore.FieldValue.serverTimestamp(),
        status: "connected",
        agentsConnected: totalAgentConnections,
      });

      log("debug", "Gateway heartbeat sent", {
        gatewayId: HUB_GATEWAY_ID,
        region: HUB_REGION,
        activeConnections: totalAgentConnections
      });
    }
  } catch (err) {
    log("error", "Gateway heartbeat failed", { error: err.message });
  }
}

// ── Assignment Notification Listener ────────────────────────────────────────
// Watch for new assignment notifications and broadcast them via WebSocket

const notificationsQuery = db.collection("assignmentNotifications")
  .where("read", "==", false)
  .orderBy("createdAt", "desc");

let notificationInitialLoad = true;
notificationsQuery.onSnapshot((snapshot) => {
  // Skip initial load to avoid broadcasting old notifications on startup
  if (notificationInitialLoad) {
    notificationInitialLoad = false;
    return;
  }

  // Process new notifications
  snapshot.docChanges().forEach(async (change) => {
    if (change.type !== "added") return;

    const notification = change.doc.data();
    const { agentId, type, assignmentId, message, channelId } = notification;

    // Build WebSocket message based on notification type
    let wsMessage = {
      type: `assignment:${type.replace("_", ":")}`,
      assignmentId,
      message,
      ts: Date.now(),
    };

    // Add type-specific fields
    if (type === "new_assignment") {
      // Fetch assignment details to include in notification
      try {
        const assignmentRef = db.collection("taskAssignments").doc(assignmentId);
        const assignmentSnap = await assignmentRef.get();
        if (assignmentSnap.exists) {
          const assignment = assignmentSnap.data();
          wsMessage = {
            type: "assignment:new",
            assignmentId,
            from: assignment.fromAgentName || assignment.fromHumanName || "Unknown",
            fromId: assignment.fromAgentId || assignment.fromHumanId,
            title: assignment.title,
            priority: assignment.priority,
            deadline: assignment.deadline?.toDate().toISOString() || null,
            ts: Date.now(),
          };
        }
      } catch (err) {
        log("warn", "Failed to fetch assignment details for notification", { assignmentId, error: err.message });
      }
    }

    // Broadcast to agent via WebSocket
    const sent = broadcastToAgent(agentId, wsMessage);
    if (sent) {
      log("info", "Assignment notification broadcast", { agentId, type, assignmentId });
    }

    // Also post to Agent Hub channel if specified
    if (channelId) {
      broadcastToChannel(channelId, {
        type: "message",
        channelId,
        from: "AgentGuildHub",
        fromType: "system",
        text: message,
        ts: Date.now(),
      });
    }
  });
}, (err) => {
  log("error", "Assignment notification listener error", { error: err.message });
});

log("info", "Assignment notification listener started");

// ── Redis Initialization ────────────────────────────────────────────────────

// Initialize Redis for distributed state management (presence, subscriptions, rate limits).
// Cross-instance messaging is handled by GCP Pub/Sub (at-least-once delivery).
try {
  await initRedis();
  log("info", `Redis initialized — instance: ${getInstanceId()}`);
} catch (err) {
  log("error", "Redis initialization failed — falling back to in-memory state", { error: err.message });
  log("warn", "Multi-instance scaling disabled");
}

// ── Pub/Sub Initialization ─────────────────────────────────────────────────

// Initialize Pub/Sub (primary cross-instance messaging — at-least-once delivery)
const pubsubReady = await initPubSub();
if (pubsubReady) {
  subscribeToMessages(handleCrossInstanceMessage);
  log("info", `Pub/Sub enabled — instance: ${INSTANCE_ID}, at-least-once delivery active`);
} else {
  log("warn", "Pub/Sub disabled — cross-instance messaging unavailable (single-instance mode)");
}

// ── Workflow Tick — Advance running workflows + evaluate cron triggers ──
const TICK_URL = process.env.APP_DOMAIN
  ? `https://${process.env.APP_DOMAIN}/api/internal/tick`
  : null;

if (TICK_URL && process.env.INTERNAL_SERVICE_SECRET) {
  setInterval(async () => {
    try {
      const res = await fetch(TICK_URL, {
        method: "POST",
        headers: { "x-service-secret": process.env.INTERNAL_SERVICE_SECRET },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.workflows?.advanced > 0 || data.cron?.fired > 0) {
          log("info", "Workflow tick", {
            advanced: data.workflows.advanced,
            cronFired: data.cron.fired,
          });
        }
      }
    } catch (err) {
      log("warn", "Workflow tick failed", { error: err.message });
    }
  }, 30_000);
  log("info", "Workflow tick scheduler started (30s interval)", { url: TICK_URL });
}

// Graceful shutdown handler
process.on("SIGTERM", async () => {
  log("info", "SIGTERM received — shutting down gracefully");
  clearInterval(batchFlushInterval);
  flushBatches(); // final flush
  await closePubSub();
  process.exit(0);
});

process.on("SIGINT", async () => {
  log("info", "SIGINT received — shutting down gracefully");
  clearInterval(batchFlushInterval);
  flushBatches(); // final flush
  await closePubSub();
  process.exit(0);
});

// ── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log("info", `Agent Guild Hub (Ed25519) listening on port ${PORT}`);
  log("info", `Region: ${HUB_REGION}`);
  if (HUB_GATEWAY_ID) {
    log("info", `Gateway ID: ${HUB_GATEWAY_ID}`);
  }
  log("info", `Health: http://localhost:${PORT}/health`);
  log("info", `WebSocket (agents):   ws://localhost:${PORT}/ws/agents/{agentId}?sig=...&ts=...`);
  log("info", `WebSocket (gateways): ws://localhost:${PORT}/ws/gateways/{gatewayId}?sig=...&ts=...`);

  // Start gateway heartbeat
  if (HUB_GATEWAY_ID) {
    reportGatewayHeartbeat(); // Initial heartbeat
    setInterval(reportGatewayHeartbeat, GATEWAY_HEARTBEAT_INTERVAL);
    log("info", `Gateway heartbeat enabled (interval: ${GATEWAY_HEARTBEAT_INTERVAL}ms)`);
  }
});
