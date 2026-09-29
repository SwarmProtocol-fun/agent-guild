/**
 * GET  /api/compute/memory?scopeType=workspace&scopeId=xxx  — List memory entries
 * POST /api/compute/memory                                   — Create memory entry
 */
import { NextRequest } from "next/server";
import { getWalletAddress } from "@/lib/auth-guard";
import { getMemoryEntries, createMemoryEntry } from "@/lib/compute/firestore";
import type { MemoryScopeType } from "@/lib/compute/types";

export async function GET(req: NextRequest) {
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const scopeType = req.nextUrl.searchParams.get("scopeType") as MemoryScopeType | null;
  const scopeId = req.nextUrl.searchParams.get("scopeId");

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
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const body = await req.json();
  const { scopeType, scopeId, content, tags, workspaceId, computerId, agentId, pinned } = body;

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

  const id = await createMemoryEntry({
    scopeType,
    scopeId,
    workspaceId: workspaceId || null,
    computerId: computerId || null,
    agentId: agentId || null,
    createdByUserId: wallet,
    content,
    embeddingRef: null,
    tags: tags || [],
    pinned: pinned ?? false,
  });

  return Response.json({ ok: true, id }, { status: 201 });
}
