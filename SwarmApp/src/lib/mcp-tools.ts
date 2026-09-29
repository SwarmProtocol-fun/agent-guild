/**
 * MCP tool logic — pure functions (agent identity + args in, plain object
 * out), no MCP SDK types leak in here. The MCP route (src/app/api/v1/mcp/
 * route.ts) is a thin wrapper that registers these as tools; keeping the
 * logic here makes it unit-testable without spinning up a transport.
 *
 * Context Vault PRD §43/§44 — scoped to the tools that map onto
 * capability this codebase actually ships (remember/recall/pack/link/
 * graph). No context_forget/context_update/context_search_documents —
 * those stay REST-only (PATCH/DELETE already exist under
 * /api/compute/memory/[id]) rather than growing the MCP surface to match
 * a tool list nothing has asked for yet.
 */
import type { AgentIdentity } from "./agent-memory-server";
import { assembleAgentContext } from "./agent-context-pack";
import { rememberMemory, hybridSearchMemory } from "./compute/memory";
import { linkEntities, getRelatedEntities, InvalidGraphEntityError } from "./compute/graph";
import type { MemoryScopeType, GraphEntityType } from "./compute/types";
import { scanForSecrets, sanitizeText } from "./secret-scanner";

const MAX_CONTENT_LENGTH = 50_000;
const MAX_TAGS = 20;

export class McpToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolInputError";
  }
}

/** Same discipline as agent-memory-server.ts's redactBeforePersist — scan
 *  once, log only the secret *types* on a hit (never the matched value),
 *  return sanitized content. Applied here because context_remember is a
 *  new write path taking arbitrary agent-supplied content, same class of
 *  input the Context Vault PRD's secret-redaction requirement (§4.5)
 *  covers on the other three write paths. */
function redactBeforePersist(raw: string, agentId: string): string {
  const scan = scanForSecrets(raw);
  if (scan.clean) return raw;
  const types = [...new Set(scan.secrets.map((s) => s.type))];
  console.warn(`[mcp:context_remember] redacted secret(s) in write from agent ${agentId}: ${types.join(", ")}`);
  return sanitizeText(raw);
}

export interface McpRememberArgs {
  content: string;
  scopeType?: MemoryScopeType;
  scopeId?: string;
  tags?: string[];
  pinned?: boolean;
  /** True when `content` is ciphertext the calling agent produced itself
   *  (AES-256-GCM, key derived locally from its X25519 vault keypair — see
   *  docs/PRD-Context-Vault.md §5). Requires `iv`/`authTag`; the server
   *  stores and returns the blob as-is and never attempts to decrypt it. */
  encrypted?: boolean;
  iv?: string;
  authTag?: string;
  /** Only meaningful when `encrypted` is true — the agent's own embedding
   *  of its plaintext, computed before encrypting, since the server never
   *  sees plaintext to embed for these entries. */
  embedding?: number[];
}

export async function mcpRemember(agent: AgentIdentity, args: McpRememberArgs): Promise<{ id: string }> {
  if (!args.content || typeof args.content !== "string") {
    throw new McpToolInputError("content is required");
  }
  if (args.content.length > MAX_CONTENT_LENGTH) {
    throw new McpToolInputError(`content must be at most ${MAX_CONTENT_LENGTH} characters`);
  }
  if (args.tags && (!Array.isArray(args.tags) || args.tags.length > MAX_TAGS)) {
    throw new McpToolInputError(`tags must be an array of at most ${MAX_TAGS} items`);
  }
  if (args.encrypted && (!args.iv || !args.authTag)) {
    throw new McpToolInputError("encrypted content requires iv and authTag");
  }

  const scopeType = args.scopeType ?? "agent";
  const scopeId = args.scopeId ?? agent.agentId;
  // Secret-scanning a ciphertext blob is meaningless (it's uniform random
  // bytes to the scanner) and would only produce false positives — the
  // redaction discipline only applies to plaintext the server can read.
  const content = args.encrypted ? args.content : redactBeforePersist(args.content, agent.agentId);

  const id = await rememberMemory({
    scopeType,
    scopeId,
    workspaceId: null,
    computerId: null,
    agentId: agent.agentId,
    createdByUserId: null,
    content,
    tags: args.tags ?? [],
    pinned: args.pinned ?? false,
    ...(args.encrypted ? { encrypted: true, iv: args.iv, authTag: args.authTag, precomputedEmbedding: args.embedding ?? null } : {}),
  });
  return { id };
}

export interface McpRecallArgs {
  query: string;
  scopeType?: MemoryScopeType;
  scopeId?: string;
  limit?: number;
}

export interface McpRecallResult {
  id: string;
  /** Ciphertext when `encrypted` is true — the caller must decrypt it
   *  locally with its own derived content key; the server never has and
   *  never returns a decrypted version. */
  content: string;
  encrypted: boolean;
  iv: string | null;
  authTag: string | null;
  score: number;
  matchType: "semantic" | "substring" | "both";
  tags: string[];
  pinned: boolean;
}

export async function mcpRecall(agent: AgentIdentity, args: McpRecallArgs): Promise<{ results: McpRecallResult[] }> {
  if (!args.query || typeof args.query !== "string") {
    throw new McpToolInputError("query is required");
  }
  const scopeType = args.scopeType ?? "agent";
  const scopeId = args.scopeId ?? agent.agentId;
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 100);

  const scored = await hybridSearchMemory(scopeType, scopeId, args.query, { limit });
  return {
    results: scored.map((m) => ({
      id: m.id,
      content: m.content,
      encrypted: m.encrypted,
      iv: m.iv,
      authTag: m.authTag,
      score: m.score,
      matchType: m.matchType,
      tags: m.tags,
      pinned: m.pinned,
    })),
  };
}

export interface McpContextPackArgs {
  task?: string;
  tokenBudget?: number;
}

export async function mcpContextPack(agent: AgentIdentity, args: McpContextPackArgs) {
  return assembleAgentContext(agent, { task: args.task, tokenBudget: args.tokenBudget });
}

export interface McpLinkArgs {
  toType: GraphEntityType;
  toId: string;
  relation: string;
  fromType?: GraphEntityType;
  fromId?: string;
}

export async function mcpLink(agent: AgentIdentity, args: McpLinkArgs): Promise<{ id: string }> {
  if (!args.toType || !args.toId || !args.relation) {
    throw new McpToolInputError("toType, toId, and relation are required");
  }
  const from = { type: args.fromType ?? ("agent" as GraphEntityType), id: args.fromId ?? agent.agentId };
  try {
    const id = await linkEntities(agent.orgId, from, { type: args.toType, id: args.toId }, args.relation, {
      type: "agent",
      id: agent.agentId,
    });
    return { id };
  } catch (err) {
    if (err instanceof InvalidGraphEntityError) throw new McpToolInputError(err.message);
    throw err;
  }
}

export interface McpGraphArgs {
  type: GraphEntityType;
  id: string;
  relation?: string;
  limit?: number;
}

export async function mcpGraph(agent: AgentIdentity, args: McpGraphArgs) {
  if (!args.type || !args.id) {
    throw new McpToolInputError("type and id are required");
  }
  try {
    const edges = await getRelatedEntities(
      agent.orgId,
      { type: args.type, id: args.id },
      { relation: args.relation, limit: args.limit },
    );
    return { edges };
  } catch (err) {
    if (err instanceof InvalidGraphEntityError) throw new McpToolInputError(err.message);
    throw err;
  }
}
