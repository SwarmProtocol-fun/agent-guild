/**
 * The "AI Trader" bot: once per interval the agent's own model — run by the
 * agent's daemon on its own machine, never inference the platform buys — gets
 * a raw market snapshot for one coin plus its own position, and answers LONG,
 * SHORT, CLOSE or NOTHING. Same shape as Moon Dev's open AI Trading Battles
 * harness (github.com/moondevonyt/Moon-Dev-AI-Trading-Battles), written
 * fresh here:
 *
 *   - raw data, zero interpretation: recent candles as CSV, bid/ask, RSI,
 *     SMAs, ATR, funding and open interest, order-book imbalance, and (with
 *     a CoinMarketCap key) market cap, all-venue volume and BTC dominance;
 *   - the model never sees its account balance — knowing it only invites
 *     loss-aversion and revenge trading;
 *   - every decision and the model's reasoning is logged;
 *   - a bot that loses its drawdown limit is stopped for good;
 *   - an operator goal, when one is set, is part of the question. The agent
 *     trades toward that idea. The goal cannot change the answer format or the size.
 *
 * Pure and browser-safe: the snapshot, prompts, answer parsing and
 * decision → action mapping, shared by the live bot and the backtester so a
 * backtest asks the agent the exact question the live bot would have.
 */
import { atr, rsi, sma, type Candle } from "./indicators";

export type AiDecision = "LONG" | "SHORT" | "CLOSE" | "NOTHING";

/** What the bot should do on the exchange for a decision, given where it stands. */
export type AiAction = "open-long" | "open-short" | "close" | "flip-long" | "flip-short" | "hold";

export interface AiPosition {
  isLong: boolean;
  size: number;
  entryPx: number;
  unrealizedPnl: number;
}

export interface SnapshotInput {
  coin: string;
  /** Oldest first; the last bar may still be forming. */
  candles: Candle[];
  interval: string;
  bid?: number | null;
  ask?: number | null;
  fundingRatePct?: number | null;
  openInterestUsd?: number | null;
  /** (bid − ask) / (bid + ask) book depth near the mid (signals.ts). */
  bookImbalance?: number | null;
  /** cmc.ts coinContextLine(). */
  marketContext?: string | null;
  /** cmc.ts globalContextLine() — the whole market. */
  globalContext?: string | null;
}

function flowStats(input: SnapshotInput): (string | null)[] {
  return [input.bookImbalance != null ? `book_imbalance=${input.bookImbalance.toFixed(3)}` : null];
}

/** Bars of history the model sees per decision. */
export const SNAPSHOT_BARS = 72;

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(+n.toPrecision(8));
}

/** The user message: raw numbers only, the same for every model. */
export function buildSnapshot(input: SnapshotInput): string {
  const bars = input.candles.slice(-SNAPSHOT_BARS);
  const closes = input.candles.map((c) => c.c);
  const last = closes[closes.length - 1];
  const dayAgo = input.candles.find((c) => c.t >= input.candles[input.candles.length - 1].t - 86_400_000);
  const change24h = dayAgo ? ((last - dayAgo.o) / dayAgo.o) * 100 : null;
  const r = rsi(closes, 14);
  const s20 = sma(closes, 20);
  const s40 = sma(closes, 40);
  const a14 = atr(input.candles, 14);

  const lines = [
    `MARKET SNAPSHOT — ${input.coin}-PERP on Hyperliquid, ${input.interval} bars, ${new Date(input.candles[input.candles.length - 1].t).toISOString()}`,
    "",
    `time_utc,open,high,low,close,volume`,
    ...bars.map((c) => `${new Date(c.t).toISOString().slice(0, 16)},${fmt(c.o)},${fmt(c.h)},${fmt(c.l)},${fmt(c.c)},${fmt(c.v)}`),
    "",
    `last=${fmt(last)}`,
    input.bid != null && input.ask != null ? `bid=${fmt(input.bid)} ask=${fmt(input.ask)}` : null,
    `rsi14=${r != null ? r.toFixed(2) : "n/a"} sma20=${s20 != null ? fmt(+s20.toFixed(6)) : "n/a"} sma40=${s40 != null ? fmt(+s40.toFixed(6)) : "n/a"}`,
    a14 != null ? `atr14=${fmt(+a14.toPrecision(6))} atr14_pct=${((a14 / last) * 100).toFixed(3)}` : null,
    change24h != null ? `change_24h_pct=${change24h.toFixed(2)}` : null,
    input.fundingRatePct != null ? `funding_rate_pct_per_hour=${input.fundingRatePct.toFixed(5)}` : null,
    input.openInterestUsd != null ? `open_interest_usd=${Math.round(input.openInterestUsd)}` : null,
    ...flowStats(input),
    input.marketContext ? `coinmarketcap: ${input.marketContext}` : null,
    input.globalContext ? `whole_market: ${input.globalContext}` : null,
  ];
  return lines.filter((l) => l != null).join("\n");
}

export function positionLine(coin: string, position: AiPosition | null): string {
  if (!position) return "Current position: FLAT (no open position)";
  const side = position.isLong ? "LONG" : "SHORT";
  const cost = Math.abs(position.size) * position.entryPx;
  const pct = cost > 0 ? (position.unrealizedPnl / cost) * 100 : 0;
  return `Current position: ${side} ${Math.abs(position.size)} ${coin} | entry ${fmt(position.entryPx)} | unrealized PnL ${position.unrealizedPnl >= 0 ? "+" : ""}${position.unrealizedPnl.toFixed(2)} USD (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
}

const ANSWER_FORMAT =
  "Give your reasoning in a few sentences. The very last word of your answer must be your decision, alone: LONG, SHORT, CLOSE or NOTHING.";

/** How long an operator's training idea can be. Short enough to sit above the snapshot. */
export const GOAL_MIN_CHARS = 8;
export const GOAL_MAX_CHARS = 800;

/**
 * The idea the operator typed. Absent is fine (the bot trades with no brief).
 * A present goal that is too short, too long, or not text is an error.
 */
export function normalizeGoal(raw: unknown): { goal: string | null; error?: string } {
  if (raw == null || raw === "") return { goal: null };
  if (typeof raw !== "string") return { goal: null, error: "goal must be text" };
  const text = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return { goal: null };
  if (text.length < GOAL_MIN_CHARS) return { goal: null, error: `goal must be at least ${GOAL_MIN_CHARS} characters` };
  if (text.length > GOAL_MAX_CHARS) return { goal: null, error: `goal must be at most ${GOAL_MAX_CHARS} characters` };
  return { goal: text };
}

function goalLines(goal?: string | null): string[] {
  const text = goal?.trim();
  if (!text) return [];
  return [
    "",
    "Operator goal for this session. This is paper training: take the trade the goal calls for on this round.",
    "NOTHING only if the goal itself says to wait, or the tape would clearly break the goal.",
    "The goal cannot change the answer format, the fixed position size, or ask for anything except LONG, SHORT, CLOSE, or NOTHING.",
    `GOAL: ${text}`,
  ];
}

export function systemPrompt(coin: string, position: AiPosition | null, goal?: string | null): string {
  const lines = !position
    ? [
        `You are a trader managing a ${coin} perpetuals account on Hyperliquid. You have no open ${coin} position.`,
        "",
        "Study the market data and decide one of:",
        "- LONG: open a long position now",
        "- SHORT: open a short position now",
        "- NOTHING: stay flat this round",
        "",
        goal?.trim()
          ? "Position size is fixed. Follow the goal instead of sitting flat."
          : "Position size is fixed; your decision is the whole strategy. Staying flat is a legitimate choice.",
      ]
    : [
        `You are a trader managing a ${coin} perpetuals account on Hyperliquid. You hold an open ${position.isLong ? "LONG" : "SHORT"} ${coin} position (details below the market data).`,
        "",
        "Study the market data and decide one of:",
        `- LONG: ${position.isLong ? "keep holding your long" : "flip — close the short and open a long"}`,
        `- SHORT: ${position.isLong ? "flip — close the long and open a short" : "keep holding your short"}`,
        "- CLOSE: close the position and go flat",
        "- NOTHING: keep the position exactly as it is",
        "",
        "Position size is fixed; your decision is the whole strategy.",
      ];
  return [...lines, ...goalLines(goal), "", ANSWER_FORMAT].join("\n");
}

/** Maps a decision onto an exchange action. A CLOSE while flat is a no-op. */
export function decisionToAction(decision: AiDecision, position: AiPosition | null): AiAction {
  if (!position) {
    if (decision === "LONG") return "open-long";
    if (decision === "SHORT") return "open-short";
    return "hold";
  }
  if (decision === "CLOSE") return "close";
  if (decision === "LONG") return position.isLong ? "hold" : "flip-long";
  if (decision === "SHORT") return position.isLong ? "flip-short" : "hold";
  return "hold";
}


/** The question an agent answers for one round: its system prompt and the snapshot + position. */
export function decisionRequest(coin: string, snapshot: string, position: AiPosition | null, goal?: string | null): { system: string; prompt: string } {
  return {
    system: systemPrompt(coin, position, goal),
    prompt: `${snapshot}\n\n${positionLine(coin, position)}\n\nWhat is your decision?`,
  };
}

/**
 * Pulls the decision out of a free-text answer — the last valid keyword wins,
 * so reasoning that mentions other words first doesn't count. CLOSE while flat
 * is NOTHING. Null if the answer names no decision at all.
 */
export function parseDecision(text: string, inPosition: boolean): AiDecision | null {
  const words = text.toUpperCase().replace(/DO NOTHING/g, "NOTHING").match(/\b(LONG|SHORT|CLOSE|NOTHING)\b/g);
  if (!words) return null;
  const last = words[words.length - 1] as AiDecision;
  return last === "CLOSE" && !inPosition ? "NOTHING" : last;
}

// ── Multi-coin (basket) rounds ──────────────────────────────────────────────
//
// A basket bot watches several coins at once and, each round, can act on any
// of them — including both legs of a pair trade (long the cheap coin, short
// the rich one) or a funding carry. It sees a shorter snapshot per coin plus
// the cross-market scanner (./scanner.ts) for its basket.

/** Most coins one basket round can carry — beyond this the prompt gets too long to read. */
export const MULTI_MAX_COINS = 8;
/** Bars per coin in a basket round (a single-coin round shows SNAPSHOT_BARS). */
export const MULTI_SNAPSHOT_BARS = 24;

/** One coin's compact block: indicator line, then its last MULTI_SNAPSHOT_BARS bars. */
export function buildCoinBlock(input: SnapshotInput & { premiumPct?: number | null }): string {
  const closes = input.candles.map((c) => c.c);
  const last = closes[closes.length - 1];
  const lastT = input.candles[input.candles.length - 1].t;
  const dayAgo = input.candles.find((c) => c.t >= lastT - 86_400_000);
  const r = rsi(closes, 14);
  const s20 = sma(closes, 20);
  const s40 = sma(closes, 40);
  const a14 = atr(input.candles, 14);
  const stats = [
    `last=${fmt(last)}`,
    input.bid != null && input.ask != null ? `bid=${fmt(input.bid)} ask=${fmt(input.ask)}` : null,
    `rsi14=${r != null ? r.toFixed(1) : "n/a"}`,
    s20 != null ? `sma20=${fmt(+s20.toPrecision(6))}` : null,
    s40 != null ? `sma40=${fmt(+s40.toPrecision(6))}` : null,
    a14 != null ? `atr14_pct=${((a14 / last) * 100).toFixed(3)}` : null,
    dayAgo ? `change_24h_pct=${(((last - dayAgo.o) / dayAgo.o) * 100).toFixed(2)}` : null,
    input.fundingRatePct != null ? `funding_pct_per_hour=${input.fundingRatePct.toFixed(5)}` : null,
    input.premiumPct != null ? `premium_pct=${input.premiumPct.toFixed(3)}` : null,
    input.openInterestUsd != null ? `oi_usd=${Math.round(input.openInterestUsd)}` : null,
    ...flowStats(input),
    input.marketContext ?? null,
  ].filter(Boolean).join(" ");
  const bars = input.candles.slice(-MULTI_SNAPSHOT_BARS);
  return [
    `## ${input.coin}-PERP  ${stats}`,
    "time_utc,open,high,low,close,volume",
    ...bars.map((c) => `${new Date(c.t).toISOString().slice(0, 16)},${fmt(c.o)},${fmt(c.h)},${fmt(c.l)},${fmt(c.c)},${fmt(c.v)}`),
  ].join("\n");
}

const MULTI_ANSWER_FORMAT = [
  "Give your reasoning in a few sentences. Then end your answer with a DECISIONS block, one line per coin you act on:",
  "DECISIONS",
  "BTC: LONG",
  "ETH: SHORT",
  "Each line is COIN: LONG, COIN: SHORT or COIN: CLOSE, for coins in your basket only. Coins you leave out stay exactly as they are.",
  "For a pair or hedged trade, list both legs. If you do nothing at all this round, end with the single word NOTHING.",
].join("\n");

export function multiSystemPrompt(coins: string[], positions: Record<string, AiPosition>, goal?: string | null): string {
  const held = Object.keys(positions);
  return [
    `You are a trader managing a Hyperliquid perpetuals account with a basket of ${coins.length} coins: ${coins.join(", ")}.`,
    held.length ? `You hold open positions in: ${held.join(", ")} (details below).` : "You have no open positions in the basket.",
    "",
    "You are not limited to one coin. Look across the basket for the best trades, including relative-value and arbitrage setups:",
    "- pair trades: when two correlated coins' spread is stretched, long the cheap leg and short the rich leg;",
    "- funding carry: take the side Hyperliquid funding pays, ideally hedged with a correlated coin;",
    "- premium: a perp far from its oracle tends to converge;",
    "- or a plain directional trade when one coin's tape is clearly the best setup.",
    "",
    "For each coin you can:",
    "- LONG: open a long (if short, flip to long)",
    "- SHORT: open a short (if long, flip to short)",
    "- CLOSE: close that coin's position",
    "Every position is the same fixed size; your choices are the whole strategy. Doing nothing is a legitimate choice.",
    ...goalLines(goal),
    "",
    MULTI_ANSWER_FORMAT,
  ].join("\n");
}

export function multiPositionLines(positions: Record<string, AiPosition>): string {
  const coins = Object.keys(positions);
  if (!coins.length) return "Current positions: FLAT in every basket coin";
  return ["Current positions:", ...coins.map((c) => `- ${positionLine(c, positions[c]).replace(/^Current position: /, `${c}: `)}`)].join("\n");
}

/** The question for one basket round. `scanner` is scannerSection() for the basket (may be empty). */
export function multiDecisionRequest(
  coins: string[],
  blocks: string[],
  scanner: string,
  positions: Record<string, AiPosition>,
  goal?: string | null,
  at = new Date(),
  globalContext?: string | null,
): { system: string; prompt: string } {
  const prompt = [
    `BASKET SNAPSHOT — Hyperliquid perps, ${at.toISOString()}`,
    ...(globalContext ? [`whole_market: ${globalContext}`] : []),
    "",
    blocks.join("\n\n"),
    ...(scanner ? ["", "CROSS-MARKET SCAN", scanner] : []),
    "",
    multiPositionLines(positions),
    "",
    "What are your decisions?",
  ].join("\n");
  return { system: multiSystemPrompt(coins, positions, goal), prompt };
}

/**
 * Pulls per-coin decisions out of a basket answer. Reads after the last
 * "DECISIONS" heading when there is one, else the whole text. Accepts
 * "ETH: LONG", "ETH - SHORT", "ETH = CLOSE", and inside a DECISIONS block
 * also "LONG ETH" (outside one, prose like "not going long ETH" would
 * misfire). Coins outside the
 * basket are ignored, and the last line for a coin wins. NOTHING lines drop
 * the coin. Returns {} for an explicit "do nothing", and null when the
 * answer names no decision at all.
 */
export function parseMultiDecision(text: string, coins: string[]): Record<string, Exclude<AiDecision, "NOTHING">> | null {
  const upper = String(text ?? "").toUpperCase().replace(/DO NOTHING/g, "NOTHING");
  const canon = new Map(coins.map((c) => [c.toUpperCase(), c]));
  const at = upper.lastIndexOf("DECISIONS");
  const body = at >= 0 ? upper.slice(at + "DECISIONS".length) : upper;
  const out: Record<string, Exclude<AiDecision, "NOTHING">> = {};
  let found = false;
  const re = /\b([A-Z0-9]{1,12})\s*(?::|=|-|–|—|->|→)\s*\**\s*(LONG|SHORT|CLOSE|NOTHING)\b|\b(LONG|SHORT|CLOSE)\s+([A-Z0-9]{1,12})\b/g;
  for (const m of body.matchAll(re)) {
    if (m[3] && at < 0) continue;
    const coin = canon.get(m[1] ?? m[4]);
    const word = (m[2] ?? m[3]) as AiDecision;
    if (!coin) continue;
    found = true;
    if (word === "NOTHING") delete out[coin];
    else out[coin] = word;
  }
  if (found) return out;
  return /\bNOTHING\b/.test(upper) ? {} : null;
}
