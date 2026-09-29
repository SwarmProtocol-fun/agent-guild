/**
 * Embedding provider for Compute Memory semantic search.
 *
 * Context Vault PRD (docs/PRD-Context-Vault.md) §4.1/§4.2 — deliberately
 * scoped to `compute/memory.ts`'s MemoryEntry, not the agent-context
 * library (`agent-memory-server.ts`). That library holds 2-3 large,
 * incrementally-edited markdown docs per agent (working/long-term/daily) —
 * too few per agent for embedding + ranking to add value over just
 * including them directly. Compute memory holds many small discrete
 * entries, which is the shape semantic retrieval is actually for. See the
 * PRD's §4.1 resolution note for the full reasoning — this file is where
 * that decision lands in code, not a migration of the other system.
 *
 * Mirrors provider.ts's shape: an interface, a real implementation per
 * backend, a stub for tests, and a factory — same pattern this codebase
 * already uses for compute providers, and deliberately keyed to the same
 * `ModelKey` taxonomy (compute/types.ts: claude/openai/gemini/generic)
 * agents and computers already use elsewhere, instead of inventing a
 * parallel one.
 *
 * IMPORTANT — provider choice is per-deployment, not per-agent-write.
 * Cosine similarity is only meaningful when the query vector and the
 * candidate vectors came from the *same* embedding model; different
 * models produce vectors with different dimensionality and a different
 * semantic space, so comparing an OpenAI-embedded memory against a
 * Voyage-embedded query isn't imprecise, it's meaningless. So although
 * this file supports every backend in ModelKey (an org can run on
 * whichever model family it has credentials for — "any model," per the
 * actual ask), `getEmbeddingProvider()`'s ambient/auto-detect path (no
 * `modelKey` argument — what `rememberMemory`/`hybridSearchMemory` use)
 * always resolves to one provider for the whole deployment, pinned by
 * `EMBEDDING_PROVIDER` or auto-detected from whichever credential exists.
 * It does NOT let each write pick a different provider based on whatever
 * model the calling agent happens to be using — that would silently
 * break ranking for any scope whose memories end up embedded by more than
 * one backend. The `modelKey` parameter exists for explicit/administrative
 * selection (e.g. provisioning), not per-write dynamic dispatch.
 */
import { createHash } from "crypto";
import type { ModelKey } from "./types";

export interface EmbeddingProvider {
  readonly name: string;
  embed(text: string): Promise<number[]>;
}

const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const OPENAI_EMBEDDING_DIMENSIONS = 1536;
const VOYAGE_EMBEDDING_MODEL = "voyage-3-lite";
const GOOGLE_EMBEDDING_MODEL = "text-embedding-004";

export class EmbeddingProviderError extends Error {
  constructor(provider: string, cause: string) {
    super(`Embedding provider "${provider}" failed: ${cause}`);
    this.name = "EmbeddingProviderError";
  }
}

/** Mirrors provider.ts's ProviderCredentialError — thrown only when a
 *  provider is explicitly requested (via `modelKey` or `EMBEDDING_PROVIDER`)
 *  and its credential is missing. Never thrown by ambient auto-detection,
 *  which returns `null` instead (see getEmbeddingProvider's doc comment). */
export class EmbeddingCredentialError extends Error {
  public readonly provider: string;
  public readonly missingEnvVar: string;

  constructor(provider: string, missingEnvVar: string) {
    super(
      `Embedding provider "${provider}" was requested but ${missingEnvVar} is not set. ` +
      `Set the required environment variable or remove the explicit selection to use auto-detection.`
    );
    this.name = "EmbeddingCredentialError";
    this.provider = provider;
    this.missingEnvVar = missingEnvVar;
  }
}

/**
 * Real provider — OpenAI's embeddings API. Not yet exercised against the
 * live API in this environment (no OPENAI_API_KEY configured here); the
 * request shape is per OpenAI's documented Embeddings endpoint. Tests
 * cover the provider contract via StubEmbeddingProvider instead of
 * mocking network calls to an endpoint this environment can't reach.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";

  async embed(text: string): Promise<number[]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new EmbeddingProviderError(this.name, "OPENAI_API_KEY is not set");
    }
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_EMBEDDING_MODEL,
        input: text,
        dimensions: OPENAI_EMBEDDING_DIMENSIONS,
      }),
    });
    if (!res.ok) {
      throw new EmbeddingProviderError(this.name, `HTTP ${res.status}`);
    }
    const data = await res.json();
    const vector = data?.data?.[0]?.embedding;
    if (!Array.isArray(vector)) {
      throw new EmbeddingProviderError(this.name, "malformed response — no embedding array");
    }
    return vector as number[];
  }
}

/**
 * Voyage AI — Anthropic's recommended embeddings partner (Anthropic has
 * no first-party embeddings endpoint of its own). Maps to ModelKey
 * "claude" in getEmbeddingProvider()'s explicit-selection path.
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = "voyage";

  async embed(text: string): Promise<number[]> {
    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      throw new EmbeddingProviderError(this.name, "VOYAGE_API_KEY is not set");
    }
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: VOYAGE_EMBEDDING_MODEL, input: [text] }),
    });
    if (!res.ok) {
      throw new EmbeddingProviderError(this.name, `HTTP ${res.status}`);
    }
    const data = await res.json();
    const vector = data?.data?.[0]?.embedding;
    if (!Array.isArray(vector)) {
      throw new EmbeddingProviderError(this.name, "malformed response — no embedding array");
    }
    return vector as number[];
  }
}

/**
 * Google's Gemini embeddings API. Maps to ModelKey "gemini".
 */
export class GoogleEmbeddingProvider implements EmbeddingProvider {
  readonly name = "google";

  async embed(text: string): Promise<number[]> {
    // GOOGLE_AI_API_KEY first — matches this codebase's existing "AI
    // providers (for agent personas)" convention in .env.example, and a
    // Google AI Studio key already works for both text generation and
    // embeddings, so reusing it avoids asking for a second credential
    // that would just be the same key under a different name.
    const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new EmbeddingProviderError(this.name, "GOOGLE_AI_API_KEY is not set");
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GOOGLE_EMBEDDING_MODEL}:embedContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { parts: [{ text }] } }),
      },
    );
    if (!res.ok) {
      throw new EmbeddingProviderError(this.name, `HTTP ${res.status}`);
    }
    const data = await res.json();
    const vector = data?.embedding?.values;
    if (!Array.isArray(vector)) {
      throw new EmbeddingProviderError(this.name, "malformed response — no embedding values");
    }
    return vector as number[];
  }
}

/**
 * Generic OpenAI-compatible embeddings endpoint — for self-hosted or
 * local models (Ollama, LM Studio, text-embeddings-inference, vLLM, etc.
 * commonly implement this same request/response shape). Maps to ModelKey
 * "generic". `EMBEDDING_BASE_URL` is the only required var; API key and
 * model name are optional since many local servers need neither.
 */
export class GenericEmbeddingProvider implements EmbeddingProvider {
  readonly name = "generic";

  async embed(text: string): Promise<number[]> {
    const baseUrl = process.env.EMBEDDING_BASE_URL;
    if (!baseUrl) {
      throw new EmbeddingProviderError(this.name, "EMBEDDING_BASE_URL is not set");
    }
    const apiKey = process.env.EMBEDDING_API_KEY;
    const model = process.env.EMBEDDING_MODEL || "default";
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, input: text }),
    });
    if (!res.ok) {
      throw new EmbeddingProviderError(this.name, `HTTP ${res.status}`);
    }
    const data = await res.json();
    const vector = data?.data?.[0]?.embedding;
    if (!Array.isArray(vector)) {
      throw new EmbeddingProviderError(this.name, "malformed response — no embedding array");
    }
    return vector as number[];
  }
}

/**
 * Deterministic fake provider for tests — same content always produces
 * the same vector, different content produces different vectors, with no
 * network dependency. Not for production use.
 */
export class StubEmbeddingProvider implements EmbeddingProvider {
  readonly name = "stub";

  async embed(text: string): Promise<number[]> {
    // Hash-seeded pseudo-vector: deterministic per input, no real semantic
    // meaning — good enough to exercise ranking/merge logic in tests.
    const hash = createHash("sha256").update(text).digest();
    const dims = 32;
    const vector: number[] = [];
    for (let i = 0; i < dims; i++) {
      vector.push((hash[i % hash.length] / 255) * 2 - 1);
    }
    return vector;
  }
}

type EmbeddingProviderKey = "openai" | "voyage" | "google" | "generic";

const PROVIDER_CONSTRUCTORS: Record<EmbeddingProviderKey, () => EmbeddingProvider> = {
  openai: () => new OpenAIEmbeddingProvider(),
  voyage: () => new VoyageEmbeddingProvider(),
  google: () => new GoogleEmbeddingProvider(),
  generic: () => new GenericEmbeddingProvider(),
};

/** Which env var getEmbeddingProvider checks to decide if a given
 *  provider is available, for both auto-detection and the explicit-but-
 *  missing-credential error message. */
const PROVIDER_CREDENTIALS: Record<EmbeddingProviderKey, { envVar: string; present: () => boolean }> = {
  openai: { envVar: "OPENAI_API_KEY", present: () => !!process.env.OPENAI_API_KEY },
  voyage: { envVar: "VOYAGE_API_KEY", present: () => !!process.env.VOYAGE_API_KEY },
  google: { envVar: "GOOGLE_AI_API_KEY", present: () => !!(process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) },
  generic: { envVar: "EMBEDDING_BASE_URL", present: () => !!process.env.EMBEDDING_BASE_URL },
};

/** ModelKey → embedding provider it maps to, for explicit selection via
 *  the `modelKey` argument. Anthropic has no first-party embeddings API,
 *  so "claude" maps to Voyage (Anthropic's own recommended partner). */
const MODEL_KEY_TO_PROVIDER: Record<ModelKey, EmbeddingProviderKey> = {
  claude: "voyage",
  openai: "openai",
  gemini: "google",
  generic: "generic",
};

/** Auto-detect priority order when nothing is explicitly selected — first
 *  credential found wins. Arbitrary but fixed, so auto-detection is at
 *  least deterministic across calls within one deployment. */
const AUTO_DETECT_ORDER: EmbeddingProviderKey[] = ["openai", "voyage", "google", "generic"];

/**
 * Resolves which embedding provider to use. Three ways to call it:
 *
 * 1. `getEmbeddingProvider()` — ambient/auto-detect (the default, used by
 *    rememberMemory/hybridSearchMemory). Returns the first configured
 *    provider in AUTO_DETECT_ORDER, or `null` if none are configured.
 *    Never throws — semantic search is an enhancement over substring
 *    search, not a hard requirement (PRD: "Vault must degrade gracefully").
 *    Can be pinned deployment-wide via `EMBEDDING_PROVIDER` (one of
 *    "openai"|"voyage"|"google"|"generic") instead of relying on the
 *    fixed priority order — pinning still degrades to `null` if that
 *    provider's own credential is missing, same as unpinned auto-detect,
 *    since `EMBEDDING_PROVIDER` is a preference for the ambient path, not
 *    an explicit per-call request.
 * 2. `getEmbeddingProvider(modelKey)` — explicit selection tied to a
 *    specific model family (claude/openai/gemini/generic — the same
 *    ModelKey used for agents/computers elsewhere in this codebase).
 *    Throws EmbeddingCredentialError if that provider's credential is
 *    missing, rather than silently falling back — same "phantom
 *    instances are worse than errors" rule compute/provider.ts already
 *    uses for explicit compute-provider selection. For administrative /
 *    provisioning use, NOT for per-write dynamic dispatch — see this
 *    file's top doc comment for why mixing providers within one
 *    searchable scope breaks ranking.
 */
export function getEmbeddingProvider(modelKey?: ModelKey): EmbeddingProvider | null {
  if (modelKey) {
    const key = MODEL_KEY_TO_PROVIDER[modelKey];
    const cred = PROVIDER_CREDENTIALS[key];
    if (!cred.present()) {
      throw new EmbeddingCredentialError(key, cred.envVar);
    }
    return PROVIDER_CONSTRUCTORS[key]();
  }

  const pinned = process.env.EMBEDDING_PROVIDER as EmbeddingProviderKey | undefined;
  const order = pinned && pinned in PROVIDER_CONSTRUCTORS ? [pinned] : AUTO_DETECT_ORDER;
  for (const key of order) {
    if (PROVIDER_CREDENTIALS[key].present()) {
      return PROVIDER_CONSTRUCTORS[key]();
    }
  }
  return null;
}

/** Cosine similarity between two equal-length vectors. Returns 0 for a
 *  zero-magnitude vector rather than NaN/dividing by zero. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** SHA-256 hex digest of memory content — stored in `embeddingRef` so a
 *  write path can skip re-embedding identical content (PRD §4.2/§123),
 *  without needing a vector store to check against. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
