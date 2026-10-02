# Security Audit — agent-guild — 2026-10-01

**Mode:** Comprehensive (2/10 confidence gate — all findings reported, including speculative)
**Scope:** Full monorepo — AgentGuildApp (Next.js), AgentGuildConnect, GatewayAgent, hub, contracts/ (Solidity, deprecated/testnet), solana-program/ (Anchor, active), firestore.rules, CI/CD, skill supply chain.
**Method:** 6 parallel focused audits (secrets/deps, CI/CD & infra, AgentGuildApp lending/trading, backend services, smart contracts, skill supply chain), synthesized below.

---

## CRITICAL

### C1. `hyperliquid-trading` mod has no authorization — any platform user can hijack another org's trading wallet, strategies, and referral rewards
**Confidence:** 9/10 · **Priority:** P0 · Found independently by two audits (CI/CD-infra pass and AgentGuildApp lending/trading pass), confirming the same root cause from different angles.

**Location:** `AgentGuildApp/mods/hyperliquid-trading/server.ts` — `POST /wallet` (L313-329), `DELETE /wallet/:agentId` (L338-342), `POST /trade` (L354-385), `POST /risk-config` (L571-589), `POST /strategy` (L612-650), `POST /strategy/:id/execute-pending` (L754-799), `POST /referral/apply` (L830-842), `POST /settle-trade` (L493-552, **no `ctx` param at all**). Root cause lives in `AgentGuildApp/src/lib/mods/runtime.ts:134-138` and `src/lib/mods/sdk.ts:79-96`.

**Description:** The mod router's only gate is "does *any* valid session exist" — `ModSession` carries no `orgId`, and `ctx.agent` (the per-agent signature path) is permanently null (the code's own comment admits it's "not wired up by the runtime yet"). Every route then trusts `body.orgId`/`body.agentId` outright. Zero calls to `requireOrgMember`/`requireOrgAdmin` anywhere in this file — contrast with `mods/solana-settlement/server.ts:161`, which does check `ctx.session?.role`, and with `src/middleware.ts:228-238`, which correctly strips and re-signs `x-wallet-address` from verified session state before it reaches any `/api/v1` route. This mod is the one place that pattern was never applied.

**Exploit scenarios:**
- `POST /wallet` with `{orgId: <victim>, agentId: <victim>, privateKey: <attacker key>}` silently hijacks the victim's trading wallet. `DELETE /wallet/:agentId` is a trivial DoS against any agent.
- `POST /strategy` plants an attacker-controlled auto-trading strategy on a victim's `agentId`; the victim's own poller later calls `execute-pending` (which hardcodes `isBuy: true`) and executes it against **real funds** — a classic confused-deputy.
- `POST /referral/apply` lets an attacker permanently hijack a victim agent's referral attribution (first-code-wins, no re-check), diverting all future reward payouts (5bps of trading volume) to themselves. Agent IDs are not secret — no guessing required.
- `POST /settle-trade` uses the **request body's** `agentId`, not `task.payload.agentId`, to call `recordTrade`/`accrueReferralReward` — an attacker who knows any completed `taskId` can attribute someone else's real fill to an agentId they control. The replay guard for this is an **in-memory, per-process map** keyed by `(taskId, chain)`, so resubmitting the same `taskId` with a different `chains` value can retrigger the reward accrual.
- `POST /strategy/:id/webhook-token` lets any signed-in user rotate/revoke another agent's TradingView webhook by knowing/guessing the strategy id.

**Remediation:** Wire `ctx.agent` for real, or at minimum add org-membership/ownership checks (mirroring `solana-settlement`'s pattern or `/api/v1/lending`'s `requireOrgMember`) to every non-public route in this mod before trusting `body.orgId`/`body.agentId`/`task.payload`. Make the settlement de-dup durable (Firestore-keyed by `taskId` alone) instead of in-memory. This should block merge of the current lending/hyperliquid working-tree changes.

---

### C2. Solana program `initialize` has no authority check — first caller after deploy becomes permanent admin
**Confidence:** 8/10 · **Priority:** P0-before-mainnet (not yet live-exploitable; no mainnet entry exists in `Anchor.toml` today)

**Location:** `solana-program/programs/agent_guild/src/registry.rs:20-41`, `treasury.rs:14-43`.

**Description:** `Initialize` has no constraint on who may call it — whoever calls it first becomes `config.authority` permanently (singleton PDA), and `authority` gates `register_agent_for`, `update_credit`, `resolve_dispute` (and its payout split), `withdraw` (full treasury drain to an arbitrary `UncheckedAccount`), and `resolve_penalty_proposal`. `InitializeTreasury` is gated on `config.authority == payer`, so whoever wins the `initialize` race also controls treasury init. `solana-program/migrations/deploy.ts` is an empty stub — there is no atomic deploy+initialize script in this repo today; `initialize` is currently called ad hoc in tests only.

**Exploit scenario:** Program ID becomes public the instant deployment lands. If the team's `initialize` call isn't bundled atomically with deployment, an attacker watching program deployments calls `initialize` first, becomes `authority`, then calls `initialize_treasury` — total admin takeover before the real team notices.

**Remediation:** Hardcode the expected authority pubkey as a program constant and check it in `initialize`, or verify `payer` against the program's BPF upgrade authority via the ProgramData account. At minimum, write an atomic deploy+initialize script before any devnet/mainnet exposure that isn't fully trusted. Flag as a candidate for formal verification given it's an authorization-flow + fund-custody finding that test coverage alone won't give high confidence on (current test suite has zero negative/adversarial tests).

---

### C3. Cross-tenant message read/write via unguarded legacy WebSocket handlers in `hub`
**Confidence:** 8/10 · **Priority:** P0

**Location:** `hub/index.mjs`, legacy WS message types `subscribe`/`unsubscribe`/`message`/`typing`/`message:ack`/`task:assign`/`task:accept` (~L1740-1865), calling `subscribeToChannel()` (~L430-451) and `broadcastToChannel()`/`persistMessage()` with a **client-supplied `channelId` and zero org-ownership check**.

**Description:** The newer structured-message path (`message-router.mjs routeBroadcast()`, L208-217) correctly validates `channelDoc.data().orgId !== orgId` before delivery — the older inline WS handlers in `index.mjs` were never updated to match.

**Exploit scenario:** Any authenticated agent (in any org) that learns another org's Firestore channel ID sends `{"type":"subscribe","channelId":"<victim-channel>"}` over its own legitimately-authenticated WS connection → live-streams that org's private channel traffic, and can also `{"type":"message","channelId":"<victim-channel>",...}` to **write** into it — a cross-tenant confidentiality *and* integrity break.

**Remediation:** Add the same `orgId` ownership check used in `routeBroadcast` to every legacy inline handler, or retire them in favor of the structured path entirely.

---

## HIGH

### H1. Global `~/.claude/settings.json` has an unconstrained `Bash` permission, added by a third-party skill installer — outside the app, but affects everything this machine's agents can do
**Confidence:** 10/10 (read directly) · **Priority:** P0 for you to review, independent of the codebase

A bare `"Bash"` entry (no command-pattern restriction) sits in `permissions.allow`, installed by `~/.superstack/manifest.json`'s `"installedBy":"superstack"` / `"permissionsAdded":["Bash","Read","Glob","Grep"]` — not something manually reviewed and granted. Every installed skill, including this `cso` audit skill itself (self-reported — see its own frontmatter: `allowed_tools: [Bash, Read, Grep, Glob, Write, Agent, WebSearch, AskUserQuestion]`, "Adapted from gstack," third-party origin), can run arbitrary shell commands with no prompt. The same installer mirrored every skill into `.claude/skills/`, `.codex/skills/`, and `.agents/skills/` in one shot.

**Remediation:** Replace the bare `Bash` allow entry with scoped command patterns; review what the superstack installer granted itself; consider moving broad grants to per-project `settings.local.json` reviewed individually. (This is a config change outside this session's scope to make unilaterally — flagging for your decision.)

### H2. ~32 globally-installed "superstack" skills (including `cso`) phone telemetry to a third-party backend before the consent gate takes effect, and a live bearer token sits in the same file they all read
**Confidence:** 9/10 · **Priority:** P1

`~/.superstack/config.json`'s default `telemetryTier` is `"anonymous"` (not "unset"), so the very first invocation on a fresh machine already POSTs to `https://sensible-crocodile-923.convex.cloud/api/mutation` before any explicit opt-in happens — confirmed live in `~/.superstack/telemetry.jsonl`, including two beacons from this very session. The same config file also holds a plaintext bearer JWT (`copilotToken`, scope `colosseum_copilot:read`, exp 2027-07) that every Bash-enabled superstack skill can read on invocation. **Remediation:** fix the default-state logic so no network call fires pre-consent; move the token out of a file generic automation reads; rotate it.

### H3. Live Firebase admin key, Solana platform signing key, and wallet-encryption master key sit in plaintext in `AgentGuildApp/.env.local`
**Confidence:** 9/10 (format-confirmed) · **Priority:** P1 (not a git-exposure issue — never committed, properly gitignored — but real material at rest)

`FIREBASE_PRIVATE_KEY` (valid PKCS8 PEM for the Firebase Admin SDK — bypasses all `firestore.rules` if exfiltrated), `SOLANA_PLATFORM_KEYPAIR` (signs sponsored on-chain agent registration/credit updates), and `AGENT_WALLET_ENCRYPTION_KEY` (the AES-256-GCM master key that decrypts **every** custodial agent wallet stored in Firestore) all live unencrypted on this dev machine. **Remediation:** rotate all three if this machine/directory was ever backed up, synced, or shared; move to GCP Secret Manager / Vault for any non-local environment.

### H4. `hub` bridge webhook fails open with no secret configured, binds all interfaces by default
**Confidence:** 7/10 · **Priority:** P1

`AgentGuildConnect/scripts/bridge.mjs:345-354` — `verifySignature()` returns `true` unconditionally when `BRIDGE_WEBHOOK_SECRET` isn't set (the out-of-the-box state; nothing enforces it at startup unlike `AGENT_ID`/`RUNTIME_URL`, which do `process.exit(1)` if missing). `server.listen(PORT)` binds all interfaces. Combined: an operator who deploys `bridge.mjs` without setting the secret lets anyone who can reach the port POST a forged message that gets forwarded into the LLM runtime adapter (prompt injection) and the response posted back into the real channel as that agent's reply. **Remediation:** require `BRIDGE_WEBHOOK_SECRET` at startup (fail closed, matching the other required config) or bind to loopback by default.

### H5. Mod-loading system has no real sandbox; the trust-chain module that's supposed to gate third-party mods is never called
**Confidence:** 9/10 · **Priority:** P1 (latent — currently all mods are first-party, but the project's own `sdk.ts` comments anticipate third-party submissions)

`AgentGuildApp/src/lib/mod-integrity.ts` defines `verifyModIntegrity`/`hashManifest` etc. with doc comments describing a "trust-chain" for community mods — zero call sites anywhere outside the file itself. The actual loader (`src/lib/mods/runtime.ts:32-75`) dynamic-`import()`s mod server code directly into the Next.js server process; `mod.setup(ctx)` runs with full Node privileges (filesystem, env/secrets, network, DB). `permissions.json` only defines `events:subscribe`/`events:emit` — nothing gates network/filesystem/DB access. `sync-mods.mjs` validates manifest *shape* only, never mod code content. **Remediation:** before accepting any non-"Agent Guild"-authored mod — real process/worker isolation, network allowlisting per declared permission, wire `mod-integrity.ts` in, static-scan submitted mod source at sync time.

### H6. Dependency hygiene is overdue — 133 npm advisories in AgentGuildApp (3 critical), stale Hardhat toolchain with an RCE advisory
**Confidence:** 8/10 · **Priority:** P1

`npm audit` by subproject: **AgentGuildApp** 3 critical / 23 high / 88 moderate / 19 low — criticals are `protobufjs` (arbitrary code execution, via `@google-cloud/compute`/Trezor wallet-adapter chain), `tar` (file-smuggling, via `e2b`), `websocket-driver` (resource-limit bypass, via `firebase`→`faye-websocket`) — all transitive, all have `fixAvailable: true`. The Solana/wallet-adapter stack directly touching `solana-adapter.ts` (`@coral-xyz/anchor`, `@solana/spl-token`, `@trezor/*`) is flagged high. **contracts/** (Hardhat, deprecated/testnet-only per its own `DEPRECATED.md`) has 14 high including `serialize-javascript` (RCE via `RegExp.flags`) and `adm-zip` (privilege-preservation-on-extraction) — build/CI-time only, but the toolchain eventually touches real deployer keys. **GatewayAgent** (the service that executes Hyperliquid trading subprocesses) is clean — 0 vulnerabilities. **Remediation:** scheduled `npm audit fix` pass across all 6 subprojects; exact-pin wallet/signing-adjacent packages (`@coral-xyz/anchor`, `@solana/web3.js`, `ethers`, `bs58`) instead of `^` ranges; add `cargo audit` to CI (not currently run — `cargo-audit` isn't even installed in this environment).

### H7. `firestore.rules`: open counter writes on `gigs`, cross-tenant read on `usageRecords`, self-flagged coarse rule on `nodes`
**Confidence:** 7-9/10 (self-acknowledged for `nodes`) · **Priority:** P1

- `gigs` (L313-322): any authenticated user can rewrite `orderCount`/`avgRating`/`ratingCount` on **any** gig listing — the ownership-check OR-branches for those two field sets have no buyer/ownership condition at all, just `request.auth != null`. Lets anyone inflate their own listing or sabotage a competitor's.
- `usageRecords` (L70-73): `allow read: if request.auth != null` — no `orgId` scoping, unlike every other collection in this file.
- `nodes` (L333-340): literal in-file comment `// TODO(security): could not determine org-scoping field, still coarse` — open read+write to any authenticated user, author-acknowledged as unresolved.

**Remediation:** require buyer-verification (against a real completed order doc) and/or move counter updates to Admin-SDK-only increments for `gigs`; scope `usageRecords` reads to `isOrgMember(resource.data.orgId)`; resolve the `nodes` TODO before it's exploited.

---

## MEDIUM

| # | Finding | Location | Confidence |
|---|---|---|---|
| M1 | Mod routes (`/api/mods/*`) are completely exempt from the app's only rate limiter (middleware only matches `/api/v1`) | `src/middleware.ts:201-215` vs. all hyperliquid mod routes | 8/10 |
| M2 | Workflow webhook HMAC check silently no-ops when no secret configured; doc-promised auto-generation never implemented | `src/app/api/workflows/webhook/[policyId]/route.ts:52`, `triggers.ts:68-69` | 7/10 |
| M3 | `hub` `POST /agents/:agentId/invoke` and `GET /diagnostics` have no rate limiting (every other authenticated path does) — unbounded in-memory state growth / Firestore-read amplification | `hub/index.mjs` ~L984-1067, ~L864-971 | 8/10 |
| M4 | `subscribe` WS message isn't idempotent — unbounded Firestore listener accumulation per long-lived connection (DoS/cost) | `hub/index.mjs` ~L1740-1746 | 7/10 |
| M5 | `isAgentPaused()` fails open on a transient Firestore read error — re-confirm this is an accepted tradeoff for an incident-response control | `hub/index.mjs` ~L631-644 | 6/10 |
| M6 | `skills-lock.json`'s pinned hash doesn't match the file it's meant to pin, and nothing in the repo verifies it anyway — decorative, false-assurance control | `skills-lock.json`, `agent/skills/appkit/SKILL.md` | 9/10 |
| M7 | Solana: ASN squatting persists — `deactivate_agent` never closes the `AsnRecord` PDA, permanently unavailable even to the original owner | `solana-program/.../registry.rs:201-206` | 7/10 |
| M8 | Solana: "Claimed but abandoned" task has no autonomous timeout — escrow can sit indefinitely if claimant ghosts and poster/admin don't act | `solana-program/.../task_board.rs:80-114` | 6/10 |
| M9 | Chained A01→privilege-escalation: `grok-reply.mjs` executes (not just describes) DM-channel instructions with `--permission-mode bypassPermissions`; combined with C3's channel-ACL gap this is a believable path to agent-takeover if DM channel IDs are learnable by an outsider | `AgentGuildConnect/scripts/grok-reply.mjs:150-165` | 6/10 (speculative chain) |
| M10 | Webhook design requires embedding the agent's wallet-decryption passphrase in a TradingView alert body in cleartext — undermines the mod's own "zero-knowledge wallet" claim; UI doesn't warn | `mods/hyperliquid-trading/server.ts:172-199` | 7/10 |
| M11 | Railway-deployed services (hub, GatewayAgent, AgentGuildConnect) aren't clearly gated by the `ci.yml` required-checks list — only the Netlify/AgentGuildApp deploy is conditioned on the `gate` job | `*/railway.json`, `.github/workflows/ci.yml:246` | 5/10 |
| M12 | `GET /api/v1/lending/offers?lenderWallet=X` has no auth/ownership check — any caller can enumerate a wallet's full offer history and notes | `src/app/api/v1/lending/offers/route.ts:13-31` | 6/10 |
| M13 | Solana: missing bounds validation on `update_credit` (regression vs. the Solidity original, which enforced 300-900/≤100) | `solana-program/.../registry.rs:223-229` | 8/10 |
| M14 | Solana: inconsistent bps-math widening (`deposit_revenue` uses plain `u64*u64`, `resolve_dispute` correctly widens to `u128`) — fails safe (overflow-checks panics the tx) but is a DoS at extreme deposit sizes | `treasury.rs:90-91` vs `task_board.rs:241` | 7/10 |

---

## LOW / INFORMATIONAL

- GatewayAgent's private-key write has no explicit `0o600` file mode (AgentGuildConnect's equivalent does) — `GatewayAgent/scripts/gateway.mjs:184`.
- `REDIS_URL` presence is validated but not that it's TLS/authenticated — purely an operator-deployment gap, not a code issue.
- `actions/cache@v4` in `ci.yml` is the one action not pinned to a full SHA (everything else is) — low risk, cache action only.
- `hub/Dockerfile` has no `.dockerignore` (every other service does) — defense-in-depth gap, no `.env` currently present to leak.
- Outbound Hyperliquid Info API `fetch()` has no explicit timeout (`mods/hyperliquid-trading/server.ts:52-60`).
- `nginx.conf` has no security headers or proxy-level rate limiting (relies entirely on app-level limiting) — only fronts the WS hub, not the main dashboard.
- Non-constant-time webhook-token comparison (`hyperliquid-store.ts:295`) — low real-world risk given 192 bits of entropy.
- Solana: escrow/rent is never reclaimed on terminal task/proposal states (`close = poster` not used) — accumulating unrecoverable rent cost, not fund loss.
- Solana: single `authority` keypair gates all privileged instructions including full treasury withdrawal — explicitly acknowledged in-code as an interim, non-multisig design; no timelock currently exists.
- `create_penalty_proposal`'s `asn` field isn't validated against the actual `agent_account` passed in — data-integrity/audit-trail issue only; the correct wallet still gets slashed on resolution.
- Hardcoded Hardhat test-account-#0 private key in CI (`DEPLOYER_PRIVATE_KEY`) — public, well-known throwaway, zero real-world value. No action needed.
- `~/.claude/skills/.trash/` retains full copies of deleted skills indefinitely — stale cruft, periodic cleanup only.
- Documented `curl | bash` installer one-liners inside some skill reference docs (not auto-executed) pointing at lower-provenance domains (`solana.new`, `surfpool.run`) alongside legitimate ones (`rustup.rs`) — human-executed only, flagged for awareness.

## Positive controls confirmed (worth preserving, not findings)

- `src/middleware.ts` correctly strips and re-signs `x-wallet-address`/session headers before any `/api/v1` route sees them — this is exactly the pattern C1/H1-class findings are missing elsewhere.
- `lending-verify.ts` is fail-closed and replay-safe: verifies on-chain balance deltas on both sides and claims the tx signature via an atomic Firestore `create()`.
- `solana-adapter.ts` settlement is fail-closed — no "mark funded anyway" path on a failed/unconfirmed transfer.
- Loan offer amount/rate are server-validated against explicit bounds, not trusted from the client.
- `auth-guard.ts` uses `crypto.timingSafeEqual` (with a length check first) for all bearer-secret comparisons.
- No secrets were ever committed to git history, anywhere, across the full repo — confirmed via `git log --all` diff-filter scan.
- `.gitignore` is well-hardened for this exact risk (covers `.env*`, `*.pem`, `*.key`, keypair files, service-account JSON) with repo-specific comments.
- No reentrancy, `tx.origin`, `delegatecall`, or unchecked external-call return values in the (deprecated) Solidity contracts; Solana program sets `overflow-checks = true` and uses `checked_add` for counters.
- CI workflow is otherwise well-pinned (full-SHA actions, `permissions: contents: read`, no `pull_request_target`, no untrusted event-body interpolation, no logged secrets).
- No command/shell injection found at any `child_process.spawn` site across hub/GatewayAgent/AgentGuildConnect — untrusted-input paths consistently use `shell:false` + argv arrays; `safe-env.mjs` strips secret-shaped env vars before subprocess spawn.
- No prompt-injection phrasing, obfuscated content, or unexpected `allowed_tools` found in any project-local or Anthropic-provided skill.

---

## Confidence Calibration

- Total findings: 37 (3 CRITICAL, 7 HIGH, 14 MEDIUM, 13 LOW/INFO)
- CRITICAL: 3 (avg confidence: 8.3/10)
- HIGH: 7 (avg confidence: 8.4/10)
- MEDIUM: 14 (avg confidence: 6.9/10)
- LOW/INFO: 13 (avg confidence: ~6/10, several explicitly non-findings noted for completeness)
- Mode: Comprehensive (2/10 gate)

## Remediation Log (applied 2026-10-01, same session)

Fixed and verified (tsc clean, lint clean, full test suites passing, `detect_changes()` final risk: **low**, 0 affected processes):

- **C1, C2, C3** — see individual write-ups above. C2 verified via a real `solana program deploy` + full 9-test Anchor suite; C3/M3/M4 verified via hub's 25-test suite.
- **H4** — `bridge.mjs` now binds `127.0.0.1` by default when `BRIDGE_WEBHOOK_SECRET` is unset (override via `--host`/`BRIDGE_HOST`), with a startup warning.
- **H7** — `gigs` counter updates now require a strict +1 step (not an arbitrary value) and `avgRating` is bounded 0-5; `usageRecords` reads scoped to `isOrgMember`; `nodes` writes denied (no legitimate client path existed).
- **H6** — dependency audit pass, see table below.
- **M1** — `/api/mods/*` added to middleware's rate-limited path set.
- **M2** — `createTriggerPolicy` auto-generates a webhook secret when none is supplied, matching the type's own doc comment.
- **M3** — `GET /diagnostics` (rate-limited by IP) and `POST /agents/:agentId/invoke` (by agentId) in hub.
- **M4** — hub's `subscribe` WS message is now idempotent per (ws, channelId); no longer opens a redundant Firestore listener on repeat.
- **M6** — `skills-lock.json`'s `computedHash` corrected to the file's actual sha256.
- **M7** — `deactivate_agent` now closes the `AsnRecord` PDA, releasing the ASN for reuse.
- **M8** — `expire_task` extended to cover a `Claimed` task past deadline with no delivery submitted (pure poster self-service, no authority step needed).
- **M9** — traced end-to-end: the DM-poll path (`/api/v1/messages`) was already scoped to the caller's own signed `agentId`; the only real gap was the WS path fixed in C3. No additional change needed.
- **M10** — webhook UI in `client.tsx` now shows a warning that the wallet passphrase must be pasted into TradingView's alert body in cleartext.
- **M12** — `GET /api/v1/lending/offers?lenderWallet=X` now requires the caller's own wallet to match.
- **M13** — `update_credit` enforces the same 300-900/≤100 bounds the Solidity original had.
- **M14** — `deposit_revenue`'s bps math widened to u128, matching `resolve_dispute`.

**H6 — dependency audit, final counts (critical/high/moderate/low):**

| Subproject | Before | After | Notes |
|---|---|---|---|
| AgentGuildApp | 3/23/88/19 (133) | 0/16/78/19 (113) | `npm audit fix` + `protobufjs` override (7.6.5) + added missing `@testing-library/dom` peer dep (was silently relying on hoisting — its absence broke `screen`/`waitFor` imports until fixed). 240/240 vitest tests pass, tsc output identical to pre-fix baseline. |
| hub | 0/0/12/2 (14) | 0/0/11/0 (11) | 25/25 tests pass. |
| GatewayAgent | 0/0/0/0 | unchanged | already clean. |
| AgentGuildConnect | 0/2/5/0 (7) | unchanged | only fix path is a breaking `@solana/web3.js` v3 bump via `@coral-xyz/anchor` — left for deliberate review, not forced. |
| contracts | 0/14/6/13 (33) | unchanged | only fix path is a breaking Hardhat v2→v3 bump — deprecated/testnet-only toolchain, left as-is. |
| solana-program (npm) | 0/7/5/1 (13) | unchanged | same `@solana/web3.js` block as AgentGuildConnect; one benign 1-line lockfile metadata addition applied. |

## Second remediation pass (same day, after explicit "tackle the rest")

- **H1** — global `~/.claude/settings.json`'s bare unscoped `"Bash"` permission removed, restoring the protective effect of the ~1558 already-existing scoped command patterns built up from real usage (nothing new needed inventing — they already covered this machine's actual workflows; the catch-all was just short-circuiting them).
- **New finding, fixed on the spot** — while reading that file, found 5 lines with live plaintext secrets from an unrelated project (LOAR/xLever): an Ethereum-style private key, OpenAI/Google/FAL/Meshy API keys, and a Postgres connection string+password, all captured verbatim because a past "always allow this exact command" approval logged the full command line including its embedded secrets. Removed those entries (stale one-off exact-match rules for already-completed deploy commands — no functionality lost). **You should still rotate those credentials independently** in whatever system manages the LOAR/xLever project — I can't confirm from this repo whether they're still live.
- **M11** — found and fixed a real bug first: the `gate` job in `ci.yml` used `if: always()` but never checked `needs.*.result`, so it unconditionally reported success even when its dependencies failed — a required check that can never fail provides no protection. Fixed, then configured live GitHub branch protection on `main` requiring the (now-meaningful) "Release Gate" check, plus enabled secret scanning + push protection repo-wide (both were off).
- **H6 investigated, not attempted** — confirmed via code inspection: `@solana/web3.js` v2/v3 is blocked upstream (Anchor 0.31.1 hard-pins v1 directly, not as a peer dep — not fixable from this repo's side regardless of effort); Hardhat v3 for `contracts/` isn't worth it given zero enforced tests and the directory's own `DEPRECATED.md` already slating it for deletion. Both correctly left as-is.
- **M5** — `isAgentPaused()` no longer blindly fails open on a Firestore read error. It now trusts the last known cached state (even past its 5s TTL) over an uninformed guess, falling back to "not paused" only when there's truly no prior signal for that agent at all (first contact during an outage).
- **H5 (partial)** — wired `mod-integrity.ts`'s `hashModEntry`/`verifyModIntegrity` into the actual install path (`installMod` now records a `contentHash`; new `verifyModInstallationIntegrity` can detect a mod's capabilities changing after an org approved it). This closes the "dead code" half of the finding. Full process-level sandboxing (real isolation for third-party mod code) remains a genuine architecture decision, not done here — correctly out of scope for a session like this.

**Still not code-fixable, needs your own action:**
- Rotate the LOAR/xLever credentials found above, wherever that project's infrastructure lives.
- H3 — rotate the 3 plaintext secrets in `AgentGuildApp/.env.local` if this machine was ever backed up/shared.
- H5 full sandboxing — a design decision for when/if third-party mods are actually accepted.
- AgentGuildConnect / contracts / solana-program dependency bumps — blocked on upstream (Anchor) or not worth it (deprecated contracts/), re-evaluate later.

## Remediation Roadmap

**P0 — fix before the current lending/hyperliquid branch merges:**
- C1: Add org/agent ownership checks to every `hyperliquid-trading` mod route (est. 4-8h — this is the one that actually blocks the in-progress diff)
- C3: Add org-check to hub's legacy WS handlers (est. 2-4h)
- H7 (`gigs`/`usageRecords`/`nodes` Firestore rules): est. 2-3h

**P0 — before any mainnet deploy of the Solana program:**
- C2: Lock down `initialize` (est. 2-4h + a reviewed atomic deploy script)

**P1 — this sprint:**
- H1/H2 (global settings.json Bash grant, superstack telemetry/token exposure) — your call, outside the codebase
- H3: rotate the three plaintext secrets in `.env.local` if this machine was ever backed up/shared
- H4, H5, H6, M1-M3, M9, M10, M13 — est. 1-2 days combined

**P2/P3 — backlog:**
- Remaining MEDIUM/LOW items above.
