/**
 * Places one Hyperliquid order from inside the app — signed in-process with
 * ./signing.ts, no GatewayAgent worker or Python subprocess in between, so a
 * trade fires the moment it's decided and the agent's key never leaves this
 * request (it used to ride the task queue to a worker).
 *
 * Behaviour mirrors GatewayAgent/docker/hyperliquid/place_order.py, the
 * worker path it replaces, and returns the same JSON shape so trade
 * history, /settle-trade and the client's order log read either one:
 *
 *   - "market" = IOC limit 1% through the mid (Hyperliquid has no market type);
 *   - price: 5 significant figures, ≤ (6 − szDecimals) decimals;
 *   - size: rounded to the coin's szDecimals, and opening orders under $10 refused;
 *   - leverage is set first (cross) when asked for — and unlike the script,
 *     a refused leverage change stops the order instead of trading anyway;
 *   - SL/TP go out as reduce-only trigger orders after the fill, one action;
 *   - a reduce-only close looks up its realized PnL from the user's fills.
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { nextNonce, orderAction, orderWire, signL1Action, type L1Action, type OrderRequest } from "./signing";

export type HlNetwork = "testnet" | "mainnet";

export const MARKET_SLIPPAGE = 0.01;
const MAX_PERP_PRICE_DECIMALS = 6;
const MIN_ORDER_USD = 10;

export interface PlaceOrderParams {
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  orderType?: "market" | "limit";
  limitPrice?: number;
  reduceOnly?: boolean;
  leverage?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  privateKey: string;
  network: HlNetwork;
}

/** Same fields place_order.py prints. */
export interface PlaceOrderResult {
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  sz: number;
  midPriceAtOrder: number;
  limitPx: number;
  reduceOnly: boolean;
  leverage: number | null;
  raw: Record<string, unknown>;
  triggers: { stopLoss?: { triggerPx: number; raw: unknown }; takeProfit?: { triggerPx: number; raw: unknown } } | null;
  realizedPnl: number | null;
}

/** The order was refused before or by Hyperliquid — nothing was placed (except, for trigger failures, see `triggers`). */
export class HyperliquidOrderError extends Error {
  constructor(message: string, readonly raw?: unknown) {
    super(message);
    this.name = "HyperliquidOrderError";
  }
}

function apiBase(network: HlNetwork): string {
  return network === "mainnet" ? "https://api.hyperliquid.xyz" : "https://api.hyperliquid-testnet.xyz";
}

async function post<T>(network: HlNetwork, path: "/info" | "/exchange", body: unknown): Promise<T> {
  const resp = await fetch(apiBase(network) + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await resp.text();
  if (!resp.ok) throw new HyperliquidOrderError(`Hyperliquid ${path} ${resp.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HyperliquidOrderError(`Hyperliquid ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

interface ExchangeResponse {
  status: "ok" | "err";
  response: string | { type: string; data?: { statuses?: Record<string, unknown>[] } };
}

async function sendAction(network: HlNetwork, privateKey: string, action: L1Action): Promise<ExchangeResponse> {
  const nonce = nextNonce();
  const signature = await signL1Action(privateKey, action, nonce, network === "mainnet");
  return post<ExchangeResponse>(network, "/exchange", { action, nonce, signature, vaultAddress: null, expiresAfter: null });
}

function statusesOf(resp: ExchangeResponse): Record<string, unknown>[] {
  return typeof resp.response === "object" ? resp.response.data?.statuses ?? [] : [];
}

function errorOf(resp: ExchangeResponse): string | null {
  if (resp.status !== "ok") return typeof resp.response === "string" ? resp.response : JSON.stringify(resp.response);
  const first = statusesOf(resp)[0];
  return first && typeof first.error === "string" ? first.error : null;
}

/** Hyperliquid rejects perp prices with more than 5 significant figures or more than (6 − szDecimals) decimals. */
export function roundPrice(px: number, szDecimals: number): number {
  return Number(Number(px.toPrecision(5)).toFixed(MAX_PERP_PRICE_DECIMALS - szDecimals));
}

export function roundSize(sz: number, szDecimals: number): number {
  return Number(sz.toFixed(szDecimals));
}

export function walletAddress(privateKey: string): string {
  return privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex).address;
}

export async function placeOrder(p: PlaceOrderParams): Promise<PlaceOrderResult> {
  const { coin, isBuy, sizeUsd, network, privateKey } = p;
  const orderType = p.orderType ?? "market";
  const reduceOnly = p.reduceOnly ?? false;

  const [mids, meta] = await Promise.all([
    post<Record<string, string>>(network, "/info", { type: "allMids" }),
    post<{ universe: { name: string; szDecimals: number }[] }>(network, "/info", { type: "meta" }),
  ]);
  const asset = meta.universe.findIndex((u) => u.name === coin);
  const mid = Number(mids[coin]);
  if (asset < 0 || !mid) throw new HyperliquidOrderError(`Unknown coin ${coin} on ${network}`);
  const szDecimals = meta.universe[asset].szDecimals;

  let limitPx: number;
  let tif: "Ioc" | "Gtc";
  if (orderType === "market") {
    limitPx = roundPrice(isBuy ? mid * (1 + MARKET_SLIPPAGE) : mid * (1 - MARKET_SLIPPAGE), szDecimals);
    tif = "Ioc";
  } else {
    if (!p.limitPrice) throw new HyperliquidOrderError("limitPrice is required for limit orders");
    limitPx = roundPrice(p.limitPrice, szDecimals);
    tif = "Gtc";
  }

  const sz = roundSize(sizeUsd / mid, szDecimals);
  if (sz <= 0) throw new HyperliquidOrderError(`$${sizeUsd} is below the smallest ${coin} order size (${10 ** -szDecimals} ${coin})`);
  if (!reduceOnly && sz * limitPx < MIN_ORDER_USD) {
    throw new HyperliquidOrderError(`Order value $${(sz * limitPx).toFixed(2)} is below Hyperliquid's $${MIN_ORDER_USD} minimum`);
  }

  if (p.leverage) {
    const lev = await sendAction(network, privateKey, { type: "updateLeverage", asset, isCross: true, leverage: Math.floor(p.leverage) });
    const err = errorOf(lev);
    if (err) throw new HyperliquidOrderError(`Leverage ${p.leverage}x refused: ${err}`, lev);
  }

  const order: OrderRequest = { asset, isBuy, sz, limitPx, reduceOnly, orderType: { limit: { tif } } };
  const resp = await sendAction(network, privateKey, orderAction([orderWire(order)]));
  const err = errorOf(resp);
  if (err) throw new HyperliquidOrderError(err, resp);
  const status = statusesOf(resp)[0] ?? {};
  const raw = (status.filled ?? status.resting ?? status) as Record<string, unknown>;

  // Realized PnL only appears per fill (closedPnl), keyed by the order's oid —
  // the daily-loss guard and trade history need it on closes. Best effort.
  let realizedPnl: number | null = null;
  if (reduceOnly && raw.oid != null) {
    try {
      const fills = await post<{ oid: number; closedPnl: string }[]>(network, "/info", { type: "userFills", user: walletAddress(privateKey) });
      const mine = fills.filter((f) => f.oid === raw.oid);
      if (mine.length) realizedPnl = mine.reduce((sum, f) => sum + Number(f.closedPnl || 0), 0);
    } catch {
      // the trade already executed; a missing PnL shouldn't fail it
    }
  }

  // SL/TP: reduce-only triggers on the opposite side, a fixed % through the entry.
  let triggers: PlaceOrderResult["triggers"] = null;
  if (!reduceOnly && (p.stopLossPct || p.takeProfitPct)) {
    const entry = raw.avgPx != null ? Number(raw.avgPx) : limitPx;
    const legs: { key: "stopLoss" | "takeProfit"; triggerPx: number; tpsl: "sl" | "tp" }[] = [];
    if (p.stopLossPct) {
      legs.push({ key: "stopLoss", tpsl: "sl", triggerPx: roundPrice(isBuy ? entry * (1 - p.stopLossPct / 100) : entry * (1 + p.stopLossPct / 100), szDecimals) });
    }
    if (p.takeProfitPct) {
      legs.push({ key: "takeProfit", tpsl: "tp", triggerPx: roundPrice(isBuy ? entry * (1 + p.takeProfitPct / 100) : entry * (1 - p.takeProfitPct / 100), szDecimals) });
    }
    const wires = legs.map((l) => orderWire({
      asset, isBuy: !isBuy, sz, limitPx: l.triggerPx, reduceOnly: true,
      orderType: { trigger: { triggerPx: l.triggerPx, isMarket: true, tpsl: l.tpsl } },
    }));
    triggers = {};
    try {
      const trig = await sendAction(network, privateKey, orderAction(wires));
      const statuses = statusesOf(trig);
      legs.forEach((l, i) => { triggers![l.key] = { triggerPx: l.triggerPx, raw: statuses[i] ?? trig }; });
    } catch (e) {
      // The entry is filled — report the missing protection rather than failing the trade.
      legs.forEach((l) => { triggers![l.key] = { triggerPx: l.triggerPx, raw: { error: (e as Error).message } }; });
    }
  }

  return {
    coin, isBuy, sizeUsd, sz, midPriceAtOrder: mid, limitPx, reduceOnly,
    leverage: p.leverage ?? null, raw, triggers, realizedPnl,
  };
}
