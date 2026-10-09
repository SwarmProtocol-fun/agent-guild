/**
 * Polymarket public market data — Gamma (discovery/metadata), the CLOB (books,
 * price history) and the Data API (wallet positions). All unsigned reads, so
 * they work from anywhere, including geoblocked regions; only order placement
 * is restricted (see live.ts).
 */

export const GAMMA_URL = "https://gamma-api.polymarket.com";
export const CLOB_URL = "https://clob.polymarket.com";
export const DATA_URL = "https://data-api.polymarket.com";

export interface Outcome {
  name: string;
  tokenId: string;
  price: number;
}

export interface FeeSchedule {
  rate: number;
  exponent: number;
}

export interface PmMarket {
  id: string;
  conditionId: string;
  slug: string;
  question: string;
  eventSlug: string | null;
  eventTitle: string | null;
  groupItemTitle: string | null;
  description: string;
  endDate: string | null;
  image: string | null;
  outcomes: Outcome[];
  bestBid: number | null;
  bestAsk: number | null;
  lastTradePrice: number | null;
  volume24hr: number;
  liquidity: number;
  tickSize: number;
  minOrderSize: number;
  negRisk: boolean;
  acceptingOrders: boolean;
  closed: boolean;
  fee: FeeSchedule | null;
  /** Index into outcomes of the winner, once the market has resolved. */
  winnerIndex: number | null;
  /** Crypto up/down markets: the window's opening reference price, once published. */
  priceToBeat: number | null;
}

export interface PmEvent {
  id: string;
  slug: string;
  title: string;
  image: string | null;
  endDate: string | null;
  volume24hr: number;
  markets: PmMarket[];
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface Book {
  /** Best (highest) first. */
  bids: BookLevel[];
  /** Best (lowest) first. */
  asks: BookLevel[];
  tickSize: number;
  minOrderSize: number;
  negRisk: boolean;
}

type Raw = Record<string, unknown>;

/** Gamma returns several array fields as JSON-encoded strings. */
function jsonList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** One Gamma market → PmMarket; null if it has no tradeable outcome tokens. */
export function normalizeMarket(raw: Raw, event?: Raw | null): PmMarket | null {
  const names = jsonList(raw.outcomes).map(String);
  const prices = jsonList(raw.outcomePrices).map((p) => num(p) ?? 0);
  const tokens = jsonList(raw.clobTokenIds).map(String);
  if (!names.length || names.length !== tokens.length || !str(raw.conditionId)) return null;

  const closed = raw.closed === true;
  // A resolved market settles to exactly one outcome at 1 and the rest at 0.
  const winnerIndex = closed && prices.length === names.length && prices.filter((p) => p === 1).length === 1
    && prices.every((p) => p === 0 || p === 1)
    ? prices.indexOf(1)
    : null;

  const feeRaw = raw.feeSchedule as Raw | undefined;
  const fee = raw.feesEnabled === true && feeRaw && num(feeRaw.rate)
    ? { rate: num(feeRaw.rate)!, exponent: num(feeRaw.exponent) ?? 1 }
    : null;
  const meta = (event?.eventMetadata ?? null) as Raw | null;

  return {
    id: String(raw.id ?? ""),
    conditionId: String(raw.conditionId),
    slug: String(raw.slug ?? ""),
    question: String(raw.question ?? ""),
    eventSlug: str(event?.slug),
    eventTitle: str(event?.title),
    groupItemTitle: str(raw.groupItemTitle),
    description: String(raw.description ?? event?.description ?? ""),
    endDate: str(raw.endDate) ?? str(event?.endDate),
    image: str(raw.icon) ?? str(raw.image) ?? str(event?.image),
    outcomes: names.map((name, i) => ({ name, tokenId: tokens[i], price: prices[i] ?? 0 })),
    bestBid: num(raw.bestBid),
    bestAsk: num(raw.bestAsk),
    lastTradePrice: num(raw.lastTradePrice),
    volume24hr: num(raw.volume24hr) ?? 0,
    liquidity: num(raw.liquidityNum) ?? num(raw.liquidity) ?? 0,
    tickSize: num(raw.orderPriceMinTickSize) ?? 0.01,
    minOrderSize: num(raw.orderMinSize) ?? 5,
    negRisk: raw.negRisk === true,
    acceptingOrders: raw.acceptingOrders === true,
    closed,
    fee,
    winnerIndex,
    priceToBeat: meta ? num(meta.priceToBeat) : null,
  };
}

export function normalizeEvent(raw: Raw): PmEvent {
  const markets = (Array.isArray(raw.markets) ? raw.markets : [])
    .map((m) => normalizeMarket(m as Raw, raw))
    .filter((m): m is PmMarket => m !== null);
  return {
    id: String(raw.id ?? ""),
    slug: String(raw.slug ?? ""),
    title: String(raw.title ?? ""),
    image: str(raw.image) ?? str(raw.icon),
    endDate: str(raw.endDate),
    volume24hr: num(raw.volume24hr) ?? 0,
    markets,
  };
}

/** CLOB book → best-first levels on both sides (the API returns them worst-first). */
export function normalizeBook(raw: Raw): Book {
  const side = (v: unknown) => (Array.isArray(v) ? v : [])
    .map((l) => ({ price: num((l as Raw).price) ?? 0, size: num((l as Raw).size) ?? 0 }))
    .filter((l) => l.price > 0 && l.size > 0);
  return {
    bids: side(raw.bids).sort((a, b) => b.price - a.price),
    asks: side(raw.asks).sort((a, b) => a.price - b.price),
    tickSize: num(raw.tick_size) ?? 0.01,
    minOrderSize: num(raw.min_order_size) ?? 5,
    negRisk: raw.neg_risk === true,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const resp = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!resp.ok) throw new Error(`Polymarket request failed (${resp.status}): ${new URL(url).pathname}`);
  return resp.json() as Promise<T>;
}

/** Open events by 24h volume — the "what's active right now" list. */
export async function getTrendingEvents(limit = 30, tag?: string): Promise<PmEvent[]> {
  const qs = new URLSearchParams({ active: "true", closed: "false", order: "volume24hr", ascending: "false", limit: String(limit) });
  if (tag) qs.set("tag_slug", tag);
  const raw = await getJson<Raw[]>(`${GAMMA_URL}/events?${qs}`);
  return raw.map(normalizeEvent).map((e) => ({ ...e, markets: e.markets.filter((m) => !m.closed) })).filter((e) => e.markets.length);
}

export async function searchEvents(q: string, limit = 20): Promise<PmEvent[]> {
  const qs = new URLSearchParams({ q, limit_per_type: String(limit), events_status: "active" });
  const raw = await getJson<{ events?: Raw[] }>(`${GAMMA_URL}/public-search?${qs}`);
  return (raw.events ?? []).map(normalizeEvent).filter((e) => e.markets.length);
}

export async function getEventBySlug(slug: string): Promise<PmEvent | null> {
  const raw = await getJson<Raw[]>(`${GAMMA_URL}/events?slug=${encodeURIComponent(slug)}`);
  return raw[0] ? normalizeEvent(raw[0]) : null;
}

export async function getMarketByConditionId(conditionId: string): Promise<PmMarket | null> {
  const id = encodeURIComponent(conditionId);
  // Gamma leaves closed markets out unless asked, and resolution checks need exactly those.
  let raw = await getJson<Raw[]>(`${GAMMA_URL}/markets?condition_ids=${id}`);
  if (!raw[0]) raw = await getJson<Raw[]>(`${GAMMA_URL}/markets?condition_ids=${id}&closed=true`);
  if (!raw[0]) return null;
  // The parent event carries eventMetadata (priceToBeat).
  const events = Array.isArray(raw[0].events) ? (raw[0].events as Raw[]) : [];
  return normalizeMarket(raw[0], events[0] ?? null);
}

export async function getBook(tokenId: string): Promise<Book> {
  return normalizeBook(await getJson<Raw>(`${CLOB_URL}/book?token_id=${encodeURIComponent(tokenId)}`));
}

export interface PricePoint {
  t: number;
  p: number;
}

/** Price history for one outcome token. interval: 1h, 6h, 1d, 1w, max. */
export async function getPriceHistory(tokenId: string, interval = "1d", fidelity = 5): Promise<PricePoint[]> {
  const qs = new URLSearchParams({ market: tokenId, interval, fidelity: String(fidelity) });
  const raw = await getJson<{ history?: { t: number; p: number }[] }>(`${CLOB_URL}/prices-history?${qs}`);
  return (raw.history ?? []).map((h) => ({ t: h.t * 1000, p: h.p }));
}

export interface WalletPosition {
  tokenId: string;
  conditionId: string;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  shares: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  redeemable: boolean;
  endDate: string | null;
}

/** On-chain positions for a live trading wallet (Data API). */
export async function getWalletPositions(address: string): Promise<WalletPosition[]> {
  const raw = await getJson<Raw[]>(`${DATA_URL}/positions?user=${encodeURIComponent(address)}&sizeThreshold=0.01&limit=200`);
  return raw.map((p) => ({
    tokenId: String(p.asset ?? ""),
    conditionId: String(p.conditionId ?? ""),
    title: String(p.title ?? ""),
    slug: String(p.slug ?? ""),
    outcome: String(p.outcome ?? ""),
    outcomeIndex: num(p.outcomeIndex) ?? 0,
    shares: num(p.size) ?? 0,
    avgPrice: num(p.avgPrice) ?? 0,
    curPrice: num(p.curPrice) ?? 0,
    initialValue: num(p.initialValue) ?? 0,
    currentValue: num(p.currentValue) ?? 0,
    cashPnl: num(p.cashPnl) ?? 0,
    redeemable: p.redeemable === true,
    endDate: str(p.endDate),
  }));
}

// ── BTC 5-minute Up/Down series ─────────────────────────────────────────────

export const BTC_WINDOW_MS = 5 * 60_000;

export interface BtcWindow {
  startMs: number;
  endMs: number;
  slug: string;
  elapsedMs: number;
  remainingMs: number;
}

/** The BTC 5-minute window `now` falls in. Slugs are keyed by the window's start (unix seconds). */
export function btcWindow(now = Date.now()): BtcWindow {
  const startMs = Math.floor(now / BTC_WINDOW_MS) * BTC_WINDOW_MS;
  return {
    startMs,
    endMs: startMs + BTC_WINDOW_MS,
    slug: `btc-updown-5m-${startMs / 1000}`,
    elapsedMs: now - startMs,
    remainingMs: startMs + BTC_WINDOW_MS - now,
  };
}

/** The live BTC 5-minute market for a window (null if Polymarket hasn't listed it). */
export async function getBtcWindowMarket(win: BtcWindow): Promise<PmMarket | null> {
  const event = await getEventBySlug(win.slug);
  return event?.markets[0] ?? null;
}
