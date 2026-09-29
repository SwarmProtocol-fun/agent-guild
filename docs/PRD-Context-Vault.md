# Context Vault — Persistent Memory for Swarm Agents

> **Component:** Core service (`src/lib/*`, `app/api/*`) — not a mod
> **Version:** 2.3 (supersedes the 155-section greenfield PRD it was derived from; revised against `gitnexus impact`/`context` findings — see §1's verification note and §8)
> **Date:** 2026-09-29
> **Status:** All four phases shipped (§6) — one Definition-of-Done item (§9) remains explicitly unverified: no real embedding-provider API key has been exercised in this environment. Phase 4 (§4.6/§4.7) added the knowledge graph and MCP server surface on top of v2.2's Phases 1–3, both previously listed in §7 as non-goals, once requested directly.
> **Source doc:** an uploaded vision PRD for `@swarm/mod-context-vault` (Firestore + Redis + pgvector + GCS + blockchain proofs + marketplace). This document keeps that PRD's good ideas and drops everything that doesn't match what's actually running.

---

## 0. Why this version exists

The source PRD is a green-field design for a service that doesn't exist yet. But SwarmApp already has two working, shipped memory systems. A PRD that ignores them and re-specifies `interface Memory { ... }` from scratch isn't "the vision" — it's a rewrite nobody asked for. This document is the same product intent, rescoped to: **extend what's live, close the three gaps that actually block agents, and defer everything else.**

---

## 1. Current State (read this before building anything)

Two parallel memory systems exist today, both Firestore-backed, both with **substring-match search only** — no embeddings, no ranking, no token budgeting, no provenance.

### 1.1 Agent Context Library (`src/lib/agent-memory-server.ts`, `memory-templates.ts`, `memory.ts`, `firestore-admin.ts`)
- Collection: `agentMemories`, one doc per `agentId + subtype` (`working_md`, `memory_md`) plus one per `agentId + date` (`daily_note`).
- **Fixed doc IDs on purpose** — the code comment explains a prior bug (query-and-find-or-create silently duplicated docs); don't reintroduce that pattern.
- Writes are agent-signed (`requireAgentAuth`, HMAC over `method:path:bodyHash`) via `POST /api/v1/memory/{append,daily,working}`, landing in three exported functions — `updateWorkingMd`, `appendMemoryMd`, `appendDailyNote` — each with exactly one caller (confirmed via `gitnexus impact`, upstream, on `swarm-core`).
- Section edits go through an **allowlist** (`ALLOWED_SECTIONS`) because `memory-templates.ts` builds RegExps directly from the section name — do not remove that check, it's the only thing standing between a caller-supplied string and a RegExp-injection DoS.
- Read side has **two intentional copies**, not one — `memory.ts`'s `getMemoryEntries` on the client Firestore SDK (called from the `/memory` dashboard page only) and `firestore-admin.ts`'s `getMemoryEntries` on the Admin SDK (called from the four `/api/memory/[agentId]/*` routes only). A code comment in `firestore-admin.ts` documents this split explicitly — it's not drift, don't merge them into one. Both do plain `.includes()` substring search.

### 1.2 Compute Memory (`src/lib/compute/memory.ts`, `compute/types.ts`, `compute/firestore.ts`)
- Separate `MemoryEntry` shape, scoped by `MemoryScopeType = "workspace" | "computer" | "agent" | "user"` rather than org+agent.
- Already has `embeddingRef: string | null` and `pinned: boolean` fields — **stubbed for exactly the two features this PRD adds first.** Nobody has wired them up yet.
- `autoCapture()` writes raw session content with no secret scanning — **but `gitnexus impact` (upstream) and a repo-wide grep both confirm zero callers.** It's dead code today, not a live risk. Don't prioritize redacting a function nothing calls; redact it when a caller is added (§4.5), not before.
- Route: `POST /api/compute/memory/search` — same substring filter as above.

### 1.3 What's missing, in priority order
1. **Real retrieval.** Nothing ranks or embeds. An agent with 500 memories gets them in whatever order Firestore returns, filtered by whether the query string literally appears.
2. **A context budget endpoint.** Nothing answers "what does this agent need for *this* task, in ≤N tokens." Callers currently pull everything and truncate themselves, or don't.
3. **Secret redaction on the three live write paths** — `updateWorkingMd`, `appendMemoryMd`, `appendDailyNote` (§1.1) accept arbitrary agent-supplied content with no scan for API keys/tokens before persisting. (`autoCapture`, §1.2, is not live — see above.)

Everything else in the source PRD (knowledge graph, blockchain memory proofs, vault marketplace, cross-Swarm federation, agent-owned wallets) is speculative product surface with no current pull. Non-goals — see §7.

> Verified via `mcp__gitnexus__impact` (upstream, `repo: swarm-core`) on `searchMemory` ×2, `getMemoryEntries` ×3, `autoCapture`, and `appendMemoryMd`, plus `mcp__gitnexus__context` on `getMemoryEntries` (firestore-admin.ts) and `appendMemoryMd` — not grep alone, per this repo's own CLAUDE.md convention.

---

## 2. Goal

> An agent asks "what do I need to know to do X" and gets back a small, ranked, provenance-tagged, permission-safe answer — instead of every memory it's ever written, or nothing.

Three concrete capabilities, built on the existing schema:

1. **Semantic retrieval** across both memory collections (or their unified successor — see §4.1).
2. **A Context Pack endpoint** — ranked, deduplicated, token-budgeted output, reusing the `pinned` field for always-included memories.
3. **Write-time secret redaction**, applied at the three live ingestion paths (`appendMemoryMd`, `updateWorkingMd`, `appendDailyNote`) and to `autoCapture` if/when it gets a caller.

---

## 3. Design Principles (kept from the source PRD)

- **Memory is data, not instructions.** Retrieved content goes into the agent's context marked as untrusted data (source PRD §56) — this matters more here than in the original doc, because `autoCapture` already ingests raw tool/session output that could contain injected text.
- **Confidence ≠ importance ≠ pinned.** Don't conflate "the agent is sure this is true" with "this should always be retrieved." `pinned` already exists for the second; add the first two only if a concrete caller needs them — don't build the field for its own sake.
- **Retrieval must never leak across scope boundaries.** `agentMemories` docs are already org+agent scoped in `firestore.rules`; `MemoryEntry`'s scope model is workspace/computer/agent/user. Any unified retrieval layer has to resolve permissions *before* running similarity search, not filter results after (source PRD §55 — this is the one architectural point from the original that's worth being strict about).
- **Vault must degrade gracefully.** If embedding generation or the vector layer is down, retrieval should fall back to the existing substring search, not fail the request.

---

## 4. What to Build

### 4.1 Reconcile the two schemas — ✅ RESOLVED (not the option originally proposed)

**Neither A nor B, as it turned out.** A cross-collection migration (Option A) touches live production data and shouldn't happen on the strength of a planning document alone — that's exactly the kind of hard-to-reverse action that needs a dedicated review, not a PRD footnote. Before defaulting to Option B (merge-query layer) either, the actual write-up of what each schema *holds* changed the picture:

- The agent-context library (`agentMemories`) is **2–3 large, incrementally-edited markdown documents per agent** (working notes, long-term memory, one daily note per date). An agent has a handful of these documents, ever. Embedding a whole growing markdown doc and ranking it against 1–2 sibling docs adds infrastructure without adding retrieval value — there's nothing to rank.
- Compute memory (`compute/memory.ts`'s `MemoryEntry`) is **many small discrete entries per scope** — the shape semantic search and ranking are actually for, and the one that already had `embeddingRef`/`pinned` stubbed in.

**Decision: build retrieval where it structurally fits — on `compute/memory.ts` — and leave the agent-context library alone.** Not a migration, not a permanent merge-query layer either; the two systems keep serving genuinely different purposes (a notebook vs. a queryable fact store) rather than being forced into one shape. If a future Context Pack (§4.4) needs to include an agent's working notes, it can call `getExistingMemory()` directly — no search needed over 2–3 documents, just inclusion.

### 4.2 Embeddings — ✅ SHIPPED

Implemented in `src/lib/compute/embeddings.ts`, mirroring this codebase's own `compute/provider.ts` pattern (interface → real implementation → stub for tests → factory), not a from-scratch design:

- `EmbeddingProvider` interface, `OpenAIEmbeddingProvider` (model `text-embedding-3-small`, 1536 dims), `StubEmbeddingProvider` (deterministic hash-seeded vectors, no network — for tests), `getEmbeddingProvider()` factory.
- **`getEmbeddingProvider()` returns `null` when nothing is configured — never throws** in its ambient/auto-detect form. Unlike `compute/provider.ts`'s compute providers (where an explicit, unavailable selection is an error — "phantom instances are worse than errors"), nobody explicitly opts into "no embeddings" by default; it's the ambient state when unconfigured, and semantic search is an enhancement over substring search, not a hard requirement. Confirmed live in this environment: **no embedding-provider credential is configured locally**, so `getEmbeddingProvider()` returns `null` here today, and every provider's HTTP path is unit-tested against a stubbed `fetch`, not verified against a real API.

**Multi-provider, added after initial ship — "each agent will have different models, should work with any model."** `getEmbeddingProvider()` originally only spoke OpenAI. Extended to all four backends this codebase's own `ModelKey` taxonomy (`compute/types.ts`: `claude | openai | gemini | generic`) already uses for agents/computers elsewhere — `VoyageEmbeddingProvider` (Anthropic's recommended embeddings partner; Anthropic has no first-party embeddings API of its own, so `claude` maps to Voyage), `GoogleEmbeddingProvider` (`gemini`, reuses the existing `GOOGLE_AI_API_KEY` from `.env.example`'s "AI providers (for agent personas)" section rather than asking for a second Google credential), `GenericEmbeddingProvider` (`generic` — any OpenAI-compatible embeddings endpoint via `EMBEDDING_BASE_URL`, covering self-hosted/local models: Ollama, LM Studio, text-embeddings-inference, vLLM). New `EmbeddingCredentialError` (mirrors `provider.ts`'s `ProviderCredentialError`) for the explicit-selection path.

**One constraint stated explicitly in the code, worth restating here because it's easy to get wrong:** provider selection is per-deployment, not per-write. Cosine similarity is only meaningful when the query vector and the candidate vectors came from the *same* embedding model — different models produce vectors with different dimensionality and semantics, so an OpenAI-embedded memory compared against a Voyage-embedded query isn't imprecise, it's meaningless. So `getEmbeddingProvider()` has two modes, not one:
- **Ambient (no argument)** — what `rememberMemory`/`hybridSearchMemory` actually call. Auto-detects the first configured credential in a fixed order, or honors a deployment-wide `EMBEDDING_PROVIDER` pin. Always resolves to *one* provider for the whole deployment; never throws.
- **Explicit (`modelKey` argument)** — for administrative/provisioning use, not per-write dynamic dispatch. Throws `EmbeddingCredentialError` if that specific backend's credential is missing, matching `compute/provider.ts`'s explicit-selection convention.

New env vars documented in `.env.example`: `VOYAGE_API_KEY`, `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_PROVIDER`. `OPENAI_API_KEY` and `GOOGLE_AI_API_KEY` are reused from the existing agent-persona section rather than duplicated. Tests: 41 cases in `embeddings.test.ts` (up from 17) — ambient auto-detect priority order, `EMBEDDING_PROVIDER` pinning and its own graceful-degrade-to-null, explicit `modelKey` mapping and its credential-error path, and the same four-case network contract (no-credential/non-ok/malformed/well-formed) run against all four real providers via a shared test helper rather than copy-pasted per provider.
- `embeddingRef` was repurposed as a SHA-256 content hash (dedup key, source PRD §123) rather than a pointer to external vector storage — there is no external vector store. A new `embedding: number[] | null` field on `MemoryEntry` holds the vector directly on the Firestore doc.
- No async job queue exists in this codebase for memory writes, and standing one up would be exactly the kind of new infrastructure this PRD said not to provision speculatively. Embedding happens inline, awaited within the write request (`rememberMemory()` in `compute/memory.ts`) — one extra network round trip per write. Revisit only if that latency proves to be a real problem under load.
- Storage: no pgvector, no Redis vector cache either, in the end — the vector lives directly on the entry's own Firestore doc and cosine similarity runs in-process against the scope's fetched entries. Simpler than the Upstash-cache design floated in an earlier draft of this section, and sufficient at current write volume; add caching only if query latency becomes a measured problem, not ahead of one.

### 4.3 Retrieval — hybrid, not vector-only — ✅ SHIPPED

Implemented as `hybridSearchMemory()` in `compute/memory.ts`, wired into `POST /api/compute/memory/search` (its confirmed single caller):

```
query
  │
  ├─ substring match (existing searchMemory(), unchanged, still exported standalone)
  ├─ cosine similarity (new — only when both a query embedding and the entry's own embedding exist)
  ▼
score = 0.5·similarity + 0.2·substring-hit + 0.3·pinned
  ▼
drop entries matching neither substring nor a similarity > 0.15
  ▼
top N
```

Permission/scope filtering happens **before** ranking by construction, not as a separate step — `getMemoryEntries(scopeType, scopeId, ...)` only ever fetches within the already-authorized scope; there's no unscoped candidate pool to filter after the fact (source PRD §55's concern doesn't apply here the way it does in a system that queries broadly then filters).

Simplified from the source PRD's 7-term formula (§16) — importance/confidence/access-frequency terms are cut because nothing populates those fields. **The 0.5/0.2/0.3 split is a starting point, not a derived result** (same status as the source PRD's own untuned weights) — tune against real retrieval quality once there's real usage to tune against.

**Degrades gracefully, by test:** if no provider is configured (true in this environment right now) or the provider throws (rate limit, network error), `hybridSearchMemory` falls back to substring-only ranking rather than failing the request — covered by `compute/__tests__/memory.test.ts`.

Tests: `compute/__tests__/embeddings.test.ts` (17 cases — cosine similarity edge cases, content hashing, stub provider determinism, the null-when-unconfigured factory behavior, OpenAI provider error paths against a stubbed `fetch`) + `compute/__tests__/memory.test.ts` (10 cases — ranking order, pinned boost, graceful degradation, semantic-only matches, exclusion of non-matches, `rememberMemory`'s embedding population). 27/27 passing; full suite 215/215. `tsc --noEmit`: zero new errors (26 pre-existing, unrelated, confirmed by diffing against `git stash`). `gitnexus detect_changes --scope all`: `risk_level: "medium"`, 2 affected processes — both are the two edited routes' own handlers, not downstream ripple.

**A note on how this almost went wrong:** adding the `embedding` field to `MemoryEntry` first came back from `gitnexus impact` as **CRITICAL risk, 82 impacted symbols, 58 direct**. Per this repo's own CLAUDE.md, that's not a warning to wave off. But a direct grep showed only 5 files actually reference `MemoryEntry` by name — the other ~53 were files importing `compute/types.ts` (a shared barrel module) for *other* exported types entirely, misattributed to this one symbol by file-level import tracking. Confirmed by spot-checking three of the listed "impacted" files (`compute/admin/page.tsx`, `azure-product-selector.tsx`, `computer-card.tsx`) for zero actual references. The field was added as optional/backward-compatible once that was confirmed. Worth remembering for this codebase specifically: a CRITICAL/HIGH result on a symbol from a widely-imported shared-types file needs a text-search sanity check before it's trusted *or* dismissed — same "don't proceed on the strength of a zero" discipline CLAUDE.md already states for `UNKNOWN`, applied to a suspiciously large non-zero instead.

### 4.4 Context Pack endpoint — ✅ SHIPPED (not the endpoint originally sketched below)

This is the single highest-leverage addition from the source PRD (its §19/§20 "Context Pack" concept) — everything else in that doc is in service of making this endpoint good.

The original plan, kept here only as a record of what was *not* built, so the reasoning below makes sense in context:

```
POST /api/v1/memory/context
{ agentId, task, tokenBudget }
→ { summary, memories: [{content, source, score}], pinned, tokenCount, sources }
```

Before writing that, `gitnexus impact` on `getExistingMemory`/`getDailyNoteIfExists` (the two functions doc-commented "used by the context endpoint") surfaced that **`GET /api/v1/context` already existed** — a shipped, agent-signed endpoint merging working memory, long-term memory, today's daily note, and recent chat messages, with keyword filtering (`q`) and a markdown output mode. It explicitly does *not* use embeddings, "per product decision" (its own code comment). Building a second, competing `/api/v1/memory/context` endpoint with a different shape would have fragmented the API and second-guessed a decision someone already made deliberately.

**What actually shipped: extended the existing endpoint, additively.**
- **`tokenBudget` param (new default behavior)** — the endpoint previously returned everything unbounded (memory docs can grow indefinitely via `appendMemoryMd`/`appendDailyNote`; message history was only bounded by count, not size). Now defaults to 8000 tokens, clamped to `[500, 32000]`. Truncation logic lives in a new pure module, `src/lib/context-pack.ts` (`buildContextPack`), kept separate from the Firestore-aware route so it's unit-testable without mocking Firebase Admin. v1 truncation is **all-or-nothing per document** — no sensible way to clip a markdown doc mid-section, so a doc that doesn't fit is omitted whole (source PRD's own "truncate greedily... stop there for v1" instruction, taken literally). Priority order preserved from the existing endpoint's own layout: working → longTerm → daily → rankedMemories → messages.
- **`task` param (new, fully additive)** — when given, runs `hybridSearchMemory("agent", agentId, task, ...)` from Phase 2 and includes the results as `rankedMemories`. Omitting `task` leaves every other field byte-for-byte identical to before this change — this does not touch the "no embeddings" keyword-filter (`q`) behavior at all; they're independent, composable filters. Degrades to substring-only ranking automatically if no embedding provider is configured (still true in this environment — see §4.2).
- Response gained `rankedMemories`, `tokenBudget`, `tokenCount`, `truncated`, `omitted` fields. The markdown output mode gained a "Relevant Memories" section and a truncation notice line.
- Token estimation: `src/lib/token-estimate.ts`, ~4 chars/token — an estimate, not a real tokenizer (no tiktoken in this codebase). Good enough for greedy budgeting, not for exact billing.
- Tests: `context-pack.test.ts` (9 cases — full inclusion, all-or-nothing doc omission, priority order, ranked-memory/message prefix truncation under budget, zero-budget edge case, no input mutation). Full suite 224/224 passing. `tsc --noEmit`: zero new errors (one narrowing fix needed — `toMarkdown`'s message param was typed against the fuller `ContextMessage` when it only ever reads 4 of its fields; narrowed to `ContextMessageInput` instead of widening the pack's output type to match).
- Skipped for v1, per this section's own instruction: the source PRD's clustering/MMR-diversity step (§21/§61) — not built, no duplicate-heavy retrieval observed yet to justify it.

**On `gitnexus detect_changes` after this change:** it reported `risk_level: "high"`, 15 affected processes — worth recording *why* that's not alarming, since a bare "high" reading without this context would misrepresent the actual change. `detect_changes --scope all` reports over the *entire* dirty working tree, not a diff scoped to one session's edits, and this repo (branch `fix/restore-core-after-strip`) had substantial unrelated uncommitted changes in it before this work started and picked up more mid-session (`credit-events/ingest.ts`, `credit-events/store.ts`, `fraud-detectors/*`, `middleware.ts`, login/landing pages — confirmed via `git diff --stat` and file mtimes to be untouched by any tool call made here). Of the 15 affected processes, the ones actually attributable to this change are the edited route's own (unchanged) downstream call graph — auth, rate-limiting, `adminDb()` — showing up as "changed" because the route's entry point changed, the same proportionate pattern seen in Phase 1 and 2's verified-safe edits. The rest trace to those unrelated files.

### 4.5 Secret redaction on write — ✅ SHIPPED

**Correction to an earlier draft of this PRD:** it claimed no secret scanner existed anywhere in the codebase. That was wrong — `src/lib/secret-scanner.ts` already existed, fully implemented and tested (`secret-scanner.test.ts`, 17 patterns: OpenAI/Anthropic/AWS/GitHub/Stripe/Slack/Discord/Telegram/Twilio keys, PEM private keys, JWTs, DB connection strings), just never called from the memory write paths. `gitnexus impact` on `sanitizeText` confirmed zero callers before this change. So Phase 1 wasn't "write a redaction module" — it was "wire the existing one in," which is a smaller, lower-risk change than originally scoped.

Implemented in `src/lib/agent-memory-server.ts`:
- New `redactBeforePersist(raw, agentId, targetDocId)` helper calls `scanForSecrets` once; on a clean scan (the common case) it returns immediately with no second pass. On a hit, it `console.warn`s the doc id + deduped secret **types** (never the matched value) and returns `sanitizeText(raw)`.
- Wired into all three live write paths confirmed by `gitnexus impact` in §1.1 — `updateWorkingMd`, `appendMemoryMd`, `appendDailyNote` — each redacts its input before it reaches the Firestore transaction.
- `autoCapture` in `compute/memory.ts` still has zero callers (§1.2) — intentionally left alone. Add the same `redactBeforePersist` call when it gets wired to a real caller, as a condition of that work landing, not as separate effort now.
- Tests: `src/lib/agent-memory-server.test.ts` (5 cases — clean passthrough, redaction, no-log-of-raw-value, no-warn-when-clean, type dedup). 22/22 passing across both files. `tsc --noEmit` clean. `gitnexus detect_changes --scope all` → `risk_level: "low"`, `affected_count: 0`, zero affected execution flows.

---

## 5. Security (build on what exists, don't reinvent)

- Reuse `firestore.rules`' deny-by-default pattern for any new collection (vector cache metadata, redaction audit log). Server-only Admin SDK writes, explicit client rules only where a dashboard page genuinely needs read access — same audit discipline already documented at the top of `firestore.rules`.
- Reuse `requireAgentAuth` (HMAC-signed requests) for the new `/context` endpoint — same auth model as `/append`.
- Extend `ALLOWED_SECTIONS`-style allowlisting to any new caller-supplied string that reaches a RegExp or query builder. This codebase has already been bitten by that once (see the comment in `agent-memory-server.ts`); don't reintroduce it in the retrieval layer.

---

## 6. Roadmap

**Phase 1 — ✅ Done:** Secret redaction on the three live write paths (§4.5). No schema changes, no new infra — turned out to be wiring up an existing scanner, not building one.

**Phase 2 — ✅ Done:** Schema decision (§4.1, resolved as "don't migrate, build on compute/") + embeddings (§4.2) + hybrid retrieval (§4.3). No migration script needed — the resolution avoided requiring one.

**Phase 3 — ✅ Done:** Token-budgeted, task-aware context (§4.4) — shipped as an extension of the pre-existing `GET /api/v1/context` endpoint rather than a new one, once impact analysis surfaced that it already existed.

**Phase 4 — ✅ Done:** Knowledge graph (§4.6) + MCP server surface (§4.7) — requested explicitly after Phase 1–3 shipped, reversing this document's original "no caller need identified" / "building the adapter before the feature it adapts is backwards" calls for those two items. Both built as thin additive layers on the same primitives Phases 1–3 already shipped, not new infrastructure.

**Still open, not scheduled as a phase:** a live check of the OpenAI embeddings path once `OPENAI_API_KEY` is actually configured somewhere it can be tested end-to-end — every embedding-dependent code path (Phase 2 and 3) has only been verified against a stubbed provider/`fetch` in this environment, never the real API.

**Explicitly not scheduled:** everything in §7.

### 4.6 Knowledge graph — ✅ SHIPPED

Source PRD §27/§28/§76/§139, scoped exactly to §139's own instruction: no graph database, edges live in the existing Firestore persistence layer as plain docs — a two-query lookup ("what's connected to X"), not a traversal engine.

- New `graphEdges` collection (`compute/firestore.ts`: `createGraphEdge`, `getGraphEdgesForEntity` — two queries, `from`-match and `to`-match, merged and deduped since Firestore has no OR-across-fields; `deleteGraphEdge`).
- Business-logic layer `compute/graph.ts`: `linkEntities(orgId, from, to, relation, createdBy?)` and `getRelatedEntities(orgId, entity, opts?)`. Validates entity type (`agent | task | project | memory | document`) and bounds id/relation length — doesn't verify the referenced entity actually exists, same trust level this codebase already gives other cross-collection references (e.g. `Task.assigneeAgentId`).
- REST: `POST /api/compute/memory/link`, `GET /api/compute/memory/graph` — wallet + `requireOrgMember`, matching the `/api/compute/workspaces` auth tier (org-scoped resource, not admin-only).
- No `firestore.rules` change needed — the ruleset's own catch-all denies any collection not explicitly allow-listed, so `graphEdges` is deny-by-default automatically (confirmed by reading the rules file, not assumed).
- Tests: `compute/__tests__/graph.test.ts`, 10 cases (valid link, relation trimming, createdBy pass-through, invalid entity type, empty id, empty/oversized relation, invalid createdBy, delegation + validation-before-firestore-call on the read side).

### 4.7 MCP server surface — ✅ SHIPPED

Source PRD §43/§44, reversing this doc's earlier "revisit once ... an actual MCP-based caller exists" call — requested directly rather than waiting for one.

- `POST/GET/DELETE /api/v1/mcp` using `@modelcontextprotocol/sdk`'s `WebStandardStreamableHTTPServerTransport` (Web-standard `Request`/`Response`, not the Node-`http`-specific transport) — one `McpServer` + transport instance per request, stateless (`sessionIdGenerator: undefined`), matching every other route in this app being a stateless serverless function with no in-memory session store to leak across invocations.
- Auth: `x-agent-id` + `x-agent-api-key` headers, checked via the same `authenticateAgent()` primitive `requireAgentAuth`'s API-key tier already uses — the header-based equivalent of that tier (MCP clients configure headers on their transport, not query params), not a new auth mechanism.
- Five tools, each a thin wrapper (`src/lib/mcp-tools.ts`, unit-tested independent of the transport) over an already-shipped capability:
  - `context_remember` → `rememberMemory()` (Phase 2), defaults to the calling agent's own scope. New write path, so it gets the same secret-redaction treatment as the three paths in §4.5 (scan → warn on type, never log the value → `sanitizeText`) rather than being exempted as a fourth unredacted path.
  - `context_recall` → `hybridSearchMemory()` (Phase 2).
  - `context_pack` → `assembleAgentContext()`, a function extracted from `GET /api/v1/context`'s handler body (§4.4) so the REST route and this tool share one implementation instead of two that can drift. Verified via `mcp__gitnexus__impact` that the route's `GET` has zero upstream callers before refactoring its internals; the extraction preserves the exact same fetch → optional `q`-narrow → `buildContextPack` sequence and is covered by its own test file (`agent-context-pack.test.ts`, 8 cases) in addition to the pre-existing `context-pack.test.ts`.
  - `context_link` / `context_graph` → §4.6's `linkEntities`/`getRelatedEntities`, defaulting the "from" entity to the calling agent.
  - Not included: `context_forget`/`context_update`/`context_search_documents` — deletion/update already exist as REST (`PATCH`/`DELETE /api/compute/memory/[id]`) and document ingestion isn't built; growing the MCP surface to match the source PRD's full tool list wasn't asked for.
- `@modelcontextprotocol/sdk` and `zod` added as direct dependencies (zod was already present transitively via the SDK; pinned explicitly since route code imports it directly).
- Tests: `mcp-tools.test.ts`, 14 cases covering defaulting, validation, redaction, and error-wrapping for all five tools' logic. The route itself (transport wiring) is intentionally thin and untested directly — same "logic in lib, routes are thin glue" split as the rest of this codebase.
- Full suite after Phase 4: 286/286 passing (was 247/247 after Phase 3). `tsc --noEmit`: no new errors from any Context Vault file (verified by diffing the error list before/after against filenames, not just a raw count — the raw count did move, from 25 to 28, but all three new lines are `.next/`-generated typegen artifacts and an unrelated already-modified `layout.tsx`, none touching this feature).

---

## 7. Non-Goals

These were in the original 155-section doc as future phases (its own §100–110, §140+). Two items that were listed here as non-goals in earlier drafts of this document — the knowledge graph and the MCP server surface — shipped in Phase 4 (§4.6/§4.7) once actually requested; the remainder stay out of scope because nothing in this codebase or its users is asking for them, and each is a multi-week project in its own right:

- Blockchain memory proofs, agent-owned wallets, on-chain hashes (source §106–108) — no product requirement, adds a dependency (`contracts/`) this feature doesn't need.
- Context/knowledge marketplace (source §110–111).
- Cross-Swarm federation, vault export/import portability (source §104–105, §109).
- Packaging this as a `SwarmApp/mods/` package (source §101–103) — memory is core infrastructure other core code already depends on (`agent-memory-server.ts` is imported outside any mod boundary); moving it into the mod system's trust boundary (see `docs/mod-sdk.md` — mods are unsandboxed but still a separate install unit) would be a regression, not a packaging improvement.

---

## 8. Open Questions

1. ~~§4.1 decision — needs a call from whoever owns `compute/` vs. the agent-context library.~~ **Resolved**, see §4.1 — not something an impact check alone could answer, so this one was a judgment call rather than a verified finding: build retrieval on `compute/`, leave the agent-context library as-is.
2. ~~Does anything depend on `searchMemory()`'s exact substring-match behavior?~~ **Resolved.** `gitnexus impact` (upstream) shows each `searchMemory` — `memory.ts`'s and `compute/memory.ts`'s — has exactly one caller (the `/memory` dashboard page, and the `/api/compute/memory/search` route, respectively). Both are LOW risk, single-caller, no test coverage found depending on literal-string semantics. Hybrid retrieval is safe to introduce behind those same call sites.
3. ~~Confirm SwarmApp's API routes have a Redis connection path before assuming §4.2's vector cache is free.~~ **Resolved — and the original assumption was wrong.** SwarmApp has no `ioredis` anywhere in `src/` or `package.json`; `hub/redis-state.mjs`'s Redis is a different deployable. SwarmApp does have `@upstash/redis` already provisioned (rate limiting). §4.2 above has been corrected to use that instead.

---

## 9. Definition of Done (v1)

```
✅ No live write path (appendMemoryMd/updateWorkingMd/appendDailyNote) persists an
   unredacted secret; autoCapture gets the same treatment when it gains a caller — DONE
✅ Schema decision made and documented (not left ambiguous) — DONE, resolved as
   "build on compute/, don't migrate agentMemories" (§4.1), not either option
   originally proposed
⚠️ Semantic search returns results ranked better than substring-match alone —
   MECHANISM DONE, ranking/fallback logic unit-tested (StubEmbeddingProvider),
   but NOT verified against a real query on real agent memory with a real
   embedding provider — no OPENAI_API_KEY is configured in this environment
   (§4.2). Live verification is still outstanding.
✅ /context endpoint returns a token-budgeted pack — DONE (§4.4). Attribution is
   partial: each ranked memory carries its id + score, but there's no separate
   score-breakdown explainability ("why was this selected") — deferred, matches
   §4.4's own "stop there for v1" scope note.
✅ Retrieval falls back to substring search if embedding/vector lookup fails — DONE,
   tested (provider throws → substring-only ranking, in both hybridSearchMemory
   and the /context route's task param).
✅ Permission scope is resolved before ranking, not after — DONE by construction
   (hybridSearchMemory only ever queries within an already-scoped fetch).
```
