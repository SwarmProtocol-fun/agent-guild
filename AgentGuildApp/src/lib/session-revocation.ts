/**
 * Session revocation list — Edge-safe (Upstash REST only, no Firebase Admin).
 *
 * The middleware runs on the Edge runtime, so it can only verify the session
 * JWT's signature; it can't read the Firestore `sessions` record. Routes that
 * trust the middleware-injected x-wallet-address / x-session-role headers
 * would therefore keep honoring a logged-out (or stolen) cookie until the
 * JWT expired. deleteSession() records the sid here and the middleware drops
 * sessions found here.
 *
 * Without Upstash configured this is a no-op (revocation then only applies
 * to routes that call validateSession()). Lookup errors fail open so a Redis
 * outage doesn't log everyone out.
 */
import { Redis } from "@upstash/redis";

/** Matches the session JWT lifetime (session.ts SESSION_MAX_AGE). */
const REVOCATION_TTL_SECONDS = 60 * 60 * 24;

let client: Redis | null | undefined;
function redis(): Redis | null {
  if (client === undefined) {
    client =
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
        ? Redis.fromEnv()
        : null;
  }
  return client;
}

const key = (sid: string) => `revoked-session:${sid}`;

export async function revokeSessionId(sid: string): Promise<void> {
  await redis()?.set(key(sid), 1, { ex: REVOCATION_TTL_SECONDS });
}

export async function isSessionRevoked(sid: string): Promise<boolean> {
  const r = redis();
  if (!r || !sid) return false;
  try {
    return (await r.exists(key(sid))) > 0;
  } catch {
    return false;
  }
}
