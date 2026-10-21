/**
 * OAuth 2.1 for Robinhood's Trading MCP server, as its metadata advertises
 * (GET https://agent.robinhood.com/.well-known/oauth-authorization-server):
 * dynamic client registration, authorization code + PKCE S256, public client
 * (no secret), refresh tokens. The resource indicator (RFC 8707) binds the
 * token to the MCP endpoint, as the MCP authorization spec requires.
 *
 * Server-only. The user signs in on robinhood.com and opens their dedicated
 * Agentic account there; this app never sees their Robinhood password.
 */
import { createHash, randomBytes } from "node:crypto";

export const MCP_URL = "https://agent.robinhood.com/mcp/trading";
export const AUTHORIZE_URL = "https://robinhood.com/oauth";
export const TOKEN_URL = "https://api.robinhood.com/oauth2/token/";
export const REGISTER_URL = "https://agent.robinhood.com/oauth/trading/register";
export const SCOPE = "internal";

export class OAuthError extends Error {
  /** True when the grant is gone (revoked, expired refresh token): the owner must connect again. */
  constructor(message: string, readonly reconnect = false) { super(message); }
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export const randomState = () => b64url(randomBytes(24));

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new OAuthError(`Robinhood client registration failed (${res.status}): ${String(data.error_description ?? data.error ?? "no detail")}`);
  return data;
}

/** Registers this deployment as an OAuth client for one redirect URI. The caller caches the client_id. */
export async function registerClient(redirectUri: string): Promise<string> {
  const data = await postJson(REGISTER_URL, {
    client_name: "Agent Guild",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  if (typeof data.client_id !== "string") throw new OAuthError("Robinhood client registration returned no client_id");
  return data.client_id;
}

export function authorizeUrl(opts: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
    scope: SCOPE,
    resource: MCP_URL,
  }).toString();
  return url.toString();
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...params, resource: MCP_URL }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    const code = String(data.error ?? "");
    // invalid_grant = the code/refresh token is spent or revoked; nothing but a new sign-in fixes it.
    throw new OAuthError(`Robinhood token request failed (${res.status}${code ? `: ${code}` : ""})`, code === "invalid_grant" || res.status === 401);
  }
  const expiresIn = Number(data.expires_in);
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
  };
}

export const exchangeCode = (opts: { clientId: string; redirectUri: string; code: string; verifier: string }) =>
  tokenRequest({ grant_type: "authorization_code", client_id: opts.clientId, redirect_uri: opts.redirectUri, code: opts.code, code_verifier: opts.verifier });

/** Robinhood may rotate the refresh token; a reply without one keeps the old one. */
export async function refreshTokens(clientId: string, refreshToken: string): Promise<Tokens> {
  const next = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
  return { ...next, refreshToken: next.refreshToken ?? refreshToken };
}
