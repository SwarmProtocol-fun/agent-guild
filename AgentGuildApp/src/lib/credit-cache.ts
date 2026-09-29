/**
 * In-memory TTL cache for credit profile lookups.
 *
 * Avoids repeated Firestore reads during enforcement and API calls.
 * Per-process only — not shared across instances.
 * Follows the Map<string, Entry> pattern from rate-limit.ts.
 */

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface CacheEntry<T> {
    data: T;
    expiresAt: number;
}

// ═══════════════════════════════════════════════════════════════
// Cache Store
// ═══════════════════════════════════════════════════════════════

const cache = new Map<string, CacheEntry<unknown>>();
const DEFAULT_TTL_MS = 60_000; // 60 seconds
const SWEEP_INTERVAL_MS = 120_000; // 2 minutes

// Periodic sweep to prevent unbounded growth
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (now >= entry.expiresAt) cache.delete(key);
    }
}, SWEEP_INTERVAL_MS).unref();

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

/** Get a cached value, or null if not found / expired. */
export function getCached<T>(key: string): T | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
        cache.delete(key);
        return null;
    }
    return entry.data as T;
}

/** Set a value in the cache with optional TTL (default 60s). */
export function setCache<T>(key: string, data: T, ttlMs = DEFAULT_TTL_MS): void {
    cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/** Remove a specific key from the cache. */
export function invalidateCache(key: string): void {
    cache.delete(key);
}

/** Remove all keys that start with the given prefix. */
export function invalidateCacheByPrefix(prefix: string): void {
    for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key);
    }
}
