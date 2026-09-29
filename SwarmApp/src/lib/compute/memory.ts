/**
 * Swarm Compute — Memory Service Helpers
 *
 * Context Vault PRD (docs/PRD-Context-Vault.md) Phase 2 — embeddings +
 * hybrid retrieval, scoped to this file's MemoryEntry (not the separate
 * agent-context library in agent-memory-server.ts; see the embeddings.ts
 * doc comment for why those two weren't merged).
 */

import type { MemoryScopeType, MemoryEntry } from "./types";
import { createMemoryEntry, getMemoryEntries } from "./firestore";
import { getEmbeddingProvider, cosineSimilarity, contentHash, type EmbeddingProvider } from "./embeddings";

/**
 * Text-based search across memory entries. Kept as a standalone export —
 * hybridSearchMemory below layers ranking on top of the same substring
 * match, it doesn't replace it.
 */
export async function searchMemory(
  scopeType: MemoryScopeType,
  scopeId: string,
  searchQuery: string,
  opts?: { limit?: number },
): Promise<MemoryEntry[]> {
  const entries = await getMemoryEntries(scopeType, scopeId, { limit: opts?.limit || 100 });
  if (!searchQuery.trim()) return entries;

  const q = searchQuery.toLowerCase();
  return entries.filter(
    (e) =>
      e.content.toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q)),
  );
}

export type ScoredMemoryEntry = MemoryEntry & { score: number; matchType: "semantic" | "substring" | "both" };

/**
 * Hybrid search: substring match (always available) + cosine similarity
 * over stored embeddings (when both the provider and the entry's own
 * embedding are available). Falls back to substring-only if no provider
 * is configured, or if embedding the query itself fails — retrieval must
 * never hard-fail because semantic search is unavailable (PRD §3,
 * "Vault must degrade gracefully").
 *
 * Ranking weights (0.5 similarity / 0.2 substring-hit / 0.3 pinned) are a
 * starting point to tune against real usage, not a derived result — see
 * PRD §4.3's own note on this.
 *
 * `opts.provider` is injectable for tests (pass a StubEmbeddingProvider,
 * or explicitly `null` to force the substring-only path); production
 * callers should omit it and let getEmbeddingProvider() decide.
 */
export async function hybridSearchMemory(
  scopeType: MemoryScopeType,
  scopeId: string,
  searchQuery: string,
  opts?: { limit?: number; provider?: EmbeddingProvider | null },
): Promise<ScoredMemoryEntry[]> {
  const limit = opts?.limit || 100;
  // Over-fetch before ranking/truncating — substring-return order doesn't
  // correlate with the ranked order we're about to compute.
  const entries = await getMemoryEntries(scopeType, scopeId, { limit: limit * 5 });

  if (!searchQuery.trim()) {
    return entries
      .map((e): ScoredMemoryEntry => ({ ...e, score: e.pinned ? 1 : 0, matchType: "substring" }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  const q = searchQuery.toLowerCase();
  const substringMatches = new Set(
    entries
      .filter((e) => e.content.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q)))
      .map((e) => e.id),
  );

  const provider = opts?.provider !== undefined ? opts.provider : getEmbeddingProvider();
  let queryEmbedding: number[] | null = null;
  if (provider) {
    try {
      queryEmbedding = await provider.embed(searchQuery);
    } catch {
      queryEmbedding = null; // degrade to substring-only rather than failing the request
    }
  }

  const scored: ScoredMemoryEntry[] = entries.map((e) => {
    const isSubstring = substringMatches.has(e.id);
    const similarity = queryEmbedding && e.embedding ? cosineSimilarity(queryEmbedding, e.embedding) : 0;
    const score = 0.5 * similarity + (isSubstring ? 0.2 : 0) + (e.pinned ? 0.3 : 0);
    const matchType: ScoredMemoryEntry["matchType"] =
      similarity > 0.3 && isSubstring ? "both" : isSubstring ? "substring" : "semantic";
    return { ...e, score, matchType };
  });

  // Drop entries that matched nothing meaningful — a nonzero pinned boost
  // alone shouldn't surface an otherwise-irrelevant memory for this query.
  const relevant = scored.filter((e) => e.matchType !== "semantic" || e.score > 0.15);
  relevant.sort((a, b) => b.score - a.score);
  return relevant.slice(0, limit);
}

/**
 * Wraps createMemoryEntry with embedding generation. Embeds inline
 * (awaited within the request) rather than via a background queue — this
 * codebase has no job queue for memory writes, and standing one up would
 * be new infrastructure this PRD deliberately avoids provisioning
 * speculatively (PRD §4.2). Costs one extra network round trip per write;
 * revisit if write volume makes that latency a real problem.
 *
 * Degrades gracefully: if embedding fails (no provider, rate limit,
 * network error), the entry is still created without a vector — found by
 * substring search only until it's re-embedded.
 */
export async function rememberMemory(
  data: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt" | "embedding" | "embeddingRef">,
  opts?: { provider?: EmbeddingProvider | null },
): Promise<string> {
  const provider = opts?.provider !== undefined ? opts.provider : getEmbeddingProvider();
  let embedding: number[] | null = null;
  let embeddingRef: string | null = null;
  if (provider) {
    embeddingRef = contentHash(data.content);
    try {
      embedding = await provider.embed(data.content);
    } catch {
      embedding = null; // entry still gets created — see doc comment above
    }
  }
  return createMemoryEntry({ ...data, embedding, embeddingRef });
}

/**
 * Auto-capture memory from a session (e.g., model notes, task summaries).
 * No current callers (confirmed via `gitnexus impact` — see PRD §1.2);
 * routed through rememberMemory so it gets embeddings for free whenever
 * it does get wired up, without needing to remember to add that later.
 */
export async function autoCapture(
  computerId: string,
  workspaceId: string,
  content: string,
  tags: string[] = [],
): Promise<string> {
  return rememberMemory({
    scopeType: "computer",
    scopeId: computerId,
    workspaceId,
    computerId,
    agentId: null,
    createdByUserId: null,
    content,
    tags: ["auto-capture", ...tags],
    pinned: false,
  });
}
