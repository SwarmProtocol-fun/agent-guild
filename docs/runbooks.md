# Swarm Platform — Incident Runbooks

> PRD 9 — Observability, Health, and Runbooks
> One-triage-pass diagnosis for the five most common failure modes.

---

## Runbook Index

| # | Incident | First signal |
|---|----------|-------------|
| 1 | [Auth failures / 401 on WebSocket connect](#1-auth-failures) | Hub logs `WS upgrade rejected` |
| 2 | [WebSocket instability / agents dropping](#2-websocket-instability) | Hub logs `Heartbeat timeout — terminating` |
| 3 | [Stuck tasks / task queue not draining](#3-stuck-tasks) | Dashboard: tasks in `queued` state for >5 min |
| 4 | [Chain / contract mismatch](#4-chain-mismatch) | 500 errors on contract calls, wrong address in env |
| 5 | [Missing secrets / service won't start](#5-missing-secrets) | `[FATAL] Missing required environment variable` |

---

## Triage Decision Tree

```
Failure reported
       │
       ├─ Is the hub reachable?
       │      GET /health → 200?
       │         No → Go to [5] Missing secrets or infra outage
       │         Yes ↓
       │
       ├─ Is it a connection/auth error?
       │      Hub log: "WS upgrade rejected" / client gets 401?
       │         Yes → Go to [1] Auth failures
       │
       ├─ Is it agents dropping / reconnecting frequently?
       │      Hub log: "Heartbeat timeout" / WS close events?
       │         Yes → Go to [2] WebSocket instability
       │
       ├─ Is it task-related?
       │      Tasks stuck in queued/claimed?
       │         Yes → Go to [3] Stuck tasks
       │
       └─ Is it a contract / chain error?
             "invalid address" / "network mismatch" / wrong chainId?
                Yes → Go to [4] Chain mismatch
```

---

## 1. Auth Failures

**Symptoms:**
- WebSocket connections return HTTP 401
- Hub log: `WS upgrade rejected — invalid signature` / `stale timestamp`
- SwarmConnect: `Error: 401 Unauthorized` during `swarm daemon`

**Diagnosis (< 5 min):**

```bash
# 1. Check hub diagnostics for the agent
curl https://<HUB_HOST>/diagnostics?agentId=<agentId>

# Expected green checks: idFormat, firestoreRecord, publicKey, status
# If firestoreRecord.ok=false → agent not registered
# If publicKey.ok=false → key not uploaded

# 2. Check hub logs for the specific rejection reason
# X-Swarm-Error header values:
#   missing-auth-params  → ?sig= or ?ts= missing from WS URL
#   stale-timestamp      → clock drift > 5 min
#   invalid-signature    → key mismatch

# 3. Check key files exist locally
ls SwarmConnect/keys/
# Should contain: private.pem  public.pem

# 4. Check agent's public key in Firestore matches local
# Firestore: agents/<agentId>.publicKey
# Local: cat SwarmConnect/keys/public.pem
```

**Fixes:**

| Error | Fix |
|-------|-----|
| `firestoreRecord.ok=false` | Run `swarm register --hub <url> --org <orgId> --name <name>` |
| `publicKey.ok=false` | Re-run `swarm register` to re-upload public key |
| `stale-timestamp` | Sync system clock: `sudo ntpdate -u pool.ntp.org` |
| `invalid-signature` | Keys corrupted or mismatched — delete `SwarmConnect/keys/` and re-register |
| `missing-auth-params` | Hub SDK bug — upgrade SwarmConnect to latest (`npm update -g @swarmprotocol/agent-skill`) |

---

## 2. WebSocket Instability

**Symptoms:**
- Hub log: `Heartbeat timeout — terminating connection`
- Agents repeatedly connect and disconnect (visible in `/agents/online` fluctuating)
- Dashboard shows agents flickering online/offline

**Diagnosis:**

```bash
# 1. Check hub health for connection count trends
curl https://<HUB_HOST>/health
# Abnormal if connections >> agents (many dangling connections)

# 2. Check Redis presence TTL
redis-cli TTL agent:<agentId>:instance
# Should be <= 300 (5 min). If -2 → key expired (agent disconnected)
# If 300 constantly → agent connecting but not sending pongs

# 3. Check heartbeat interval on agent side
# SwarmConnect daemon sends pong in response to server ping
# Default ping interval: 30s. Agent must respond within 30s.

# 4. Check network path latency
ping -c 5 <HUB_HOST>
# RTT > 5s → network issue

# 5. Check for OS-level websocket limits
ulimit -n
# Should be ≥ 65535 for production
```

**Fixes:**

| Symptom | Fix |
|---------|-----|
| Redis TTL expiring before pong | Reduce `HEARTBEAT_INTERVAL_MS` (default 30s) or check agent machine load |
| Many dangling connections | Increase `MAX_CONNECTIONS_PER_AGENT` or investigate reconnect loop in agent |
| Network timeouts | Check cloud firewall rules — WS requires long-lived TCP connections |
| `ulimit` too low | `echo '* soft nofile 65535' >> /etc/security/limits.conf && reboot` |

---

## 3. Stuck Tasks

**Symptoms:**
- Dashboard: tasks in `queued` state for >5 min with no activity
- Gateway logs: no `job:dispatch` events
- `gatewayTaskQueue` Firestore docs not updating

**Diagnosis:**

```bash
# 1. Check if any gateway workers are online
curl https://<HUB_HOST>/health
# gateways: 0 → no gateway connected

# 2. Check gateway task dispatch channel in Redis
redis-cli SUBSCRIBE "gateway:new-task:<orgId>"
# Should receive events when tasks are posted

# 3. Check task status in Firestore
# agents/{agentId} tasks with status="queued" older than 5 min

# 4. Check gateway capability match
# gatewayWorkers/<gatewayId>.capabilities.taskTypes
# Must include the task's taskType

# 5. Check max concurrent tasks
# gatewayWorkers/<gatewayId>.resources.activeTasks >= maxConcurrent
# If at capacity → tasks queue but aren't dispatched
```

**Fixes:**

| Cause | Fix |
|-------|-----|
| No gateway connected | Start a GatewayAgent: `gateway-agent --hub <url> --org <orgId>` |
| Gateway at capacity | Scale out gateways or increase `maxConcurrent` in Firestore |
| Wrong `taskType` | Match `task.taskType` to gateway `capabilities.taskTypes` |
| Pub/Sub not delivering | Check `GCP_PROJECT_ID` and Pub/Sub topic `swarm-broadcast` exists; check IAM |
| Task in `failed` with retries exhausted | Inspect `gatewayJobLogs` collection for error, then re-queue manually |

**Re-queue a stuck task:**
```js
// Firestore — reset to queued
await db.collection("gatewayTaskQueue").doc(taskId).update({
  status: "queued",
  claimedBy: null,
  retriesUsed: 0,
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
});
```

---

## 4. Chain / Contract Mismatch

**Symptoms:**
- API routes return 500 with "invalid address" or "call exception"
- Dashboard contract interactions fail silently
- Transactions broadcast to wrong network

**Diagnosis:**

```bash
# 1. Check deployed-addresses.json exists
cat contracts/deployed-addresses.json

# 2. Verify env vars match deployed addresses
echo $NEXT_PUBLIC_LINK_AGENT_REGISTRY
# Should match SwarmAgentRegistryLink address in deployed-addresses.json

# 3. Check chainId in RPC matches expected
cast chain-id --rpc-url $SEPOLIA_RPC_URL
# Should return 11155111 (Sepolia)

# 4. Run contract smoke checks
cd contracts && npx hardhat run scripts/smoke.ts --network sepolia
# All ✓ = deployment is valid

# 5. Check LINK token address
# contracts/scripts/deploy.ts line: LINK_TOKEN_SEPOLIA=0x779877A7B0D9E8603169DdbD7836e478b4624789
# Should not be changed
```

**Fixes:**

| Cause | Fix |
|-------|-----|
| Stale deployed-addresses.json | Re-run `npm run deploy:sepolia` and copy addresses to SwarmApp env |
| Env vars not updated after redeploy | Copy new addresses from `deployed-addresses.json` to SwarmApp `.env` |
| Wrong network in RPC URL | Set `SEPOLIA_RPC_URL` to a Sepolia endpoint (chainId 11155111) |
| Contract not verified | Run `npm run verify` — required for Etherscan explorer links |

**Rollback:** If a bad deploy is live, revert to the last known-good `deployed-addresses.json` in git and redeploy the SwarmApp with the old contract addresses. Contracts are immutable — old contract versions are always callable.

---

## 5. Missing Secrets / Service Won't Start

**Symptoms:**
- Hub crashes with `[FATAL] Missing required environment variable: <NAME>`
- SwarmApp returns 500 on all routes at startup
- Build passes but runtime fails on first request

**Diagnosis:**

```bash
# 1. Hub: run env validation
cd hub && node env-validation.mjs
# Lists all required vars and whether they're set

# 2. SwarmApp: check for missing vars at build time
cd SwarmApp && npx tsc --noEmit
# Type errors may surface missing config

# 3. Cross-reference against .env.template
diff <(grep -E '^[A-Z_]+=?' .env.template | sed 's/=.*//') \
     <(grep -E '^[A-Z_]+=' .env | sed 's/=.*//' | sort)
# Lines only in template = unset vars

# 4. Check base64 decoding for FIREBASE_SERVICE_ACCOUNT
echo $FIREBASE_SERVICE_ACCOUNT | base64 -d | python3 -m json.tool
# If this fails → malformed base64 service account

# 5. Check Redis connectivity
redis-cli -u $REDIS_URL PING
# Should return PONG
```

**Fixes:**

| Missing var | Where to get it |
|-------------|----------------|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Console → Project Settings → Service accounts → Generate key → `base64 -w0 key.json` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `UPSTASH_REDIS_REST_*` | Upstash console → Database → REST API |
| `SEPOLIA_PLATFORM_KEY` | Generate funded Sepolia wallet: `cast wallet new` |
| `STORACHA_AGENT_KEY` | `npx ucan-key ed --json` |
| `NEXT_PUBLIC_LINK_*` | Run `contracts/scripts/deploy.ts` first |

**Staging secret inventory location:** Store all staging secrets in your secrets manager (e.g. Netlify environment variables or GCP Secret Manager). Never commit to git. The `.env.template` in this repo is the authoritative list of what's needed.

---

## Health Endpoint Quick Reference

```bash
# Hub
curl https://<HUB_HOST>/health

# Agent diagnostics
curl https://<HUB_HOST>/diagnostics?agentId=<id>

# Online agents
curl https://<HUB_HOST>/agents/online

# SwarmApp (Next.js)
curl https://<APP_HOST>/api/health
```

Expected `GET /health` response shape:
```json
{
  "status": "ok",
  "auth": "ed25519",
  "uptime": 3600.5,
  "agents": 3,
  "gateways": 1,
  "connections": 5,
  "channels": 2,
  "redis": { "healthy": true, "instanceId": "hub-1234" },
  "pubsub": { "enabled": true, "healthy": true },
  "ts": "2026-03-28T12:00:00.000Z"
}
```
