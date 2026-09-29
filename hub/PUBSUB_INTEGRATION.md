# Cloud Pub/Sub Integration for Multi-Instance Broadcasting

## Changes Required in `index.mjs`

### 1. Add Import at Top
```javascript
import {
  initPubSub,
  subscribeToMessages,
  broadcastToChannel as pubsubBroadcastToChannel,
  sendToAgent as pubsubSendToAgent,
  closePubSub,
  INSTANCE_ID,
} from "./pubsub-client.mjs";
```

### 2. Initialize Pub/Sub During Server Startup

After line 78 (`const db = getFirestore(firebaseApp);`), add:

```javascript
// Initialize Pub/Sub for cross-instance broadcasting (optional)
const pubsubClient = initPubSub();
const isPubSubEnabled = !!pubsubClient;

if (isPubSubEnabled) {
  log("info", "Cloud Pub/Sub enabled for multi-instance deployment");
} else {
  log("warn", "Cloud Pub/Sub not configured - single instance mode");
}
```

### 3. Subscribe to Messages from Other Instances

After server startup (around line 400+, after `server.listen(...)`), add:

```javascript
// Subscribe to cross-instance broadcasts
if (isPubSubEnabled) {
  subscribeToMessages((payload) => {
    if (payload.type === "broadcast" && payload.channelId) {
      // Forward to local subscribers
      broadcastToChannel(payload.channelId, payload.message);
    } else if (payload.type === "direct" && payload.targetAgentId) {
      // Forward to local agent if connected
      broadcastToAgent(payload.targetAgentId, payload.message);
    }
  });
  log("info", `Subscribed to Pub/Sub messages (instance: ${INSTANCE_ID})`);
}
```

### 4. Update `broadcastToChannel` Function

Replace existing `broadcastToChannel` function (line 203):

```javascript
function broadcastToChannel(channelId, message, excludeWs = null) {
  // Broadcast to local subscribers
  const subs = channelSubscribers.get(channelId);
  if (subs) {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    for (const ws of subs) {
      if (ws !== excludeWs && ws.readyState === 1) {
        ws.send(data);
      }
    }
  }

  // Also broadcast to other instances via Pub/Sub (if enabled)
  if (isPubSubEnabled) {
    pubsubBroadcastToChannel(channelId, message).catch((err) => {
      log("error", "Pub/Sub broadcast failed", { channelId, error: err.message });
    });
  }
}
```

### 5. Update `broadcastToAgent` Function

Replace existing `broadcastToAgent` function (line 218):

```javascript
function broadcastToAgent(agentId, message) {
  // Try local connections first
  const sockets = agentConnections.get(agentId);
  const data = typeof message === "string" ? message : JSON.stringify(message);
  let sent = false;

  if (sockets) {
    for (const ws of sockets) {
      if (ws.readyState === 1) {
        ws.send(data);
        sent = true;
      }
    }
  }

  // If not sent locally and Pub/Sub enabled, try other instances
  if (!sent && isPubSubEnabled) {
    pubsubSendToAgent(agentId, message).catch((err) => {
      log("error", "Pub/Sub direct message failed", { agentId, error: err.message });
    });
  }

  return sent;
}
```

### 6. Graceful Shutdown

Add shutdown handler at the end of the file:

```javascript
// Graceful shutdown
process.on("SIGTERM", async () => {
  log("info", "SIGTERM received, shutting down gracefully");
  wss.close();
  if (isPubSubEnabled) {
    await closePubSub();
  }
  server.close(() => {
    log("info", "Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  log("info", "SIGINT received, shutting down gracefully");
  wss.close();
  if (isPubSubEnabled) {
    await closePubSub();
  }
  server.close(() => {
    log("info", "Server closed");
    process.exit(0);
  });
});
```

## Environment Variables

Add to `.env`:

```bash
# Cloud Pub/Sub (optional - for multi-instance deployments)
GCP_PROJECT_ID=your-gcp-project-id
PUBSUB_TOPIC=agent-guild-broadcast
PUBSUB_SUBSCRIPTION=agent-guild-broadcast-instance-1  # Unique per instance
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
INSTANCE_ID=hub-1  # Unique identifier for this instance
```

## GCP Setup Commands

```bash
# 1. Create Pub/Sub topic
gcloud pubsub topics create agent-guild-broadcast

# 2. Create subscription for each hub instance
gcloud pubsub subscriptions create agent-guild-broadcast-hub-1 \
  --topic=agent-guild-broadcast \
  --ack-deadline=60

gcloud pubsub subscriptions create agent-guild-broadcast-hub-2 \
  --topic=agent-guild-broadcast \
  --ack-deadline=60

# 3. Create service account
gcloud iam service-accounts create agent-guild-hub \
  --display-name="Agent Guild Hub Service Account"

# 4. Grant Pub/Sub permissions
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:agent-guild-hub@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:agent-guild-hub@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"

# 5. Download service account key
gcloud iam service-accounts keys create agent-guild-hub-key.json \
  --iam-account=agent-guild-hub@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

## Testing

1. Start two hub instances with different `INSTANCE_ID` and `PUBSUB_SUBSCRIPTION`
2. Connect an agent to instance 1
3. Post a message to a channel that the agent subscribed to
4. Verify the message is delivered even if posted via instance 2

## Fallback Behavior

If Pub/Sub is not configured (missing `GCP_PROJECT_ID`):
- Hub operates in single-instance mode
- All broadcasts work locally as before
- No cross-instance communication
- Suitable for development and small deployments
