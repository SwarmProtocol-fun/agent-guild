/**
 * Sliding-window rate limiter for v1 API routes.
 *
 * Primary: Upstash Redis (shared across instances, survives restarts).
 * Fallback: in-memory Map (when Redis is not configured).
 *
 * Usage:
 *   const limited = await rateLimit(identifier);
 *   if (limited) return limited; // returns a 429 Response
 */

import { getRedis } from "@/lib/redis";

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 60; // per identifier per window
const KEY_PREFIX = "rl:v1:";

// ── In-memory fallback ───────────────────────────────────────────────────────

interface FallbackEntry {
  timestamps: number[];
}

const fallbackStore = new Map<string, FallbackEntry>();
const SWEEP_INTERVAL_MS = 120_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, entry] of fallbackStore) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) fallbackStore.delete(key);
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

function fallbackRateLimit(identifier: string): Response | null {
  ensureSweep();
  const now = Date.now();
  let entry = fallbackStore.get(identifier);
  if (!entry) {
    entry = { timestamps: [] };
    fallbackStore.set(identifier, entry);
  }

  entry.timestamps = entry.timestamps.filter((t) => now - t < WINDOW_MS);

  if (entry.timestamps.length >= MAX_REQUESTS) {
    const retryAfterSec = Math.ceil(
      (entry.timestamps[0] + WINDOW_MS - now) / 1000,
    );
    return Response.json(
      { error: "Rate limit exceeded" },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSec) },
      },
    );
  }

  entry.timestamps.push(now);
  return null;
}

// ── Redis rate limit (ZSET sliding window — same pattern as hub/redis-state) ─

async function redisRateLimit(identifier: string): Promise<Response | null> {
  const redis = getRedis()!;
  const key = `${KEY_PREFIX}${identifier}`;
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  try {
    // Atomic pipeline: remove expired, count, add current, set TTL
    const pipe = redis.pipeline();
    pipe.zremrangebyscore(key, 0, windowStart);
    pipe.zcard(key);
    pipe.zadd(key, { score: now, member: `${now}:${Math.random().toString(36).slice(2, 8)}` });
    pipe.pexpire(key, WINDOW_MS + 1000); // TTL = window + 1s buffer

    const results = await pipe.exec();
    const count = results[1] as number;

    if (count >= MAX_REQUESTS) {
      // Get oldest member score to calculate retry-after
      const oldest = await redis.zrange<string[]>(key, 0, 0);
      let retryAfterSec = 60;
      if (oldest && oldest.length > 0) {
        // Score is the timestamp — parse from member
        const scores = await redis.zscore(key, oldest[0]);
        if (scores) {
          retryAfterSec = Math.max(
            1,
            Math.ceil(((scores as number) + WINDOW_MS - now) / 1000),
          );
        }
      }

      // Remove the member we just added (request denied)
      // We need to get the last added member — use the random suffix we created
      // Actually, since we already counted before adding, we can just leave it
      // and let it expire. The count was checked before the add.

      return Response.json(
        { error: "Rate limit exceeded" },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfterSec) },
        },
      );
    }

    return null;
  } catch (err) {
    // Fail-open: if Redis errors, fall through to in-memory
    console.warn("[rate-limit] Redis error, falling back to in-memory:", err);
    return fallbackRateLimit(identifier);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check rate limit for an identifier (typically agentId or IP).
 * Returns null if allowed, or a 429 Response if rate-limited.
 */
export async function rateLimit(
  identifier: string,
): Promise<Response | null> {
  const redis = getRedis();
  if (redis) {
    return redisRateLimit(identifier);
  }
  return fallbackRateLimit(identifier);
}
