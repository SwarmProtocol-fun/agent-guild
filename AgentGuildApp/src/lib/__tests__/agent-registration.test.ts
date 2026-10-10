// @vitest-environment node
/**
 * /api/v1/register anti-sybil gate, end to end against an in-memory
 * Firestore: a new identity or key change needs the org owner's single-use
 * grant, counts against the owner's quota, and starts provisional.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeFirestore, fakeFieldValue, fakeTimestamp } from "../lending/__tests__/fake-firestore";

let db: FakeFirestore;
let humanVerified = false;
let asnCounter = 0;

vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => db }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: fakeFieldValue, Timestamp: fakeTimestamp }));
vi.mock("@/lib/firestore-admin", () => ({
    getOrganization: async (id: string) => (await db.collection("organizations").doc(id).get()).data() ?? null,
    agentCheckIn: async () => undefined,
    ensureAgentGroupChat: async () => ({ id: "hub" }),
}));
vi.mock("@/lib/credit-scoring", () => ({ generateASN: () => `ASN-TEST-${++asnCounter}` }));
vi.mock("@/lib/solana/client", () => ({ solanaAddressFromEd25519Pem: (pem: string) => `sol:${pem.length}:${pem.slice(-12)}` }));
vi.mock("@/lib/solana/platform", () => ({ registerAgentForOnChain: async () => ({ txSignature: null }) }));
vi.mock("@/lib/identity-nft-service", () => ({ ensureAgentIdentityNfts: async () => undefined, needsIdentityNfts: () => false }));
vi.mock("@/lib/asn-auto-restore", () => ({ checkAndRestoreASN: async () => ({ restored: false }) }));
vi.mock("@/lib/reputation-chain", () => ({
    emitSkillReport: async () => undefined,
    createPrivateMemoryTopic: async () => { throw new Error("no memory in tests"); },
    postPrivateMemory: async () => undefined,
}));
vi.mock("@/lib/credit-events/ingest", () => ({ ingestCreditEvent: async () => undefined, normalizeAgentRegistration: () => ({}) }));
vi.mock("@/lib/scoring-engine", () => ({ recomputeAndSync: async () => undefined }));
vi.mock("@/lib/human-verification", () => ({ isOwnerHumanVerified: async () => humanVerified }));
vi.mock("@/app/api/v1/verify", () => ({ isAdminConfigError: () => false }));

const { POST } = await import("@/app/api/v1/register/route");
const { issueSetupToken, hashToken } = await import("@/lib/agent-registration-grants");

const OWNER = "ownerwallet";
const pem = (n: string) => `-----BEGIN PUBLIC KEY-----\nKEY${n}\n-----END PUBLIC KEY-----`;

async function register(body: Record<string, unknown>) {
    const resp = await POST({ json: async () => ({ orgId: "org1", agentType: "agent", ...body }) } as never);
    return { status: resp.status, body: await resp.json() };
}

const agents = () => db.all("agents");

beforeEach(async () => {
    db = new FakeFirestore();
    humanVerified = false;
    await db.collection("organizations").doc("org1").set({ name: "Org", ownerAddress: OWNER, members: [OWNER] });
});

describe("new identities need the owner's grant", () => {
    it("rejects a new agent with no token or invite — and creates nothing", async () => {
        const r = await register({ publicKey: pem("a"), agentName: "bot" });
        expect(r.status).toBe(403);
        expect(r.body.code).toBe("REGISTRATION_GRANT_REQUIRED");
        expect(agents()).toHaveLength(0);
    });

    it("registers with a setup token: provisional, charged to the owner, token burned", async () => {
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "bot", issuedBy: OWNER });
        const r = await register({ publicKey: pem("a"), agentName: "bot", registrationToken: token });
        expect(r.status).toBe(200);
        expect(r.body.existing).toBe(false);

        const [a] = agents();
        expect(a).toMatchObject({ name: "bot", provisional: true, ownerWallet: OWNER, publicKey: pem("a") });
        expect(typeof a.keyBoundAt).toBe("number");
        expect(db.col("agentRegistrationGrants").get(hashToken(token))!.usedAt).toBeTypeOf("number");
    });

    it("a token is single-use", async () => {
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "bot", issuedBy: OWNER });
        await register({ publicKey: pem("a"), agentName: "bot", registrationToken: token });
        const r = await register({ publicKey: pem("b"), agentName: "bot", registrationToken: token, takeover: true });
        expect(r.body.code).toBe("REGISTRATION_GRANT_USED");
        expect(agents()[0].publicKey).toBe(pem("a"));
    });

    it("a token for one name can't mint a different one, and isn't burned trying", async () => {
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "bot", issuedBy: OWNER });
        const r = await register({ publicKey: pem("a"), agentName: "other", registrationToken: token });
        expect(r.body.code).toBe("REGISTRATION_GRANT_MISMATCH");
        expect(db.col("agentRegistrationGrants").get(hashToken(token))!.usedAt).toBeNull();
    });

    it("expired tokens are rejected", async () => {
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "bot", issuedBy: OWNER });
        await db.collection("agentRegistrationGrants").doc(hashToken(token)).update({ expiresAt: Date.now() - 1 });
        expect((await register({ publicKey: pem("a"), agentName: "bot", registrationToken: token })).body.code).toBe("REGISTRATION_GRANT_EXPIRED");
    });

    it("accepts an invite code once, then rejects it", async () => {
        await db.collection("agentInvites").doc("inv1").set({
            code: "ABCD2345", orgId: "org1", agentName: "bot", createdBy: OWNER, expiresAt: Date.now() + 60_000, usedAt: null,
        });
        expect((await register({ publicKey: pem("a"), agentName: "bot", inviteCode: "abcd2345" })).status).toBe(200);
        expect((await register({ publicKey: pem("b"), agentName: "bot2", inviteCode: "ABCD2345" })).body.code).toBe("REGISTRATION_GRANT_USED");
    });

    it("rejects a legacy invite older than 7 days", async () => {
        await db.collection("agentInvites").doc("inv1").set({
            code: "OLDCODE2", orgId: "org1", agentName: "bot", createdBy: OWNER, createdAt: { seconds: (Date.now() - 8 * 86_400_000) / 1000 },
        });
        expect((await register({ publicKey: pem("a"), agentName: "bot", inviteCode: "OLDCODE2" })).body.code).toBe("REGISTRATION_GRANT_EXPIRED");
    });
});

describe("existing identities", () => {
    it("the same key reconnects without any token", async () => {
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "bot", issuedBy: OWNER });
        await register({ publicKey: pem("a"), agentName: "bot", registrationToken: token });
        const r = await register({ publicKey: pem("a"), agentName: "bot" });
        expect(r.status).toBe(200);
        expect(r.body.existing).toBe(true);
    });

    it("knowing an org id + agent name no longer lets anyone take over the key", async () => {
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "bot", issuedBy: OWNER });
        await register({ publicKey: pem("a"), agentName: "bot", registrationToken: token });
        const r = await register({ publicKey: pem("attacker"), agentName: "bot", takeover: true });
        expect(r.status).toBe(403);
        expect(agents()[0].publicKey).toBe(pem("a"));
    });

    it("an owner-authorized takeover still needs --takeover, without burning the token", async () => {
        const first = await issueSetupToken({ orgId: "org1", agentName: "bot", issuedBy: OWNER });
        await register({ publicKey: pem("a"), agentName: "bot", registrationToken: first.token });

        const { token } = await issueSetupToken({ orgId: "org1", agentName: "bot", issuedBy: OWNER });
        const r = await register({ publicKey: pem("b"), agentName: "bot", registrationToken: token });
        expect(r.body.code).toBe("KEY_TAKEOVER_REQUIRED");

        const r2 = await register({ publicKey: pem("b"), agentName: "bot", registrationToken: token, takeover: true });
        expect(r2.status).toBe(200);
        expect(r2.body.keyUpdated).toBe(true);
        expect(agents()).toHaveLength(1);
        expect(agents()[0].publicKey).toBe(pem("b"));
    });

    it("binds a dashboard-reserved agent named by the token and starts it provisional", async () => {
        await db.collection("agents").doc("res1").set({ orgId: "org1", name: "reserved", status: "offline", creditScore: 680 });
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "reserved", agentId: "res1", issuedBy: OWNER });
        const r = await register({ publicKey: pem("a"), agentName: "reserved", registrationToken: token });
        expect(r.status).toBe(200);
        expect(r.body.agentId).toBe("res1");
        expect(db.col("agents").get("res1")).toMatchObject({ publicKey: pem("a"), provisional: true, ownerWallet: OWNER });
    });

    it("a retired agent can't reconnect", async () => {
        await db.collection("agents").doc("old").set({ orgId: "org1", name: "old", publicKey: pem("a"), retiredAt: Date.now() });
        const r = await register({ publicKey: pem("a"), agentName: "old" });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe("AGENT_RETIRED");
    });
});

describe("owner quota", () => {
    const seed = async (n: number) => {
        for (let i = 0; i < n; i++) {
            await db.collection("agents").doc(`x${i}`).set({ orgId: "org1", name: `x${i}`, ownerWallet: OWNER, keyBoundAt: Date.now() - 5 * 86_400_000 });
        }
    };

    it("an unverified owner stops at 3 active agents — the grant survives for later", async () => {
        await seed(3);
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "bot", issuedBy: OWNER });
        const r = await register({ publicKey: pem("a"), agentName: "bot", registrationToken: token });
        expect(r.status).toBe(429);
        expect(r.body.code).toBe("OWNER_AGENT_LIMIT");
        expect(db.col("agentRegistrationGrants").get(hashToken(token))!.usedAt).toBeNull();
    });

    it("a proof-of-human verified owner can run more", async () => {
        await seed(3);
        humanVerified = true;
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "bot", issuedBy: OWNER });
        expect((await register({ publicKey: pem("a"), agentName: "bot", registrationToken: token })).status).toBe(200);
    });

    it("re-keying an already-bound agent doesn't consume quota", async () => {
        await seed(3);
        await db.collection("agents").doc("x0").update({ publicKey: pem("old") });
        const { token } = await issueSetupToken({ orgId: "org1", agentName: "x0", agentId: "x0", issuedBy: OWNER });
        expect((await register({ publicKey: pem("new"), agentName: "x0", registrationToken: token })).status).toBe(200);
    });
});
