/**
 * GET /api/v1/context?agent=&sig=&ts=   (or ?agentId=&apiKey=)
 *
 * The context library endpoint: merges an agent's working memory,
 * long-term memory, today's daily note, and recent chat messages across
 * its channels into one payload — the thing any agent framework can fetch
 * by its own ID to get its context.
 *
 * Query params:
 *   q       — case-insensitive substring filter. Narrows memory docs to
 *             matching ##/### sections and messages to matching text
 *             (keyword + recency, no embeddings — per product decision).
 *   limit   — max messages, default 50, capped at 200.
 *   since   — only messages after this epoch-ms timestamp.
 *   format  — "markdown" returns one prompt-ready text block instead of JSON.
 *
 * Read-only: never creates a memory doc (unlike the /v1/memory/* routes).
 */
import { NextRequest } from "next/server";
import { requireAgentAuth } from "@/lib/auth-guard";
import { rateLimit } from "../rate-limit";
import { getExistingMemory, getDailyNoteIfExists, type MemoryDoc } from "@/lib/agent-memory-server";
import { getRecentMessagesForAgent, type ContextMessage, type ResolvedChannel } from "@/lib/agent-context";

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Return only the ##/### sections (heading + body) whose heading or body
 *  contains `q`. Returns null if the doc has no matching section. */
function filterSections(content: string, q: string): string | null {
  const parts = content.split(/(?=^#{2,3} .+$)/m);
  const matches = parts.filter((p) => p.toLowerCase().includes(q));
  return matches.length > 0 ? matches.join("").trim() : null;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const agentParam = sp.get("agent") || sp.get("agentId") || "";
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  const auth = await requireAgentAuth(request, `GET:/v1/context:${agentParam}`);
  if (!auth.ok || !auth.agent) {
    return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });
  }
  if (!auth.agent.orgId) {
    return Response.json({ error: "Agent has no organization" }, { status: 403 });
  }

  const q = sp.get("q")?.trim().toLowerCase() || "";
  const limit = Math.min(parseInt(sp.get("limit") || "50", 10) || 50, 200);
  const sinceParam = sp.get("since");
  const sinceMs = sinceParam ? parseInt(sinceParam, 10) : undefined;
  const format = sp.get("format");

  try {
    const [memory, daily, recent] = await Promise.all([
      getExistingMemory(auth.agent),
      getDailyNoteIfExists(auth.agent, todayUTC()),
      getRecentMessagesForAgent(auth.agent.agentId, { limit, sinceMs }),
    ]);

    let working: MemoryDoc | null = memory.working;
    let longTerm: MemoryDoc | null = memory.longTerm;
    let dailyNote: MemoryDoc | null = daily;
    let messages: ContextMessage[] = recent.messages;

    if (q) {
      const narrowed = working ? filterSections(working.content, q) : null;
      working = narrowed && working ? { ...working, content: narrowed } : null;
      const narrowedLT = longTerm ? filterSections(longTerm.content, q) : null;
      longTerm = narrowedLT && longTerm ? { ...longTerm, content: narrowedLT } : null;
      const narrowedDaily = dailyNote ? filterSections(dailyNote.content, q) : null;
      dailyNote = narrowedDaily && dailyNote ? { ...dailyNote, content: narrowedDaily } : null;
      messages = messages.filter((m) => m.content.toLowerCase().includes(q));
    }

    const payload = {
      agent: { agentId: auth.agent.agentId, agentName: auth.agent.agentName, orgId: auth.agent.orgId },
      memory: {
        working: working?.content ?? null,
        longTerm: longTerm?.content ?? null,
        daily: dailyNote?.content ?? null,
      },
      messages,
      channels: recent.channels,
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
  messages: ContextMessage[];
  channels: ResolvedChannel[];
}): string {
  const lines: string[] = [`# Context — ${payload.agent.agentName} (${payload.agent.agentId})`, ""];

  if (payload.memory.working) lines.push(payload.memory.working, "");
  if (payload.memory.longTerm) lines.push(payload.memory.longTerm, "");
  if (payload.memory.daily) lines.push(payload.memory.daily, "");

  if (payload.messages.length > 0) {
    lines.push("## Recent Messages", "");
    for (const m of payload.messages) {
      const when = new Date(m.timestamp).toISOString();
      lines.push(`- [${when}] **${m.from}** (#${m.channelName}): ${m.content}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
