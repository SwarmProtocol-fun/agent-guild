/**
 * Outbound HTTP for bindings, with SSRF protection.
 *
 * Uses node:http(s) with a custom `lookup` so the address that was checked is
 * the address that gets connected to — a hostname can't pass the check and
 * then re-resolve to 169.254.169.254 (DNS rebinding). Redirects are never
 * followed: a 3xx is returned to the agent as-is, so the credential can't be
 * bounced to another host.
 *
 * VAULT_ALLOW_INSECURE_EGRESS=1 allows http:// and private addresses. Local
 * development and tests only.
 */

import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import type { UpstreamRequest } from "./policy";

export const EGRESS_TIMEOUT_MS = 20_000;
export const EGRESS_MAX_RESPONSE_BYTES = 1_000_000;

export function insecureEgressAllowed(): boolean {
  return process.env.VAULT_ALLOW_INSECURE_EGRESS === "1" && process.env.NODE_ENV !== "production";
}

const BLOCKED_HOSTNAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /^metadata$/i];

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast + reserved
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v) || v.startsWith("64:ff9b:") || v.startsWith("2001:db8:");
  }
  return true; // not an IP at all — refuse
}

export function checkHostname(hostname: string): string | null {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (insecureEgressAllowed()) return null;
  if (BLOCKED_HOSTNAMES.some((re) => re.test(host))) return `Host ${host} is not allowed`;
  if (net.isIP(host) && isPrivateAddress(host)) return `Address ${host} is private`;
  return null;
}

function safeLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as dns.LookupAddress[];
    if (!insecureEgressAllowed()) {
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad) return callback(Object.assign(new Error(`${hostname} resolves to private address ${bad.address}`), { code: "EPRIVATE" }), "");
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export interface EgressResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export function sendUpstream(req: UpstreamRequest): Promise<EgressResponse> {
  const hostError = checkHostname(req.url.hostname);
  if (hostError) return Promise.reject(new Error(hostError));
  if (req.url.protocol !== "https:" && !insecureEgressAllowed()) return Promise.reject(new Error("Only https upstreams are allowed"));

  const lib = req.url.protocol === "https:" ? https : http;
  const headers: Record<string, string> = { "user-agent": "agent-guild-vault/1", ...req.headers };
  if (req.body !== undefined) headers["content-length"] = String(Buffer.byteLength(req.body));

  return new Promise((resolve, reject) => {
    const r = lib.request(
      req.url,
      { method: req.method, headers, lookup: safeLookup as never, timeout: EGRESS_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > EGRESS_MAX_RESPONSE_BYTES) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (size - EGRESS_MAX_RESPONSE_BYTES)));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const finish = () => {
          const outHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) outHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
          }
          resolve({ status: res.statusCode || 0, headers: outHeaders, body: Buffer.concat(chunks).toString("utf8"), truncated });
        };
        res.on("end", finish);
        res.on("close", () => { if (truncated) finish(); });
        res.on("error", (e) => { if (!truncated) reject(e); });
      },
    );
    r.on("timeout", () => r.destroy(new Error(`Upstream timed out after ${EGRESS_TIMEOUT_MS / 1000}s`)));
    r.on("error", reject);
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}
