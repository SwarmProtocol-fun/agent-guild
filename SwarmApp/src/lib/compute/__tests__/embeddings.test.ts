import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cosineSimilarity,
  contentHash,
  StubEmbeddingProvider,
  getEmbeddingProvider,
  OpenAIEmbeddingProvider,
  VoyageEmbeddingProvider,
  GoogleEmbeddingProvider,
  GenericEmbeddingProvider,
  EmbeddingProviderError,
  EmbeddingCredentialError,
  type EmbeddingProvider,
} from "../embeddings";

const EMBEDDING_ENV_VARS = [
  "OPENAI_API_KEY",
  "VOYAGE_API_KEY",
  "GOOGLE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_PROVIDER",
] as const;

/** Saves + clears every embedding-related env var, restores on cleanup —
 *  needed because getEmbeddingProvider's auto-detect reads several at
 *  once, so tests can't just manage OPENAI_API_KEY in isolation anymore. */
function withCleanEmbeddingEnv() {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of EMBEDDING_ENV_VARS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of EMBEDDING_ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 for mismatched lengths instead of throwing", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for a zero-magnitude vector instead of NaN", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for two empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("contentHash", () => {
  it("is deterministic for identical content", () => {
    expect(contentHash("same text")).toBe(contentHash("same text"));
  });

  it("differs for different content", () => {
    expect(contentHash("text a")).not.toBe(contentHash("text b"));
  });

  it("returns a 64-char hex sha256 digest", () => {
    expect(contentHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("StubEmbeddingProvider", () => {
  const provider = new StubEmbeddingProvider();

  it("is deterministic for identical input", async () => {
    const a = await provider.embed("hello");
    const b = await provider.embed("hello");
    expect(a).toEqual(b);
  });

  it("produces different vectors for different input", async () => {
    const a = await provider.embed("hello");
    const b = await provider.embed("goodbye");
    expect(a).not.toEqual(b);
  });

  it("produces a vector similarity close to 1 for identical text", async () => {
    const a = await provider.embed("deploy target is Railway");
    const b = await provider.embed("deploy target is Railway");
    expect(cosineSimilarity(a, b)).toBeCloseTo(1);
  });
});

describe("getEmbeddingProvider — ambient auto-detect", () => {
  withCleanEmbeddingEnv();

  it("returns null when nothing is configured — never throws", () => {
    expect(getEmbeddingProvider()).toBeNull();
  });

  it("returns an OpenAIEmbeddingProvider when OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    expect(getEmbeddingProvider()).toBeInstanceOf(OpenAIEmbeddingProvider);
  });

  it("returns a VoyageEmbeddingProvider when only VOYAGE_API_KEY is set", () => {
    process.env.VOYAGE_API_KEY = "voyage-test-key";
    expect(getEmbeddingProvider()).toBeInstanceOf(VoyageEmbeddingProvider);
  });

  it("returns a GoogleEmbeddingProvider when only GOOGLE_AI_API_KEY is set (the existing agent-persona credential)", () => {
    process.env.GOOGLE_AI_API_KEY = "google-test-key";
    expect(getEmbeddingProvider()).toBeInstanceOf(GoogleEmbeddingProvider);
  });

  it("also accepts GOOGLE_API_KEY as a fallback alias for Google", () => {
    process.env.GOOGLE_API_KEY = "google-test-key";
    expect(getEmbeddingProvider()).toBeInstanceOf(GoogleEmbeddingProvider);
  });

  it("also accepts GEMINI_API_KEY as a fallback alias for Google", () => {
    process.env.GEMINI_API_KEY = "gemini-test-key";
    expect(getEmbeddingProvider()).toBeInstanceOf(GoogleEmbeddingProvider);
  });

  it("returns a GenericEmbeddingProvider when only EMBEDDING_BASE_URL is set", () => {
    process.env.EMBEDDING_BASE_URL = "http://localhost:11434";
    expect(getEmbeddingProvider()).toBeInstanceOf(GenericEmbeddingProvider);
  });

  it("prefers OpenAI over other configured providers when multiple credentials exist (fixed priority order)", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.VOYAGE_API_KEY = "voyage-test";
    expect(getEmbeddingProvider()).toBeInstanceOf(OpenAIEmbeddingProvider);
  });

  it("EMBEDDING_PROVIDER pins the ambient path to a specific provider, overriding priority order", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.VOYAGE_API_KEY = "voyage-test";
    process.env.EMBEDDING_PROVIDER = "voyage";
    expect(getEmbeddingProvider()).toBeInstanceOf(VoyageEmbeddingProvider);
  });

  it("degrades to null (not a throw) when EMBEDDING_PROVIDER is pinned but that provider's own credential is missing", () => {
    process.env.OPENAI_API_KEY = "sk-test"; // available, but not what's pinned
    process.env.EMBEDDING_PROVIDER = "voyage"; // no VOYAGE_API_KEY set
    expect(getEmbeddingProvider()).toBeNull();
  });
});

describe("getEmbeddingProvider — explicit modelKey selection", () => {
  withCleanEmbeddingEnv();

  it("maps each ModelKey to its documented provider", () => {
    process.env.OPENAI_API_KEY = "k";
    process.env.VOYAGE_API_KEY = "k";
    process.env.GOOGLE_API_KEY = "k";
    process.env.EMBEDDING_BASE_URL = "http://localhost";

    expect(getEmbeddingProvider("openai")).toBeInstanceOf(OpenAIEmbeddingProvider);
    expect(getEmbeddingProvider("claude")).toBeInstanceOf(VoyageEmbeddingProvider);
    expect(getEmbeddingProvider("gemini")).toBeInstanceOf(GoogleEmbeddingProvider);
    expect(getEmbeddingProvider("generic")).toBeInstanceOf(GenericEmbeddingProvider);
  });

  it("throws EmbeddingCredentialError — not null — when explicitly requested but the credential is missing", () => {
    // Nothing configured at all.
    expect(() => getEmbeddingProvider("claude")).toThrow(EmbeddingCredentialError);
  });

  it("is unaffected by EMBEDDING_PROVIDER — explicit modelKey always wins", () => {
    process.env.EMBEDDING_PROVIDER = "openai";
    process.env.VOYAGE_API_KEY = "k";
    expect(getEmbeddingProvider("claude")).toBeInstanceOf(VoyageEmbeddingProvider);
  });
});

/** Shared contract tests for the four network-backed providers — each
 *  should: throw EmbeddingProviderError with no credential (without
 *  calling fetch), throw on a non-ok response, throw on a malformed body,
 *  and return the vector on a well-formed one. None of these hit a real
 *  network — see embeddings.ts's doc comment on why (no live API keys in
 *  this environment for any of the four backends). */
function describeProviderContract(
  label: string,
  makeProvider: () => EmbeddingProvider,
  credentialEnvVar: string | string[],
  mockOkResponse: (vector: number[]) => unknown,
  mockMalformedResponse: () => unknown,
) {
  describe(label, () => {
    withCleanEmbeddingEnv();

    afterEach(() => vi.unstubAllGlobals());

    it("throws EmbeddingProviderError when no credential is configured, without calling fetch", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      await expect(makeProvider().embed("x")).rejects.toThrow(EmbeddingProviderError);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("throws EmbeddingProviderError on a non-ok HTTP response", async () => {
      for (const v of Array.isArray(credentialEnvVar) ? credentialEnvVar : [credentialEnvVar]) {
        process.env[v] = "test-value";
      }
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

      await expect(makeProvider().embed("x")).rejects.toThrow(EmbeddingProviderError);
    });

    it("throws EmbeddingProviderError on a malformed response body", async () => {
      for (const v of Array.isArray(credentialEnvVar) ? credentialEnvVar : [credentialEnvVar]) {
        process.env[v] = "test-value";
      }
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => mockMalformedResponse() }));

      await expect(makeProvider().embed("x")).rejects.toThrow(EmbeddingProviderError);
    });

    it("returns the embedding vector on a well-formed response", async () => {
      for (const v of Array.isArray(credentialEnvVar) ? credentialEnvVar : [credentialEnvVar]) {
        process.env[v] = "test-value";
      }
      const fakeVector = [0.1, 0.2, 0.3];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => mockOkResponse(fakeVector) }));

      await expect(makeProvider().embed("x")).resolves.toEqual(fakeVector);
    });
  });
}

describeProviderContract(
  "OpenAIEmbeddingProvider",
  () => new OpenAIEmbeddingProvider(),
  "OPENAI_API_KEY",
  (v) => ({ data: [{ embedding: v }] }),
  () => ({}),
);

describeProviderContract(
  "VoyageEmbeddingProvider",
  () => new VoyageEmbeddingProvider(),
  "VOYAGE_API_KEY",
  (v) => ({ data: [{ embedding: v }] }),
  () => ({}),
);

describeProviderContract(
  "GoogleEmbeddingProvider",
  () => new GoogleEmbeddingProvider(),
  "GOOGLE_AI_API_KEY",
  (v) => ({ embedding: { values: v } }),
  () => ({}),
);

describeProviderContract(
  "GenericEmbeddingProvider",
  () => new GenericEmbeddingProvider(),
  "EMBEDDING_BASE_URL",
  (v) => ({ data: [{ embedding: v }] }),
  () => ({}),
);
