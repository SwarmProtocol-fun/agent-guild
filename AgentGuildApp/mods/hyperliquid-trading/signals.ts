/**
 * Order-book imbalance from Hyperliquid's public L2 book: resting bid
 * notional against ask notional within a band around the mid. +1 is all
 * bids, −1 all asks. Heavy one-sided depth near the touch leans the next
 * move that way. (HLP and smart-money positioning live in ./intel.ts.)
 *
 * Pure and browser-safe: the server fetches, this computes.
 */

export interface DepthLevel { px: number; sz: number }

export interface Imbalance {
  coin: string;
  bidUsd: number;
  askUsd: number;
  /** (bid − ask) / (bid + ask), in [−1, 1]; 0 with an empty book. */
  imbalance: number;
  /** The band around the mid that was counted, in percent. */
  bandPct: number;
}

/** Book imbalance within ±bandPct of the mid (best bid/ask average). */
export function bookImbalance(coin: string, bids: DepthLevel[], asks: DepthLevel[], bandPct = 0.5): Imbalance {
  const best = bids[0]?.px && asks[0]?.px ? (bids[0].px + asks[0].px) / 2 : bids[0]?.px || asks[0]?.px || 0;
  const lo = best * (1 - bandPct / 100);
  const hi = best * (1 + bandPct / 100);
  const bidUsd = bids.filter((l) => l.px >= lo).reduce((s, l) => s + l.px * l.sz, 0);
  const askUsd = asks.filter((l) => l.px <= hi).reduce((s, l) => s + l.px * l.sz, 0);
  const total = bidUsd + askUsd;
  return { coin, bidUsd, askUsd, imbalance: total > 0 ? (bidUsd - askUsd) / total : 0, bandPct };
}
