/**
 * Self-improving AI Trader bots. Every few closed trades a bot reviews its own
 * round trips — the reasoning it gave going in and out, and how each ended —
 * and rewrites a short set of lessons that ride along in every later prompt.
 * Selection keeps it honest: once a new set of lessons has traded enough, it
 * is compared with the set before it, and a set that trades worse is rolled
 * back. The operator's goal never changes; only the bot's own notes do.
 *
 * Pure: the server (server.ts runReflectionPass) reads the decision log,
 * asks the agent through the same AiRequest queue as a trading round
 * (purpose "reflect"), and stores the result on the strategy's `evolution`.
 */

/** One decision-log row, as much of it as reflection needs. Oldest-first order is not assumed. */
export interface LogRow {
  coin?: string | null;
  action: string;
  reasoning: string;
  price: number | null;
  error: string | null;
  createdAt: Date | null;
}

/** An open-then-close the bot made, priced at the mids it logged. */
export interface Trip {
  coin: string;
  side: "long" | "short";
  entryPx: number;
  exitPx: number;
  /** Price move in the trade's favour, %, before fees and funding. */
  pnlPct: number;
  openedAt: number;
  closedAt: number;
  entryReason: string;
  exitReason: string;
}

export interface TripStats {
  count: number;
  winRate: number;
  avgPct: number;
}

/** One set of lessons the bot traded with, and how it did. Newest first in BotEvolution.history. */
export interface LessonVersion {
  version: number;
  lessons: string | null;
  adoptedAt: number;
  /** Why it was adopted: the bot's own review, a rollback, or an operator reset. */
  note: "reflected" | "reverted" | "reset";
  /** Closed trips traded under this version, and their stats (filled in when it is replaced). */
  trips: number;
  avgPct: number | null;
  winRate: number | null;
}

/** Stored on the strategy document beside params, so a trading round's params write never clobbers it. */
export interface BotEvolution {
  enabled: boolean;
  lessons: string | null;
  version: number;
  /** When the current lessons were adopted (ms); trips closed after it count toward them. */
  adoptedAt: number | null;
  /** How the current lessons came to be. */
  note: LessonVersion["note"];
  /** The current version has been compared with the one before it. */
  judged: boolean;
  /** A reflection question out with the agent. */
  requestId: string | null;
  /** Last time the reflection pass looked at this bot (ms). */
  checkedAt: number | null;
  /** Ask for a review on the next pass even with fewer trips than usual. */
  forceReflect?: boolean;
  history: LessonVersion[];
}

/** Closed trips between reviews. */
export const REFLECT_EVERY_TRIPS = 5;
/** Trips a new version trades before it is judged against the one before it. */
export const JUDGE_AFTER_TRIPS = 5;
/** How much worse (average % per trip) a version must do than its predecessor to be rolled back. */
export const REVERT_MARGIN_PCT = 0.1;
/** The reflection pass looks at a bot at most this often. */
export const REFLECT_CHECK_MS = 5 * 60_000;
/** How long the agent has to answer a review. */
export const REFLECT_ANSWER_MS = 10 * 60_000;
export const MAX_LESSONS = 6;
export const MAX_LESSON_CHARS = 180;
const HISTORY_KEEP = 8;
/** Recent trips shown to the agent in one review. */
const REVIEW_TRIPS = 12;
const REASON_CHARS = 280;

export function newEvolution(): BotEvolution {
  return { enabled: true, lessons: null, version: 0, adoptedAt: null, note: "reset", judged: true, requestId: null, checkedAt: null, history: [] };
}

/** Reads whatever is stored (possibly nothing, possibly an older shape) into a full BotEvolution. */
export function readEvolution(raw: unknown): BotEvolution {
  const base = newEvolution();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<BotEvolution>;
  return {
    enabled: r.enabled !== false,
    lessons: typeof r.lessons === "string" && r.lessons.trim() ? r.lessons : null,
    version: Number.isFinite(r.version) ? Number(r.version) : 0,
    adoptedAt: Number.isFinite(r.adoptedAt) ? Number(r.adoptedAt) : null,
    note: r.note === "reflected" || r.note === "reverted" ? r.note : "reset",
    judged: r.judged !== false,
    requestId: typeof r.requestId === "string" ? r.requestId : null,
    checkedAt: Number.isFinite(r.checkedAt) ? Number(r.checkedAt) : null,
    ...(r.forceReflect ? { forceReflect: true } : {}),
    history: Array.isArray(r.history) ? r.history.slice(0, HISTORY_KEEP) : [],
  };
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Rebuilds the bot's round trips from its decision log. Opens and closes are
 * matched per coin, oldest first; a flip closes one side and opens the other
 * at the same mid. Rows with an error never traded, and a trip without a
 * logged price at both ends can't be scored, so both are skipped.
 */
export function roundTrips(rows: LogRow[], defaultCoin: string): Trip[] {
  const sorted = [...rows]
    .filter((r) => !r.error && r.createdAt)
    .sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime());
  const open = new Map<string, { side: "long" | "short"; px: number | null; at: number; reason: string }>();
  const trips: Trip[] = [];
  const close = (coin: string, px: number | null, at: number, reason: string) => {
    const o = open.get(coin);
    if (!o) return;
    open.delete(coin);
    if (o.px == null || px == null || o.px <= 0) return;
    const move = ((px - o.px) / o.px) * 100;
    trips.push({
      coin, side: o.side, entryPx: o.px, exitPx: px, pnlPct: o.side === "long" ? move : -move,
      openedAt: o.at, closedAt: at, entryReason: o.reason, exitReason: reason,
    });
  };
  for (const r of sorted) {
    const coin = r.coin || defaultCoin;
    const at = r.createdAt!.getTime();
    switch (r.action) {
      case "open-long":
      case "open-short":
        // The second half of a flip logs an open with no price; the flip already opened it.
        if (!open.has(coin)) open.set(coin, { side: r.action === "open-long" ? "long" : "short", px: r.price, at, reason: r.reasoning });
        break;
      case "close":
        close(coin, r.price, at, r.reasoning);
        break;
      case "flip-long":
      case "flip-short":
        close(coin, r.price, at, r.reasoning);
        open.set(coin, { side: r.action === "flip-long" ? "long" : "short", px: r.price, at, reason: r.reasoning });
        break;
    }
  }
  return trips;
}

export function tripStats(trips: Trip[]): TripStats {
  if (!trips.length) return { count: 0, winRate: 0, avgPct: 0 };
  const wins = trips.filter((t) => t.pnlPct > 0).length;
  return { count: trips.length, winRate: wins / trips.length, avgPct: trips.reduce((s, t) => s + t.pnlPct, 0) / trips.length };
}

/** Trips closed under the current lessons. */
export function tripsSince(trips: Trip[], since: number | null): Trip[] {
  return since == null ? trips : trips.filter((t) => t.closedAt > since);
}

/** The current version, closed out with how it traded, ready to push onto history. */
function closeOutCurrent(ev: BotEvolution, trips: Trip[]): LessonVersion {
  const s = tripStats(tripsSince(trips, ev.adoptedAt));
  return {
    version: ev.version, lessons: ev.lessons, adoptedAt: ev.adoptedAt ?? 0, note: ev.note,
    trips: s.count, avgPct: s.count ? s.avgPct : null, winRate: s.count ? s.winRate : null,
  };
}

/** What to do now, and the evolution to store either way (a kept version comes back marked judged). */
export type EvolutionStep =
  | { kind: "none"; evolution: BotEvolution }
  | { kind: "reflect"; evolution: BotEvolution }
  | { kind: "revert"; evolution: BotEvolution; from: number; to: number; why: string };

/**
 * What the reflection pass should do for a bot now: roll back a version that
 * traded worse than the one before it, ask for a review once enough trips
 * have closed under the current lessons, or nothing. A rollback comes first —
 * reviewing a set that's about to be dropped would be wasted.
 */
export function planEvolution(ev: BotEvolution, trips: Trip[], now: number): EvolutionStep {
  if (!ev.enabled || ev.requestId) return { kind: "none", evolution: ev };
  const current = tripsSince(trips, ev.adoptedAt);
  const prev = ev.history[0];
  let kept = ev;
  if (!ev.judged && current.length >= JUDGE_AFTER_TRIPS) {
    const s = tripStats(current);
    if (!prev || prev.avgPct == null || s.avgPct >= prev.avgPct - REVERT_MARGIN_PCT) kept = { ...ev, judged: true };
  }
  if (!kept.judged && prev && prev.avgPct != null && current.length >= JUDGE_AFTER_TRIPS) {
    const s = tripStats(current);
    if (s.avgPct < prev.avgPct - REVERT_MARGIN_PCT) {
      const next: BotEvolution = {
        ...ev,
        lessons: prev.lessons,
        version: ev.version + 1,
        adoptedAt: now,
        note: "reverted",
        // The restored set already won its comparison; it is judged again only after its next review.
        judged: true,
        forceReflect: false,
        history: [closeOutCurrent(ev, trips), ...ev.history].slice(0, HISTORY_KEEP),
      };
      return {
        kind: "revert", evolution: next, from: ev.version, to: prev.version,
        why: `v${ev.version} averaged ${signedPct(s.avgPct)} over ${s.count} trips vs ${signedPct(prev.avgPct)} for v${prev.version}`,
      };
    }
  }
  if (current.length >= REFLECT_EVERY_TRIPS || (kept.forceReflect && trips.length > 0)) return { kind: "reflect", evolution: kept };
  return { kind: "none", evolution: kept };
}

function signedPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function tripLine(t: Trip, i: number): string {
  const held = Math.max(1, Math.round((t.closedAt - t.openedAt) / 60_000));
  return [
    `${i + 1}. ${t.coin} ${t.side.toUpperCase()} ${t.entryPx} → ${t.exitPx} = ${signedPct(t.pnlPct)} (held ${held} min)`,
    `   why in: ${clip(t.entryReason, REASON_CHARS) || "(no reasoning logged)"}`,
    `   why out: ${clip(t.exitReason, REASON_CHARS) || "(no reasoning logged)"}`,
  ].join("\n");
}

/** The question for one review: the bot's goal, current lessons and recent trips. */
export function reflectionRequest(input: {
  market: string;
  goal: string | null;
  evolution: BotEvolution;
  trips: Trip[];
}): { system: string; prompt: string } {
  const { evolution: ev, trips } = input;
  const recent = trips.slice(-REVIEW_TRIPS);
  const all = tripStats(trips);
  const current = tripStats(tripsSince(trips, ev.adoptedAt));
  const system = [
    `You are an AI trading bot on Hyperliquid (${input.market}) reviewing your own closed trades to get better.`,
    "Below are the operator's goal (fixed — you can't change it), the lessons you're trading with now, and your recent round trips with the reasoning you gave going in and out.",
    "",
    "Work out what is making money and what is losing it: which setups, signals, timing or holding habits. Then write the lessons your future self will read before every decision.",
    `- At most ${MAX_LESSONS} lessons, one short sentence each, concrete and checkable against the data you see each round (trend, funding, book imbalance, volume, z-scores, liquidations, time held).`,
    "- Keep lessons that are working, fix or drop the ones that are losing, add what the trades teach.",
    "- Lessons can't change the answer format, the fixed position size or leverage, and can't contradict the operator's goal.",
    "",
    "Answer with a few sentences of analysis, then a line that says LESSONS, then the lessons, one per line, each starting with \"- \".",
  ].join("\n");
  const prompt = [
    `GOAL: ${input.goal?.trim() || "(none — trade the tape as you see fit)"}`,
    "",
    ev.lessons ? `CURRENT LESSONS (v${ev.version}):\n${ev.lessons}` : "CURRENT LESSONS: none yet — this is your first review.",
    "",
    `RECORD: ${all.count} round trips, win rate ${Math.round(all.winRate * 100)}%, average ${signedPct(all.avgPct)} per trip (price move, before fees).`,
    ev.lessons ? `Under the current lessons: ${current.count} trips, win rate ${Math.round(current.winRate * 100)}%, average ${signedPct(current.avgPct)}.` : "",
    "",
    `RECENT TRIPS (oldest first, last ${recent.length}):`,
    ...recent.map(tripLine),
    "",
    "What are your updated lessons?",
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
  return { system, prompt };
}

/**
 * Pulls the lessons out of a review answer: the bullet lines after the last
 * "LESSONS" heading (or, without one, every bullet line). Each is cleaned and
 * clipped; at most MAX_LESSONS. Null when there are none.
 */
export function parseLessons(text: string): string | null {
  const lines = text.replace(/\r/g, "").split("\n");
  let start = -1;
  lines.forEach((l, i) => {
    if (/^\s*[#*_\s]*LESSONS\b[*_:\s]*$/i.test(l) || /^\s*[#*_\s]*LESSONS[*_]*\s*:/i.test(l)) start = i;
  });
  const body = start >= 0 ? lines.slice(start + 1) : lines;
  // "LESSONS: - a - b" on one line is unusual; inline text after the colon is treated as a first lesson.
  if (start >= 0) {
    const inline = lines[start].replace(/^\s*[#*_\s]*LESSONS[*_]*\s*:?\s*/i, "").trim();
    if (inline) body.unshift(`- ${inline}`);
  }
  const lessons = body
    .map((l) => l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/)?.[1] ?? null)
    .filter((l): l is string => !!l)
    .map((l) => l.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\*\*/g, "").trim())
    .filter((l) => l.length >= 4)
    .slice(0, MAX_LESSONS)
    .map((l) => `- ${clip(l, MAX_LESSON_CHARS)}`);
  return lessons.length ? lessons.join("\n") : null;
}

/** Adopts the lessons from an answered review as the next version. */
export function adoptLessons(ev: BotEvolution, lessons: string, trips: Trip[], now: number): BotEvolution {
  return {
    ...ev,
    lessons,
    version: ev.version + 1,
    adoptedAt: now,
    note: "reflected",
    // Judged against the set it replaces (the no-lessons baseline for v1) once it has traded enough.
    judged: false,
    requestId: null,
    forceReflect: false,
    history: [closeOutCurrent(ev, trips), ...ev.history].slice(0, HISTORY_KEEP),
  };
}

/** The operator wipes the bot's lessons: it trades with none until its next review. */
export function resetLessons(ev: BotEvolution, trips: Trip[], now: number): BotEvolution {
  if (!ev.lessons) return { ...ev, requestId: null, forceReflect: false };
  return {
    ...ev,
    lessons: null,
    version: ev.version + 1,
    adoptedAt: now,
    note: "reset",
    judged: true,
    requestId: null,
    forceReflect: false,
    history: [closeOutCurrent(ev, trips), ...ev.history].slice(0, HISTORY_KEEP),
  };
}

/** The lines a trading round's system prompt carries for the bot's lessons. */
export function lessonLines(lessons?: string | null): string[] {
  const text = lessons?.trim();
  if (!text) return [];
  return [
    "",
    "Your own lessons, written after reviewing your past trades. Use them to judge this round;",
    "the operator goal and the answer format still come first, and they can't change the position size.",
    text,
  ];
}
