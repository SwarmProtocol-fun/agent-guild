/**
 * Market intel from free, keyless data outlets — the positioning and flow
 * that Moon Dev's paid data layer sells, rebuilt from public sources that
 * answer from US servers (Binance and Bybit geoblock the US, so neither is used):
 *
 *   - Smart vs dumb money: Hyperliquid's public leaderboard
 *     (stats-data.hyperliquid.xyz) ranks every account by PnL. The month's
 *     best and worst large accounts' open positions (clearinghouseState)
 *     are summed per coin.
 *   - HLP: Hyperliquid's market-making vault takes the other side of the
 *     flow. Its child vaults' positions are public; HLP net short a coin
 *     means takers (retail) are net long it.
 *   - Liquidations: OKX's public liquidation-orders feed (last 100 fills per
 *     coin), summed by window and side.
 *   - Crowd ratio: OKX's long/short account ratio.
 *   - Sentiment: alternative.me Fear & Greed, Deribit's DVOL implied-vol
 *     index, and the Coinbase premium (US spot vs Hyperliquid perp).
 *
 * Pure and browser-safe: the server fetches and caches, this module parses
 * and aggregates, the Scanner tab renders it and the AI Trader quotes it.
 */

export interface LeaderboardRow {
  ethAddress: string;
  accountValue: string;
  windowPerformances: [string, { pnl: string; roi: string; vlm: string }][];
  displayName?: string | null;
}

export interface Trader {
  address: string;
  accountValue: number;
  monthPnl: number;
  monthRoi: number;
}

/**
 * The month's `n` best and `n` worst large accounts that actually traded.
 * accountValue ≥ minAccountUsd keeps out dust; non-zero month volume keeps
 * out idle wallets whose PnL is only funding or deposits.
 */
export function pickTraders(rows: LeaderboardRow[], n = 30, minAccountUsd = 100_000): { smart: Trader[]; dumb: Trader[] } {
  const traders: Trader[] = [];
  for (const r of rows ?? []) {
    const month = r.windowPerformances?.find((w) => w[0] === "month")?.[1];
    const accountValue = Number(r.accountValue);
    if (!month || !(accountValue >= minAccountUsd) || !(Number(month.vlm) > 0)) continue;
    traders.push({ address: r.ethAddress, accountValue, monthPnl: Number(month.pnl), monthRoi: Number(month.roi) });
  }
  const byPnl = [...traders].sort((a, b) => b.monthPnl - a.monthPnl);
  return {
    smart: byPnl.slice(0, n).filter((t) => t.monthPnl > 0),
    dumb: byPnl.slice(-n).reverse().filter((t) => t.monthPnl < 0),
  };
}

export interface CoinPositioning {
  longUsd: number;
  shortUsd: number;
  longs: number;
  shorts: number;
}

/** Minimal clearinghouseState: only what positioning needs. */
export interface PositionsState {
  assetPositions: { position: { coin: string; szi: string; positionValue: string } }[];
}

/** Sums open positions per coin across accounts. */
export function aggregatePositions(states: PositionsState[]): Record<string, CoinPositioning> {
  const out: Record<string, CoinPositioning> = {};
  for (const st of states) {
    for (const a of st?.assetPositions ?? []) {
      const size = Number(a.position.szi);
      const value = Math.abs(Number(a.position.positionValue));
      if (!size || !Number.isFinite(value)) continue;
      const row = (out[a.position.coin] ??= { longUsd: 0, shortUsd: 0, longs: 0, shorts: 0 });
      if (size > 0) {
        row.longUsd += value;
        row.longs++;
      } else {
        row.shortUsd += value;
        row.shorts++;
      }
    }
  }
  return out;
}

/** (long − short) / (long + short): +1 all long, −1 all short, null when nobody holds it. */
export function netBias(p: CoinPositioning | undefined): number | null {
  if (!p) return null;
  const total = p.longUsd + p.shortUsd;
  return total > 0 ? (p.longUsd - p.shortUsd) / total : null;
}

export interface OkxLiquidationDetail {
  bkPx: string;
  posSide: "long" | "short" | string;
  sz: string;
  ts: string;
}

export interface LiquidationWindow {
  window: string;
  /** Longs force-closed (price fell into them). */
  longUsd: number;
  shortUsd: number;
}

export const LIQ_WINDOWS: [string, number][] = [["1h", 3_600_000], ["4h", 14_400_000], ["12h", 43_200_000]];

/**
 * OKX liquidation fills summed per window. `ctVal` is coins per contract
 * (OKX sizes are in contracts). A window older than the oldest fill in the
 * feed is reported as covering only what the feed holds — `coveredMs` says how far back.
 */
export function summarizeLiquidations(details: OkxLiquidationDetail[], ctVal: number, now: number): { windows: LiquidationWindow[]; coveredMs: number } {
  const fills = (details ?? [])
    .map((d) => ({ t: Number(d.ts), usd: Number(d.sz) * ctVal * Number(d.bkPx), long: d.posSide === "long" }))
    .filter((f) => Number.isFinite(f.t) && Number.isFinite(f.usd));
  const oldest = fills.length ? Math.min(...fills.map((f) => f.t)) : now;
  return {
    coveredMs: now - oldest,
    windows: LIQ_WINDOWS.map(([window, ms]) => {
      const inside = fills.filter((f) => now - f.t <= ms);
      return {
        window,
        longUsd: inside.filter((f) => f.long).reduce((s, f) => s + f.usd, 0),
        shortUsd: inside.filter((f) => !f.long).reduce((s, f) => s + f.usd, 0),
      };
    }),
  };
}

export interface CoinIntel {
  coin: string;
  smart: CoinPositioning | null;
  dumb: CoinPositioning | null;
  hlp: CoinPositioning | null;
  /** OKX accounts long ÷ accounts short. */
  okxLongShortRatio: number | null;
  liquidations: LiquidationWindow[] | null;
  liquidationsCoveredMs: number | null;
}

export interface MarketIntel {
  at: number;
  coins: CoinIntel[];
  fearGreed: { value: number; label: string } | null;
  /** Deribit 30-day implied volatility index, annualised %. */
  dvol: { BTC: number | null; ETH: number | null };
  /** (Coinbase BTC-USD − Hyperliquid BTC mid) / HL mid, in %. Positive: US spot buyers paying up. */
  coinbasePremiumPct: number | null;
  /** How many leaderboard accounts each side was built from. */
  traders: { smart: number; dumb: number };
  /** Sources that failed this round — the rest of the intel is still good. */
  errors: string[];
}

function usd(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

function biasText(p: CoinPositioning | null): string {
  const b = netBias(p ?? undefined);
  if (b == null || !p) return "none";
  return `${b >= 0 ? "+" : ""}${b.toFixed(2)} (long ${usd(p.longUsd)} / short ${usd(p.shortUsd)}, ${p.longs}L/${p.shorts}S)`;
}

/**
 * Plain lines for an AI Trader prompt: market-wide sentiment, then one block
 * per coin. Raw numbers, no interpretation, like the rest of the snapshot.
 */
export function intelSection(intel: MarketIntel, coins: string[]): string {
  const want = new Set(coins.map((c) => c.toUpperCase()));
  const rows = intel.coins.filter((c) => want.has(c.coin.toUpperCase()));
  const lines: string[] = [];
  const global = [
    intel.fearGreed ? `fear_greed=${intel.fearGreed.value} (${intel.fearGreed.label})` : null,
    intel.dvol.BTC != null ? `btc_dvol=${intel.dvol.BTC.toFixed(1)}` : null,
    intel.dvol.ETH != null ? `eth_dvol=${intel.dvol.ETH.toFixed(1)}` : null,
    intel.coinbasePremiumPct != null ? `coinbase_premium_pct=${intel.coinbasePremiumPct.toFixed(3)}` : null,
  ].filter(Boolean);
  if (global.length) lines.push(`SENTIMENT ${global.join(" ")}`);
  for (const c of rows) {
    const block = [
      `${c.coin}:`,
      `  smart_money_net_bias=${biasText(c.smart)}  [top ${intel.traders.smart} Hyperliquid accounts by month PnL]`,
      `  dumb_money_net_bias=${biasText(c.dumb)}  [bottom ${intel.traders.dumb} by month PnL]`,
      `  hlp_net_bias=${biasText(c.hlp)}  [Hyperliquid's market maker; takers hold the opposite]`,
      c.okxLongShortRatio != null ? `  okx_long_short_account_ratio=${c.okxLongShortRatio.toFixed(2)}` : null,
      c.liquidations
        ? `  okx_liquidations_usd ${c.liquidations.map((w) => `${w.window}: longs ${usd(w.longUsd)} shorts ${usd(w.shortUsd)}`).join(" | ")}`
        : null,
    ].filter(Boolean);
    lines.push(block.join("\n"));
  }
  return lines.length ? ["OTHER MARKET DATA (free public sources)", ...lines].join("\n") : "";
}
