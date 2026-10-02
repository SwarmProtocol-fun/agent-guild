/**
 * Short-lived, scoped agent tokens.
 *
 * An agent proves itself once with its Ed25519 key (POST /api/v1/tokens) and
 * gets back a bearer token that expires in minutes and only allows the
 * listed scopes (and, optionally, only certain bindings). This is what goes
 * into places that shouldn't hold the agent's private key — a hosted runtime,
 * a sidecar, a CI job.
 *
 * Tokens are HS256 JWTs signed with a key *derived* from SESSION_SECRET (not
 * SESSION_SECRET itself) and carry their own iss/aud/typ, so one can never be
 * replayed as a dashboard session or vice versa. Org owners revoke every
 * outstanding token for an agent at once by bumping `tokensNotBefore` on the
 * agent doc (see revokeAgentTokens).
 */

import crypto from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";

export const TOKEN_PREFIX = "agt_";
export const TOKEN_SCOPES = ["bindings:list", "bindings:execute", "llm:proxy", "intents:submit", "identity:assert"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

const ISSUER = "agent-guild";
const AUDIENCE = "agent-guild:agent";
const TOKEN_TYPE = "agent+jwt";
export const MAX_TTL_SECONDS = 24 * 3600;
export const DEFAULT_TTL_SECONDS = 15 * 60;

export interface AgentTokenClaims {
  agentId: string;
  orgId: string;
  agentName: string;
  scopes: TokenScope[];
  /** When present, only these bindings may be used with the token. */
  bindings?: string[];
  issuedAt: number; // seconds
  expiresAt: number; // seconds
  jti: string;
}

function signingKey(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 32) throw new Error("SESSION_SECRET must be set (min 32 chars) to issue agent tokens");
  return new Uint8Array(crypto.createHmac("sha256", raw).update("agent-guild:agent-token:v1").digest());
}

export function parseScopes(raw: unknown): TokenScope[] | string {
  const list = (Array.isArray(raw) ? raw : String(raw ?? "").split(",")).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return ["bindings:list", "bindings:execute"];
  const bad = list.filter((s) => !(TOKEN_SCOPES as readonly string[]).includes(s));
  if (bad.length) return `Unknown scope(s): ${bad.join(", ")}. Allowed: ${TOKEN_SCOPES.join(", ")}`;
  return [...new Set(list)] as TokenScope[];
}

export async function issueAgentToken(
  agent: { agentId: string; orgId: string; agentName: string },
  opts: { scopes: TokenScope[]; bindings?: string[]; ttlSeconds?: number },
): Promise<{ token: string; claims: AgentTokenClaims }> {
  const ttl = Math.min(Math.max(Math.floor(opts.ttlSeconds ?? DEFAULT_TTL_SECONDS), 60), MAX_TTL_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomBytes(12).toString("hex");
  const jwt = await new SignJWT({
    org: agent.orgId,
    name: agent.agentName,
    scp: opts.scopes,
    ...(opts.bindings?.length ? { bnd: opts.bindings } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: TOKEN_TYPE })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(agent.agentId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setJti(jti)
    .sign(signingKey());
  return {
    token: `${TOKEN_PREFIX}${jwt}`,
    claims: {
      agentId: agent.agentId,
      orgId: agent.orgId,
      agentName: agent.agentName,
      scopes: opts.scopes,
      ...(opts.bindings?.length ? { bindings: opts.bindings } : {}),
      issuedAt: now,
      expiresAt: now + ttl,
      jti,
    },
  };
}

/** Signature, expiry, issuer/audience/type only — no revocation check (see verifyAgentToken). */
export async function decodeAgentToken(token: string): Promise<AgentTokenClaims | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  try {
    const { payload, protectedHeader } = await jwtVerify(token.slice(TOKEN_PREFIX.length), signingKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    if (protectedHeader.typ !== TOKEN_TYPE || !payload.sub || typeof payload.org !== "string") return null;
    return {
      agentId: payload.sub,
      orgId: payload.org,
      agentName: typeof payload.name === "string" ? payload.name : payload.sub,
      scopes: Array.isArray(payload.scp) ? (payload.scp as TokenScope[]) : [],
      ...(Array.isArray(payload.bnd) ? { bindings: payload.bnd as string[] } : {}),
      issuedAt: payload.iat ?? 0,
      expiresAt: payload.exp ?? 0,
      jti: payload.jti ?? "",
    };
  } catch {
    return null;
  }
}

/** Full check: signature + expiry + the agent still exists in the same org + not revoked since issue. */
export async function verifyAgentToken(token: string): Promise<AgentTokenClaims | null> {
  const claims = await decodeAgentToken(token);
  if (!claims) return null;
  const snap = await adminDb().collection("agents").doc(claims.agentId).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  if ((data.orgId || data.organizationId) !== claims.orgId) return null;
  const notBefore = data.tokensNotBefore instanceof Timestamp ? data.tokensNotBefore.seconds : 0;
  if (claims.issuedAt < notBefore) return null;
  return claims;
}

/** Invalidate every token issued to this agent so far. */
export async function revokeAgentTokens(agentId: string): Promise<void> {
  // +1s so a token minted in the same second as the revocation is also cut off.
  await adminDb().collection("agents").doc(agentId).update({
    tokensNotBefore: Timestamp.fromMillis(Date.now() + 1000),
    tokensRevokedAt: FieldValue.serverTimestamp(),
  });
}

export function bearerToken(headers: Headers): string | null {
  const h = headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m && m[1].startsWith(TOKEN_PREFIX) ? m[1] : null;
}
