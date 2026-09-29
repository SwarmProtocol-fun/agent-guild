/**
 * Shared "assemble this agent's context" logic — extracted from
 * GET /api/v1/context so the same code path serves both that REST route
 * and the MCP `context_pack` tool (src/lib/mcp-tools.ts), instead of two
 * implementations that can drift. Byte-for-byte the same fetch → optional
 * `q` narrow → buildContextPack sequence the route used before this
 * extraction (verified via `mcp__gitnexus__impact` — the route's GET has
 * zero upstream callers, so refactoring its internals carries no external
 * contract risk as long as this preserves the same behavior, which it
 * does: same functions, same order, same defaults).
 */
import { getExistingMemory, getDailyNoteIfExists, type AgentIdentity, type MemoryDoc } from "./agent-memory-server";
import { getRecentMessagesForAgent, type ContextMessage, type ResolvedChannel } from "./agent-context";
import { hybridSearchMemory } from "./compute/memory";
import {
  buildContextPack,
  clampTokenBudget,
  type RankedMemoryInput,
  type ContextMessageInput,
} from "./context-pack";

export interface AssembleContextOptions {
  /** When given, runs hybridSearchMemory and includes results as
   *  rankedMemories. Omitting it leaves rankedMemories empty. */
  task?: string;
  tokenBudget?: number;
  /** Case-insensitive substring filter over memory doc sections and
   *  messages — the REST route's `q` param. Not used by the MCP tool,
   *  which relies on `task`-driven ranking instead. */
  q?: string;
  messageLimit?: number;
  sinceMs?: number;
}

export interface AssembledContext {
  working: string | null;
  longTerm: string | null;
  daily: string | null;
  rankedMemories: RankedMemoryInput[];
  messages: ContextMessageInput[];
  channels: ResolvedChannel[];
  tokenBudget: number;
  tokenCount: number;
  truncated: boolean;
  omitted: string[];
}

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

export async function assembleAgentContext(
  agent: AgentIdentity,
  opts: AssembleContextOptions = {},
): Promise<AssembledContext> {
  const { task, q, messageLimit = 50, sinceMs } = opts;
  const tokenBudget = clampTokenBudget(opts.tokenBudget);

  const [memory, daily, recent, ranked] = await Promise.all([
    getExistingMemory(agent),
    getDailyNoteIfExists(agent, todayUTC()),
    getRecentMessagesForAgent(agent.agentId, { limit: messageLimit, sinceMs }),
    task ? hybridSearchMemory("agent", agent.agentId, task, { limit: 20 }) : Promise.resolve([]),
  ]);

  let working: MemoryDoc | null = memory.working;
  let longTerm: MemoryDoc | null = memory.longTerm;
  let dailyNote: MemoryDoc | null = daily;
  let messages: ContextMessage[] = recent.messages;
  const rankedMemories: RankedMemoryInput[] = ranked.map((m) => ({ id: m.id, content: m.content, score: m.score }));

  if (q) {
    const narrowed = working ? filterSections(working.content, q) : null;
    working = narrowed && working ? { ...working, content: narrowed } : null;
    const narrowedLT = longTerm ? filterSections(longTerm.content, q) : null;
    longTerm = narrowedLT && longTerm ? { ...longTerm, content: narrowedLT } : null;
    const narrowedDaily = dailyNote ? filterSections(dailyNote.content, q) : null;
    dailyNote = narrowedDaily && dailyNote ? { ...dailyNote, content: narrowedDaily } : null;
    messages = messages.filter((m) => m.content.toLowerCase().includes(q));
    // `q` and `task` are independent filters; rankedMemories (already
    // relevance-sorted for `task`) is left as-is rather than re-filtered
    // by an unrelated keyword — matches the route's pre-extraction behavior.
  }

  const pack = buildContextPack({
    working: working?.content ?? null,
    longTerm: longTerm?.content ?? null,
    daily: dailyNote?.content ?? null,
    rankedMemories,
    messages: messages.map((m) => ({ from: m.from, channelName: m.channelName, content: m.content, timestamp: m.timestamp })),
    tokenBudget,
  });

  return { ...pack, channels: recent.channels };
}
