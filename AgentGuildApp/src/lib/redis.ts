/**
 * Upstash Redis client singleton.
 *
 * Connectionless HTTP-based client — works in serverless (Netlify,
 * Cloudflare Workers) without persistent TCP connections.
 *
 * Env:
 *   UPSTASH_REDIS_REST_URL   — e.g. https://us1-example.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN — bearer token
 *
 * When env vars are missing the client is null and all dependents
 * fall back to in-memory or no-op behavior (fail-open).
 */

import { Redis } from "@upstash/redis";

// ── Singleton ────────────────────────────────────────────────────────────────

let _redis: Redis | null = null;
let _initialized = false;

/**
 * Get the Upstash Redis client (or null if not configured).
 * Safe to call repeatedly — only creates one instance.
 */
export function getRedis(): Redis | null {
  if (_initialized) return _redis;
  _initialized = true;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.warn(
      "[redis] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — falling back to in-memory",
    );
    return null;
  }

  _redis = new Redis({ url, token });
  return _redis;
}

/**
 * Returns true if Redis is configured and available.
 */
export function isRedisConfigured(): boolean {
  return getRedis() !== null;
}
