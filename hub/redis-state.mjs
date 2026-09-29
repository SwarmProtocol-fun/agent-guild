/**
 * Redis-Backed State Management for Multi-Instance WebSocket Hub
 *
 * Replaces in-memory Maps with distributed Redis state using ioredis.
 * Enables horizontal scaling across multiple hub instances.
 */

import Redis from 'ioredis';

const INSTANCE_ID = process.env.INSTANCE_ID || `hub-${process.pid}`;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redisClient = null;
let pubClient = null;
let subClient = null;

/**
 * Initialize Redis connections
 */
export async function initRedis() {
  if (redisClient) return redisClient;

  console.log(`[Redis] Connecting to ${REDIS_URL.replace(/:.+@/, ':***@')}`);

  // Main client for state operations
  redisClient = new Redis(REDIS_URL);
  redisClient.on('error', (err) => console.error('[Redis] Client error:', err));
  redisClient.on('connect', () => console.log(`[Redis] Connected as instance ${INSTANCE_ID}`));

  // Pub/Sub clients (must be separate connections)
  pubClient = new Redis(REDIS_URL);
  subClient = new Redis(REDIS_URL);

  // Cleanup on shutdown
  process.on('SIGINT', async () => {
    await cleanupInstance();
    await redisClient.quit();
    await pubClient.quit();
    await subClient.quit();
  });

  // Register this instance
  await registerInstance();

  return redisClient;
}

/**
 * Get Redis clients
 */
export function getRedis() {
  if (!redisClient) throw new Error('Redis not initialized. Call initRedis() first.');
  return { client: redisClient, pub: pubClient, sub: subClient };
}

/* ────────────────────────────────────────────────────────────────────────
 *  Agent Connections (Presence Tracking)
 * ──────────────────────────────────────────────────────────────────────── */

export async function trackAgentConnection(agentId, orgId, agentName, agentType) {
  const key = `agent:${agentId}:instance`;
  const metadata = JSON.stringify({ orgId, agentName, agentType, connectedAt: Date.now() });

  // Store agent's current instance with 5-minute TTL
  await redisClient.setex(key, 300, INSTANCE_ID);
  await redisClient.setex(`agent:${agentId}:meta`, 300, metadata);
  await redisClient.sadd(`instance:${INSTANCE_ID}:agents`, agentId);

  console.log(`[Redis] Agent ${agentId} connected to ${INSTANCE_ID}`);
}

export async function untrackAgentConnection(agentId) {
  await redisClient.del(`agent:${agentId}:instance`, `agent:${agentId}:meta`);
  await redisClient.srem(`instance:${INSTANCE_ID}:agents`, agentId);
  console.log(`[Redis] Agent ${agentId} disconnected from ${INSTANCE_ID}`);
}

export async function refreshAgentPresence(agentId) {
  await redisClient.expire(`agent:${agentId}:instance`, 300);
  await redisClient.expire(`agent:${agentId}:meta`, 300);
}

export async function getAgentInstance(agentId) {
  return await redisClient.get(`agent:${agentId}:instance`);
}

export async function getInstanceAgents() {
  return await redisClient.smembers(`instance:${INSTANCE_ID}:agents`);
}

export async function getAllOnlineAgents() {
  const keys = await redisClient.keys('agent:*:instance');
  const agents = [];

  for (const key of keys) {
    const agentId = key.split(':')[1];
    const instance = await redisClient.get(key);
    const metaJson = await redisClient.get(`agent:${agentId}:meta`);
    const metadata = metaJson ? JSON.parse(metaJson) : {};
    agents.push({ agentId, instance, ...metadata });
  }

  return agents;
}

/* ────────────────────────────────────────────────────────────────────────
 *  Channel Subscriptions
 * ──────────────────────────────────────────────────────────────────────── */

export async function subscribeChannel(channelId, agentId) {
  await redisClient.sadd(`channel:${channelId}:subscribers`, agentId);
  await redisClient.sadd(`agent:${agentId}:channels`, channelId);
  console.log(`[Redis] Agent ${agentId} subscribed to channel ${channelId}`);
}

export async function unsubscribeChannel(channelId, agentId) {
  await redisClient.srem(`channel:${channelId}:subscribers`, agentId);
  await redisClient.srem(`agent:${agentId}:channels`, channelId);
}

export async function getChannelSubscribers(channelId) {
  return await redisClient.smembers(`channel:${channelId}:subscribers`);
}

export async function getAgentChannels(agentId) {
  return await redisClient.smembers(`agent:${agentId}:channels`);
}

export async function unsubscribeAllChannels(agentId) {
  const channels = await getAgentChannels(agentId);
  for (const channelId of channels) {
    await unsubscribeChannel(channelId, agentId);
  }
}

/* ────────────────────────────────────────────────────────────────────────
 *  Rate Limiting (Sliding Window)
 * ──────────────────────────────────────────────────────────────────────── */

/** In-memory fallback for when Redis is unavailable */
const _memoryLimits = new Map(); // key → { count, windowStart }

function checkRateLimitMemory(key, limit, windowMs) {
  const now = Date.now();
  let entry = _memoryLimits.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    entry = { count: 0, windowStart: now };
  }
  entry.count++;
  _memoryLimits.set(key, entry);

  // Periodically clean stale entries (every 100 checks)
  if (_memoryLimits.size > 1000) {
    for (const [k, v] of _memoryLimits) {
      if (now - v.windowStart > windowMs * 2) _memoryLimits.delete(k);
    }
  }

  const remaining = Math.max(0, limit - entry.count);
  return {
    allowed: entry.count <= limit,
    remaining,
    resetAt: entry.windowStart + windowMs,
  };
}

export async function checkRateLimit(key, limit, windowMs) {
  // Fallback to in-memory if Redis is unavailable
  if (!redisClient) {
    return checkRateLimitMemory(key, limit, windowMs);
  }

  try {
    const now = Date.now();
    const windowStart = now - windowMs;
    const rateLimitKey = `ratelimit:${key}`;

    // Remove expired entries
    await redisClient.zremrangebyscore(rateLimitKey, 0, windowStart);

    // Count current requests
    const count = await redisClient.zcard(rateLimitKey);

    if (count >= limit) {
      const oldest = await redisClient.zrange(rateLimitKey, 0, 0);
      const resetAt = oldest.length > 0 ? parseInt(oldest[0]) + windowMs : now + windowMs;
      return { allowed: false, remaining: 0, resetAt };
    }

    // Add current request
    await redisClient.zadd(rateLimitKey, now, now.toString());
    await redisClient.expire(rateLimitKey, Math.ceil(windowMs / 1000));

    return { allowed: true, remaining: limit - count - 1, resetAt: now + windowMs };
  } catch (err) {
    // Redis error — fall back to in-memory rate limiting (not fail-open)
    console.warn("[Redis] Rate limit check failed, using in-memory fallback:", err.message);
    return checkRateLimitMemory(key, limit, windowMs);
  }
}

export async function resetRateLimit(key) {
  await redisClient.del(`ratelimit:${key}`);
}

/* ────────────────────────────────────────────────────────────────────────
 *  Auth Nonce Consumption (Replay Protection)
 *
 *  Ed25519-authenticated requests sign (message, ts) and are accepted within
 *  a time window (AUTH_WINDOW_MS) rather than requiring a fresh handshake.
 *  A valid (agentId/gatewayId, sig, ts) tuple observed once — e.g. via a
 *  proxy access log, browser history on a query-string endpoint, or network
 *  capture — could otherwise be replayed verbatim for the rest of that
 *  window. This makes each (subjectId, ts) pair single-use: the first use
 *  claims it via SET NX with a TTL past the auth window; any repeat within
 *  that TTL is rejected as a replay.
 * ──────────────────────────────────────────────────────────────────────── */

/** In-memory fallback: key → expiry timestamp (ms) */
const _memoryNonces = new Map();

function consumeNonceMemory(key, ttlMs) {
  const now = Date.now();
  const expiry = _memoryNonces.get(key);
  if (expiry && expiry > now) return false; // already consumed, still within TTL

  _memoryNonces.set(key, now + ttlMs);

  if (_memoryNonces.size > 5000) {
    for (const [k, exp] of _memoryNonces) {
      if (exp <= now) _memoryNonces.delete(k);
    }
  }
  return true;
}

/**
 * Atomically claim a (subjectId, ts) auth nonce.
 * @returns {Promise<boolean>} true if this is the first use (accept), false if already seen (reject as replay)
 */
export async function consumeAuthNonce(subjectId, tsMs, ttlMs) {
  const key = `authnonce:${subjectId}:${tsMs}`;

  if (!redisClient) {
    return consumeNonceMemory(key, ttlMs);
  }

  try {
    // "NX" — only set if not already present; the sig/ts pair becomes the
    // idempotency key, so a genuine retry with a *new* signature still works.
    const result = await redisClient.set(key, "1", "PX", ttlMs, "NX");
    return result === "OK";
  } catch (err) {
    console.warn("[Redis] Nonce consumption check failed, using in-memory fallback:", err.message);
    return consumeNonceMemory(key, ttlMs);
  }
}

/* ────────────────────────────────────────────────────────────────────────
 *  Cross-Instance Messaging (Pub/Sub)
 * ──────────────────────────────────────────────────────────────────────── */

export async function publishToInstances(channel, message) {
  await pubClient.publish(channel, JSON.stringify(message));
}

export async function subscribeToInstances(channel, handler) {
  await subClient.subscribe(channel);
  subClient.on('message', (ch, message) => {
    if (ch === channel) {
      try {
        const parsed = JSON.parse(message);
        handler(parsed);
      } catch (err) {
        console.error('[Redis] Failed to parse pub/sub message:', err);
      }
    }
  });
  console.log(`[Redis] Subscribed to ${channel}`);
}

/* ────────────────────────────────────────────────────────────────────────
 *  Instance Management
 * ──────────────────────────────────────────────────────────────────────── */

export async function registerInstance() {
  const key = `instance:${INSTANCE_ID}:heartbeat`;
  await redisClient.setex(key, 60, Date.now().toString());

  // Periodic heartbeat every 30s
  setInterval(async () => {
    await redisClient.setex(key, 60, Date.now().toString());
  }, 30000);
}

export async function getActiveInstances() {
  const keys = await redisClient.keys('instance:*:heartbeat');
  return keys.map((k) => k.split(':')[1]);
}

export async function cleanupInstance() {
  console.log(`[Redis] Cleaning up instance ${INSTANCE_ID}`);
  const agents = await getInstanceAgents();

  for (const agentId of agents) {
    await untrackAgentConnection(agentId);
    await unsubscribeAllChannels(agentId);
  }

  await redisClient.del(`instance:${INSTANCE_ID}:agents`, `instance:${INSTANCE_ID}:heartbeat`);
}

export function getInstanceId() {
  return INSTANCE_ID;
}

export async function checkRedisHealth() {
  try {
    const pong = await redisClient.ping();
    return { healthy: pong === 'PONG', latency: 0 };
  } catch (err) {
    return { healthy: false, error: err.message };
  }
}

/* ────────────────────────────────────────────────────────────────────────
 *  Gateway Connections (Presence Tracking)
 * ──────────────────────────────────────────────────────────────────────── */

export async function trackGatewayConnection(gatewayId, orgId, workerName) {
  const key = `gateway:${gatewayId}:instance`;
  const metadata = JSON.stringify({ orgId, workerName, connectedAt: Date.now() });

  await redisClient.setex(key, 300, INSTANCE_ID);
  await redisClient.setex(`gateway:${gatewayId}:meta`, 300, metadata);
  await redisClient.sadd(`instance:${INSTANCE_ID}:gateways`, gatewayId);
  await redisClient.sadd(`org:${orgId}:gateways`, gatewayId);

  console.log(`[Redis] Gateway ${gatewayId} connected to ${INSTANCE_ID}`);
}

export async function untrackGatewayConnection(gatewayId) {
  const metaJson = await redisClient.get(`gateway:${gatewayId}:meta`);
  const metadata = metaJson ? JSON.parse(metaJson) : {};

  await redisClient.del(`gateway:${gatewayId}:instance`, `gateway:${gatewayId}:meta`);
  await redisClient.srem(`instance:${INSTANCE_ID}:gateways`, gatewayId);
  if (metadata.orgId) {
    await redisClient.srem(`org:${metadata.orgId}:gateways`, gatewayId);
  }

  console.log(`[Redis] Gateway ${gatewayId} disconnected from ${INSTANCE_ID}`);
}

export async function refreshGatewayPresence(gatewayId) {
  await redisClient.expire(`gateway:${gatewayId}:instance`, 300);
  await redisClient.expire(`gateway:${gatewayId}:meta`, 300);
}

export async function getGatewayInstance(gatewayId) {
  return await redisClient.get(`gateway:${gatewayId}:instance`);
}

export async function getOrgGateways(orgId) {
  return await redisClient.smembers(`org:${orgId}:gateways`);
}

/* ────────────────────────────────────────────────────────────────────────
 *  Gateway Job Log Pub/Sub
 * ──────────────────────────────────────────────────────────────────────── */

export async function publishJobLogs(taskId, lines) {
  await pubClient.publish(`gateway:logs:${taskId}`, JSON.stringify({ taskId, lines, ts: Date.now() }));
}

export async function publishNewTask(orgId, taskId, taskType) {
  await pubClient.publish(`gateway:new-task:${orgId}`, JSON.stringify({ taskId, taskType, ts: Date.now() }));
}
