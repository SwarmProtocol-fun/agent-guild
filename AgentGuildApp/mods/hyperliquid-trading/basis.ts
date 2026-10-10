/**
 * Spot-perp basis (cash and carry), all on Hyperliquid: buy the coin on
 * Hyperliquid spot and short the same size of its perp. The two legs cancel
 * on price, so what's left is the carry — funding the short collects while
 * longs pay — plus the perp's premium over spot closing in.
 *
 *   - Rows: every perp with a USDC spot market (BTC trades on spot as UBTC,
 *     ETH as UETH, HYPE as HYPE), its basis (perp − spot) / spot and funding.
 *   - Bot: enters when funding pays at least entryAprPct a year to the short
 *     and the perp isn't at a discount deeper than minBasisPct; exits when
 *     funding drops under exitAprPct or after maxHoldHours. Only the positive
 *     carry is traded — the reverse needs a spot short, which spot can't do.
 *
 * Pure and browser-safe.
 */

const HOURS_PER_YEAR = 24 * 365;

export interface SpotToken { index: number; name: string; szDecimals: number }
export interface SpotPair { name: string; index: number; tokens: [number, number] }
export interface SpotCtx { midPx: string | null; markPx: string; dayNtlVlm: string }

export interface SpotMarket {
  /** The perp this spot market hedges (BTC for UBTC). */
  coin: string;
  /** The book/mid key: "@142", or "PURR/USDC" for the oldest pairs. */
  pair: string;
  token: string;
  szDecimals: number;
  midPx: number;
  volume24hUsd: number;
}

/** Spot token names that hedge a perp: the coin itself, or Unit's wrapped "U" + coin. */
export function spotTokenNames(coin: string): string[] {
  return [coin, `U${coin}`];
}

/**
 * Each perp coin's USDC spot market, from spotMetaAndAssetCtxs. When several
 * spot markets match, the busiest wins.
 */
export function mapSpotMarkets(
  perpCoins: string[],
  meta: { tokens: SpotToken[]; universe: SpotPair[] },
  ctxs: SpotCtx[],
): Map<string, SpotMarket> {
  const tokenByIndex = new Map(meta.tokens.map((t) => [t.index, t]));
  const usdc = meta.tokens.find((t) => t.name === "USDC")?.index ?? 0;
  const byName = new Map<string, { pair: SpotPair; ctx: SpotCtx; token: SpotToken }[]>();
  for (const pair of meta.universe) {
    if (pair.tokens[1] !== usdc) continue;
    const token = tokenByIndex.get(pair.tokens[0]);
    const ctx = ctxs[pair.index];
    if (!token || !ctx) continue;
    byName.set(token.name, [...(byName.get(token.name) ?? []), { pair, ctx, token }]);
  }
  const out = new Map<string, SpotMarket>();
  for (const coin of perpCoins) {
    const found = spotTokenNames(coin).flatMap((n) => byName.get(n) ?? []);
    const best = found.sort((a, b) => Number(b.ctx.dayNtlVlm) - Number(a.ctx.dayNtlVlm))[0];
    if (!best) continue;
    const midPx = Number(best.ctx.midPx ?? best.ctx.markPx);
    if (!(midPx > 0)) continue;
    out.set(coin, {
      coin, pair: best.pair.name, token: best.token.name, szDecimals: best.token.szDecimals,
      midPx, volume24hUsd: Number(best.ctx.dayNtlVlm) || 0,
    });
  }
  return out;
}

export interface BasisRow {
  coin: string;
  spotPair: string;
  spotToken: string;
  spotPx: number;
  perpPx: number;
  /** (perp − spot) / spot, in percent. Positive: perp trades rich. */
  basisPct: number;
  /** Hyperliquid funding, annualised, in percent. Positive: longs pay shorts — the carry this trade collects. */
  fundingAprPct: number;
  spotVolume24hUsd: number;
  perpVolume24hUsd: number;
}

/** Basis rows for every perp with a spot market, best carry first. Spot markets thinner than minSpotVolumeUsd are dropped. */
export function findBasis(
  perps: { coin: string; markPx: number; fundingRatePct: number; volume24hUsd: number }[],
  spots: Map<string, SpotMarket>,
  opts: { minSpotVolumeUsd?: number; limit?: number } = {},
): BasisRow[] {
  const minVol = opts.minSpotVolumeUsd ?? 50_000;
  const rows: BasisRow[] = [];
  for (const p of perps) {
    const s = spots.get(p.coin);
    if (!s || s.volume24hUsd < minVol || !(p.markPx > 0)) continue;
    rows.push({
      coin: p.coin, spotPair: s.pair, spotToken: s.token, spotPx: s.midPx, perpPx: p.markPx,
      basisPct: ((p.markPx - s.midPx) / s.midPx) * 100,
      fundingAprPct: (p.fundingRatePct / 100) * HOURS_PER_YEAR * 100,
      spotVolume24hUsd: s.volume24hUsd, perpVolume24hUsd: p.volume24hUsd,
    });
  }
  rows.sort((a, b) => b.fundingAprPct - a.fundingAprPct);
  return rows.slice(0, opts.limit ?? 20);
}

export interface BasisParams {
  coin: string;
  /** Enter when funding pays the short at least this much a year, in percent. */
  entryAprPct: number;
  /** Exit when funding falls under this, in percent a year. */
  exitAprPct: number;
  /** Don't enter while the perp is at a discount deeper than this (−0.2 → perp no more than 0.2% under spot). */
  minBasisPct: number;
  maxHoldHours: number;
}

export const BASIS_DEFAULTS: Omit<BasisParams, "coin"> = { entryAprPct: 15, exitAprPct: 3, minBasisPct: -0.2, maxHoldHours: 24 * 7 };

export interface OpenBasis {
  coin: string;
  openedAt: number;
  entryBasisPct: number;
  entryFundingAprPct: number;
  /** Spot coins bought — the perp short is the same size. */
  spotSz: number;
  spotPx: number;
}

export type BasisDecision =
  | { action: "open"; reason: string }
  | { action: "close"; reason: string }
  | { action: "hold"; reason: string };

export function decideBasis(p: BasisParams, row: BasisRow | null, open: OpenBasis | null, now: number): BasisDecision {
  if (!row) return { action: "hold", reason: `No ${p.coin} spot market with enough volume to hedge on.` };
  const apr = row.fundingAprPct.toFixed(1);
  if (open) {
    if (row.fundingAprPct < p.exitAprPct) return { action: "close", reason: `Funding down to ${apr}% APR, under the ${p.exitAprPct}% exit. Unwinding both legs.` };
    if (now - open.openedAt >= p.maxHoldHours * 3_600_000) return { action: "close", reason: `Held ${p.maxHoldHours}h. Unwinding both legs (funding ${apr}% APR).` };
    return { action: "hold", reason: `Carrying: funding ${apr}% APR, basis ${row.basisPct.toFixed(3)}%.` };
  }
  if (row.fundingAprPct < p.entryAprPct) return { action: "hold", reason: `Funding ${apr}% APR is under the ${p.entryAprPct}% entry.` };
  if (row.basisPct < p.minBasisPct) return { action: "hold", reason: `Perp is ${row.basisPct.toFixed(3)}% under spot, past the ${p.minBasisPct}% limit.` };
  return { action: "open", reason: `Funding pays shorts ${apr}% APR with basis ${row.basisPct.toFixed(3)}%: buying ${row.spotToken} spot, shorting the ${p.coin} perp.` };
}

export function buildBasisParams(raw: Record<string, unknown> | undefined, coin: string | null): BasisParams | { error: string } {
  if (!coin) return { error: "a basis bot needs a coin such as BTC" };
  const num = (k: keyof typeof BASIS_DEFAULTS) => (raw?.[k] == null || raw[k] === "" ? BASIS_DEFAULTS[k] : Number(raw[k]));
  const p: BasisParams = { coin, entryAprPct: num("entryAprPct"), exitAprPct: num("exitAprPct"), minBasisPct: num("minBasisPct"), maxHoldHours: num("maxHoldHours") };
  if (!(p.entryAprPct > 0 && p.entryAprPct <= 1000)) return { error: "entryAprPct must be above 0" };
  if (!(p.exitAprPct < p.entryAprPct)) return { error: "exitAprPct must be under entryAprPct" };
  if (!(p.minBasisPct >= -10 && p.minBasisPct <= 10)) return { error: "minBasisPct must be between −10 and 10" };
  if (!(p.maxHoldHours >= 1 && p.maxHoldHours <= 24 * 90)) return { error: "maxHoldHours must be between 1 and 2160" };
  return p;
}
