/**
 * POST /api/compute/memory/search — Search memory entries
 */
import { NextRequest } from "next/server";
import crypto from "crypto";
import { requireWalletOrAgentIdentity } from "@/lib/agent-identity-guard";
import { hybridSearchMemory } from "@/lib/compute/memory";
import type { MemoryScopeType } from "@/lib/compute/types";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");

  const auth = await requireWalletOrAgentIdentity(req, `POST:/compute/memory/search:${bodyHash}`);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON.parse is `any` by design
  let body: any;
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  let { scopeType, scopeId } = body as { scopeType?: MemoryScopeType; scopeId?: string };
  const { query: searchQuery, limit } = body as { query: string; limit?: number };

  if (auth.agent) {
    scopeType = scopeType ?? "agent";
    scopeId = scopeId ?? auth.agent.agentId;
  }

  if (!scopeType || !scopeId) {
    return Response.json({ error: "scopeType and scopeId required" }, { status: 400 });
  }

  const entries = await hybridSearchMemory(scopeType, scopeId, searchQuery || "", { limit });
  return Response.json({ ok: true, entries });
}
