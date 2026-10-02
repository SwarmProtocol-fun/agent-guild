// @vitest-environment node
import { describe, it, expect, beforeAll, vi } from "vitest";
import { SignJWT } from "jose";

const agentDoc: { exists: boolean; data: () => Record<string, unknown> } = {
  exists: true,
  data: () => ({ orgId: "org1" }),
};
vi.mock("../firebase-admin", () => ({
  adminDb: () => ({ collection: () => ({ doc: () => ({ get: async () => agentDoc }) }) }),
}));

import { issueAgentToken, decodeAgentToken, verifyAgentToken, parseScopes, bearerToken, TOKEN_PREFIX } from "../agent-tokens";
import { Timestamp } from "firebase-admin/firestore";

const agent = { agentId: "agentA", orgId: "org1", agentName: "A" };

beforeAll(() => {
  process.env.SESSION_SECRET = "x".repeat(64);
});

describe("agent tokens", () => {
  it("issues a prefixed token that round-trips its claims", async () => {
    const { token, claims } = await issueAgentToken(agent, { scopes: ["bindings:execute"], bindings: ["stripe-api"], ttlSeconds: 300 });
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(claims.expiresAt - claims.issuedAt).toBe(300);
    const decoded = await decodeAgentToken(token);
    expect(decoded).toMatchObject({ agentId: "agentA", orgId: "org1", scopes: ["bindings:execute"], bindings: ["stripe-api"] });
  });

  it("clamps the lifetime to 60s..24h", async () => {
    const short = await issueAgentToken(agent, { scopes: ["bindings:list"], ttlSeconds: 1 });
    expect(short.claims.expiresAt - short.claims.issuedAt).toBe(60);
    const long = await issueAgentToken(agent, { scopes: ["bindings:list"], ttlSeconds: 10 ** 9 });
    expect(long.claims.expiresAt - long.claims.issuedAt).toBe(24 * 3600);
  });

  it("rejects tampered, expired and foreign tokens", async () => {
    const { token } = await issueAgentToken(agent, { scopes: ["bindings:list"] });
    expect(await decodeAgentToken(token.slice(0, -2) + "xx")).toBeNull();
    expect(await decodeAgentToken(token.slice(TOKEN_PREFIX.length))).toBeNull(); // missing prefix

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    expect(await decodeAgentToken(token)).toBeNull();
    vi.useRealTimers();
  });

  it("can't be forged from a session JWT signed with SESSION_SECRET itself", async () => {
    const sessionLike = await new SignJWT({ org: "org1", scp: ["bindings:execute"] })
      .setProtectedHeader({ alg: "HS256", typ: "agent+jwt" })
      .setIssuer("agent-guild").setAudience("agent-guild:agent").setSubject("agentA")
      .setIssuedAt().setExpirationTime("10m")
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET!));
    expect(await decodeAgentToken(`${TOKEN_PREFIX}${sessionLike}`)).toBeNull();
  });

  it("is refused after revocation and when the agent changed org", async () => {
    const { token } = await issueAgentToken(agent, { scopes: ["bindings:list"] });
    expect(await verifyAgentToken(token)).not.toBeNull();

    agentDoc.data = () => ({ orgId: "org1", tokensNotBefore: Timestamp.fromMillis(Date.now() + 1000) });
    expect(await verifyAgentToken(token)).toBeNull();

    agentDoc.data = () => ({ orgId: "org2" });
    expect(await verifyAgentToken(token)).toBeNull();

    agentDoc.data = () => ({ orgId: "org1" });
    agentDoc.exists = false;
    expect(await verifyAgentToken(token)).toBeNull();
    agentDoc.exists = true;
  });

  it("parses scopes", () => {
    expect(parseScopes(undefined)).toEqual(["bindings:list", "bindings:execute"]);
    expect(parseScopes("llm:proxy, bindings:list")).toEqual(["llm:proxy", "bindings:list"]);
    expect(parseScopes(["admin"])).toMatch(/Unknown scope/);
  });

  it("only picks up agt_ bearer tokens", () => {
    expect(bearerToken(new Headers({ authorization: "Bearer agt_abc" }))).toBe("agt_abc");
    expect(bearerToken(new Headers({ authorization: "Bearer sk-other" }))).toBeNull();
    expect(bearerToken(new Headers())).toBeNull();
  });
});
