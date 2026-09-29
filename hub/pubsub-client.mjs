/**
 * Google Cloud Pub/Sub client for cross-instance broadcasting.
 *
 * PRIMARY cross-instance messaging path. At-least-once delivery guarantees
 * that agent messages survive instance restarts and network hiccups —
 * unlike Redis Pub/Sub which is at-most-once (fire-and-forget).
 *
 * Features:
 * - Ordering keys: messages for the same channel/agent are delivered in order
 * - Dedup IDs: prevents duplicate delivery within the 10-min dedup window
 * - Startup validation: verifies topic + subscription exist before accepting traffic
 * - Metrics: publish/receive counters, latency, error rates
 *
 * Setup Required:
 * 1. Create topic: `gcloud pubsub topics create agent-guild-broadcast --message-ordering`
 * 2. Create subscription: `gcloud pubsub subscriptions create agent-guild-broadcast-{instance} \
 *      --topic=agent-guild-broadcast --enable-message-ordering --ack-deadline=30`
 * 3. Set GOOGLE_APPLICATION_CREDENTIALS for authentication
 *
 * Env:
 *   GCP_PROJECT_ID              — GCP project ID (required to enable)
 *   PUBSUB_TOPIC                — topic name (default: agent-guild-broadcast)
 *   PUBSUB_SUBSCRIPTION         — subscription name (default: auto per instance)
 *   INSTANCE_ID                 — unique instance identifier
 *   GOOGLE_APPLICATION_CREDENTIALS — service account JSON path
 */
import { PubSub } from "@google-cloud/pubsub";
import crypto from "crypto";

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const TOPIC_NAME = process.env.PUBSUB_TOPIC || "agent-guild-broadcast";
const INSTANCE_ID = process.env.INSTANCE_ID || `hub-${process.pid}`;
const SUBSCRIPTION_NAME =
  process.env.PUBSUB_SUBSCRIPTION || `agent-guild-broadcast-${INSTANCE_ID}`;

let pubsubClient = null;
let topic = null;
let subscription = null;

// ── Metrics ──────────────────────────────────────────────────────────────────

const metrics = {
  publishCount: 0,
  publishErrors: 0,
  receiveCount: 0,
  receiveErrors: 0,
  dedupDrops: 0,
  echoDrops: 0,
  lastPublishMs: 0,
  lastReceiveMs: 0,
};

// ── Dedup tracking ───────────────────────────────────────────────────────────
// Short-lived cache to detect messages we already processed (at-least-once
// means we may see the same message twice if ack is delayed).
const processedMessages = new Map(); // messageId → timestamp
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

let dedupSweepTimer = null;

function startDedupSweep() {
  if (dedupSweepTimer) return;
  dedupSweepTimer = setInterval(() => {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [id, ts] of processedMessages) {
      if (ts < cutoff) processedMessages.delete(id);
    }
  }, 60_000);
  dedupSweepTimer.unref();
}

// ── Initialization ───────────────────────────────────────────────────────────

/**
 * Initialize Pub/Sub client.
 * Validates topic and subscription exist before returning.
 *
 * @returns {PubSub|null} Client instance or null if disabled/failed
 */
export async function initPubSub() {
  if (!PROJECT_ID) {
    console.warn(
      "[PubSub] GCP_PROJECT_ID not set — multi-instance broadcasting disabled",
    );
    return null;
  }

  try {
    pubsubClient = new PubSub({ projectId: PROJECT_ID });
    topic = pubsubClient.topic(TOPIC_NAME, {
      enableMessageOrdering: true,
    });

    // Validate topic exists
    const [topicExists] = await topic.exists();
    if (!topicExists) {
      console.error(
        `[PubSub] Topic "${TOPIC_NAME}" does not exist — create it first:`,
        `gcloud pubsub topics create ${TOPIC_NAME} --message-ordering`,
      );
      pubsubClient = null;
      topic = null;
      return null;
    }

    // Get or validate subscription
    subscription = pubsubClient.subscription(SUBSCRIPTION_NAME);
    const [subExists] = await subscription.exists();
    if (!subExists) {
      console.warn(
        `[PubSub] Subscription "${SUBSCRIPTION_NAME}" not found — creating automatically`,
      );
      try {
        [subscription] = await topic.createSubscription(SUBSCRIPTION_NAME, {
          enableMessageOrdering: true,
          ackDeadlineSeconds: 30,
          expirationPolicy: { ttl: { seconds: 0 } }, // never expire
          retryPolicy: {
            minimumBackoff: { seconds: 1 },
            maximumBackoff: { seconds: 60 },
          },
        });
        console.log(`[PubSub] Created subscription: ${SUBSCRIPTION_NAME}`);
      } catch (err) {
        console.error(
          `[PubSub] Failed to create subscription "${SUBSCRIPTION_NAME}":`,
          err.message,
        );
        pubsubClient = null;
        topic = null;
        return null;
      }
    }

    startDedupSweep();

    console.log(`[PubSub] Initialized — topic: ${TOPIC_NAME}`);
    console.log(`[PubSub] Subscription: ${SUBSCRIPTION_NAME}`);
    console.log(`[PubSub] Instance ID: ${INSTANCE_ID}`);

    return pubsubClient;
  } catch (err) {
    console.error("[PubSub] Failed to initialize:", err);
    pubsubClient = null;
    topic = null;
    subscription = null;
    return null;
  }
}

// ── Publishing ───────────────────────────────────────────────────────────────

/**
 * Generate a dedup-safe message ID.
 * GCP Pub/Sub deduplicates messages with the same ID within a 10-min window.
 */
function generateMessageId(type, key) {
  const rand = crypto.randomBytes(6).toString("hex");
  return `${INSTANCE_ID}:${type}:${key}:${Date.now()}:${rand}`;
}

/**
 * Publish a message to the broadcast topic.
 *
 * @param {object} envelope - Full message envelope
 * @param {string} orderingKey - Key for message ordering (channelId or agentId)
 * @returns {Promise<string|null>} GCP message ID
 */
async function publishEnvelope(envelope, orderingKey) {
  if (!topic) return null;

  const dedupId = generateMessageId(
    envelope.type,
    orderingKey,
  );

  try {
    const start = Date.now();
    const messageId = await topic.publishMessage({
      data: Buffer.from(JSON.stringify(envelope)),
      orderingKey,
      attributes: {
        sourceInstance: INSTANCE_ID,
        type: envelope.type,
        dedupId,
      },
    });
    metrics.publishCount++;
    metrics.lastPublishMs = Date.now() - start;
    return messageId;
  } catch (err) {
    metrics.publishErrors++;
    console.error("[PubSub] Publish failed:", err.message);
    // Resume ordering key if it was paused due to error
    topic.resumePublishing(orderingKey);
    throw err;
  }
}

/**
 * Broadcast a WebSocket message to all instances for a channel.
 * Uses channelId as ordering key — messages within a channel arrive in order.
 *
 * @param {string} channelId - Target channel ID
 * @param {object} message - WebSocket message payload
 */
export async function broadcastToChannel(channelId, message) {
  return publishEnvelope(
    {
      type: "broadcast",
      sourceInstance: INSTANCE_ID,
      channelId,
      message,
      timestamp: Date.now(),
    },
    `channel:${channelId}`,
  );
}

/**
 * Send a message to a specific agent across all instances.
 * Uses agentId as ordering key — messages to an agent arrive in order.
 *
 * @param {string} agentId - Target agent ID
 * @param {object} message - Message payload
 */
export async function sendToAgent(agentId, message) {
  return publishEnvelope(
    {
      type: "direct",
      sourceInstance: INSTANCE_ID,
      targetAgentId: agentId,
      message,
      timestamp: Date.now(),
    },
    `agent:${agentId}`,
  );
}

// ── Subscription ─────────────────────────────────────────────────────────────

/**
 * Subscribe to messages from other instances.
 * Handles echo prevention, deduplication, and error recovery.
 *
 * @param {function} callback - Handler for received messages
 */
export function subscribeToMessages(callback) {
  if (!subscription) {
    console.warn("[PubSub] Not initialized — cannot subscribe");
    return;
  }

  const messageHandler = (message) => {
    try {
      const payload = JSON.parse(message.data.toString());

      // Echo prevention: ignore messages from this instance
      if (payload.sourceInstance === INSTANCE_ID) {
        metrics.echoDrops++;
        message.ack();
        return;
      }

      // Deduplication: check if we already processed this message
      const dedupId =
        message.attributes?.dedupId || message.id;
      if (processedMessages.has(dedupId)) {
        metrics.dedupDrops++;
        message.ack();
        return;
      }
      processedMessages.set(dedupId, Date.now());

      metrics.receiveCount++;
      metrics.lastReceiveMs = Date.now();

      callback(payload);
      message.ack();
    } catch (err) {
      metrics.receiveErrors++;
      console.error("[PubSub] Failed to process message:", err);
      message.nack(); // Retry delivery
    }
  };

  subscription.on("message", messageHandler);
  subscription.on("error", (err) => {
    console.error("[PubSub] Subscription error:", err);
  });

  console.log("[PubSub] Subscribed to messages");
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Gracefully shutdown Pub/Sub client.
 */
export async function closePubSub() {
  if (dedupSweepTimer) {
    clearInterval(dedupSweepTimer);
    dedupSweepTimer = null;
  }
  if (subscription) {
    try {
      await subscription.close();
    } catch {
      // ignore close errors during shutdown
    }
  }
  if (pubsubClient) {
    try {
      await pubsubClient.close();
    } catch {
      // ignore close errors during shutdown
    }
  }
  console.log("[PubSub] Closed");
}

// ── Health ────────────────────────────────────────────────────────────────────

/**
 * Check if Pub/Sub is configured and healthy.
 * Returns detailed status including metrics.
 */
export async function isPubSubHealthy() {
  if (!pubsubClient || !topic) {
    return { enabled: false };
  }

  try {
    const [exists] = await topic.exists();
    return {
      enabled: true,
      healthy: exists,
      instanceId: INSTANCE_ID,
      subscription: SUBSCRIPTION_NAME,
      metrics: { ...metrics },
    };
  } catch (err) {
    return {
      enabled: true,
      healthy: false,
      instanceId: INSTANCE_ID,
      error: err.message,
      metrics: { ...metrics },
    };
  }
}

/**
 * Returns true if Pub/Sub is initialized and has a topic.
 */
export function isPubSubEnabled() {
  return topic !== null;
}

/**
 * Get current metrics snapshot.
 */
export function getPubSubMetrics() {
  return { ...metrics };
}

export { INSTANCE_ID };

// ── Legacy compatibility ─────────────────────────────────────────────────────
// publishMessage still works but prefer broadcastToChannel/sendToAgent
export async function publishMessage(message) {
  if (!topic) return null;
  try {
    const data = Buffer.from(JSON.stringify(message));
    const messageId = await topic.publishMessage({ data });
    return messageId;
  } catch (err) {
    console.error("[PubSub] Failed to publish:", err);
    throw err;
  }
}
