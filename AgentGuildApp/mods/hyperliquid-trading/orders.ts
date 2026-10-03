/**
 * Plain-text orders for the "Give orders" box — "long ETH $25 5x sl 3 tp 8",
 * "sell 50 SOL @ 140", "close BTC". Parsed client-side into exactly the
 * fields POST /trade and POST /close already take, so an order typed here
 * goes through the same capability, wallet, and risk checks as the form.
 */

export type ParsedOrder =
  | {
      kind: "trade";
      coin: string;
      isBuy: boolean;
      sizeUsd: number;
      orderType: "market" | "limit";
      limitPrice?: number;
      leverage?: number;
      stopLossPct?: number;
      takeProfitPct?: number;
    }
  | { kind: "close"; coin: string };

const BUY = new Set(["buy", "long"]);
const SELL = new Set(["sell", "short"]);
const NUM = /^\$?(\d+(?:\.\d+)?)(k)?\$?$/i;

function num(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.replace(/,/g, "").match(NUM);
  if (!m) return null;
  return Number(m[1]) * (m[2] ? 1000 : 1);
}

/** Returns the order, or a human-readable reason it couldn't be read. */
export function parseOrder(text: string): ParsedOrder | { error: string } {
  const words = text.trim().toLowerCase().replace(/%/g, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return { error: "Type an order, e.g. long ETH $25 5x" };

  const action = words.shift()!;
  if (action === "close") {
    const coin = words.find((w) => /^[a-z][a-z0-9]*$/.test(w));
    if (!coin) return { error: "Which coin? e.g. close ETH" };
    return { kind: "close", coin: coin.toUpperCase() };
  }
  if (!BUY.has(action) && !SELL.has(action)) {
    return { error: `Start with buy, long, sell, short, or close — not "${action}"` };
  }

  let coin: string | null = null;
  let sizeUsd: number | null = null;
  let limitPrice: number | undefined;
  let leverage: number | undefined;
  let stopLossPct: number | undefined;
  let takeProfitPct: number | undefined;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const lev = w.match(/^(\d+(?:\.\d+)?)x$/);
    if (lev) { leverage = Number(lev[1]); continue; }
    if ((w === "sl" || w === "stop") && num(next) != null) { stopLossPct = num(next)!; i++; continue; }
    if (w === "tp" && num(next) != null) { takeProfitPct = num(next)!; i++; continue; }
    if ((w === "@" || w === "at" || w === "limit") && num(next) != null) { limitPrice = num(next)!; i++; continue; }
    if (w.startsWith("@") && num(w.slice(1)) != null) { limitPrice = num(w.slice(1))!; continue; }
    if (w === "usd" || w === "of" || w === "worth" || w === "market") continue;
    if (num(w) != null && sizeUsd == null) { sizeUsd = num(w); continue; }
    if (/^[a-z][a-z0-9]*$/.test(w) && coin == null) { coin = w.toUpperCase(); continue; }
    return { error: `Didn't understand "${w}"` };
  }

  if (!coin) return { error: "Which coin? e.g. long ETH $25" };
  if (!sizeUsd || sizeUsd <= 0) return { error: "How much, in USD? e.g. long ETH $25" };

  return {
    kind: "trade",
    coin,
    isBuy: BUY.has(action),
    sizeUsd,
    orderType: limitPrice ? "limit" : "market",
    ...(limitPrice ? { limitPrice } : {}),
    ...(leverage ? { leverage } : {}),
    ...(stopLossPct ? { stopLossPct } : {}),
    ...(takeProfitPct ? { takeProfitPct } : {}),
  };
}

/** One-line read-back of what will actually be sent, shown before the operator confirms. */
export function describeOrder(o: ParsedOrder): string {
  if (o.kind === "close") return `Close the whole ${o.coin} position (reduce-only market)`;
  const parts = [
    `${o.isBuy ? "Long" : "Short"} ${o.coin}`,
    `$${o.sizeUsd.toLocaleString()}`,
    o.orderType === "limit" ? `limit @ ${o.limitPrice}` : "market",
  ];
  if (o.leverage) parts.push(`${o.leverage}x`);
  if (o.stopLossPct) parts.push(`SL ${o.stopLossPct}%`);
  if (o.takeProfitPct) parts.push(`TP ${o.takeProfitPct}%`);
  return parts.join(" · ");
}
