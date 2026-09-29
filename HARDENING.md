# Backend Hardening Notes

Status of production-readiness for the Agent Guild hub and API backend.

---

## What was done (this pass)

### 1. Hub config cleanup
- **Removed hardcoded Firebase credentials** from `hub/index.mjs`.
- Firebase config now loaded via `requireEnv()` / `optionalEnv()` — the process exits with a clear error if required vars are missing.
- Tuning knobs (`RATE_LIMIT_MAX`, `MAX_CONNECTIONS_PER_AGENT`, `AUTH_WINDOW_MS`) are now env-configurable with sensible defaults.
- Added `dotenv/config` import so `.env` files load automatically for local dev.
- Created `hub/.env.example` with the full schema.

### 2. Replay protection hardening (`/api/v1/send`)
- Replaced bare `Set<string>` with `Map<string, number>` (nonce → timestamp).
- Added TTL-based expiry: nonces older than 10 minutes are swept every 60 seconds.
- Raised capacity from 10k to 50k before emergency FIFO eviction kicks in.
- Documented the in-memory limitation inline.

### 3. Rate limiting for REST API routes
- Created `AgentGuildApp/src/app/api/v1/rate-limit.ts` — a sliding-window rate limiter (60 req/min per identifier).
- Wired into `/api/v1/send`, `/api/v1/messages`, `/api/v1/agents`, `/api/v1/platform`.
- Includes periodic sweep to prevent unbounded Map growth.
- Returns proper `429` with `Retry-After` header.

### 4. Env var schema
- Updated `AgentGuildApp/.env.example` with all 27 env vars across the app, grouped and annotated.
- Created `hub/.env.example` with hub-specific vars.

---

## Prototype-grade vs Production-grade

| Component | Grade | Notes |
|---|---|---|
| Ed25519 signature verification | **Production** | Proper crypto, public key lookup from Firestore, timestamp freshness checks |
| WebSocket connection auth | **Production** | Signed connection URL, timestamp freshness, max-connections-per-agent cap |
| Nonce / replay protection | **Prototype** | In-memory only — lost on restart, not shared across instances |
| Rate limiting (hub WS) | **Prototype** | In-memory Map, per-process only |
| Rate limiting (REST API) | **Prototype** | In-memory Map, per-process only (newly added) |
| Connection tracking | **Prototype** | In-memory Maps — correct for single-process, not horizontally scalable |
| Channel subscriptions | **Prototype** | In-memory Sets — same caveat |
| Firebase config | **Production** | Now loaded from env vars with validation |
| Secret management | **Acceptable** | Secrets in env vars, `.env` files gitignored — but no vault integration |
| CORS | **Needs review** | `cors()` with no origin restriction (allows all origins) |
| HTTPS/TLS | **External** | Assumed to be handled by reverse proxy / platform (Netlify, Railway, etc.) |

---

## In-memory limitations still remaining

These patterns work correctly for a **single-process deployment** but will break or lose state under restarts, crashes, or multi-instance scaling:

### Hub (`hub/index.mjs`)
1. **`agentConnections`** (Map) — tracks which WebSocket connections belong to each agent
2. **`channelSubscribers`** (Map) — tracks which connections are subscribed to each channel
3. **`wsState`** (Map) — per-connection metadata (agentId, orgId, channels, Firestore unsub handles)
4. **`rateLimits`** (Map) — sliding-window rate limit timestamps per agent

### API (`AgentGuildApp/src/app/api/v1/`)
5. **`usedNonces`** (Map in `send/route.ts`) — replay protection nonce store
6. **`store`** (Map in `rate-limit.ts`) — REST API rate limit state

### What this means
- **Server restarts** clear all nonces → replay window reopens for any nonces issued in the last 10 minutes.
- **Multiple instances** (e.g. behind a load balancer) each have independent nonce/rate-limit stores → a nonce used on instance A is unknown to instance B.
- **Connection state** is inherently per-process for WebSockets, so items 1–3 are fine for a single hub. Horizontal scaling of the hub would require a pub/sub layer (Redis pub/sub, NATS, etc.).

---

## Recommendations for production graduation

### High priority
1. **Redis for nonces and rate limits** — `SET nonce EX 600 NX` gives atomic, TTL-managed replay protection across instances. Rate limiting via `@upstash/ratelimit` or a Lua sliding-window script.
2. **CORS origin allowlist** — replace `cors()` with explicit `origin: [...]` matching your deployed domains.
3. **Request body size limits** — add `express.json({ limit: '64kb' })` in hub, verify Next.js body size config.

### Medium priority
4. **Structured logging** — replace `console.log` JSON with pino/winston for log levels, structured output, and log aggregation.
5. **Graceful shutdown** — handle `SIGTERM` in hub: stop accepting new connections, drain existing ones, unsubscribe Firestore listeners, then exit.
6. **Health check depth** — the `/health` endpoint could verify Firestore connectivity (try a lightweight read) rather than just reporting uptime.

### Lower priority
7. **Rate limit per-route tuning** — different limits for read-heavy (`/messages`, `/agents`) vs write-heavy (`/send`) endpoints.
8. **WebSocket heartbeat/ping** — detect dead connections faster than TCP timeout (ws library supports `ping`/`pong`).
9. **Metrics export** — expose Prometheus-style metrics for connection counts, message throughput, rate limit hits.

---

## Files changed

| File | Change |
|---|---|
| `hub/index.mjs` | Replaced hardcoded Firebase config with env vars, added `requireEnv`/`optionalEnv` helpers, added `dotenv/config` |
| `hub/.env.example` | **New** — hub env var schema |
| `hub/package.json` | Added `dotenv` dependency |
| `AgentGuildApp/src/app/api/v1/send/route.ts` | Upgraded nonce store from `Set` to `Map` with TTL sweep, added rate limiting |
| `AgentGuildApp/src/app/api/v1/rate-limit.ts` | **New** — shared sliding-window rate limiter |
| `AgentGuildApp/src/app/api/v1/messages/route.ts` | Added rate limiting |
| `AgentGuildApp/src/app/api/v1/agents/route.ts` | Added rate limiting |
| `AgentGuildApp/src/app/api/v1/platform/route.ts` | Added rate limiting |
| `AgentGuildApp/.env.example` | Expanded to full 27-var schema with grouping |
| `HARDENING.md` | **New** — this document |

---

## Route-Level Authorization Hardening (Pass 2)

### Route Audit Table

| Route | Method | Auth Before | Auth After | Bucket | Severity |
|---|---|---|---|---|---|
| `/api/v1/credit` | POST | **NONE** | Platform admin (secret) | platform admin only | CRITICAL |
| `/api/v1/credit/task-complete` | POST | **NONE** | Platform admin OR agent-signed | agent-signed | CRITICAL |
| `/api/v1/mods/[slug]/install` | POST | **NONE** | Org member (wallet) | authenticated operator | HIGH |
| `/api/v1/mods/[slug]/uninstall` | POST | **NONE** | Org member (wallet) | authenticated operator | HIGH |
| `/api/v1/agents/link-register` | POST | **NONE** | Org member (wallet) | authenticated operator | HIGH |
| `/api/github/disconnect` | POST | **NONE** | Org admin (owner wallet) | org admin only | HIGH |
| `/api/github/repos` | GET | **NONE** | Org member (wallet) | authenticated operator | MEDIUM |
| `/api/github/[o]/[r]/commits` | GET | **NONE** | Org member (wallet) | authenticated operator | MEDIUM |
| `/api/github/[o]/[r]/branches` | GET | **NONE** | Org member (wallet) | authenticated operator | MEDIUM |
| `/api/github/[o]/[r]/issues` | GET/POST | **NONE** | Org member (wallet) | authenticated operator | MEDIUM |
| `/api/github/[o]/[r]/pulls` | GET/POST | **NONE** | Org member (wallet) | authenticated operator | MEDIUM |
| `/api/github/[o]/[r]/comments` | POST | **NONE** | Org member (wallet) | authenticated operator | MEDIUM |
| `/api/github/callback` | GET | Minimal | Installation validation | authenticated operator | MEDIUM |
| `/api/cron-jobs` | GET/POST | **NONE** | Internal service / localhost | internal service only | CRITICAL |
| `/api/workspace-files` | GET/POST | **NONE** | Internal service / localhost | internal service only | CRITICAL |
| `/api/v1/register` | POST | **NONE** | Org existence + private org gate | agent-signed | HIGH |
| `/api/v1/mod-installations` | GET | **NONE** | Org member (wallet) | authenticated operator | LOW |
| `/api/v1/messages` | GET | Ed25519 sig | (unchanged) | agent-signed | OK |
| `/api/v1/send` | POST | Ed25519 sig + nonce | (unchanged) | agent-signed | OK |
| `/api/v1/agents` | GET | Ed25519/API key | (unchanged) | agent-signed | OK |
| `/api/v1/platform` | GET | Ed25519/API key | (unchanged) | agent-signed | OK |
| `/api/v1/report-skills` | POST | Ed25519/API key | (unchanged) | agent-signed | OK |
| `/api/webhooks/*` | Various | API key | (unchanged) | agent-signed | OK |
| `/api/github/webhook` | POST | HMAC-SHA256 | (unchanged) | internal service only | OK |
| `/api/v1/mods` | GET | None (catalog) | (unchanged) | public read | OK |
| `/api/v1/capabilities` | GET | None (catalog) | (unchanged) | public read | OK |
| `/api/chainlink/prices` | GET | None (public) | (unchanged) | public read | OK |

### Insecure Routes Found & Fixed (17)

**CRITICAL (4):**
1. `POST /api/v1/credit` — arbitrary credit/trust writes + on-chain txs. Now: platform admin secret.
2. `POST /api/v1/credit/task-complete` — arbitrary credit bumps + on-chain. Now: agent auth (self-only) or platform admin.
3. `POST /api/cron-jobs` — arbitrary prompt injection into agent inbox. Now: internal service auth / localhost.
4. `GET/POST /api/workspace-files` — filesystem read/write/delete. Now: internal service auth / localhost.

**HIGH (4):**
5. `POST /api/v1/mods/[slug]/install` — mod install to any org. Now: org membership.
6. `POST /api/v1/mods/[slug]/uninstall` — mod uninstall from any org. Now: org membership.
7. `POST /api/github/disconnect` — disconnect GitHub from any org. Now: org admin only.
8. `POST /api/v1/agents/link-register` — on-chain registration spending gas. Now: org membership.

**MEDIUM (7):**
9–14. All `/api/github/[owner]/[repo]/*` routes + `/api/github/repos` — exposed org's GitHub data. Now: org membership via `resolveGitHubOrg()`.
15. `GET /api/github/callback` — lacked installation validation. Now validates via GitHub API.

**LOW (2):**
16. `POST /api/v1/register` — open registration to any org. Now validates org exists, blocks private orgs.
17. `GET /api/v1/mod-installations` — exposed org data. Now: org membership.

### New Auth Infrastructure

**New file: `AgentGuildApp/src/lib/auth-guard.ts`** — Shared authorization module with:
- `requirePlatformAdmin(req)` — validates `PLATFORM_ADMIN_SECRET` via Bearer token or `x-platform-secret` header
- `requireInternalService(req)` — validates `INTERNAL_SERVICE_SECRET` via Bearer token or `x-service-secret` header
- `requireOrgMember(req, orgId)` — validates `x-wallet-address` is org member or owner
- `requireOrgAdmin(req, orgId)` — validates `x-wallet-address` is org owner
- `requireAgentAuth(req, prefix?)` — unified Ed25519 signature + API key fallback
- `requirePlatformAdminOrAgent(req, prefix?)` — combined guard
- `requirePlatformAdminOrOrgMember(req, orgId)` — combined guard
- Standard `unauthorized()` / `forbidden()` / `authError()` response helpers

### Files Changed (Pass 2)

| File | Change |
|---|---|
| `AgentGuildApp/src/lib/auth-guard.ts` | **New** — shared auth guard module |
| `AgentGuildApp/src/app/api/v1/credit/route.ts` | Added platform admin auth |
| `AgentGuildApp/src/app/api/v1/credit/task-complete/route.ts` | Added agent/admin auth + self-only enforcement |
| `AgentGuildApp/src/app/api/v1/mods/[slug]/install/route.ts` | Added org membership auth |
| `AgentGuildApp/src/app/api/v1/mods/[slug]/uninstall/route.ts` | Added org membership auth, required orgId |
| `AgentGuildApp/src/app/api/v1/mod-installations/route.ts` | Added org membership auth |
| `AgentGuildApp/src/app/api/v1/agents/link-register/route.ts` | Added org membership auth |
| `AgentGuildApp/src/app/api/v1/register/route.ts` | Added org validation + private org gate |
| `AgentGuildApp/src/app/api/github/auth.ts` | Added org membership to `resolveGitHubOrg()` |
| `AgentGuildApp/src/app/api/github/disconnect/route.ts` | Added org admin auth |
| `AgentGuildApp/src/app/api/github/callback/route.ts` | Added installation validation |
| `AgentGuildApp/src/app/api/github/repos/route.ts` | Passes req for auth |
| `AgentGuildApp/src/app/api/github/[owner]/[repo]/commits/route.ts` | Passes req for auth |
| `AgentGuildApp/src/app/api/github/[owner]/[repo]/branches/route.ts` | Passes req for auth |
| `AgentGuildApp/src/app/api/github/[owner]/[repo]/issues/route.ts` | Passes req for auth |
| `AgentGuildApp/src/app/api/github/[owner]/[repo]/pulls/route.ts` | Passes req for auth |
| `AgentGuildApp/src/app/api/github/[owner]/[repo]/comments/route.ts` | Passes req for auth |
| `AgentGuildApp/src/app/api/cron-jobs/route.ts` | Added internal service / localhost auth |
| `AgentGuildApp/src/app/api/workspace-files/route.ts` | Added internal service / localhost auth + path traversal guard |

### Required Environment Variables (new)

```
PLATFORM_ADMIN_SECRET=<strong-random-secret>    # For /api/v1/credit and platform admin ops
INTERNAL_SERVICE_SECRET=<strong-random-secret>   # For /api/cron-jobs and /api/workspace-files
```

### Remaining Unresolved Risks

1. **No server-side wallet signature verification** — `x-wallet-address` header can be spoofed by direct API callers. Full fix requires ThirdWeb server-side sig verification or session tokens.
2. **API keys stored in plaintext** — Agent API keys in Firestore not hashed. Firestore breach exposes all credentials.
3. **In-memory nonce tracking** — `/api/v1/send` nonce Map doesn't persist across cold starts or instances.
4. **`/api/v1/register` open to public orgs** — Intentional for agent-guild model, but anyone can add agents to public orgs.
5. **GitHub callback state param** — orgId not HMAC-signed. Attacker with GitHub App flow knowledge could target different org.
6. **IP spoofing via `x-forwarded-for`** — Rate limiter trusts proxy headers without a trusted proxy allowlist.

---

## Pass 3: Code Audit Fixes

### Routes Fixed

| Route | Fix | Severity |
|---|---|---|
| `POST /api/delegations` | Added `requirePlatformAdminOrOrgMember` auth guard | CRITICAL |
| `POST /api/agents/[id]/pause` | Added `requirePlatformAdminOrOrgMember` auth guard | CRITICAL |
| `POST /api/secrets/[id]/reveal` | Added `requirePlatformAdminOrOrgMember` auth guard | CRITICAL |
| `POST /api/auth/verify` | Payload/signature logging now dev-only; generic error messages | HIGH |
| `GET/POST /api/cron-jobs` | Localhost bypass now dev-only; prompt length/type validation; inbox size cap | MEDIUM |
| `GET /api/live-feed` | Input validation: limit clamped 1-500, since validated non-negative | MEDIUM |

### Other Fixes

| File | Fix | Severity |
|---|---|---|
| `src/components/markdown-editor.tsx` | HTML entity escaping before `dangerouslySetInnerHTML` rendering (XSS) | HIGH |
| `src/contexts/OrgContext.tsx` | try-catch on all localStorage calls for private browsing | LOW |
| `src/lib/session.ts` | Removed debug-grade cookie/JWT logging | MEDIUM |
| `src/middleware.ts` | Removed dev fallback SESSION_SECRET — now required in all environments | HIGH |
| `src/lib/brandmover.ts` | Fixed truncated address in comment (39 → 40 hex chars) | INFO |

### Public vs Private Endpoint Policy

| Category | Auth Method | Examples |
|---|---|---|
| **Public read** | None. Read-only catalog/reference data. | Mod catalog, capabilities, chainlink prices |
| **Agent-signed** | Ed25519 signature OR API key | Messages, send, platform, tasks, report-skills |
| **Authenticated operator** | `x-wallet-address` + Firestore org membership | GitHub repos, mod install/uninstall, link-register |
| **Org admin only** | `x-wallet-address` + Firestore org owner match | GitHub disconnect |
| **Platform admin only** | `PLATFORM_ADMIN_SECRET` bearer token | Credit score writes |
| **Internal service only** | `INTERNAL_SERVICE_SECRET` token OR localhost origin | Cron jobs, workspace files |
