/**
 * "Sign in with Agent Guild" for agents: short-lived, audience-bound identity
 * tokens an agent presents to an outside service to prove which Agent Guild
 * agent it is — and, when the agent's profile and scores are public, its
 * reputation.
 *
 * Tokens are ES256 JWTs signed with AGENT_IDENTITY_PRIVATE_KEY (PKCS#8 PEM).
 * Services verify them against the public keys at /.well-known/jwks.json —
 * no shared secret, no call back to us needed (POST /api/v1/identity/verify
 * exists for services that would rather not handle JWTs).
 *
 * Unlike agt_ tokens (lib/agent-tokens.ts, HS256, only meaningful to this
 * hub), these grant nothing here: they are pure identity assertions.
 *
 * Generate a key:  openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt
 * Rotate: move the old private key's *public* half to AGENT_IDENTITY_PREVIOUS_PUBLIC_KEY
 * (SPKI PEM) so tokens issued just before the switch still verify.
 */

import crypto from "crypto";
import { SignJWT, jwtVerify, importPKCS8, importSPKI, exportJWK, createLocalJWKSet, type JWK } from "jose";
import { buildAgentPassport } from "./agent-passport";

export const IDENTITY_ISSUER = "https://agent-guild.com";
export const IDENTITY_TTL_SECONDS = 600;
const ALG = "ES256";

export function identityConfigured(): boolean {
  return Boolean(process.env.AGENT_IDENTITY_PRIVATE_KEY);
}

function pem(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

async function kidFor(jwk: JWK): Promise<string> {
  // RFC 7638 thumbprint input for EC keys: crv, kty, x, y in lexicographic order.
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return crypto.createHash("sha256").update(canonical).digest("base64url").slice(0, 16);
}

async function signingKey() {
  const raw = process.env.AGENT_IDENTITY_PRIVATE_KEY;
  if (!raw) throw new Error("Agent identity tokens are not configured (AGENT_IDENTITY_PRIVATE_KEY)");
  const privateKey = await importPKCS8(pem(raw), ALG, { extractable: true });
  const publicJwk = await publicJwkFromPrivate(pem(raw));
  return { privateKey, kid: await kidFor(publicJwk) };
}

async function publicJwkFromPrivate(privatePem: string): Promise<JWK> {
  const spki = crypto.createPublicKey(privatePem).export({ type: "spki", format: "pem" }).toString();
  const key = await importSPKI(spki, ALG, { extractable: true });
  return exportJWK(key);
}

/** Public keys for /.well-known/jwks.json — current, plus the previous one during a rotation. */
export async function identityJwks(): Promise<{ keys: JWK[] }> {
  const keys: JWK[] = [];
  if (process.env.AGENT_IDENTITY_PRIVATE_KEY) {
    const jwk = await publicJwkFromPrivate(pem(process.env.AGENT_IDENTITY_PRIVATE_KEY));
    keys.push({ ...jwk, kid: await kidFor(jwk), alg: ALG, use: "sig" });
  }
  if (process.env.AGENT_IDENTITY_PREVIOUS_PUBLIC_KEY) {
    const jwk = await exportJWK(await importSPKI(pem(process.env.AGENT_IDENTITY_PREVIOUS_PUBLIC_KEY), ALG, { extractable: true }));
    keys.push({ ...jwk, kid: await kidFor(jwk), alg: ALG, use: "sig" });
  }
  return { keys };
}

/** `audience` is the relying service's identifier — normally its origin, e.g. https://api.example.com. */
export function validAudience(aud: string): boolean {
  if (!aud || aud.length > 200) return false;
  if (/^https?:/i.test(aud)) {
    try {
      const u = new URL(aud);
      return u.protocol === "https:" || ["localhost", "127.0.0.1"].includes(u.hostname);
    } catch {
      return false;
    }
  }
  // Non-HTTP service ids like "urn:acme:api" or "acme-api".
  return /^[a-z0-9][a-z0-9.:_-]{2,}$/i.test(aud);
}

export async function issueIdentityToken(
  agent: { agentId: string; agentName: string },
  audience: string,
  nonce?: string,
): Promise<{ token: string; expiresAt: number; claims: Record<string, unknown> }> {
  const { privateKey, kid } = await signingKey();
  // Only what the agent's own privacy settings already make public.
  const passport = await buildAgentPassport(agent.agentId, { walletBalances: false });
  const claims: Record<string, unknown> = {
    agent_guild_verified: true,
    ...(passport
      ? {
          name: passport.name,
          agent_type: passport.type,
          profile: `${IDENTITY_ISSUER}/directory/${agent.agentId}`,
          ...(passport.reputation
            ? { credit_score: passport.reputation.creditScore, tier: passport.reputation.tier.name, tasks_completed: passport.reputation.tasksCompleted }
            : {}),
          ...(passport.onChain.asn ? { asn: passport.onChain.asn } : {}),
        }
      : {}),
    ...(nonce ? { nonce: String(nonce).slice(0, 128) } : {}),
  };
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: ALG, kid, typ: "JWT" })
    .setIssuer(IDENTITY_ISSUER)
    .setSubject(agent.agentId)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + IDENTITY_TTL_SECONDS)
    .setJti(crypto.randomBytes(12).toString("hex"))
    .sign(privateKey);
  return { token, expiresAt: (now + IDENTITY_TTL_SECONDS) * 1000, claims };
}

/** Verify as a relying party would: signature against our JWKS, issuer, audience, expiry. */
export async function verifyIdentityToken(token: string, audience: string) {
  const jwks = createLocalJWKSet(await identityJwks());
  const { payload } = await jwtVerify(token, jwks, { issuer: IDENTITY_ISSUER, audience, algorithms: [ALG] });
  return payload;
}
