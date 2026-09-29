/**
 * URL validation utilities — SSRF protection
 *
 * Prevents server-side request forgery by blocking requests to private/reserved
 * IP ranges and requiring HTTPS for callback/webhook URLs.
 */

/** Check if a hostname resolves to a private/reserved IP range */
export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();

  // Block localhost variants
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;

  // Block .local, .internal, .localhost TLDs
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;

  // Block IP addresses in private/reserved ranges
  const ipv4Match = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
    if (a === 127) return true;           // 127.0.0.0/8 loopback
    if (a === 10) return true;            // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true;          // 169.254.0.0/16 link-local
    if (a === 0) return true;             // 0.0.0.0/8
  }

  return false;
}

/** Validate a webhook/callback URL — must be HTTPS and not target private networks */
export function validateCallbackUrl(
  url: string,
): { ok: true; parsed: URL } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "URL must use HTTPS" };
  }

  if (isPrivateHostname(parsed.hostname)) {
    return { ok: false, error: "URL cannot target private networks" };
  }

  return { ok: true, parsed };
}
