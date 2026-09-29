/**
 * GET  /api/compute/memory?scopeType=workspace&scopeId=xxx  — List memory entries
 * POST /api/compute/memory                                   — Create memory entry
 */
import { NextRequest } from "next/server";
import crypto from "crypto";
import { requireWalletOrAgentIdentity } from "@/lib/agent-identity-guard";
import { getMemoryEntries } from "@/lib/compute/firestore";
import { rememberMemory } from "@/lib/compute/memory";
import type { MemoryScopeType } from "@/lib/compute/types";

export async function GET(req: NextRequest) {
  const auth = await requireWalletOrAgentIdentity(req, "GET:/compute/memory");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  // Agent callers default to their own agent-scoped memories — mirrors
  // mcpRecall's own defaulting (mcp-tools.ts) so the REST and MCP onramps
  // behave the same way for an agent that omits scope.
  const scopeType = (req.nextUrl.searchParams.get("scopeType") as MemoryScopeType | null)
    ?? (auth.agent ? "agent" : null);
  const scopeId = req.nextUrl.searchParams.get("scopeId") ?? (auth.agent ? auth.agent.agentId : null);

  if (!scopeType || !scopeId) {
    return Response.json({ error: "scopeType and scopeId required" }, { status: 400 });
  }

  const pinnedParam = req.nextUrl.searchParams.get("pinned");
  const entries = await getMemoryEntries(scopeType, scopeId, {
    pinned: pinnedParam ? pinnedParam === "true" : undefined,
    limit: parseInt(req.nextUrl.searchParams.get("limit") || "100"),
  });

  return Response.json({ ok: true, entries });
}

export async function POST(req: NextRequest) {
  // Read raw text first (not req.json()) so an Ed25519-signing caller's
  // body-hash binding — signedBodyRequest() in SwarmConnect's CLI, same
  // convention as PUT /v1/memory/working — verifies against exactly the
  // bytes that arrived, not a re-serialized copy.
  const rawBody = await req.text();
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");

  const auth = await requireWalletOrAgentIdentity(req, `POST:/compute/memory:${bodyHash}`);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON.parse is `any` by design; matches this route's pre-existing req.json() typing
  let body: any;
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { content, tags, workspaceId, computerId, pinned, encrypted, iv, authTag, embedding } = body;
  let { scopeType, scopeId, agentId } = body as { scopeType?: MemoryScopeType; scopeId?: string; agentId?: string };

  // Agent callers (Ed25519/API-key, no wallet session) default to writing
  // into their own agent scope, same as the MCP onramp's context_remember.
  if (auth.agent) {
    scopeType = scopeType ?? "agent";
    scopeId = scopeId ?? auth.agent.agentId;
    agentId = agentId ?? auth.agent.agentId;
  }

  if (!scopeType || !scopeId || !content) {
    return Response.json({ error: "scopeType, scopeId, and content are required" }, { status: 400 });
  }
  const VALID_SCOPES: MemoryScopeType[] = ["workspace", "computer", "agent", "user"];
  if (!VALID_SCOPES.includes(scopeType)) {
    return Response.json({ error: `Invalid scopeType. Must be one of: ${VALID_SCOPES.join(", ")}` }, { status: 400 });
  }
  if (typeof content !== "string" || content.length > 50000) {
    return Response.json({ error: "content must be a string with at most 50000 characters" }, { status: 400 });
  }
  if (tags && (!Array.isArray(tags) || tags.length > 20)) {
    return Response.json({ error: "tags must be an array with at most 20 items" }, { status: 400 });
  }
  if (encrypted && (!iv || !authTag)) {
    return Response.json({ error: "encrypted content requires iv and authTag" }, { status: 400 });
  }

  const id = await rememberMemory({
    scopeType,
    scopeId,
    workspaceId: workspaceId || null,
    computerId: computerId || null,
    agentId: agentId || null,
    createdByUserId: auth.walletAddress || null,
    content,
    tags: tags || [],
    pinned: pinned ?? false,
    ...(encrypted ? { encrypted: true, iv, authTag, precomputedEmbedding: embedding ?? null } : {}),
  });

  return Response.json({ ok: true, id }, { status: 201 });
}
