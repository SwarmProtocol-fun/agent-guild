/**
 * General-purpose rate limiter for API endpoints.
 *
 * Primary: Upstash Redis (shared across instances).
 * Fallback: in-memory fixed-window (when Redis is not configured).
 */

import { getRedis } from "@/lib/redis";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  max: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
}

// ── Key prefix ───────────────────────────────────────────────────────────────

const KEY_PREFIX = "rl:gen:";

// ── In-memory fallback ───────────────────────────────────────────────────────

interface FallbackEntry {
  count: number;
  resetTime: number;
}

const fallbackLimits = new Map<string, FallbackEntry>();

function cleanupExpiredEntries() {
  const now = Date.now();
  for (const [key, entry] of fallbackLimits) {
    if (now >= entry.resetTime) fallbackLimits.delete(key);
  }
}

function fallbackCheck(key: string, config: RateLimitConfig): RateLimitResult {
  const now = Date.now();
  const entry = fallbackLimits.get(key);

  if (Math.random() < 0.01) cleanupExpiredEntries();

  if (!entry || now >= entry.resetTime) {
    fallbackLimits.set(key, { count: 1, resetTime: now + config.windowMs });
    return { allowed: true, remaining: config.max - 1, resetTime: now + config.windowMs };
  }

  if (entry.count >= config.max) {
    return { allowed: false, remaining: 0, resetTime: entry.resetTime };
  }

  entry.count++;
  return { allowed: true, remaining: config.max - entry.count, resetTime: entry.resetTime };
}

// ── Redis check ──────────────────────────────────────────────────────────────

async function redisCheck(
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const redis = getRedis()!;
  const redisKey = `${KEY_PREFIX}${key}`;
  const now = Date.now();
  const windowStart = now - config.windowMs;

  try {
    const pipe = redis.pipeline();
    pipe.zremrangebyscore(redisKey, 0, windowStart);
    pipe.zcard(redisKey);
    pipe.zadd(redisKey, {
      score: now,
      member: `${now}:${Math.random().toString(36).slice(2, 8)}`,
    });
    pipe.pexpire(redisKey, config.windowMs + 1000);

    const results = await pipe.exec();
    const count = results[1] as number;
    const resetTime = now + config.windowMs;

    if (count >= config.max) {
      return { allowed: false, remaining: 0, resetTime };
    }

    return { allowed: true, remaining: config.max - count - 1, resetTime };
  } catch (err) {
    console.warn("[rate-limit] Redis error, falling back to in-memory:", err);
    return fallbackCheck(key, config);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if a request is allowed under rate limit.
 * @param key - Unique identifier (e.g., IP address, user ID)
 * @param config - Rate limit configuration
 */
export async function checkRateLimit(
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const redis = getRedis();
  if (redis) return redisCheck(key, config);
  return fallbackCheck(key, config);
}

/**
 * Reset rate limit for a specific key.
 */
export async function resetRateLimit(key: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(`${KEY_PREFIX}${key}`);
    } catch {
      // fall through
    }
  }
  fallbackLimits.delete(key);
}

/**
 * Clear all rate limit entries.
 */
export async function clearAllRateLimits(): Promise<void> {
  fallbackLimits.clear();
  // Note: Redis keys self-expire via TTL — no bulk clear needed
}

/**
 * Get rate limit statistics (for debugging).
 */
export function getRateLimitStats() {
  const now = Date.now();
  let activeEntries = 0;
  let expiredEntries = 0;

  fallbackLimits.forEach((entry) => {
    if (now < entry.resetTime) activeEntries++;
    else expiredEntries++;
  });

  return { totalEntries: fallbackLimits.size, activeEntries, expiredEntries };
}

/**
 * Get client IP from Next.js request.
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();

  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp;

  return "unknown";
}
