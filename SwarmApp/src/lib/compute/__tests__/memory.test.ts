/**
 * `../firestore` is mocked at the module boundary — calling the real
 * getMemoryEntries/createMemoryEntry would hit Firebase Admin, which
 * throws in this environment (no service-account credentials configured
 * locally). This tests hybridSearchMemory/rememberMemory's own logic:
 * ranking, the substring/semantic merge, and graceful degradation when no
 * embedding provider is available — not Firestore plumbing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryEntry } from "../types";
import { StubEmbeddingProvider } from "../embeddings";

const getMemoryEntries = vi.fn();
const createMemoryEntry = vi.fn();
vi.mock("../firestore", () => ({
  getMemoryEntries: (...args: unknown[]) => getMemoryEntries(...args),
  createMemoryEntry: (...args: unknown[]) => createMemoryEntry(...args),
}));

const { hybridSearchMemory, rememberMemory } = await import("../memory");

function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: overrides.id || "mem_1",
    scopeType: "workspace",
    scopeId: "ws_1",
    workspaceId: "ws_1",
    computerId: null,
    agentId: null,
    createdByUserId: null,
    content: "",
    embeddingRef: null,
    embedding: null,
    encrypted: false,
    iv: null,
    authTag: null,
    tags: [],
    pinned: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("hybridSearchMemory", () => {
  beforeEach(() => {
    getMemoryEntries.mockReset();
    createMemoryEntry.mockReset();
  });

  it("falls back to substring-only ranking when no provider is configured", async () => {
    getMemoryEntries.mockResolvedValue([
      entry({ id: "a", content: "deploy target is Railway" }),
      entry({ id: "b", content: "unrelated note about pricing" }),
    ]);

    const results = await hybridSearchMemory("workspace", "ws_1", "railway", { provider: null });

    expect(results.map((r) => r.id)).toEqual(["a"]);
    expect(results[0].matchType).toBe("substring");
  });

  it("degrades to substring-only when the embedding provider throws", async () => {
    getMemoryEntries.mockResolvedValue([entry({ id: "a", content: "deploy target is Railway" })]);
    const failingProvider = { name: "failing", embed: vi.fn().mockRejectedValue(new Error("rate limited")) };

    const results = await hybridSearchMemory("workspace", "ws_1", "railway", { provider: failingProvider });

    expect(results.map((r) => r.id)).toEqual(["a"]);
    expect(failingProvider.embed).toHaveBeenCalledWith("railway");
  });

  it("ranks a pinned memory above an unpinned substring match", async () => {
    getMemoryEntries.mockResolvedValue([
      entry({ id: "unpinned", content: "railway deploy notes" }),
      entry({ id: "pinned", content: "railway deploy notes", pinned: true }),
    ]);

    const results = await hybridSearchMemory("workspace", "ws_1", "railway", { provider: null });

    expect(results[0].id).toBe("pinned");
  });

  it("surfaces a semantically similar entry even without a substring hit", async () => {
    const provider = new StubEmbeddingProvider();
    const railwayVector = await provider.embed("railway deploy notes");
    getMemoryEntries.mockResolvedValue([
      entry({ id: "semantic-match", content: "unrelated wording entirely", embedding: railwayVector }),
    ]);

    const results = await hybridSearchMemory("workspace", "ws_1", "railway deploy notes", { provider });

    expect(results.map((r) => r.id)).toContain("semantic-match");
    expect(results[0].matchType).toBe("semantic");
  });

  it("excludes an entry that matches neither substring nor embedding", async () => {
    const provider = new StubEmbeddingProvider();
    const unrelatedVector = await provider.embed("completely different topic");
    getMemoryEntries.mockResolvedValue([
      entry({ id: "no-match", content: "nothing relevant here", embedding: unrelatedVector }),
    ]);

    const results = await hybridSearchMemory("workspace", "ws_1", "railway deploy notes", { provider });

    expect(results.map((r) => r.id)).not.toContain("no-match");
  });

  it("returns pinned-first order for an empty query", async () => {
    getMemoryEntries.mockResolvedValue([
      entry({ id: "a" }),
      entry({ id: "b", pinned: true }),
    ]);

    const results = await hybridSearchMemory("workspace", "ws_1", "", { provider: null });

    expect(results[0].id).toBe("b");
  });

  it("never substring-matches an encrypted entry's ciphertext, even if it happens to contain the query text", async () => {
    // "railway" appears literally in this "ciphertext" on purpose — proves
    // the exclusion is driven by the `encrypted` flag, not content shape.
    getMemoryEntries.mockResolvedValue([
      entry({ id: "encrypted", content: "railway-looking-ciphertext-blob", encrypted: true, iv: "iv", authTag: "tag" }),
    ]);

    const results = await hybridSearchMemory("workspace", "ws_1", "railway", { provider: null });

    expect(results.map((r) => r.id)).not.toContain("encrypted");
  });

  it("still ranks an encrypted entry semantically using its caller-supplied embedding", async () => {
    const provider = new StubEmbeddingProvider();
    const queryVector = await provider.embed("deploy notes");
    getMemoryEntries.mockResolvedValue([
      entry({ id: "encrypted-semantic", content: "opaque-ciphertext", encrypted: true, iv: "iv", authTag: "tag", embedding: queryVector }),
    ]);

    const results = await hybridSearchMemory("workspace", "ws_1", "deploy notes", { provider });

    expect(results.map((r) => r.id)).toContain("encrypted-semantic");
    expect(results[0].matchType).toBe("semantic");
  });
});

describe("rememberMemory", () => {
  beforeEach(() => {
    getMemoryEntries.mockReset();
    createMemoryEntry.mockReset();
    createMemoryEntry.mockResolvedValue("new_id");
  });

  it("creates the entry with a null embedding when no provider is configured", async () => {
    await rememberMemory(
      { scopeType: "workspace", scopeId: "ws_1", workspaceId: "ws_1", computerId: null, agentId: null, createdByUserId: null, content: "hello", tags: [], pinned: false },
      { provider: null },
    );

    expect(createMemoryEntry).toHaveBeenCalledWith(expect.objectContaining({ embedding: null, embeddingRef: null }));
  });

  it("populates embedding + embeddingRef when a provider is available", async () => {
    const provider = new StubEmbeddingProvider();
    await rememberMemory(
      { scopeType: "workspace", scopeId: "ws_1", workspaceId: "ws_1", computerId: null, agentId: null, createdByUserId: null, content: "hello", tags: [], pinned: false },
      { provider },
    );

    const call = createMemoryEntry.mock.calls[0][0];
    expect(call.embedding).toEqual(await provider.embed("hello"));
    expect(call.embeddingRef).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still creates the entry when embedding generation fails", async () => {
    const failingProvider = { name: "failing", embed: vi.fn().mockRejectedValue(new Error("rate limited")) };
    await rememberMemory(
      { scopeType: "workspace", scopeId: "ws_1", workspaceId: "ws_1", computerId: null, agentId: null, createdByUserId: null, content: "hello", tags: [], pinned: false },
      { provider: failingProvider },
    );

    expect(createMemoryEntry).toHaveBeenCalledWith(expect.objectContaining({ content: "hello", embedding: null }));
  });

  it("stores ciphertext as-is and never calls an embedding provider for encrypted content", async () => {
    const provider = new StubEmbeddingProvider();
    const embedSpy = vi.spyOn(provider, "embed");
    await rememberMemory(
      {
        scopeType: "agent", scopeId: "agent_1", workspaceId: null, computerId: null, agentId: "agent_1", createdByUserId: null,
        content: "base64-ciphertext-blob", tags: [], pinned: false,
        encrypted: true, iv: "base64-iv", authTag: "base64-tag", precomputedEmbedding: [0.1, 0.2],
      },
      { provider },
    );

    expect(embedSpy).not.toHaveBeenCalled();
    expect(createMemoryEntry).toHaveBeenCalledWith(expect.objectContaining({
      content: "base64-ciphertext-blob",
      encrypted: true,
      iv: "base64-iv",
      authTag: "base64-tag",
      embedding: [0.1, 0.2],
      embeddingRef: null,
    }));
  });

  it("rejects an encrypted entry missing iv or authTag", async () => {
    await expect(rememberMemory({
      scopeType: "agent", scopeId: "agent_1", workspaceId: null, computerId: null, agentId: "agent_1", createdByUserId: null,
      content: "ciphertext", tags: [], pinned: false, encrypted: true,
    })).rejects.toThrow(/iv and authTag/);
  });
});
