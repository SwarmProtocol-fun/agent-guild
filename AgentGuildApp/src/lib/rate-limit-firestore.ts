/**
 * Rate Limiter - Firestore-backed rate limiting for multi-instance deployments
 *
 * Uses Firestore transactions for atomic increments across instances.
 * Rate limit documents auto-expire via TTL field (requires Firestore TTL policy).
 *
 * Server-only (Firebase Admin SDK) — this bypasses Firestore rules, so it
 * must never be imported into client-facing code.
 *
 * Collection: `rateLimits`
 * Document ID: hashed key (IP address or user ID)
 * TTL Field: `expiresAt` (configure Firestore TTL policy on this field)
 */

import { adminDb } from "./firebase-admin";
import { Timestamp, FieldValue } from "firebase-admin/firestore";

const RATE_LIMIT_COLLECTION = "rateLimits";

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

interface RateLimitDoc {
  count: number;
  resetAt: Timestamp;
  expiresAt: Timestamp; // For Firestore TTL policy
  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue;
}

/**
 * Check if a request is allowed under rate limit.
 * Uses Firestore transaction for atomic increment across instances.
 *
 * @param key - Unique identifier (e.g., IP address, user ID)
 * @param config - Rate limit configuration
 * @returns Result indicating if request is allowed
 */
export async function checkRateLimit(
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const docRef = adminDb().collection(RATE_LIMIT_COLLECTION).doc(hashKey(key));

  try {
    return await adminDb().runTransaction(async (transaction) => {
      const docSnap = await transaction.get(docRef);
      const now = Date.now();
      const resetTime = now + config.windowMs;

      // No existing rate limit or expired
      if (!docSnap.exists) {
        const newDoc: RateLimitDoc = {
          count: 1,
          resetAt: Timestamp.fromMillis(resetTime),
          expiresAt: Timestamp.fromMillis(resetTime + 3600000), // +1 hour for cleanup
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        transaction.set(docRef, newDoc);
        return {
          allowed: true,
          remaining: config.max - 1,
          resetTime,
        };
      }

      const data = docSnap.data() as RateLimitDoc;
      const existingResetTime = data.resetAt.toMillis();

      // Expired - reset counter
      if (now >= existingResetTime) {
        const newDoc: RateLimitDoc = {
          count: 1,
          resetAt: Timestamp.fromMillis(resetTime),
          expiresAt: Timestamp.fromMillis(resetTime + 3600000),
          createdAt: data.createdAt,
          updatedAt: FieldValue.serverTimestamp(),
        };
        transaction.set(docRef, newDoc);
        return {
          allowed: true,
          remaining: config.max - 1,
          resetTime,
        };
      }

      // Rate limit exceeded
      if (data.count >= config.max) {
        return {
          allowed: false,
          remaining: 0,
          resetTime: existingResetTime,
        };
      }

      // Increment counter
      transaction.update(docRef, {
        count: data.count + 1,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        allowed: true,
        remaining: config.max - (data.count + 1),
        resetTime: existingResetTime,
      };
    });
  } catch (err) {
    console.error("[RateLimit] Transaction failed:", err);
    // Fail-open: allow request if Firestore is unavailable.
    // This is intentional — a Firestore outage should not lock out all users.
    // Trade-off: during outage, rate limiting is bypassed. Monitor Firestore
    // availability separately (e.g., GCP uptime checks).
    return {
      allowed: true,
      remaining: config.max - 1,
      resetTime: Date.now() + config.windowMs,
    };
  }
}

/**
 * Reset rate limit for a specific key.
 * Useful for testing or manual override.
 */
export async function resetRateLimit(key: string): Promise<void> {
  const docRef = adminDb().collection(RATE_LIMIT_COLLECTION).doc(hashKey(key));
  await docRef.set({
    count: 0,
    resetAt: Timestamp.now(),
    expiresAt: Timestamp.now(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Get rate limit statistics for a key (for debugging).
 */
export async function getRateLimitStats(key: string) {
  const docRef = adminDb().collection(RATE_LIMIT_COLLECTION).doc(hashKey(key));
  const docSnap = await docRef.get();

  if (!docSnap.exists) {
    return {
      exists: false,
      count: 0,
      resetAt: null,
    };
  }

  const data = docSnap.data() as RateLimitDoc;
  return {
    exists: true,
    count: data.count,
    resetAt: data.resetAt.toDate(),
    expiresAt: data.expiresAt.toDate(),
  };
}

/**
 * Hash key to prevent document ID issues with special characters.
 * Uses simple base64 encoding (collision-safe for IP addresses).
 */
function hashKey(key: string): string {
  // Simple base64 encoding for safe document IDs
  return Buffer.from(key).toString("base64").replace(/[/+=]/g, "_");
}

/**
 * Get client IP from Next.js request.
 * Handles proxied requests (Cloudflare, nginx, ALB).
 */
export function getClientIp(req: Request): string {
  // Try various headers in order of preference
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  const cfConnectingIp = req.headers.get("cf-connecting-ip");
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  // Fallback (will rate limit all requests together - not ideal for production)
  return "unknown";
}
