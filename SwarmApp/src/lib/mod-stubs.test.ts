/**
 * issueAgentIdentity / getAgentIdentity — the core-native, synchronous
 * identity credential that requireAgentIdentity (auth-guard.ts) gates vault
 * access on. See docs/PRD-Context-Vault.md §5.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal in-memory Firestore fake — just enough for doc().get/set/update.
function createFakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  function docRef(id: string) {
    return {
      async get() {
        const exists = docs.has(id);
        return { exists, data: () => (exists ? docs.get(id) : undefined) };
      },
      async set(data: Record<string, unknown>) {
        docs.set(id, data);
      },
      async update(patch: Record<string, unknown>) {
        docs.set(id, { ...(docs.get(id) || {}), ...patch });
      },
    };
  }
  return {
    collection() {
      return { doc: (id: string) => docRef(id) };
    },
  };
}

const fakeDb = createFakeFirestore();
vi.mock("./firebase-admin", () => ({ adminDb: () => fakeDb }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "SERVER_TS" } }));

const { issueAgentIdentity, getAgentIdentity } = await import("./mod-stubs");

describe("issueAgentIdentity", () => {
  beforeEach(() => {
    // fresh fake per test — recreate the module-level map indirectly by
    // using unique agentIds per test instead of resetting the fake.
  });

  it("issues a new identity record on first registration", async () => {
    const record = await issueAgentIdentity("agent_a", "0xabc", "ASN-1", "vault-pub-a");
    expect(record).toMatchObject({ tokenId: "agent_a", asn: "ASN-1", agentAddress: "0xabc", vaultPublicKey: "vault-pub-a" });
    expect(typeof record.issuedAt).toBe("number");
  });

  it("is idempotent — re-registering the same agent returns the same tokenId/asn, not a new one", async () => {
    const first = await issueAgentIdentity("agent_b", "0xdef", "ASN-2", null);
    const second = await issueAgentIdentity("agent_b", "0xdef", "ASN-2", null);
    expect(second.tokenId).toBe(first.tokenId);
    expect(second.issuedAt).toBe(first.issuedAt);
  });

  it("backfills vaultPublicKey on a later registration if it was missing", async () => {
    await issueAgentIdentity("agent_c", "0xghi", "ASN-3", null);
    const backfilled = await issueAgentIdentity("agent_c", "0xghi", "ASN-3", "vault-pub-c");
    expect(backfilled.vaultPublicKey).toBe("vault-pub-c");

    const reread = await getAgentIdentity("agent_c");
    expect(reread?.vaultPublicKey).toBe("vault-pub-c");
  });

  it("never overwrites an already-set vaultPublicKey with a later omission", async () => {
    await issueAgentIdentity("agent_d", "0xjkl", "ASN-4", "vault-pub-d");
    const again = await issueAgentIdentity("agent_d", "0xjkl", "ASN-4", null);
    expect(again.vaultPublicKey).toBe("vault-pub-d");
  });
});

describe("getAgentIdentity", () => {
  it("returns null for an agent that never registered", async () => {
    expect(await getAgentIdentity("never_registered")).toBeNull();
  });

  it("returns the issued record for a registered agent", async () => {
    await issueAgentIdentity("agent_e", "0xmno", "ASN-5", "vault-pub-e");
    const identity = await getAgentIdentity("agent_e");
    expect(identity).toMatchObject({ tokenId: "agent_e", asn: "ASN-5", vaultPublicKey: "vault-pub-e" });
  });
});
