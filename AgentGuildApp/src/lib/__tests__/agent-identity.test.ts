// @vitest-environment node
import { describe, it, expect, beforeAll, vi } from "vitest";
import crypto from "node:crypto";

const passports = new Map<string, unknown>();
vi.mock("../agent-passport", () => ({ buildAgentPassport: async (id: string) => passports.get(id) ?? null }));

import { issueIdentityToken, verifyIdentityToken, identityJwks, validAudience } from "../agent-identity";

const newKey = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pkcs8 = (k: crypto.KeyObject) => k.export({ type: "pkcs8", format: "pem" }).toString();
const spki = (k: crypto.KeyObject) => k.export({ type: "spki", format: "pem" }).toString();

beforeAll(() => {
  // Env-var style: newlines escaped, as PEMs usually arrive from a dashboard.
  process.env.AGENT_IDENTITY_PRIVATE_KEY = pkcs8(newKey().privateKey).replace(/\n/g, "\\n");
  passports.set("pubAgent", {
    name: "Scout", type: "research",
    reputation: { creditScore: 712, tier: { name: "Gold" }, tasksCompleted: 41 },
    onChain: { asn: "ASN-123", solanaRegistered: true },
  });
});

const AUD = "https://api.example.com";

describe("agent identity tokens", () => {
  it("issues a token a relying party can verify with the JWKS", async () => {
    const { token, claims } = await issueIdentityToken({ agentId: "pubAgent", agentName: "Scout" }, AUD, "n-42");
    const payload = await verifyIdentityToken(token, AUD);
    expect(payload).toMatchObject({ sub: "pubAgent", iss: "https://agent-guild.com", aud: AUD, name: "Scout", credit_score: 712, tier: "Gold", nonce: "n-42" });
    expect(claims.agent_guild_verified).toBe(true);
    expect(payload.exp! - payload.iat!).toBe(600);
  });

  it("publishes only public key material", async () => {
    const { keys } = await identityJwks();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(keys[0].d).toBeUndefined();
    expect(keys[0].kid).toBeTruthy();
  });

  it("rejects the wrong audience and tampered tokens", async () => {
    const { token } = await issueIdentityToken({ agentId: "pubAgent", agentName: "Scout" }, AUD);
    await expect(verifyIdentityToken(token, "https://other.example.com")).rejects.toThrow();
    const [h, p, s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), credit_score: 900 })).toString("base64url");
    await expect(verifyIdentityToken(`${h}.${forged}.${s}`, AUD)).rejects.toThrow();
  });

  it("asserts only identity for agents whose profile is private", async () => {
    const { token } = await issueIdentityToken({ agentId: "privateAgent", agentName: "Hidden" }, AUD);
    const payload = await verifyIdentityToken(token, AUD);
    expect(payload.sub).toBe("privateAgent");
    expect(payload.name).toBeUndefined();
    expect(payload.credit_score).toBeUndefined();
  });

  it("keeps tokens from the previous key valid during rotation", async () => {
    const { token } = await issueIdentityToken({ agentId: "pubAgent", agentName: "Scout" }, AUD);
    const oldPrivate = process.env.AGENT_IDENTITY_PRIVATE_KEY!.replace(/\\n/g, "\n");
    process.env.AGENT_IDENTITY_PREVIOUS_PUBLIC_KEY = spki(crypto.createPublicKey(oldPrivate));
    process.env.AGENT_IDENTITY_PRIVATE_KEY = pkcs8(newKey().privateKey);
    expect((await identityJwks()).keys).toHaveLength(2);
    expect((await verifyIdentityToken(token, AUD)).sub).toBe("pubAgent");
    delete process.env.AGENT_IDENTITY_PREVIOUS_PUBLIC_KEY;
    await expect(verifyIdentityToken(token, AUD)).rejects.toThrow();
  });

  it("validates audiences", () => {
    expect(validAudience("https://api.example.com")).toBe(true);
    expect(validAudience("urn:acme:api")).toBe(true);
    expect(validAudience("http://localhost:3000")).toBe(true);
    expect(validAudience("http://api.example.com")).toBe(false);
    expect(validAudience("")).toBe(false);
  });
});
