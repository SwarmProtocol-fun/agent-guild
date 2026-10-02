/**
 * Binding policy — pure functions, no I/O.
 *
 * A binding is "agent may call <baseUrl> with <secret> injected, but only
 * these methods, under these path prefixes". The agent names the binding and
 * describes the request; everything that could leak or redirect the
 * credential (host, auth header, auth query param, redirects) is fixed by the
 * binding and never taken from the agent.
 */

export type BindingAuth =
  | { style: "bearer" }
  | { style: "header"; header: string; prefix?: string }
  | { style: "query"; param: string }
  | { style: "basic"; username: string };

export interface Binding {
  id: string;
  orgId: string;
  name: string;
  description: string;
  secretId: string;
  baseUrl: string;
  auth: BindingAuth;
  allowedMethods: string[];
  allowedPaths: string[];
  /** Agent ids allowed to use this binding; ["*"] = every agent in the org. */
  agentIds: string[];
  /** 0 = unlimited. */
  maxCallsPerHour: number;
  revoked: boolean;
  createdBy: string;
}

export interface ExecuteRequest {
  binding: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

export const BINDING_NAME_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

/** Headers an agent may never set — they'd override the injected credential or confuse the upstream. */
const BLOCKED_REQUEST_HEADERS = new Set([
  "authorization", "proxy-authorization", "cookie", "host", "content-length",
  "connection", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive",
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
]);

/** Response headers never passed back to the agent. */
const DROPPED_RESPONSE_HEADERS = new Set(["set-cookie", "set-cookie2", "www-authenticate", "proxy-authenticate"]);

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

// ─── binding definition ────────────────────────────────────────

export type BindingInput = Omit<Binding, "id" | "orgId" | "createdBy" | "revoked">;

/**
 * Validate an admin-supplied binding. `allowInsecure` permits http:// base
 * URLs (local development only — see egress.ts).
 */
export function validateBindingInput(raw: Record<string, unknown>, allowInsecure = false): Result<BindingInput> {
  const name = String(raw.name ?? "").trim();
  if (!BINDING_NAME_RE.test(name)) return fail("name must be 2–48 chars: lowercase letters, digits, dashes");

  const secretId = String(raw.secretId ?? "").trim();
  if (!secretId) return fail("secretId is required");

  let base: URL;
  try { base = new URL(String(raw.baseUrl ?? "")); } catch { return fail("baseUrl must be an absolute URL"); }
  if (base.protocol !== "https:" && !(allowInsecure && base.protocol === "http:")) return fail("baseUrl must use https");
  if (base.username || base.password) return fail("baseUrl must not contain credentials");
  if (base.search || base.hash) return fail("baseUrl must not contain a query string or fragment");
  const baseUrl = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;

  const auth = raw.auth as Record<string, unknown> | undefined;
  let parsedAuth: BindingAuth;
  switch (auth?.style) {
    case "bearer":
      parsedAuth = { style: "bearer" };
      break;
    case "header": {
      const header = String(auth.header ?? "");
      if (!HEADER_NAME_RE.test(header)) return fail("auth.header must be a valid header name");
      const prefix = auth.prefix == null ? undefined : String(auth.prefix);
      if (prefix && /[\r\n]/.test(prefix)) return fail("auth.prefix must be a single line");
      parsedAuth = { style: "header", header, ...(prefix ? { prefix } : {}) };
      break;
    }
    case "query": {
      const param = String(auth.param ?? "");
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(param)) return fail("auth.param must be a valid query parameter name");
      parsedAuth = { style: "query", param };
      break;
    }
    case "basic": {
      const username = String(auth.username ?? "");
      if (!username || username.includes(":")) return fail("auth.username is required and must not contain ':'");
      parsedAuth = { style: "basic", username };
      break;
    }
    default:
      return fail("auth.style must be bearer, header, query or basic");
  }

  const allowedMethods = toStringArray(raw.allowedMethods, ["GET"]).map((m) => m.toUpperCase());
  if (!allowedMethods.length || allowedMethods.some((m) => !(METHODS as readonly string[]).includes(m))) {
    return fail(`allowedMethods must be a subset of ${METHODS.join(", ")}`);
  }

  const allowedPaths = toStringArray(raw.allowedPaths, ["/"]);
  if (!allowedPaths.length || allowedPaths.some((p) => !p.startsWith("/") || p.includes(".."))) {
    return fail("allowedPaths must be path prefixes starting with '/'");
  }

  const agentIds = toStringArray(raw.agentIds, []);
  if (!agentIds.length) return fail("agentIds must list at least one agent id, or \"*\" for every agent in the org");

  const maxCallsPerHour = Number(raw.maxCallsPerHour ?? 0);
  if (!Number.isInteger(maxCallsPerHour) || maxCallsPerHour < 0) return fail("maxCallsPerHour must be a non-negative integer");

  return {
    ok: true,
    value: {
      name,
      description: String(raw.description ?? "").slice(0, 500),
      secretId,
      baseUrl,
      auth: parsedAuth,
      allowedMethods: [...new Set(allowedMethods)],
      allowedPaths: [...new Set(allowedPaths)],
      agentIds: [...new Set(agentIds)],
      maxCallsPerHour,
    },
  };
}

function toStringArray(v: unknown, fallback: string[]): string[] {
  if (v == null) return fallback;
  const arr = Array.isArray(v) ? v : String(v).split(",");
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

// ─── per-call checks ───────────────────────────────────────────

export function agentMayUse(binding: Pick<Binding, "agentIds" | "revoked">, agentId: string): boolean {
  return !binding.revoked && (binding.agentIds.includes("*") || binding.agentIds.includes(agentId));
}

function pathAllowed(relPath: string, prefixes: string[]): boolean {
  return prefixes.some((p) => {
    if (p === "/") return true;
    const prefix = p.replace(/\/+$/, "");
    return relPath === prefix || relPath.startsWith(`${prefix}/`);
  });
}

export interface UpstreamRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Turn an agent's request into the exact upstream request, credential
 * included, or explain why it's refused.
 */
export function buildUpstreamRequest(binding: Binding, req: ExecuteRequest, secret: string): Result<UpstreamRequest> {
  const method = String(req.method || "GET").toUpperCase();
  if (!binding.allowedMethods.includes(method)) {
    return fail(`Method ${method} not allowed by binding "${binding.name}" (allowed: ${binding.allowedMethods.join(", ")})`);
  }

  const path = String(req.path || "/");
  // eslint-disable-next-line no-control-regex
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u001f]/.test(path) || /(^|\/)\.\.?(\/|$)/.test(path)) {
    return fail("path must be an absolute path without '..', backslashes or control characters");
  }
  if (path.includes("?") || path.includes("#")) return fail("Put query parameters in `query`, not in `path`");

  const base = new URL(binding.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const url = new URL(`${basePath}${path}`, base.origin);
  if (url.origin !== base.origin || !url.pathname.startsWith(basePath)) return fail("path escapes the binding's base URL");
  const relPath = url.pathname.slice(basePath.length) || "/";
  if (!pathAllowed(relPath, binding.allowedPaths)) {
    return fail(`Path ${relPath} not allowed by binding "${binding.name}" (allowed: ${binding.allowedPaths.join(", ")})`);
  }

  const reservedParam = binding.auth.style === "query" ? binding.auth.param.toLowerCase() : null;
  for (const [k, v] of Object.entries(req.query || {})) {
    if (reservedParam && k.toLowerCase() === reservedParam) return fail(`Query parameter "${k}" is set by the binding`);
    url.searchParams.append(k, String(v));
  }

  const headers: Record<string, string> = {};
  const reservedHeader = binding.auth.style === "header" ? binding.auth.header.toLowerCase() : null;
  const agentHeaders = Object.entries(req.headers || {});
  if (agentHeaders.length > 30) return fail("Too many headers");
  for (const [k, v] of agentHeaders) {
    const lower = k.toLowerCase();
    if (!HEADER_NAME_RE.test(k) || /[\r\n]/.test(String(v))) return fail(`Invalid header ${k}`);
    if (BLOCKED_REQUEST_HEADERS.has(lower) || lower === reservedHeader || lower.startsWith("proxy-")) {
      return fail(`Header "${k}" can't be set by the agent`);
    }
    headers[lower] = String(v);
  }

  switch (binding.auth.style) {
    case "bearer":
      headers.authorization = `Bearer ${secret}`;
      break;
    case "header":
      headers[binding.auth.header.toLowerCase()] = `${binding.auth.prefix ?? ""}${secret}`;
      break;
    case "query":
      url.searchParams.set(binding.auth.param, secret);
      break;
    case "basic":
      headers.authorization = `Basic ${Buffer.from(`${binding.auth.username}:${secret}`).toString("base64")}`;
      break;
  }

  let body: string | undefined;
  if (req.body !== undefined && req.body !== null && method !== "GET" && method !== "HEAD") {
    if (typeof req.body === "string") {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
      headers["content-type"] ??= "application/json";
    }
  }

  return { ok: true, value: { url, method, headers, body } };
}

// ─── response hygiene ──────────────────────────────────────────

/** Every encoding of the secret an upstream might plausibly echo back. */
function secretForms(secret: string): string[] {
  const forms = new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")]);
  return [...forms].filter((f) => f.length >= 6);
}

export function redact(text: string, secret: string): string {
  let out = text;
  for (const form of secretForms(secret)) out = out.split(form).join("[REDACTED]");
  return out;
}

export function filterResponseHeaders(headers: Record<string, string>, secret: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (DROPPED_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
    out[k] = redact(v, secret);
  }
  return out;
}

/** Shown in the audit log instead of the real URL when the credential rides in the query string. */
export function auditUrl(url: URL, auth: BindingAuth): string {
  const copy = new URL(url.toString());
  if (auth.style === "query") copy.searchParams.set(auth.param, "[REDACTED]");
  return `${copy.origin}${copy.pathname}${copy.search}`;
}
