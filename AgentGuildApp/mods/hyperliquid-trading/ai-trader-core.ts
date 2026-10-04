/**
 * The "AI Trader" bot: once per interval the agent's own model — run by the
 * agent's daemon on its own machine, never inference the platform buys — gets
 * a raw market snapshot for one coin plus its own position, and answers LONG,
 * SHORT, CLOSE or NOTHING. Same shape as Moon Dev's open AI Trading Battles
 * harness (github.com/moondevonyt/Moon-Dev-AI-Trading-Battles), written
 * fresh here:
 *
 *   - raw data, zero interpretation: recent candles as CSV, bid/ask, RSI,
 *     SMAs, funding and open interest;
 *   - the model never sees its account balance — knowing it only invites
 *     loss-aversion and revenge trading;
 *   - every decision and the model's reasoning is logged;
 *   - a bot that loses its drawdown limit is stopped for good.
 *
 * Pure and browser-safe: the snapshot, prompts, answer parsing and
 * decision → action mapping, shared by the live bot and the backtester so a
 * backtest asks the agent the exact question the live bot would have.
 */
import { rsi, sma, type Candle } from "./indicators";

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

  const lines = [
    `MARKET SNAPSHOT — ${input.coin}-PERP on Hyperliquid, ${input.interval} bars, ${new Date(input.candles[input.candles.length - 1].t).toISOString()}`,
    "",
    `time_utc,open,high,low,close,volume`,
    ...bars.map((c) => `${new Date(c.t).toISOString().slice(0, 16)},${fmt(c.o)},${fmt(c.h)},${fmt(c.l)},${fmt(c.c)},${fmt(c.v)}`),
    "",
    `last=${fmt(last)}`,
    input.bid != null && input.ask != null ? `bid=${fmt(input.bid)} ask=${fmt(input.ask)}` : null,
    `rsi14=${r != null ? r.toFixed(2) : "n/a"} sma20=${s20 != null ? fmt(+s20.toFixed(6)) : "n/a"} sma40=${s40 != null ? fmt(+s40.toFixed(6)) : "n/a"}`,
    change24h != null ? `change_24h_pct=${change24h.toFixed(2)}` : null,
    input.fundingRatePct != null ? `funding_rate_pct_per_hour=${input.fundingRatePct.toFixed(5)}` : null,
    input.openInterestUsd != null ? `open_interest_usd=${Math.round(input.openInterestUsd)}` : null,
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

export function systemPrompt(coin: string, position: AiPosition | null): string {
  if (!position) {
    return [
      `You are a trader managing a ${coin} perpetuals account on Hyperliquid. You have no open ${coin} position.`,
      "",
      "Study the market data and decide one of:",
      "- LONG: open a long position now",
      "- SHORT: open a short position now",
      "- NOTHING: stay flat this round",
      "",
      "Position size is fixed; your decision is the whole strategy. Staying flat is a legitimate choice.",
      ANSWER_FORMAT,
    ].join("\n");
  }
  const side = position.isLong ? "LONG" : "SHORT";
  return [
    `You are a trader managing a ${coin} perpetuals account on Hyperliquid. You hold an open ${side} ${coin} position (details below the market data).`,
    "",
    "Study the market data and decide one of:",
    `- LONG: ${position.isLong ? "keep holding your long" : "flip — close the short and open a long"}`,
    `- SHORT: ${position.isLong ? "flip — close the long and open a short" : "keep holding your short"}`,
    "- CLOSE: close the position and go flat",
    "- NOTHING: keep the position exactly as it is",
    "",
    "Position size is fixed; your decision is the whole strategy.",
    ANSWER_FORMAT,
  ].join("\n");
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
export function decisionRequest(coin: string, snapshot: string, position: AiPosition | null): { system: string; prompt: string } {
  return {
    system: systemPrompt(coin, position),
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
