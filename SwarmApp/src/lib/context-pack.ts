/**
 * Context Pack assembly — the token-budgeted truncation layer for
 * GET /api/v1/context (Context Vault PRD §4.4).
 *
 * Deliberately a pure function taking already-fetched data, not a
 * Firestore-aware service — the route owns fetching (getExistingMemory,
 * getDailyNoteIfExists, getRecentMessagesForAgent, optionally
 * hybridSearchMemory); this module only decides what fits in the budget
 * and in what priority order. Keeps the truncation logic unit-testable
 * without mocking Firebase Admin or auth.
 *
 * v1 truncation is all-or-nothing per document (working/longTerm/daily) —
 * there's no sensible way to cut a markdown doc mid-section without
 * breaking its structure, so a doc that doesn't fit is omitted whole
 * rather than clipped. Ranked memories and messages are added one at a
 * time in priority/given order until the budget runs out (PRD §4.4:
 * "truncate greedily... stop there for v1" — this is that).
 */
import { estimateTokens } from "./token-estimate";

export const DEFAULT_TOKEN_BUDGET = 8000;
export const MIN_TOKEN_BUDGET = 500;
export const MAX_TOKEN_BUDGET = 32_000;

/** Shared by the REST route (`?tokenBudget=`) and the MCP `context_pack`
 *  tool, so both callers clamp to the same range instead of drifting. */
export function clampTokenBudget(raw: number | string | null | undefined): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_TOKEN_BUDGET;
  return Math.min(MAX_TOKEN_BUDGET, Math.max(MIN_TOKEN_BUDGET, n));
}

export interface RankedMemoryInput {
  id: string;
  content: string;
  score: number;
}

export interface ContextMessageInput {
  from: string;
  channelName: string;
  content: string;
  timestamp: number;
}

export interface ContextPackInput {
  working: string | null;
  longTerm: string | null;
  daily: string | null;
  /** Already sorted by relevance (best first) — hybridSearchMemory's own
   *  output order. This function doesn't re-sort. */
  rankedMemories: RankedMemoryInput[];
  /** As given by the caller — this function doesn't reorder, just takes
   *  a prefix. Preserve whatever order the caller considers priority. */
  messages: ContextMessageInput[];
  tokenBudget: number;
}

export interface ContextPackResult {
  working: string | null;
  longTerm: string | null;
  daily: string | null;
  rankedMemories: RankedMemoryInput[];
  messages: ContextMessageInput[];
  tokenBudget: number;
  tokenCount: number;
  truncated: boolean;
  /** Section names dropped entirely for not fitting — "working",
   *  "longTerm", "daily", and/or "rankedMemories"/"messages" when at
   *  least one item of that kind didn't fit. */
  omitted: string[];
}

export function buildContextPack(input: ContextPackInput): ContextPackResult {
  let remaining = Math.max(0, input.tokenBudget);
  let truncated = false;
  const omitted: string[] = [];

  function takeDoc(label: string, text: string | null): string | null {
    if (text === null) return null;
    const cost = estimateTokens(text);
    if (cost <= remaining) {
      remaining -= cost;
      return text;
    }
    truncated = true;
    omitted.push(label);
    return null;
  }

  // Priority order matches the existing GET /v1/context markdown layout
  // (working → longTerm → daily) so this doesn't reorder output that
  // existing callers may already depend on.
  const working = takeDoc("working", input.working);
  const longTerm = takeDoc("longTerm", input.longTerm);
  const daily = takeDoc("daily", input.daily);

  const rankedMemories: RankedMemoryInput[] = [];
  let rankedOmitted = false;
  for (const m of input.rankedMemories) {
    const cost = estimateTokens(m.content);
    if (cost <= remaining) {
      remaining -= cost;
      rankedMemories.push(m);
    } else {
      rankedOmitted = true;
      break; // score-sorted — once one doesn't fit, treat the rest as lower priority too
    }
  }
  if (rankedOmitted) {
    truncated = true;
    omitted.push("rankedMemories");
  }

  const messages: ContextMessageInput[] = [];
  let messagesOmitted = false;
  for (const m of input.messages) {
    const cost = estimateTokens(m.content);
    if (cost <= remaining) {
      remaining -= cost;
      messages.push(m);
    } else {
      messagesOmitted = true;
      break;
    }
  }
  if (messagesOmitted) {
    truncated = true;
    omitted.push("messages");
  }

  return {
    working,
    longTerm,
    daily,
    rankedMemories,
    messages,
    tokenBudget: input.tokenBudget,
    tokenCount: Math.max(0, input.tokenBudget) - remaining,
    truncated,
    omitted,
  };
}
