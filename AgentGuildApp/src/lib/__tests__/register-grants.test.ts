/**
 * /api/v1/register anti-sybil gate, end to end against the in-memory
 * Firestore: binding a key to a new identity needs a single-use owner grant,
 * counts against the owner's quota, and starts the agent provisional.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeFirestore, fakeFieldValue, fakeTimestamp } from "@/lib/lending/__tests__/fake-firestore";

let db: FakeFirestore;
let humanVerified = false;

vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => db }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: fakeFieldValue, Timestamp: fakeTimestamp }));
vi.mock("@/lib/firestore-admin", () => ({
    getOrganization: async (id: string) => db.col("organizations").get(id) ?? null,
    agentCheckIn: async () => undefined,
    ensureAgentGroupChat: async () => ({ id: "hub" }),
}));
vi.mock("@/lib/solana/client", () => ({ solanaAddressFromEd25519Pem: (pem: string) => `sol_${pem.length}_${pem.slice(-8)}` }));
vi.mock("@/lib/solana/platform", () => ({ registerAgentForOnChain: async () => ({ txSignature: null }) }));
vi.mock("@/lib/identity-nft-service", () => ({ ensureAgentIdentityNfts: async () => undefined, needsIdentityNfts: () => false }));
vi.mock("@/lib/asn-auto-restore", () => ({ checkAndRestoreASN: async () => ({ restored: false }) }));
vi.mock("@/lib/reputation-chain", () => ({
    emitSkillReport: async () => undefined,
    createPrivateMemoryTopic: async () => { throw new Error("offline"); },
    postPrivateMemory: async () => undefined,
}));
vi.mock("@/lib/credit-events/ingest", () => ({ ingestCreditEvent: async () => undefined, normalizeAgentRegistration: () => ({}) }));
vi.mock("@/lib/scoring-engine", () => ({ recomputeAndSync: async () => undefined }));
vi.mock("@/lib/human-verification", () => ({ isOwnerHumanVerified: async () => humanVerified }));
vi.mock("@/lib/agent-avatar", () => ({ getAgentAvatarUrl: () => "avatar" }));
vi.mock("@/app/api/v1/briefing", () => ({ PLATFORM_BRIEFING: "" }));
vi.mock("@/app/api/v1/verify", () => ({ isAdminConfigError: () => false }));

const { POST } = await import("@/app/api/v1/register/route");
const { issueSetupToken, hashToken } = await import("@/lib/agent-registration-grants");

const OWNER = "0xowner";
const pem = (n: string) => `-----BEGIN PUBLIC KEY-----\n${n.padEnd(12, "x")}\n-----END PUBLIC KEY-----`;

async function register(body: Record<string, unknown>) {
    const res = await POST({ json: async () => ({ orgId: "org1", agentType: "agent", ...body }) } as never);
    return { status: res.status, body: await res.json() };
}

const agents = () => db.all("agents");
const seedAgent = (id: string, data: Record<string, unknown>) => db.col("agents").set(id, { orgId: "org1", status: "offline", ...data });

beforeEach(() => {
    db = new FakeFirestore();
    humanVerified = false;
    db.col("organizations").set("org1", { ownerAddress: OWNER, members: [OWNER] });
    db.col("organizations").set("org2", { ownerAddress: "0xother", members: [] });
});

describe("new identities need the owner's grant", () => {
    it("rejects a bare orgId — no agent is minted", async () => {
        const r = await register({ publicKey: pem("k1"), agentName: "bot-2" });
        expect(r.status).toBe(403);
        expect(r.body.code).toBe("REGISTRATION_GRANT_REQUIRED");
        expect(agents()).toHaveLength(0);
    });

    it("mints a provisional, owner-charged agent with a valid setup token, then burns the token", async () => {
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "bot", issuedBy: OWNER });
        const r = await register({ publicKey: pem("k1"), agentName: "bot", registrationToken: token });
        expect(r.status).toBe(200);
        expect(r.body.existing).toBe(false);
        const [a] = agents();
        expect(a).toMatchObject({ name: "bot", provisional: true, ownerWallet: OWNER });
        expect(typeof a.keyBoundAt).toBe("number");
        expect(db.col("agentRegistrationGrants").get(hashToken(token))!.usedAt).toBeTypeOf("number");

        const again = await register({ publicKey: pem("k2"), agentName: "bot", registrationToken: token });
        expect(again.body.code).toBe("REGISTRATION_GRANT_USED");
    });

    it("a token for another name or org is refused and stays unused", async () => {
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "bot", issuedBy: OWNER });
        expect((await register({ publicKey: pem("k1"), agentName: "other", registrationToken: token })).body.code).toBe("REGISTRATION_GRANT_MISMATCH");
        expect((await register({ publicKey: pem("k1"), agentName: "bot", orgId: "org2", registrationToken: token })).body.code).toBe("REGISTRATION_GRANT_MISMATCH");
        expect(db.col("agentRegistrationGrants").get(hashToken(token))!.usedAt).toBeNull();
    });

    it("expired tokens are refused", async () => {
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "bot", issuedBy: OWNER });
        db.col("agentRegistrationGrants").get(hashToken(token))!.expiresAt = Date.now() - 1;
        expect((await register({ publicKey: pem("k1"), agentName: "bot", registrationToken: token })).body.code).toBe("REGISTRATION_GRANT_EXPIRED");
    });

    it("an invite code is a single-use grant", async () => {
        db.col("agentInvites").set("i1", { code: "ABCD2345", orgId: "org1", agentName: "joiner", createdBy: OWNER, expiresAt: Date.now() + 1e6, usedAt: null });
        expect((await register({ publicKey: pem("k1"), agentName: "joiner", inviteCode: "abcd2345" })).status).toBe(200);
        expect((await register({ publicKey: pem("k2"), agentName: "joiner", inviteCode: "ABCD2345" })).body.code).toBe("REGISTRATION_GRANT_USED");
    });

    it("legacy invites without expiresAt age out from createdAt", async () => {
        db.col("agentInvites").set("i1", { code: "OLDCODE1", orgId: "org1", agentName: "j", createdBy: OWNER, createdAt: { seconds: Date.now() / 1000 - 8 * 86400 } });
        expect((await register({ publicKey: pem("k1"), agentName: "j", inviteCode: "OLDCODE1" })).body.code).toBe("REGISTRATION_GRANT_EXPIRED");
    });
});

describe("existing identities", () => {
    it("a known key reconnects without any grant", async () => {
        seedAgent("a1", { name: "bot", publicKey: pem("k1"), walletAddress: "w", asn: "ASN-1" });
        const r = await register({ publicKey: pem("k1"), agentName: "bot" });
        expect(r.status).toBe(200);
        expect(r.body.existing).toBe(true);
    });

    it("knowing an org + agent name no longer lets anyone swap the agent's key", async () => {
        seedAgent("a1", { name: "bot", publicKey: pem("victim"), walletAddress: "w", asn: "ASN-1" });
        const r = await register({ publicKey: pem("attacker"), agentName: "bot", takeover: true });
        expect(r.status).toBe(403);
        expect(db.col("agents").get("a1")!.publicKey).toBe(pem("victim"));
    });

    it("an owner-authorized takeover still needs --takeover, and a refused attempt keeps the token", async () => {
        seedAgent("a1", { name: "bot", publicKey: pem("old"), walletAddress: "w", asn: "ASN-1" });
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "bot", issuedBy: OWNER });
        const first = await register({ publicKey: pem("new"), agentName: "bot", registrationToken: token });
        expect(first.body.code).toBe("KEY_TAKEOVER_REQUIRED");
        const second = await register({ publicKey: pem("new"), agentName: "bot", registrationToken: token, takeover: true });
        expect(second.status).toBe(200);
        expect(second.body.keyUpdated).toBe(true);
        expect(db.col("agents").get("a1")!.publicKey).toBe(pem("new"));
    });

    it("a dashboard-reserved agent gets bound and starts provisional on first key", async () => {
        seedAgent("r1", { name: "fresh", asn: "ASN-R", creditScore: 680 });
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "fresh", agentId: "r1", issuedBy: OWNER });
        const r = await register({ publicKey: pem("k1"), agentName: "fresh", registrationToken: token });
        expect(r.status).toBe(200);
        expect(r.body.agentId).toBe("r1");
        expect(db.col("agents").get("r1")).toMatchObject({ provisional: true, ownerWallet: OWNER, publicKey: pem("k1") });
    });

    it("a retired agent can't reconnect", async () => {
        seedAgent("a1", { name: "bot", publicKey: pem("k1"), walletAddress: "w", asn: "ASN-1", retiredAt: Date.now() });
        expect((await register({ publicKey: pem("k1"), agentName: "bot" })).body.code).toBe("AGENT_RETIRED");
    });
});

describe("owner quota", () => {
    const fill = (n: number) => {
        for (let i = 0; i < n; i++) seedAgent(`o${i}`, { name: `o${i}`, publicKey: pem(`o${i}`), ownerWallet: OWNER, keyBoundAt: Date.now() - 10 * 86400_000 });
    };

    it("stops an unverified owner at 3 active agents without burning the grant", async () => {
        fill(3);
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "fourth", issuedBy: OWNER });
        const r = await register({ publicKey: pem("k4"), agentName: "fourth", registrationToken: token });
        expect(r.status).toBe(429);
        expect(r.body.code).toBe("OWNER_AGENT_LIMIT");
        expect(db.col("agentRegistrationGrants").get(hashToken(token))!.usedAt).toBeNull();
    });

    it("a proof-of-human verified owner can go further", async () => {
        fill(3);
        humanVerified = true;
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "fourth", issuedBy: OWNER });
        expect((await register({ publicKey: pem("k4"), agentName: "fourth", registrationToken: token })).status).toBe(200);
    });

    it("key rotation on an already-bound agent doesn't count as a new identity", async () => {
        fill(3);
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "o0", agentId: "o0", issuedBy: OWNER });
        expect((await register({ publicKey: pem("rotated"), agentName: "o0", registrationToken: token })).status).toBe(200);
    });
});
