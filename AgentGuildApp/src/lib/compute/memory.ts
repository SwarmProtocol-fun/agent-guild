/**
 * Swarm Compute — Memory Service Helpers
 */

import type { MemoryScopeType, MemoryEntry } from "./types";
import { createMemoryEntry, getMemoryEntries } from "./firestore";

/**
 * Text-based search across memory entries.
 * Future: integrate vector embeddings for semantic search.
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

/**
 * Auto-capture memory from a session (e.g., model notes, task summaries).
 */
export async function autoCapture(
  computerId: string,
  workspaceId: string,
  content: string,
  tags: string[] = [],
): Promise<string> {
  return createMemoryEntry({
    scopeType: "computer",
    scopeId: computerId,
    workspaceId,
    computerId,
    agentId: null,
    createdByUserId: null,
    content,
    embeddingRef: null,
    tags: ["auto-capture", ...tags],
    pinned: false,
  });
}
