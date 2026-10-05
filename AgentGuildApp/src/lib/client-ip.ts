/**
 * Client IP for rate limiting — Edge- and Node-safe (headers only).
 *
 * The first X-Forwarded-For entry is whatever the client sent: proxies
 * append to the header rather than replace it, so keying a rate limit on it
 * lets a caller pick a fresh "IP" per request and bypass the limit.
 * Platform-set headers come first because the platform overwrites them:
 * Netlify's x-nf-client-connection-ip (production). Elsewhere (Railway,
 * local) falls back to the old behavior rather than guessing at the proxy
 * chain — picking a proxy's own IP would put every user in one bucket.
 */
export function getClientIp(req: Pick<Request, "headers">): string {
  const netlify = req.headers.get("x-nf-client-connection-ip");
  if (netlify) return netlify.trim();

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();

  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
