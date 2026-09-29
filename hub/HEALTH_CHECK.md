# Health Check Endpoint for Hub

## Add to `index.mjs`

Add this endpoint after the CORS configuration (around line 490):

```javascript
/**
 * GET /health - Health check endpoint
 * Used by load balancers to determine instance health.
 */
app.get("/health", async (req, res) => {
  const startTime = Date.now();

  try {
    // Check Firestore connectivity
    const healthDoc = await getDoc(doc(db, "system", "health"));
    const firestoreHealthy = true; // If we got here, Firestore is reachable

    // Check Pub/Sub if enabled
    let pubsubHealthy = true;
    if (isPubSubEnabled) {
      pubsubHealthy = await isPubSubHealthy();
    }

    // Check memory
    const usage = process.memoryUsage();
    const heapPercent = (usage.heapUsed / usage.heapTotal) * 100;
    const memoryHealthy = heapPercent < 90;

    // Get connection stats
    const totalConnections = Array.from(agentConnections.values()).reduce(
      (sum, sockets) => sum + sockets.size,
      0
    );

    const allHealthy = firestoreHealthy && memoryHealthy && pubsubHealthy;
    const status = allHealthy ? "healthy" : "degraded";

    const response = {
      status,
      timestamp: new Date().toISOString(),
      instanceId: INSTANCE_ID,
      region: HUB_REGION,
      checks: {
        firestore: firestoreHealthy,
        pubsub: isPubSubEnabled ? pubsubHealthy : "disabled",
        memory: memoryHealthy,
      },
      stats: {
        connections: totalConnections,
        agents: agentConnections.size,
        channels: channelSubscribers.size,
        heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
        heapPercent: Math.round(heapPercent),
      },
      uptime: process.uptime(),
      version: process.env.npm_package_version || "unknown",
    };

    const duration = Date.now() - startTime;

    res.status(allHealthy ? 200 : 503).json(response);

    if (duration > 1000) {
      log("warn", "Slow health check", { duration });
    }
  } catch (err) {
    log("error", "Health check failed", { error: err.message });
    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      error: err.message,
    });
  }
});

/**
 * GET /ready - Readiness check
 * Returns 200 only when the server is ready to accept traffic.
 * Used by Kubernetes and some load balancers.
 */
app.get("/ready", (req, res) => {
  // Check if WebSocket server is ready
  if (!wss || wss.readyState !== 1) {
    return res.status(503).json({ ready: false, reason: "WebSocket server not ready" });
  }

  res.status(200).json({
    ready: true,
    timestamp: new Date().toISOString(),
  });
});
```

## Import isPubSubHealthy

Add to the Pub/Sub import at the top:

```javascript
import {
  initPubSub,
  subscribeToMessages,
  broadcastToChannel as pubsubBroadcastToChannel,
  sendToAgent as pubsubSendToAgent,
  closePubSub,
  isPubSubHealthy,  // Add this
  INSTANCE_ID,
} from "./pubsub-client.mjs";
```

## Create Health Check Document in Firestore

Run this once to create the system health document:

```javascript
// In Firebase Console or via script:
db.collection("system").doc("health").set({
  created: new Date(),
  purpose: "Health check endpoint test document"
});
```

## Load Balancer Configuration

### AWS Application Load Balancer (ALB)

```hcl
resource "aws_lb_target_group" "agent_guild_hub" {
  name     = "agent-guild-hub-tg"
  port     = 8400
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    path                = "/health"
    matcher             = "200"
  }

  # Sticky sessions for WebSocket
  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400  # 24 hours
    enabled         = true
  }
}
```

### NGINX

```nginx
upstream agent_guild_hub {
    # Sticky sessions using IP hash
    ip_hash;

    server hub1.internal:8400 max_fails=3 fail_timeout=30s;
    server hub2.internal:8400 max_fails=3 fail_timeout=30s;
}

server {
    listen 80;
    server_name hub.agent-guild.example.com;

    location / {
        proxy_pass http://agent-guild_hub;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }

    # Health check endpoint
    location /health {
        proxy_pass http://agent-guild_hub/health;
        access_log off;
    }
}

# Active health checks (requires nginx-plus or custom module)
match hub_health {
    status 200;
    body ~ "healthy";
}
```

### Google Cloud Load Balancer

```hcl
resource "google_compute_health_check" "agent_guild_hub" {
  name                = "agent-guild-hub-health-check"
  check_interval_sec  = 30
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 3

  http_health_check {
    port         = 8400
    request_path = "/health"
  }
}

resource "google_compute_backend_service" "agent_guild_hub" {
  name                  = "agent-guild-hub-backend"
  protocol              = "HTTP"
  timeout_sec           = 3600
  enable_cdn            = false
  health_checks         = [google_compute_health_check.agent_guild_hub.id]
  load_balancing_scheme = "EXTERNAL"

  # Session affinity for WebSocket
  session_affinity = "CLIENT_IP"

  backend {
    group = google_compute_instance_group.agent_guild_hub.id
  }
}
```

## Monitoring

### Prometheus Metrics (Optional Enhancement)

Add a `/metrics` endpoint for Prometheus scraping:

```javascript
app.get("/metrics", (req, res) => {
  const usage = process.memoryUsage();
  const totalConnections = Array.from(agentConnections.values()).reduce(
    (sum, sockets) => sum + sockets.size,
    0
  );

  const metrics = `
# HELP agent_guild_hub_connections_total Total WebSocket connections
# TYPE agent_guild_hub_connections_total gauge
agent_guild_hub_connections_total{instance="${INSTANCE_ID}",region="${HUB_REGION}"} ${totalConnections}

# HELP agent_guild_hub_agents_total Total connected agents
# TYPE agent_guild_hub_agents_total gauge
agent_guild_hub_agents_total{instance="${INSTANCE_ID}",region="${HUB_REGION}"} ${agentConnections.size}

# HELP agent_guild_hub_channels_total Total active channels
# TYPE agent_guild_hub_channels_total gauge
agent_guild_hub_channels_total{instance="${INSTANCE_ID}",region="${HUB_REGION}"} ${channelSubscribers.size}

# HELP agent_guild_hub_memory_heap_used_bytes Heap memory used
# TYPE agent_guild_hub_memory_heap_used_bytes gauge
agent_guild_hub_memory_heap_used_bytes{instance="${INSTANCE_ID}",region="${HUB_REGION}"} ${usage.heapUsed}

# HELP agent_guild_hub_uptime_seconds Server uptime
# TYPE agent_guild_hub_uptime_seconds counter
agent_guild_hub_uptime_seconds{instance="${INSTANCE_ID}",region="${HUB_REGION}"} ${process.uptime()}
  `.trim();

  res.set("Content-Type", "text/plain");
  res.send(metrics);
});
```
