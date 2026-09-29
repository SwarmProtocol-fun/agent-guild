/**
 * Organization Cache - Simple in-memory cache for organization lookups
 * Reduces Firestore queries during login flow
 */

import type { Organization } from "./firestore";

interface CacheEntry {
  orgs: Organization[];
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

// Cache TTL: 5 minutes
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Get cached organizations for a wallet address
 * Returns null if not in cache or expired
 */
export function getCachedOrgs(address: string): Organization[] | null {
  const key = address.toLowerCase();
  const entry = cache.get(key);

  if (!entry) return null;

  // Check if expired
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return entry.orgs;
}

/**
 * Cache organizations for a wallet address
 */
export function cacheOrgs(address: string, orgs: Organization[]): void {
  const key = address.toLowerCase();
  cache.set(key, {
    orgs,
    timestamp: Date.now(),
  });
}

/**
 * Clear cached entry for a specific address
 */
export function clearCachedOrgs(address: string): void {
  cache.delete(address.toLowerCase());
}

/**
 * Clear all cached entries
 */
export function clearAllOrgCache(): void {
  cache.clear();
}

/**
 * Get cache statistics (for debugging)
 */
export function getOrgCacheStats() {
  const now = Date.now();
  let validEntries = 0;
  let expiredEntries = 0;

  cache.forEach((entry) => {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      expiredEntries++;
    } else {
      validEntries++;
    }
  });

  return {
    totalEntries: cache.size,
    validEntries,
    expiredEntries,
    ttlMs: CACHE_TTL_MS,
  };
}
