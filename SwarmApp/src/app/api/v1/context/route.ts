/**
 * GET /api/v1/context?agent=&sig=&ts=   (or ?agentId=&apiKey=)
 *
 * The context library endpoint: merges an agent's working memory,
 * long-term memory, today's daily note, and recent chat messages across
 * its channels into one payload — the thing any agent framework can fetch
 * by its own ID to get its context.
 *
 * Query params:
 *   q           — case-insensitive substring filter. Narrows memory docs to
 *                 matching ##/### sections and messages to matching text
 *                 (keyword + recency, no embeddings — per product decision;
 *                 this behavior is unchanged by tokenBudget/task below).
 *   task        — optional. When present, additionally runs semantic +
 *                 substring ranking (compute/memory.ts's hybridSearchMemory,
 *                 scoped to this agent) and includes the results as
 *                 `rankedMemories`. Purely additive — omitting `task`
 *                 leaves every other field exactly as before this option
 *                 existed. Degrades to substring-only ranking if no
 *                 embedding provider is configured (Context Vault PRD §3).
 *   tokenBudget — default 8000, clamped to [500, 32000]. Context Vault PRD
 *                 §4.4 — greedy truncation, whole documents/messages/ranked
 *                 memories are included or omitted, never clipped mid-item
 *                 (see context-pack.ts). This is new: earlier versions of
 *                 this endpoint returned everything unbounded. Pass a large
 *                 tokenBudget to approximate the old behavior.
 *   limit       — max messages, default 50, capped at 200.
 *   since       — only messages after this epoch-ms timestamp.
 *   format      — "markdown" returns one prompt-ready text block instead of JSON.
 *
 * Read-only: never creates a memory doc (unlike the /v1/memory/* routes).
 */
import { NextRequest } from "next/server";
import { requireAgentIdentity } from "@/lib/agent-identity-guard";
import { logAgentCall } from "@/lib/agent-call-log";
import { rateLimit } from "../rate-limit";
import { type ResolvedChannel } from "@/lib/agent-context";
import { assembleAgentContext } from "@/lib/agent-context-pack";
import { clampTokenBudget, type RankedMemoryInput, type ContextMessageInput } from "@/lib/context-pack";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const agentParam = sp.get("agent") || sp.get("agentId") || "";
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  const auth = await requireAgentIdentity(request, `GET:/v1/context:${agentParam}`);
  if (!auth.ok || !auth.agent) {
    return Response.json({ error: auth.error || "Unauthorized" }, { status: auth.status || 401 });
  }
  if (!auth.agent.orgId) {
    return Response.json({ error: "Agent has no organization" }, { status: 403 });
  }
  logAgentCall({
    agentId: auth.agent.agentId,
    orgId: auth.agent.orgId,
    authMethod: "unknown",
    method: "GET",
    endpoint: "/v1/context",
  });

  const q = sp.get("q")?.trim().toLowerCase() || "";
  const task = sp.get("task")?.trim() || "";
  const tokenBudget = clampTokenBudget(sp.get("tokenBudget"));
  const limit = Math.min(parseInt(sp.get("limit") || "50", 10) || 50, 200);
  const sinceParam = sp.get("since");
  const sinceMs = sinceParam ? parseInt(sinceParam, 10) : undefined;
  const format = sp.get("format");

  try {
    const assembled = await assembleAgentContext(auth.agent, { task, tokenBudget, q, messageLimit: limit, sinceMs });

    const payload = {
      agent: { agentId: auth.agent.agentId, agentName: auth.agent.agentName, orgId: auth.agent.orgId },
      memory: {
        working: assembled.working,
        longTerm: assembled.longTerm,
        daily: assembled.daily,
      },
      rankedMemories: assembled.rankedMemories,
      messages: assembled.messages,
      channels: assembled.channels,
      tokenBudget: assembled.tokenBudget,
      tokenCount: assembled.tokenCount,
      truncated: assembled.truncated,
      omitted: assembled.omitted,
      generatedAt: Date.now(),
    };

    if (format === "markdown") {
      return new Response(toMarkdown(payload), {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }
    return Response.json(payload);
  } catch (err) {
    console.error("GET /v1/context error:", err);
    return Response.json({ error: "Failed to build context" }, { status: 500 });
  }
}

function toMarkdown(payload: {
  agent: { agentId: string; agentName: string; orgId: string };
  memory: { working: string | null; longTerm: string | null; daily: string | null };
  rankedMemories: RankedMemoryInput[];
  // Narrower than ContextMessage — toMarkdown only ever reads these four
  // fields, and payload.messages comes out of buildContextPack() typed as
  // ContextMessageInput[], which doesn't carry id/channelId/fromType.
  messages: ContextMessageInput[];
  channels: ResolvedChannel[];
  tokenBudget: number;
  tokenCount: number;
  truncated: boolean;
  omitted: string[];
}): string {
  const lines: string[] = [`# Context — ${payload.agent.agentName} (${payload.agent.agentId})`, ""];

  if (payload.memory.working) lines.push(payload.memory.working, "");
  if (payload.memory.longTerm) lines.push(payload.memory.longTerm, "");
  if (payload.memory.daily) lines.push(payload.memory.daily, "");

  if (payload.rankedMemories.length > 0) {
    lines.push("## Relevant Memories", "");
    for (const m of payload.rankedMemories) {
      lines.push(`- (score ${m.score.toFixed(2)}) ${m.content}`);
    }
    lines.push("");
  }

  if (payload.messages.length > 0) {
    lines.push("## Recent Messages", "");
    for (const m of payload.messages) {
      const when = new Date(m.timestamp).toISOString();
      lines.push(`- [${when}] **${m.from}** (#${m.channelName}): ${m.content}`);
    }
    lines.push("");
  }

  if (payload.truncated) {
    lines.push(
      `> Context truncated to fit a ${payload.tokenBudget}-token budget (used ~${payload.tokenCount}). ` +
      `Omitted: ${payload.omitted.join(", ")}.`,
      "",
    );
  }

  return lines.join("\n");
}
