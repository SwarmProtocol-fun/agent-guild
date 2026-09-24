# Swarm Production Deployment Guide

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Load Balancer Configuration](#load-balancer-configuration)
3. [Sticky Sessions for WebSocket](#sticky-sessions-for-websocket)
4. [Environment Configuration](#environment-configuration)
5. [Firestore Setup](#firestore-setup)
6. [Cloud Pub/Sub Setup](#cloud-pubsub-setup-optional)
7. [Monitoring & Health Checks](#monitoring--health-checks)

---

## Architecture Overview

```
                        ┌─────────────────┐
                        │  Load Balancer  │
                        │ (ALB/nginx/GCP) │
                        └────────┬────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 │                               │
          ┌──────▼──────┐               ┌───────▼──────┐
          │   Hub #1    │               │   Hub #2     │
          │  (Instance) │◄─Pub/Sub──────►  (Instance)  │
          └─────┬───────┘               └──────┬───────┘
                │                               │
                └───────────┬───────────────────┘
                            │
                     ┌──────▼──────┐
                     │  Firestore  │
                     │  (Shared)   │
                     └─────────────┘
```

### Key Principles

1. **Sticky Sessions Required**: WebSocket connections MUST route to the same instance
2. **Shared State via Firestore**: Sessions, rate limits, nonces stored in Firestore
3. **Cross-Instance Messaging**: Cloud Pub/Sub broadcasts messages between instances
4. **Stateful Connections**: In-memory connection tracking (can't be shared)

---

## Load Balancer Configuration

### AWS Application Load Balancer (ALB)

**Requirements:**
- ✅ Session affinity enabled (sticky sessions)
- ✅ Health checks on `/health` endpoint
- ✅ WebSocket support (HTTP/1.1 upgrade)
- ✅ Long connection timeout (3600s)

**Terraform Configuration:**

```hcl
# Target Group for Hub instances
resource "aws_lb_target_group" "swarm_hub" {
  name     = "swarm-hub-tg"
  port     = 8400
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  # Health checks
  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    path                = "/health"
    matcher             = "200"
  }

  # Sticky sessions (REQUIRED for WebSocket)
  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400  # 24 hours
    enabled         = true
  }

  # Deregistration delay for graceful shutdown
  deregistration_delay = 300
}

# Application Load Balancer
resource "aws_lb" "swarm" {
  name               = "swarm-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids

  enable_deletion_protection = true
  enable_http2               = true
}

# Listener for Hub WebSocket
resource "aws_lb_listener" "hub" {
  load_balancer_arn = aws_lb.swarm.arn
  port              = "8400"
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.swarm_hub.arn
  }
}

# Auto Scaling Group for Hub instances
resource "aws_autoscaling_group" "swarm_hub" {
  name                = "swarm-hub-asg"
  vpc_zone_identifier = var.private_subnet_ids
  target_group_arns   = [aws_lb_target_group.swarm_hub.arn]

  min_size         = 2
  max_size         = 10
  desired_capacity = 2

  health_check_type         = "ELB"
  health_check_grace_period = 300

  launch_template {
    id      = aws_launch_template.swarm_hub.id
    version = "$Latest"
  }

  tag {
    key                 = "Name"
    value               = "swarm-hub"
    propagate_at_launch = true
  }
}
```

---

### NGINX Configuration

**nginx.conf:**

```nginx
upstream swarm_hub {
    # CRITICAL: IP hash for sticky sessions
    ip_hash;

    # Hub instances
    server hub1.internal:8400 max_fails=3 fail_timeout=30s;
    server hub2.internal:8400 max_fails=3 fail_timeout=30s;

    # Keep connection alive to backends
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name hub.swarm.example.com;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name hub.swarm.example.com;

    # SSL certificates
    ssl_certificate /etc/letsencrypt/live/hub.swarm.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hub.swarm.example.com/privkey.pem;

    # SSL settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # WebSocket proxy settings
    location / {
        proxy_pass http://swarm_hub;

        # WebSocket upgrade headers
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts for long-lived connections
        proxy_connect_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;

        # Disable buffering for WebSocket
        proxy_buffering off;
    }

    # Health check endpoint (no logging)
    location /health {
        proxy_pass http://swarm_hub/health;
        access_log off;
    }

    # Rate limiting for REST API
    location /api/ {
        limit_req zone=api_limit burst=20 nodelay;
        proxy_pass http://swarm_hub;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

# Rate limit zone (10 requests per second per IP)
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
```

---

### Google Cloud Load Balancer

**GCP Configuration:**

```hcl
# Health check
resource "google_compute_health_check" "swarm_hub" {
  name                = "swarm-hub-health"
  check_interval_sec  = 30
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 3

  http_health_check {
    port         = 8400
    request_path = "/health"
  }
}

# Backend service with session affinity
resource "google_compute_backend_service" "swarm_hub" {
  name                  = "swarm-hub-backend"
  protocol              = "HTTP"
  timeout_sec           = 3600
  enable_cdn            = false
  health_checks         = [google_compute_health_check.swarm_hub.id]
  load_balancing_scheme = "EXTERNAL"

  # CRITICAL: Session affinity for WebSocket
  session_affinity = "CLIENT_IP"
  affinity_cookie_ttl_sec = 86400

  backend {
    group           = google_compute_instance_group_manager.swarm_hub.instance_group
    balancing_mode  = "UTILIZATION"
    max_utilization = 0.8
  }
}

# Managed instance group
resource "google_compute_instance_group_manager" "swarm_hub" {
  name               = "swarm-hub-igm"
  base_instance_name = "swarm-hub"
  zone               = var.zone
  target_size        = 2

  version {
    instance_template = google_compute_instance_template.swarm_hub.id
  }

  named_port {
    name = "http"
    port = 8400
  }

  auto_healing_policies {
    health_check      = google_compute_health_check.swarm_hub.id
    initial_delay_sec = 300
  }
}
```

---

## Sticky Sessions for WebSocket

### Why Sticky Sessions Are Required

WebSocket connections are **stateful**:
- Connection tracking stored in-memory (per instance)
- Channel subscriptions maintained locally
- Agent authentication state cached

Without sticky sessions:
- Clients route to different instances randomly
- Connection state lost between requests
- Authentication fails
- Messages not delivered

### Implementation Methods

| Method | How It Works | Pros | Cons |
|--------|-------------|------|------|
| **IP Hash** | Route based on client IP | Simple, no cookies | Breaks with NAT/proxies |
| **Cookie-based** | Set sticky cookie by LB | Works with NAT | Requires cookie support |
| **Client IP Affinity** | GCP-specific session affinity | Built-in, reliable | GCP only |

### Verifying Sticky Sessions

Test with curl:

```bash
# Get initial instance ID from health check
INSTANCE_1=$(curl -s https://hub.swarm.example.com/health | jq -r '.instanceId')

# Make second request (should route to same instance)
INSTANCE_2=$(curl -s https://hub.swarm.example.com/health | jq -r '.instanceId')

# Verify they match
if [ "$INSTANCE_1" == "$INSTANCE_2" ]; then
  echo "✅ Sticky sessions working"
else
  echo "❌ Sticky sessions NOT working"
fi
```

---

## Environment Configuration

### Hub Instance (.env)

```bash
# Server
PORT=8400
NODE_ENV=production

# Instance identity (UNIQUE per instance)
INSTANCE_ID=hub-us-east-1a
HUB_REGION=us-east
HUB_GATEWAY_ID=gateway-prod-1

# Firebase (shared across instances)
FIREBASE_API_KEY=your-firebase-api-key
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_STORAGE_BUCKET=your-project.appspot.com
FIREBASE_MESSAGING_SENDER_ID=123456789
FIREBASE_APP_ID=1:123456789:web:abc123

# Security
ALLOWED_ORIGINS=https://swarmprotocol.ai,https://app.swarmprotocol.ai
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=60
MAX_CONNECTIONS_PER_AGENT=5
AUTH_WINDOW_MS=300000

# Cloud Pub/Sub (for multi-instance)
GCP_PROJECT_ID=your-gcp-project
PUBSUB_TOPIC=swarm-broadcast
PUBSUB_SUBSCRIPTION=swarm-broadcast-hub-us-east-1a  # UNIQUE per instance
GOOGLE_APPLICATION_CREDENTIALS=/app/service-account.json

# Monitoring
LOG_LEVEL=info
ENABLE_METRICS=true
```

### Next.js App (.env.local)

```bash
# Session
SESSION_SECRET=generate-with-openssl-rand-hex-32

# Firebase (same as hub)
FIREBASE_API_KEY=your-firebase-api-key
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_STORAGE_BUCKET=your-project.appspot.com
FIREBASE_MESSAGING_SENDER_ID=123456789
FIREBASE_APP_ID=1:123456789:web:abc123

# WalletConnect / Reown
NEXT_PUBLIC_REOWN_PROJECT_ID=your-reown-project-id

# Platform admin wallets (comma-separated)
PLATFORM_ADMIN_WALLETS=0x1234...abcd,0x5678...efgh

# Production
NODE_ENV=production
```

---

## Firestore Setup

### Required Collections

```javascript
// Collections that must exist:
- authNonces         // Auth nonces (TTL: 5 min)
- sessions           // User sessions (TTL: 24 hours)
- rateLimits         // Rate limit counters (TTL: varies)
- organizations      // User organizations
- agents             // Agent registry
- channels           // Chat channels
- messages           // Channel messages
- system/health      // Health check document
```

### Firestore TTL Policy

Enable automatic cleanup of expired documents:

```bash
# Configure TTL on rateLimits collection
gcloud firestore fields ttls update expiresAt \
  --collection-group=rateLimits \
  --enable-ttl

# Configure TTL on authNonces collection
gcloud firestore fields ttls update expiresAt \
  --collection-group=authNonces \
  --enable-ttl
```

### Security Rules

**firestore.rules:**

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Rate limits - server-only
    match /rateLimits/{document=**} {
      allow read, write: if false;  // Server SDK only
    }

    // Auth nonces - server-only
    match /authNonces/{document=**} {
      allow read, write: if false;  // Server SDK only
    }

    // Sessions - server-only
    match /sessions/{document=**} {
      allow read, write: if false;  // Server SDK only
    }

    // System health check
    match /system/{document=**} {
      allow read: if true;
      allow write: if false;
    }

    // Organizations - authenticated users
    match /organizations/{orgId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null &&
                   (request.auth.uid == resource.data.ownerAddress ||
                    request.auth.uid in resource.data.adminAddresses);
    }

    // Agents - authenticated users in org
    match /agents/{agentId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null &&
                   request.auth.uid == resource.data.ownerAddress;
    }
  }
}
```

---

## Cloud Pub/Sub Setup (Optional)

Required for multi-instance deployments with cross-instance broadcasting.

### GCP Setup

```bash
# 1. Create topic
gcloud pubsub topics create swarm-broadcast

# 2. Create subscription for each instance
gcloud pubsub subscriptions create swarm-broadcast-hub-1 \
  --topic=swarm-broadcast \
  --ack-deadline=60

gcloud pubsub subscriptions create swarm-broadcast-hub-2 \
  --topic=swarm-broadcast \
  --ack-deadline=60

# 3. Create service account
gcloud iam service-accounts create swarm-hub \
  --display-name="Swarm Hub Service Account"

# 4. Grant permissions
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:swarm-hub@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:swarm-hub@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"

# 5. Download key
gcloud iam service-accounts keys create swarm-hub-key.json \
  --iam-account=swarm-hub@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

### Terraform

```hcl
resource "google_pubsub_topic" "swarm_broadcast" {
  name = "swarm-broadcast"
}

resource "google_pubsub_subscription" "swarm_hub_1" {
  name  = "swarm-broadcast-hub-1"
  topic = google_pubsub_topic.swarm_broadcast.name

  ack_deadline_seconds = 60
  message_retention_duration = "600s"
}

resource "google_service_account" "swarm_hub" {
  account_id   = "swarm-hub"
  display_name = "Swarm Hub Service Account"
}

resource "google_project_iam_member" "swarm_hub_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.swarm_hub.email}"
}

resource "google_project_iam_member" "swarm_hub_pubsub_subscriber" {
  project = var.project_id
  role    = "roles/pubsub.subscriber"
  member  = "serviceAccount:${google_service_account.swarm_hub.email}"
}
```

---

## Monitoring & Health Checks

### Health Check Endpoints

| Endpoint | Purpose | Expected Response |
|----------|---------|-------------------|
| `GET /health` | Liveness check | 200 if healthy, 503 if degraded |
| `GET /ready` | Readiness check | 200 if ready to accept traffic |
| `GET /metrics` | Prometheus metrics | Prometheus format |

### Key Metrics to Monitor

- `swarm_hub_connections_total` - Total WebSocket connections
- `swarm_hub_agents_total` - Connected agents
- `swarm_hub_memory_heap_used_bytes` - Heap memory usage
- `swarm_hub_uptime_seconds` - Instance uptime

### Alerting Rules

```yaml
# Prometheus alerting rules
groups:
  - name: swarm_hub
    rules:
      - alert: HighMemoryUsage
        expr: swarm_hub_memory_heap_used_bytes / swarm_hub_memory_heap_total_bytes > 0.9
        for: 5m
        annotations:
          summary: "Hub instance {{ $labels.instance }} high memory usage"

      - alert: NoConnectedAgents
        expr: swarm_hub_agents_total == 0
        for: 10m
        annotations:
          summary: "Hub instance {{ $labels.instance }} has no connected agents"

      - alert: HealthCheckFailing
        expr: up{job="swarm_hub"} == 0
        for: 2m
        annotations:
          summary: "Hub instance {{ $labels.instance }} is down"
```

---

## Deployment Checklist

### Pre-Deployment

- [ ] Firestore collections created
- [ ] Firestore security rules deployed
- [ ] Firestore TTL policies configured
- [ ] Load balancer configured with sticky sessions
- [ ] Health check endpoints tested
- [ ] SSL certificates installed
- [ ] Environment variables set (unique INSTANCE_ID per instance)
- [ ] Cloud Pub/Sub topic and subscriptions created (if multi-instance)
- [ ] Service account keys generated and deployed

### Post-Deployment

- [ ] Health checks returning 200
- [ ] Sticky sessions verified (same instance ID on repeat requests)
- [ ] WebSocket connections establish successfully
- [ ] Cross-instance broadcasting works (if Pub/Sub enabled)
- [ ] Rate limiting functional across instances
- [ ] Monitoring dashboards configured
- [ ] Alerting rules deployed

### Testing

```bash
# Test health check
curl https://hub.swarm.example.com/health | jq

# Test sticky sessions
for i in {1..5}; do
  curl -s https://hub.swarm.example.com/health | jq -r '.instanceId'
done

# Test WebSocket connection
wscat -c wss://hub.swarm.example.com

# Test rate limiting
for i in {1..100}; do
  curl -s -w "%{http_code}\n" -o /dev/null https://app.swarm.example.com/api/auth/verify \
    -X POST -H "Content-Type: application/json" -d '{"address": "0x123"}'
done
```

---

## Troubleshooting

### WebSocket Connections Dropping

**Symptoms**: Agents disconnect frequently

**Causes**:
1. No sticky sessions configured
2. Load balancer timeout too short
3. Health check failing, causing instance drain

**Solutions**:
- Verify sticky sessions with curl test
- Increase load balancer timeout to 3600s
- Check health check endpoint logs

### Rate Limiting Not Working Across Instances

**Symptoms**: Different rate limits on different instances

**Causes**:
1. Still using in-memory rate limiting
2. Firestore rate limiter not properly configured

**Solutions**:
- Verify imports use `rate-limit-firestore.ts`
- Check Firestore rate limit documents exist
- Test with concurrent requests from different IPs

### Pub/Sub Messages Not Broadcasting

**Symptoms**: Messages only delivered to local instance

**Causes**:
1. Pub/Sub not initialized (missing GCP_PROJECT_ID)
2. Service account lacks permissions
3. Subscription not created

**Solutions**:
- Check hub logs for "Pub/Sub enabled" message
- Verify service account has pubsub.publisher and pubsub.subscriber roles
- Test topic with `gcloud pubsub topics publish`

---

## Security Hardening Checklist

- [ ] SESSION_SECRET is 32+ characters random hex
- [ ] CORS origins whitelist configured (no wildcards)
- [ ] Rate limiting enabled on all auth endpoints
- [ ] Firestore security rules block direct client access to sensitive collections
- [ ] SSL/TLS enabled with valid certificates
- [ ] Service account keys stored securely (not in code)
- [ ] Environment variables never committed to git
- [ ] Health check endpoints don't expose sensitive data
- [ ] WebSocket authentication required for all connections
- [ ] Connection limits per agent enforced (MAX_CONNECTIONS_PER_AGENT)
