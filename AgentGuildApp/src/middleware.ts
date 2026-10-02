/**
 * Next.js Middleware — Server-side session validation.
 *
 * Runs on every matched route BEFORE rendering.
 * Validates the `agent_guild_session` JWT cookie and injects session headers
 * for downstream API routes and server components.
 *
 * Protected dashboard routes redirect to "/" if no valid session.
 * API routes that need auth get a 401 response.
 */
import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const SESSION_COOKIE = "agent_guild_session";

// ── Rate limiting for /api/v1/* mutations ──────────────────
// @upstash/ratelimit + @upstash/redis were installed as dependencies but
// never wired up anywhere — every /api/v1/* mutating request (purchase,
// publish, credit-ops, webhooks, ...) was unrate-limited. Sliding window,
// per-IP, applied here in middleware so it covers all ~70 v1 routes
// uniformly rather than requiring each route handler to opt in.
const RATE_LIMIT_MAX = parseInt(process.env.API_V1_RATE_LIMIT_MAX || "30", 10);
const RATE_LIMIT_WINDOW = (process.env.API_V1_RATE_LIMIT_WINDOW || "10 s") as `${number} ${"ms" | "s" | "m" | "h" | "d"}`;

const upstashConfigured = !!(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);

const ratelimit = upstashConfigured
  ? new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW),
      prefix: "ratelimit:api-v1",
      analytics: false,
    })
  : null;

/** Best-effort in-memory fallback for when Upstash isn't configured (e.g. local dev). Not distributed across instances. */
const memoryLimitState = new Map<string, { count: number; windowStart: number }>();
const MEMORY_WINDOW_MS = 10_000;

function checkMemoryRateLimit(key: string): boolean {
  const now = Date.now();
  let entry = memoryLimitState.get(key);
  if (!entry || now - entry.windowStart > MEMORY_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
  }
  entry.count++;
  memoryLimitState.set(key, entry);
  if (memoryLimitState.size > 5000) {
    for (const [k, v] of memoryLimitState) {
      if (now - v.windowStart > MEMORY_WINDOW_MS * 2) memoryLimitState.delete(k);
    }
  }
  return entry.count <= RATE_LIMIT_MAX;
}

function getClientIP(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

// ── Security Headers ──────────────────────────────────────
// Applied to all SSR responses. Netlify [[headers]] only cover
// static assets — SSR pages served by serverless functions need
// these set here in the middleware.
const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://*.google.com https://*.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com https://fonts.reown.com data:",
    "img-src 'self' data: blob: https: http:",
    "connect-src 'self' https: wss:",
    "frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org https://secure.walletconnect.com https://secure.walletconnect.org https://accounts.google.com",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; "),
};

function getSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      "SESSION_SECRET env var must be set (min 32 chars). " +
      "Generate one with: openssl rand -hex 32"
    );
  }
  return new TextEncoder().encode(raw);
}

/** Routes that require a valid session to access */
const PROTECTED_PAGE_PREFIXES = [
  "/dashboard",
  "/agents",
  "/agent-guilds",
  "/jobs",
  "/gigs",
  "/discover",
  "/missions",
  "/chat",
  "/settings",
  "/profile",
  "/analytics",
  "/activity",
  "/approvals",
  "/calendar",
  "/cron",
  "/doctor",
  "/gateways",
  "/kanban",
  "/logs",
  "/market",
  "/memory",
  "/summaries",
  "/metrics",
  "/onboarding",
  "/operators",
  "/organizations",
  "/agent-guild",
  "/usage",
  "/compute",
];

/** API routes that require operator session (not agent auth) */
const PROTECTED_API_PREFIXES = [
  "/api/auth/session", // needs cookie read, but doesn't need protection
];

/** API routes that should pass through without session check */
const PUBLIC_API_PREFIXES = [
  "/api/auth/payload",
  "/api/auth/verify",
  "/api/auth/logout",
  "/api/auth/session",
  "/api/webhooks",
  "/api/v1",
  "/api/cron-jobs",
  "/api/github/webhook",
  "/api/github/callback",
];

interface SessionPayload {
  sub: string;
  sid: string;
  role: string;
}

async function verifyToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

/** Apply security headers to a response */
function withSecurityHeaders(res: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(key, value);
  }
  return res;
}

const MAX_BODY_BYTES = 2_000_000; // 2MB global limit for API routes

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Skip public assets and Next.js internals
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  ) {
    return withSecurityHeaders(NextResponse.next());
  }

  // Enforce body-size limit on API routes
  if (pathname.startsWith("/api/")) {
    const contentLength = req.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
      return withSecurityHeaders(
        NextResponse.json(
          { error: `Request body too large (max ${MAX_BODY_BYTES / 1_000_000}MB)` },
          { status: 413 }
        )
      );
    }
  }

  // Rate limit mutating /api/v1/* and /api/mods/* requests, keyed by client
  // IP. Mod routes (handleModRequest in src/lib/mods/runtime.ts) have no
  // rate limiting of their own — without this they were the one mutating
  // API surface completely exempt from it.
  if (
    (pathname.startsWith("/api/v1") || pathname.startsWith("/api/mods")) &&
    ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
  ) {
    const ip = getClientIP(req);
    const allowed = ratelimit
      ? (await ratelimit.limit(`${ip}:${pathname}`)).success
      : checkMemoryRateLimit(`${ip}:${pathname}`);
    if (!allowed) {
      return withSecurityHeaders(
        NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 })
      );
    }
  }

  // Read session cookie
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifyToken(token) : null;

  // Inject session headers into the REQUEST so API route handlers can read them.
  // Strip any client-supplied values first — otherwise an unauthenticated caller
  // could set x-wallet-address themselves and impersonate any wallet. This MUST
  // run before the public-route early-return below: /api/v1/* is public (agents
  // authenticate via their own signature scheme) but its route handlers still
  // read these headers for session-based operator auth, so spoofed headers must
  // never reach them.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete("x-wallet-address");
  requestHeaders.delete("x-session-address");
  requestHeaders.delete("x-session-role");
  requestHeaders.delete("x-session-id");
  if (session) {
    requestHeaders.set("x-wallet-address", session.sub);
    requestHeaders.set("x-session-address", session.sub);
    requestHeaders.set("x-session-role", session.role);
    requestHeaders.set("x-session-id", session.sid);
  }

  // Check if this is a public API route — pass through, but with the
  // sanitized/re-signed headers computed above, not the raw client headers.
  if (PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p))) {
    return withSecurityHeaders(
      NextResponse.next({ request: { headers: requestHeaders } })
    );
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // Also mirror to response headers for client-side consumption
  if (session) {
    response.headers.set("x-session-address", session.sub);
    response.headers.set("x-session-role", session.role);
    response.headers.set("x-session-id", session.sid);
  }

  // Check protected page routes
  const isProtectedPage = PROTECTED_PAGE_PREFIXES.some((p) =>
    pathname.startsWith(p)
  );

  if (isProtectedPage && !session) {
    // No valid session — redirect to landing page
    const loginUrl = new URL("/", req.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return withSecurityHeaders(response);
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next (static files)
     * - favicon.ico
     * - public files with extensions (images, etc.)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot)$).*)",
  ],
};
