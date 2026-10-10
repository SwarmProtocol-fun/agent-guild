import { defineServerMod, type RouteContext } from "@agent-guild/sdk";
import { enqueueTask, getTask, newTaskId, recordCompletedTask } from "@/lib/gateway/store";
import { settleOnChains, hashJobResult } from "@/lib/settlement/registry";
import { encryptValue, decryptValue } from "@/lib/secrets";
import { enableModCapabilities, enforceCapability, getAgent, getAgentCapabilities, getAgentsByOrg, getOrganizationsByWalletAdmin } from "@/lib/firestore-admin";
import { listAgentWallets, generateAgentWallet, getAgentWalletEvmPrivateKey } from "@/lib/agent-wallets";
import { Wallet as EvmWallet } from "ethers";
import { requireOrgMembershipByAddress } from "@/lib/auth-guard";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import {
  getRiskConfig,
  setRiskConfig,
  recordTrade,
  getTradeHistory,
  getDailyRealizedPnl,
  createStrategy,
  toggleStrategy,
  getStrategy,
  getStrategies,
  getEnabledStrategies,
  getPendingStrategies,
  markStrategyPending,
  clearStrategyPending,
  touchStrategyRun,
  getAgentWallet,
  setAgentWallet,
  deleteAgentWallet,
  setStrategyWebhookToken,
  getStrategyByWebhookToken,
  getKnownCoins,
  setKnownCoins,
  getReferral,
  ensureReferral,
  applyReferralCode,
  accrueReferralReward,
  getInstantTrading,
  setInstantTrading,
  deleteInstantTrading,
  type DcaParams,
  type GridParams,
  type SniperParams,
  type AiParams,
  type Strategy,
  recordAiDecision,
  getAiDecisions,
  createAiRequest,
  getAiRequest,
  listOpenAiRequests,
  answerAiRequest,
  expireAiRequest,
  type AiRequest,
  getPaperAccount,
  resetPaperAccount,
  listPaperPositions,
  listAllPaperPositions,
  createPaperOrder,
  getPaperOrder,
  listPaperOrders,
  listAllPaperOrders,
  deletePaperOrder,
  bookPaperFill,
  applyPaperFunding,
  updatePaperTrailingStop,
  getPaperTradeHistory,
  type PaperPositionDoc,
} from "@/lib/mods/hyperliquid-store";
import crypto from "crypto";
import {
  buildSnapshot,
  decisionRequest,
  decisionToAction,
  normalizeGoal,
  parseDecision,
  type AiAction,
  type AiDecision,
  type AiPosition,
} from "./ai-trader-core";
import type { Candle } from "./indicators";
import { findPerpAsset, readOraclePxOnchain, type PerpAssetMeta } from "./oracle";
import { placeOrder as placeHlOrder, MARKET_SLIPPAGE, MIN_ORDER_USD, type PlaceOrderResult } from "./exchange";
import {
  MAKER_FEE_RATE,
  PAPER_START_BALANCE,
  TAKER_FEE_RATE,
  fundingPayment,
  isLiquidatable,
  restingFillable,
  roundSize,
  summarize,
  ratchetTrail,
  triggerHit,
  walkBook,
  type CoinMeta,
} from "./paper";

type HlNetwork = "testnet" | "mainnet";

function hlInfoUrl(network: HlNetwork): string {
  return network === "mainnet"
    ? "https://api.hyperliquid.xyz/info"
    : "https://api.hyperliquid-testnet.xyz/info";
}

function defaultNetwork(): HlNetwork {
  return process.env.HYPERLIQUID_NETWORK === "mainnet" ? "mainnet" : "testnet";
}

/** Public, unsigned reads against Hyperliquid's Info API — no private key needed. */
async function hlInfo<T>(body: Record<string, unknown>, network: HlNetwork): Promise<T> {
  const resp = await fetch(hlInfoUrl(network), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Hyperliquid info request failed: ${resp.status}`);
  return resp.json();
}

async function getMidPrice(coin: string, network: HlNetwork): Promise<number> {
  const mids = await hlInfo<Record<string, string>>({ type: "allMids" }, network);
  const px = Number(mids[coin]);
  if (!px) throw new Error(`No mid price for ${coin}`);
  return px;
}

type PerpUniverse = { name: string; szDecimals: number; maxLeverage?: number }[];
const universeCache = new Map<HlNetwork, { at: number; universe: PerpUniverse }>();

/** Perp universe (asset index = position) — cached a minute, since listings change rarely. */
async function getPerpUniverse(network: HlNetwork): Promise<PerpUniverse> {
  const hit = universeCache.get(network);
  if (hit && Date.now() - hit.at < 60_000) return hit.universe;
  const meta = await hlInfo<{ universe: PerpUniverse }>({ type: "meta" }, network);
  universeCache.set(network, { at: Date.now(), universe: meta.universe });
  return meta.universe;
}

interface OracleReading {
  coin: string;
  oraclePx: number;
  markPx: number | null;
  source: "onchain" | "api";
}

/**
 * Oracle price for one perp. `onchain` reads HyperEVM's 0x…0807 precompile
 * and falls back to the Info API if the RPC is down; `api` goes straight to
 * `metaAndAssetCtxs` (which also carries markPx).
 */
async function getOraclePrice(coin: string, network: HlNetwork, source: "onchain" | "api"): Promise<OracleReading> {
  if (source === "onchain") {
    const asset: PerpAssetMeta | null = findPerpAsset(await getPerpUniverse(network), coin);
    if (!asset) throw new Error(`Unknown perp: ${coin}`);
    try {
      return { coin, oraclePx: await readOraclePxOnchain(asset, network), markPx: null, source: "onchain" };
    } catch {
      // RPC hiccup — the Info API serves the same oracle value
    }
  }
  type Ctx = { oraclePx: string; markPx: string };
  const [meta, ctxs] = await hlInfo<[{ universe: PerpUniverse }, Ctx[]]>({ type: "metaAndAssetCtxs" }, network);
  const asset = findPerpAsset(meta.universe, coin);
  const ctx = asset ? ctxs[asset.index] : undefined;
  if (!ctx) throw new Error(`Unknown perp: ${coin}`);
  return { coin, oraclePx: Number(ctx.oraclePx), markPx: Number(ctx.markPx) || null, source: "api" };
}

/** The full set of perp coins currently tradeable on Hyperliquid — used by the "new-listing" sniper mode. */
async function getUniverseCoins(network: HlNetwork): Promise<string[]> {
  const meta = await hlInfo<{ universe: { name: string }[] }>({ type: "meta" }, network);
  return meta.universe.map((a) => a.name);
}

interface MarketCoin {
  coin: string;
  markPx: number;
  change24hPct: number;
  volume24hUsd: number;
  openInterestUsd: number;
  fundingRatePct: number;
  maxLeverage: number;
}

/**
 * Whole-market snapshot (price, 24h change, volume, open interest, funding)
 * across every tradeable perp — the overview used to decide what to trade,
 * not any one agent's position. One `metaAndAssetCtxs` call returns the
 * universe (name/leverage) and matching asset contexts (price/funding/OI) by
 * index; delisted coins are dropped since they can't be traded. Sorted by
 * 24h volume, the natural "what's active right now" ordering.
 */
async function getMarketOverview(network: HlNetwork): Promise<MarketCoin[]> {
  type AssetCtx = { funding: string; openInterest: string; prevDayPx: string; dayNtlVlm: string; markPx: string };
  type UniverseAsset = { name: string; maxLeverage: number; isDelisted?: boolean };
  const [meta, ctxs] = await hlInfo<[{ universe: UniverseAsset[] }, AssetCtx[]]>({ type: "metaAndAssetCtxs" }, network);

  const coins: MarketCoin[] = [];
  meta.universe.forEach((asset, i) => {
    const ctx = ctxs[i];
    if (!ctx || asset.isDelisted) return;
    const markPx = Number(ctx.markPx);
    const prevDayPx = Number(ctx.prevDayPx);
    coins.push({
      coin: asset.name,
      markPx,
      change24hPct: prevDayPx ? ((markPx - prevDayPx) / prevDayPx) * 100 : 0,
      volume24hUsd: Number(ctx.dayNtlVlm),
      openInterestUsd: Number(ctx.openInterest) * markPx,
      fundingRatePct: Number(ctx.funding) * 100,
      maxLeverage: asset.maxLeverage,
    });
  });

  coins.sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  return coins;
}

/**
 * Decrypts an agent's own stored Hyperliquid key for exactly one request.
 * There is no server-held master key — `masterSecret` is the agent's own
 * passphrase, supplied fresh on every call, never persisted. A wrong
 * passphrase fails the GCM auth tag check inside decryptValue and throws.
 */
async function resolveAgentWallet(agentId: string, masterSecret: string): Promise<{ privateKey: string; network: HlNetwork }> {
  const wallet = await getAgentWallet(agentId);
  if (!wallet) throw new Error(`No Hyperliquid wallet set for agent ${agentId} — call POST /wallet first`);
  let privateKey: string;
  try {
    privateKey = decryptValue(wallet.encryptedValue, wallet.iv, agentId, masterSecret);
  } catch {
    throw new Error("Incorrect masterSecret for this agent's wallet");
  }
  return { privateKey, network: wallet.network };
}

/**
 * The key a trade is signed with. An agent on instant trading signs with its
 * platform-held wallet and needs no passphrase; every other agent needs its
 * passphrase to decrypt its own key (resolveAgentWallet).
 */
async function resolveSigningKey(agentId: string, masterSecret?: string): Promise<{ privateKey: string; network: HlNetwork }> {
  const instant = await getInstantTrading(agentId);
  if (instant) {
    const privateKey = await getAgentWalletEvmPrivateKey(instant.walletId, instant.orgId, agentId);
    return { privateKey, network: instant.network };
  }
  if (!masterSecret) throw new Error("masterSecret is required (or turn on instant trading for this agent)");
  return resolveAgentWallet(agentId, masterSecret);
}

/** Where an agent trades from — instant-trading wallet first, else its passphrase wallet. Null if neither is set. */
async function getTradingWallet(agentId: string): Promise<{ network: HlNetwork; address: string | null; instant: boolean } | null> {
  const instant = await getInstantTrading(agentId);
  if (instant) return { network: instant.network, address: instant.address, instant: true };
  const wallet = await getAgentWallet(agentId);
  if (!wallet) return null;
  let address = wallet.address ?? null;
  if (!address) {
    // Wallets generated via /api/v1/agents/:id/wallets record their address
    // there rather than in this mod's store.
    const generated = (await listAgentWallets(agentId)).find((w) => w.chain === "evm" && w.hyperliquidRegistered);
    address = generated?.publicKey ?? null;
  }
  return { network: wallet.network, address, instant: false };
}

/** Chart intervals the terminal offers, in Hyperliquid's candleSnapshot naming. */
const CANDLE_INTERVAL_MS: Record<string, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};

/** Applied when instant trading is switched on for an agent with no risk limits — the platform signing alone must never be unbounded. */
const INSTANT_DEFAULT_RISK = { leverage: 3, maxPositionUsd: 100, maxDailyLossUsd: 50 };

interface AssetPosition {
  position: { coin: string; szi: string; positionValue: string; unrealizedPnl: string; entryPx: string };
}
interface ClearinghouseState {
  assetPositions: AssetPosition[];
  marginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string };
}

/**
 * Server-side guard shared by /trade, /strategy/:id/signal, and the strategy
 * tick evaluator — every path that can enqueue a live order runs through
 * this so a risk config set via /risk-config is never bypassed.
 */
async function enforceRiskAndEnqueue(params: {
  orgId: string;
  agentId: string;
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  privateKey: string;
  network: HlNetwork;
  orderType?: "market" | "limit";
  limitPrice?: number;
  leverage?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  reduceOnly?: boolean;
}): Promise<{ taskId: string } | { error: string }> {
  const { orgId, agentId, coin, isBuy, sizeUsd, privateKey, network, orderType = "market", limitPrice, reduceOnly = false } = params;

  const risk = await getRiskConfig(agentId);
  if (risk && !reduceOnly) {
    if (sizeUsd > risk.maxPositionUsd) {
      return { error: `sizeUsd ${sizeUsd} exceeds configured maxPositionUsd ${risk.maxPositionUsd}` };
    }
    const dailyPnl = await getDailyRealizedPnl(agentId);
    if (dailyPnl <= -risk.maxDailyLossUsd) {
      return { error: `Daily loss limit reached (${dailyPnl.toFixed(2)} <= -${risk.maxDailyLossUsd})` };
    }
  }

  const leverage = params.leverage ?? risk?.leverage;
  const stopLossPct = params.stopLossPct ?? (reduceOnly ? undefined : risk?.defaultStopLossPct);
  const takeProfitPct = params.takeProfitPct ?? (reduceOnly ? undefined : risk?.defaultTakeProfitPct);

  // privateKey/network travel in the task payload — this agent's own
  // decrypted-for-this-request key, never a shared worker secret (see
  // resolveAgentWallet). GatewayAgent's hyperliquid executor passes them
  // straight through as env vars to the signing subprocess and never
  // persists them (scripts/executors/hyperliquid.mjs).
  const taskId = await enqueueTask({
    orgId,
    taskType: "hyperliquid",
    payload: {
      agentId, coin, isBuy, sizeUsd, orderType, privateKey, network,
      ...(limitPrice ? { limitPrice } : {}),
      ...(reduceOnly ? { reduceOnly } : {}),
      ...(leverage ? { leverage } : {}),
      ...(stopLossPct ? { stopLossPct } : {}),
      ...(takeProfitPct ? { takeProfitPct } : {}),
    },
    priority: "normal",
    resources: { requiredTags: ["hyperliquid"] },
    timeoutMs: 30000,
    maxRetries: reduceOnly ? 0 : 2,
  });

  return { taskId };
}

/**
 * Where orders get signed. "native" (default): right here, in this request,
 * via ./exchange.ts. "worker": the old path — enqueued for a GatewayAgent
 * worker running place_order.py — kept as an escape hatch.
 */
function executionMode(): "native" | "worker" {
  return process.env.HYPERLIQUID_EXECUTION === "worker" ? "worker" : "native";
}

/**
 * Signs and sends the order now, then records it as an already-completed
 * gateway task in the same result shape the worker produced
 * ({ data: { coin, isBuy, sizeUsd, fill, stdout } }), so GET /status,
 * POST /settle-trade and the client's order log work unchanged. The key is
 * never written anywhere.
 */
async function placeNatively(p: {
  orgId: string; agentId: string; coin: string; isBuy: boolean; sizeUsd: number; privateKey: string; network: HlNetwork;
  orderType: "market" | "limit"; limitPrice?: number; reduceOnly: boolean; leverage?: number; stopLossPct?: number; takeProfitPct?: number;
}): Promise<{ taskId: string } | { error: string }> {
  const { orgId, agentId, coin, isBuy, sizeUsd, orderType, limitPrice, reduceOnly, leverage, stopLossPct, takeProfitPct, network } = p;
  const started = Date.now();
  let fill: PlaceOrderResult;
  try {
    fill = await placeHlOrder(p);
  } catch (err) {
    return { error: (err as Error).message };
  }

  // The order is live from here on: never report it as failed, or a caller
  // (a strategy left pending, a retried signal) could place it twice.
  const taskId = newTaskId();
  try {
    await recordCompletedTask(taskId, {
      orgId,
      taskType: "hyperliquid",
      payload: {
        agentId, coin, isBuy, sizeUsd, orderType, network, execution: "native",
        ...(limitPrice ? { limitPrice } : {}),
        ...(reduceOnly ? { reduceOnly } : {}),
        ...(leverage ? { leverage } : {}),
        ...(stopLossPct ? { stopLossPct } : {}),
        ...(takeProfitPct ? { takeProfitPct } : {}),
      },
      result: {
        data: { agentId, coin, isBuy, sizeUsd, fill, stdout: JSON.stringify(fill), stderr: "" },
        artifacts: [],
        executionTimeMs: Date.now() - started,
        exitCode: 0,
      },
      priority: "normal",
      resources: { requiredTags: ["hyperliquid"] },
      timeoutMs: 30000,
      maxRetries: 0,
    });
  } catch (err) {
    console.error(`[hyperliquid] order ${taskId} for agent ${agentId} filled but its record failed to save:`, err, fill);
  }
  return { taskId };
}

// ── Paper trading ────────────────────────────────────────────────────────────

/** Paper fills always use mainnet's book and prices — testnet's are too thin to preview anything real. */
const PAPER_NETWORK: HlNetwork = "mainnet";
/** Widest trailing stop a paper order accepts, in percent. */
const MAX_TRAILING_STOP_PCT = 50;

interface PaperMarket {
  mids: Record<string, number>;
  meta: Record<string, CoinMeta>;
}

async function getPaperMarket(): Promise<PaperMarket> {
  const [mids, universe] = await Promise.all([
    hlInfo<Record<string, string>>({ type: "allMids" }, PAPER_NETWORK),
    getPerpUniverse(PAPER_NETWORK),
  ]);
  return {
    mids: Object.fromEntries(Object.entries(mids).map(([c, px]) => [c, Number(px)])),
    meta: Object.fromEntries(universe.map((u) => [u.name, { szDecimals: u.szDecimals, maxLeverage: u.maxLeverage ?? 50 }])),
  };
}

/** The paper account marked to the current mainnet mids. */
async function getPaperSummary(agentId: string, orgId: string) {
  const [account, positions, market] = await Promise.all([getPaperAccount(agentId, orgId), listPaperPositions(agentId), getPaperMarket()]);
  return { account, ...summarize(account.balance, positions, market.mids, market.meta) };
}

interface PaperOrderParams {
  orgId: string;
  agentId: string;
  coin: string;
  isBuy: boolean;
  sizeUsd?: number;
  /** Exact size in coins — closes use it so nothing is left behind as the price moves. */
  sz?: number;
  orderType?: "market" | "limit";
  limitPrice?: number;
  leverage?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  trailingStopPct?: number;
  reduceOnly?: boolean;
  strategyId?: string | null;
}

interface PaperOrderOutcome {
  /** The paper trade id (or the resting order's, if nothing filled yet) — named like a live order's taskId so bot logs treat both alike. */
  taskId: string;
  paper: true;
  filled: { sz: number; avgPx: number; fee: number; realizedPnl: number } | null;
  resting: { orderId: string; sz: number; limitPx: number } | null;
  balance: number | null;
}

/**
 * The paper twin of placing a live order. Same rules as live: risk limits,
 * size from the mid at the coin's szDecimals, the $10 minimum, market orders
 * capped at MARKET_SLIPPAGE from mid. It fills against the real mainnet book
 * at the taker fee, and the unfilled rest of a limit order rests until the tick fills it.
 */
async function placePaperOrder(p: PaperOrderParams): Promise<PaperOrderOutcome | { error: string }> {
  const orderType = p.orderType ?? "market";
  const reduceOnly = p.reduceOnly ?? false;

  const risk = await getRiskConfig(p.agentId);
  if (risk && !reduceOnly) {
    if ((p.sizeUsd ?? 0) > risk.maxPositionUsd) {
      return { error: `sizeUsd ${p.sizeUsd} exceeds configured maxPositionUsd ${risk.maxPositionUsd}` };
    }
    const account = await getPaperAccount(p.agentId, p.orgId);
    if (account.dailyPnl <= -risk.maxDailyLossUsd) {
      return { error: `Daily loss limit reached on paper (${account.dailyPnl.toFixed(2)} <= -${risk.maxDailyLossUsd})` };
    }
  }

  let market: PaperMarket;
  let book: { levels?: { px: string; sz: string }[][] };
  try {
    [market, book] = await Promise.all([getPaperMarket(), hlInfo<typeof book>({ type: "l2Book", coin: p.coin }, PAPER_NETWORK)]);
  } catch (err) {
    return { error: `Couldn't read the ${p.coin} market: ${(err as Error).message}` };
  }
  const mid = market.mids[p.coin];
  const meta = market.meta[p.coin];
  if (!mid || !meta) return { error: `Unknown coin ${p.coin}` };

  const sz = roundSize(p.sz ?? (p.sizeUsd ?? 0) / mid, meta.szDecimals);
  if (sz <= 0) return { error: `$${p.sizeUsd} is below the smallest ${p.coin} order size (${10 ** -meta.szDecimals} ${p.coin})` };
  let limitPx: number;
  if (orderType === "market") {
    limitPx = p.isBuy ? mid * (1 + MARKET_SLIPPAGE) : mid * (1 - MARKET_SLIPPAGE);
  } else {
    if (!p.limitPrice) return { error: "limitPrice is required for limit orders" };
    limitPx = p.limitPrice;
  }
  if (!reduceOnly && sz * limitPx < MIN_ORDER_USD) {
    return { error: `Order value $${(sz * limitPx).toFixed(2)} is below Hyperliquid's $${MIN_ORDER_USD} minimum` };
  }

  const leverage = p.leverage ?? risk?.leverage ?? 1;
  const stopLossPct = p.stopLossPct ?? (reduceOnly ? undefined : risk?.defaultStopLossPct);
  const takeProfitPct = p.takeProfitPct ?? (reduceOnly ? undefined : risk?.defaultTakeProfitPct);
  const trailingStopPct = reduceOnly ? undefined : p.trailingStopPct;
  const side = (p.isBuy ? book.levels?.[1] : book.levels?.[0]) ?? [];
  const walk = walkBook(side.map((l) => ({ px: Number(l.px), sz: Number(l.sz) })), sz, p.isBuy, limitPx, meta.szDecimals);

  let filled: PaperOrderOutcome["filled"] = null;
  let balance: number | null = null;
  let tradeId: string | null = null;
  if (walk.sz > 0) {
    const booked = await bookPaperFill(
      p.agentId,
      { coin: p.coin, isBuy: p.isBuy, sz: walk.sz, px: walk.avgPx, feeRate: TAKER_FEE_RATE, leverage, reduceOnly, stopLossPct, takeProfitPct, trailingStopPct },
      market.mids, market.meta,
      { orgId: p.orgId, reason: p.strategyId ? "strategy" : "manual", strategyId: p.strategyId ?? null },
    );
    if ("error" in booked) return booked;
    filled = { sz: booked.sz, avgPx: walk.avgPx, fee: booked.fee, realizedPnl: booked.realized };
    balance = booked.balance;
    tradeId = booked.tradeId;
  }

  let resting: PaperOrderOutcome["resting"] = null;
  const rest = roundSize(sz - walk.sz, meta.szDecimals);
  if (orderType === "limit" && rest > 0) {
    const orderId = await createPaperOrder({
      agentId: p.agentId, orgId: p.orgId, coin: p.coin, isBuy: p.isBuy, sz: rest, limitPx, leverage, reduceOnly,
      stopLossPct: stopLossPct ?? null, takeProfitPct: takeProfitPct ?? null, trailingStopPct: trailingStopPct ?? null, strategyId: p.strategyId ?? null,
    });
    resting = { orderId, sz: rest, limitPx };
  }
  if (!filled && !resting) {
    return { error: `Nothing filled — no ${p.coin} liquidity within ${MARKET_SLIPPAGE * 100}% of the mid` };
  }
  return { taskId: (tradeId ?? resting?.orderId)!, paper: true, filled, resting, balance };
}

/**
 * Hub tick phase for paper accounts, on mainnet prices: fills resting limits
 * the mid has traded through (at their limit, maker fee), moves trailing stops
 * up behind the mark, fires stop losses and take profits at the mark, charges hourly funding, and liquidates any account
 * whose equity drops under its maintenance margin.
 */
export async function runHyperliquidPaperTick(): Promise<{ filled: number; trailed: number; triggered: number; funded: number; liquidated: number; errors: number }> {
  const result = { filled: 0, trailed: 0, triggered: 0, funded: 0, liquidated: 0, errors: 0 };
  const [orders, positions] = await Promise.all([listAllPaperOrders(), listAllPaperPositions()]);
  if (!orders.length && !positions.length) return result;

  type Ctx = { funding: string; oraclePx: string; markPx: string; midPx?: string | null };
  const [meta, ctxs] = await hlInfo<[{ universe: { name: string; szDecimals: number; maxLeverage: number }[] }, Ctx[]]>(
    { type: "metaAndAssetCtxs" }, PAPER_NETWORK,
  );
  const coinMeta: Record<string, CoinMeta> = {};
  const mids: Record<string, number> = {};
  const marks: Record<string, number> = {};
  const funding: Record<string, { rate: number; oraclePx: number }> = {};
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    if (!c) return;
    coinMeta[u.name] = { szDecimals: u.szDecimals, maxLeverage: u.maxLeverage };
    marks[u.name] = Number(c.markPx);
    mids[u.name] = Number(c.midPx) || Number(c.markPx);
    funding[u.name] = { rate: Number(c.funding), oraclePx: Number(c.oraclePx) };
  });

  for (const o of orders) {
    const mid = mids[o.coin];
    if (!mid || !restingFillable(o.isBuy, o.limitPx, mid)) continue;
    try {
      const booked = await bookPaperFill(
        o.agentId,
        {
          coin: o.coin, isBuy: o.isBuy, sz: o.sz, px: o.limitPx, feeRate: MAKER_FEE_RATE, leverage: o.leverage, reduceOnly: o.reduceOnly,
          stopLossPct: o.stopLossPct ?? undefined, takeProfitPct: o.takeProfitPct ?? undefined, trailingStopPct: o.trailingStopPct ?? undefined,
        },
        mids, coinMeta,
        { orgId: o.orgId, reason: "limit", strategyId: o.strategyId, restingOrderId: o.id },
      );
      if (!("error" in booked)) {
        result.filled++;
      } else if (booked.error !== "Order is no longer open") {
        // Can't be filled any more (margin gone, position already closed) — cancel rather than retry every tick.
        await deletePaperOrder(o.id);
        console.warn(`[hyperliquid-paper] cancelled order ${o.id}: ${booked.error}`);
      }
    } catch (err) {
      result.errors++;
      console.error(`[hyperliquid-paper] order ${o.id} failed:`, err);
    }
  }

  const now = Date.now();
  const afterFills = result.filled ? await listAllPaperPositions() : positions;
  for (const held of afterFills) {
    const mark = marks[held.coin];
    if (!mark) continue;
    let p = held;
    try {
      const trailed = ratchetTrail(p, mark);
      if (trailed != null) {
        await updatePaperTrailingStop(p.agentId, p.coin, trailed);
        p = { ...p, slPx: trailed };
        result.trailed++;
      }
      const hit = triggerHit(p, mark);
      if (hit) {
        const booked = await bookPaperFill(
          p.agentId,
          { coin: p.coin, isBuy: p.szi < 0, sz: Math.abs(p.szi), px: mark, feeRate: TAKER_FEE_RATE, leverage: p.leverage, reduceOnly: true },
          marks, coinMeta, { orgId: p.orgId, reason: hit },
        );
        if (!("error" in booked)) result.triggered++;
        continue;
      }
      const since = p.lastFundingAt?.getTime() ?? now;
      const hours = Math.floor((now - since) / 3_600_000);
      const f = funding[p.coin];
      if (hours >= 1 && f) {
        // Capped at a day, so a tick outage can't land one huge payment.
        const amount = fundingPayment(p.szi, f.oraclePx || mark, f.rate) * Math.min(hours, 24);
        await applyPaperFunding(p.agentId, p.coin, amount, new Date(since + hours * 3_600_000));
        result.funded++;
      }
    } catch (err) {
      result.errors++;
      console.error(`[hyperliquid-paper] position ${p.id} failed:`, err);
    }
  }

  const byAgent = new Map<string, PaperPositionDoc[]>();
  for (const p of result.triggered ? await listAllPaperPositions() : afterFills) {
    byAgent.set(p.agentId, [...(byAgent.get(p.agentId) ?? []), p]);
  }
  for (const [agentId, held] of byAgent) {
    try {
      const account = await getPaperAccount(agentId, held[0].orgId);
      if (!isLiquidatable(summarize(account.balance, held, marks, coinMeta))) continue;
      for (const p of held) {
        await bookPaperFill(
          agentId,
          { coin: p.coin, isBuy: p.szi < 0, sz: Math.abs(p.szi), px: marks[p.coin] || p.entryPx, feeRate: TAKER_FEE_RATE, leverage: p.leverage, reduceOnly: true },
          marks, coinMeta, { orgId: p.orgId, reason: "liquidation" },
        );
      }
      result.liquidated++;
    } catch (err) {
      result.errors++;
      console.error(`[hyperliquid-paper] liquidation check for ${agentId} failed:`, err);
    }
  }
  return result;
}

type Signer = { privateKey: string; network: HlNetwork };

/** One bot order: filled on the paper account for a paper bot, otherwise signed with `signer` and sent. */
async function sendStrategyOrder(
  strategy: Strategy,
  signer: Signer | null,
  order: { coin: string; isBuy: boolean; sizeUsd: number; leverage?: number; reduceOnly?: boolean; sz?: number },
): Promise<{ taskId: string } | { error: string }> {
  if (strategy.paper) {
    return placePaperOrder({ orgId: strategy.orgId, agentId: strategy.agentId, strategyId: strategy.id, ...order });
  }
  if (!signer) return { error: "No signing key for a live order" };
  const { coin, isBuy, sizeUsd, leverage, reduceOnly } = order;
  return enforceRiskAndEnqueue({ orgId: strategy.orgId, agentId: strategy.agentId, coin, isBuy, sizeUsd, leverage, reduceOnly, ...signer });
}

/** Where a bot's market data comes from: mainnet for a paper bot, else its agent's trading network (null: no wallet yet). */
async function strategyNetwork(strategy: Strategy): Promise<HlNetwork | null> {
  if (strategy.paper) return PAPER_NETWORK;
  return (await getTradingWallet(strategy.agentId))?.network ?? null;
}

type AccessDenied = { error: string; status: number };

/**
 * Authorizes a request against a specific orgId. Every route below used to
 * trust `body.orgId` outright whenever there was no verified agent signature
 * — any signed-in operator could act on an org they have no
 * relationship to (set/delete another org's trading wallet, place trades,
 * loosen risk limits, plant strategies, hijack referral rewards). This
 * mirrors `solana-settlement`'s `ctx.session.role` check and
 * `/api/v1/lending`'s `requireOrgMember`, adapted for mod routes (a
 * `ModSession` only carries a wallet address, not a `NextRequest` to re-read
 * the `x-wallet-address` header from).
 */
async function requireOrgAccess(ctx: RouteContext, orgId: string): Promise<AccessDenied | null> {
  if (ctx.agent) {
    return ctx.agent.orgId === orgId ? null : { error: "Agent signature does not match orgId", status: 403 };
  }
  if (!ctx.session) return { error: "Authentication required", status: 401 };
  const result = await requireOrgMembershipByAddress(ctx.session.address, orgId);
  return result.ok ? null : { error: result.error ?? "Forbidden", status: result.status ?? 403 };
}

/**
 * Same check as `requireOrgAccess`, but for routes keyed only by `:agentId`
 * with no orgId in the request — resolves the agent's real org from its own
 * record (never trusting a client-supplied orgId) and checks access against
 * that. Returns the resolved orgId so callers don't need a second lookup.
 */
async function requireAgentOrgAccess(ctx: RouteContext, agentId: string): Promise<{ orgId: string } | AccessDenied> {
  if (ctx.agent) {
    if (ctx.agent.agentId !== agentId) return { error: "Agent signature does not match agentId", status: 403 };
    return { orgId: ctx.agent.orgId };
  }
  const agent = await getAgent(agentId);
  if (!agent) return { error: "Agent not found", status: 404 };
  const denied = await requireOrgAccess(ctx, agent.orgId);
  if (denied) return denied;
  return { orgId: agent.orgId };
}

type RouteError = { status: number; body: { error: string } };

/**
 * Shared by POST /strategy/:id/signal (authenticated) and the public POST
 * /webhook/:id (token-gated) — both just need to validate the strategy is a
 * "signal" type, decrypt the wallet with the caller-supplied masterSecret,
 * and enqueue the trade. Keeping this in one place means the webhook route
 * can never drift from the same risk/wallet checks the in-app route gets.
 */
async function fireSignalStrategy(
  strategy: Strategy,
  body: { masterSecret?: string; isBuy?: boolean },
): Promise<{ taskId: string } | RouteError> {
  if (strategy.type !== "signal") {
    return { status: 400, body: { error: "Only signal strategies can be fired this way" } };
  }
  let signer: Signer | null = null;
  if (!strategy.paper) {
    try {
      signer = await resolveSigningKey(strategy.agentId, body.masterSecret);
    } catch (err) {
      return { status: 400, body: { error: (err as Error).message } };
    }
  }

  const signalParams = strategy.params as { direction?: "buy" | "sell" };
  const isBuy = body.isBuy ?? (signalParams.direction ? signalParams.direction === "buy" : true);

  const result = await sendStrategyOrder(strategy, signer, { coin: strategy.coin, isBuy, sizeUsd: strategy.sizeUsd });
  if ("error" in result) return { status: 400, body: result };
  await touchStrategyRun(strategy.id);
  return result;
}

/**
 * Places the trade a dca/grid/sniper strategy was flagged for, then clears
 * (or, for a one-shot sniper, disarms) it. Shared by POST
 * /strategy/:id/execute-pending (the agent showing up with its passphrase)
 * and the tick itself, which calls it straight away for an agent on instant
 * trading. Uses the price level/context captured at trigger time
 * (strategy.pendingContext), not a fresh read.
 */
async function executePendingStrategy(strategy: Strategy, masterSecret?: string): Promise<{ taskId: string } | RouteError> {
  // Same gate as POST /trade — uninstalling the mod (or turning off this
  // capability) must stop a daemon that still holds the passphrase, and the
  // tick on an instant-trading agent. Checked before anything clears
  // pendingSignal, so the signal stays set.
  try {
    await enforceCapability(strategy.agentId, strategy.orgId, "hyperliquid-trade");
  } catch (err) {
    return { status: 403, body: { error: (err as Error).message } };
  }
  if (!strategy.pendingSignal) {
    return { status: 400, body: { error: "Strategy has no pending signal" } };
  }

  let signer: Signer | null = null;
  if (!strategy.paper) {
    try {
      signer = await resolveSigningKey(strategy.agentId, masterSecret);
    } catch (err) {
      return { status: 400, body: { error: (err as Error).message } };
    }
  }

  if (strategy.type === "ai") {
    // The action the model chose when the tick flagged this (no fresh model call).
    const ctx = (strategy.pendingContext ?? {}) as { action?: AiAction; isLong?: boolean; notionalUsd?: number };
    if (!ctx.action) return { status: 400, body: { error: "Pending AI decision has no action" } };
    const pos = ctx.isLong != null && ctx.notionalUsd ? { isLong: ctx.isLong, notionalUsd: ctx.notionalUsd } : null;
    const placed = await placeAiAction(strategy, ctx.action, pos, signer);
    if (placed && "error" in placed) return { status: 400, body: placed };
    await clearStrategyPending(strategy.id, placed?.params);
    if (!placed) return { status: 400, body: { error: "Nothing to do — the position has already changed" } };
    return { taskId: placed.taskId };
  }

  // A "new-listing ANY" sniper doesn't know its target coin until the
  // tick evaluator catches one — that's what pendingContext.detectedCoin
  // is for. Every other strategy type just trades its own `coin`.
  const detectedCoin = (strategy.pendingContext as { detectedCoin?: string } | null)?.detectedCoin;
  const coin = strategy.type === "sniper" && detectedCoin ? detectedCoin : strategy.coin;

  const result = await sendStrategyOrder(strategy, signer, { coin, isBuy: true, sizeUsd: strategy.sizeUsd });
  if ("error" in result) return { status: 400, body: result };

  if (strategy.type === "grid") {
    const params_ = strategy.params as GridParams;
    const level = (strategy.pendingContext as { level?: number } | null)?.level;
    const visited = params_.visitedLevels ?? [];
    await clearStrategyPending(strategy.id, level != null ? { ...params_, visitedLevels: [...visited, level] } : undefined);
  } else if (strategy.type === "sniper") {
    // One-shot: a sniper disarms after firing rather than re-arming for
    // the next listing/price break, same UX as UniDexBot's sniper.
    await clearStrategyPending(strategy.id);
    await toggleStrategy(strategy.id, false);
  } else {
    await clearStrategyPending(strategy.id);
  }
  return result;
}

// ── AI Trader ────────────────────────────────────────────────────────────────

const AI_MIN_INTERVAL_MS = 15 * 60_000;
/** Paper training can decide every minute. Live bots stay at 15. */
const PAPER_MIN_INTERVAL_MS = 60_000;
/**
 * A one-minute paper round still leaves the daemon this long to answer.
 * Shorter than that and a slow model gets the round skipped.
 */
const PAPER_ANSWER_FLOOR_MS = 3 * 60_000;
/** How long the agent has to answer one live round before it's skipped. */
const AI_ANSWER_WINDOW_MS = 10 * 60_000;
/** A backtest waits on the agent one bar at a time; each question lives this long. */
const AI_BACKTEST_ANSWER_MS = 3 * 60_000;
/** A flip whose close hasn't filled within this long is abandoned. */
const FLIP_GIVE_UP_MS = 10 * 60_000;
const AI_SNAPSHOT_HISTORY = 112; // 72 shown + warm-up for SMA40/RSI
const TRAIN_DEFAULT_SIZE_USD = 25;
const TRAIN_DEFAULT_INTERVAL_MS = PAPER_MIN_INTERVAL_MS;
const TRAIN_DEFAULT_DRAWDOWN_PCT = 10;
const TRAIN_MAX_SIZE_USD = 100_000;

/** Shared by POST /strategy (type ai) and POST /paper/train. */
function buildAiParams(params: Record<string, unknown> | undefined, minIntervalMs = AI_MIN_INTERVAL_MS): AiParams | { error: string } {
  const intervalMs = Number(params?.intervalMs ?? 3_600_000);
  const maxDrawdownPct = Number(params?.maxDrawdownPct ?? 50);
  const leverage = params?.leverage != null && params.leverage !== "" ? Number(params.leverage) : undefined;
  if (!(intervalMs >= minIntervalMs)) {
    const minutes = minIntervalMs / 60_000;
    return { error: `params.intervalMs must be at least ${minutes} minute${minutes === 1 ? "" : "s"} for an ai strategy` };
  }
  if (!(maxDrawdownPct > 0 && maxDrawdownPct < 100)) {
    return { error: "params.maxDrawdownPct must be between 0 and 100" };
  }
  const goal = normalizeGoal(params?.goal);
  if (goal.error) return { error: goal.error };
  return {
    intervalMs,
    maxDrawdownPct,
    ...(leverage ? { leverage } : {}),
    ...(goal.goal ? { goal: goal.goal } : {}),
    flipTo: null,
    openRequestId: null,
  };
}

function cleanTrainCoin(raw: unknown): string | null {
  const coin = String(raw ?? "").trim().toUpperCase();
  if (coin === "ANY" || !/^[A-Z0-9]{1,12}$/.test(coin)) return null;
  return coin;
}

/** How long this round's question stays open. Paper floors it so a 1-minute cadence can still be answered. */
function aiAnswerWindow(paper: boolean, intervalMs: number): number {
  if (!paper) return Math.min(AI_ANSWER_WINDOW_MS, intervalMs);
  return Math.min(AI_ANSWER_WINDOW_MS, Math.max(intervalMs, PAPER_ANSWER_FLOOR_MS));
}

/** The largest chart interval no longer than the bot's decision interval. */
function candleIntervalFor(intervalMs: number): string {
  const fits = Object.entries(CANDLE_INTERVAL_MS).filter(([, ms]) => ms <= intervalMs);
  return fits.length ? fits[fits.length - 1][0] : "1m";
}

async function fetchCandles(coin: string, interval: string, bars: number, network: HlNetwork, endTime = Date.now()): Promise<Candle[]> {
  const ms = CANDLE_INTERVAL_MS[interval];
  const raw = await hlInfo<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>(
    { type: "candleSnapshot", req: { coin, interval, startTime: endTime - ms * bars, endTime } },
    network,
  );
  return raw.map((k) => ({ t: k.t, o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c), v: Number(k.v) }));
}

/** Perps account value plus free spot USDC (unified accounts park idle margin on spot). */
async function accountEquity(wallet: string, network: HlNetwork) {
  const [state, spot] = await Promise.all([
    hlInfo<ClearinghouseState>({ type: "clearinghouseState", user: wallet }, network),
    hlInfo<{ balances?: { coin: string; total: string; hold: string }[] }>(
      { type: "spotClearinghouseState", user: wallet }, network,
    ).catch(() => ({ balances: [] })),
  ]);
  const usdc = spot.balances?.find((b) => b.coin === "USDC");
  const spotUsdc = usdc ? Math.max(0, Number(usdc.total) - Number(usdc.hold)) : 0;
  const perpsValue = Number(state.marginSummary.accountValue);
  return { state, perpsValue, spotUsdc, accountValue: perpsValue + spotUsdc };
}

function positionFor(state: ClearinghouseState, coin: string): { position: AiPosition; notionalUsd: number } | null {
  const p = state.assetPositions.find((a) => a.position.coin === coin);
  const size = p ? Number(p.position.szi) : 0;
  if (!p || size === 0) return null;
  return {
    position: { isLong: size > 0, size, entryPx: Number(p.position.entryPx), unrealizedPnl: Number(p.position.unrealizedPnl) },
    notionalUsd: Math.abs(Number(p.position.positionValue)),
  };
}

/** A bot's open position as the order paths need it; size (signed, in coins) lets a paper close take exactly all of it. */
type AiHeld = { isLong: boolean; notionalUsd: number; size?: number };

function heldFor(held: { position: AiPosition; notionalUsd: number } | null): AiHeld | null {
  return held ? { isLong: held.position.isLong, notionalUsd: held.notionalUsd, size: held.position.size } : null;
}

/** Equity and this bot's position — from the paper account for a paper bot, else read off Hyperliquid for its wallet. */
async function aiAccountState(strategy: Strategy): Promise<
  { accountValue: number; held: { position: AiPosition; notionalUsd: number } | null; network: HlNetwork } | { error: string }
> {
  if (strategy.paper) {
    const summary = await getPaperSummary(strategy.agentId, strategy.orgId);
    const p = summary.positions.find((x) => x.coin === strategy.coin);
    return {
      accountValue: summary.equity,
      network: PAPER_NETWORK,
      held: p ? { position: { isLong: p.szi > 0, size: p.szi, entryPx: p.entryPx, unrealizedPnl: p.unrealizedPnl }, notionalUsd: p.notionalUsd } : null,
    };
  }
  const wallet = await getTradingWallet(strategy.agentId);
  if (!wallet?.address) return { error: "This agent has no trading wallet yet." };
  const { state, accountValue } = await accountEquity(wallet.address, wallet.network);
  return { accountValue, network: wallet.network, held: positionFor(state, strategy.coin) };
}

/**
 * Sends the order(s) for one AI action. Opens are a fixed sizeUsd; a close
 * is reduce-only for the whole position. A flip only sends its close here and
 * records flipTo — the tick opens the new side once the close has filled,
 * so the two orders can never race each other on the worker.
 * Returns null when the action no longer applies (e.g. nothing to close).
 */
async function placeAiAction(
  strategy: Strategy,
  action: AiAction,
  pos: AiHeld | null,
  signer: Signer | null,
): Promise<{ taskId: string; params?: AiParams } | { error: string } | null> {
  const params = strategy.params as AiParams;
  const coin = strategy.coin;
  const open = (isBuy: boolean) => sendStrategyOrder(strategy, signer, { coin, isBuy, sizeUsd: strategy.sizeUsd, leverage: params.leverage });
  if (action === "open-long" || action === "open-short") {
    return open(action === "open-long");
  }
  if (action === "close" || action === "flip-long" || action === "flip-short") {
    if (!pos) return null;
    const closed = await sendStrategyOrder(strategy, signer, {
      coin, isBuy: !pos.isLong, sizeUsd: pos.notionalUsd, reduceOnly: true, ...(pos.size ? { sz: Math.abs(pos.size) } : {}),
    });
    if ("error" in closed || action === "close") return closed;
    // A paper close has already filled, so a paper flip opens the new side right away.
    if (strategy.paper) return open(action === "flip-long");
    const flipped: AiParams = { ...params, flipTo: action === "flip-long" ? "long" : "short" };
    await touchStrategyRun(strategy.id, flipped);
    return { ...closed, params: flipped };
  }
  return null;
}

/** Signs and sends now for an instant-trading agent; otherwise leaves it pending for the agent's passphrase. */
async function executeOrQueueAiAction(
  strategy: Strategy,
  action: AiAction,
  pos: AiHeld | null,
): Promise<{ taskId: string | null; error: string | null }> {
  try {
    await enforceCapability(strategy.agentId, strategy.orgId, "hyperliquid-trade");
  } catch (err) {
    return { taskId: null, error: (err as Error).message };
  }
  let signer: Signer | null = null;
  if (!strategy.paper) {
    if (!(await getInstantTrading(strategy.agentId))) {
      await markStrategyPending(strategy.id, { action, isLong: pos?.isLong ?? null, notionalUsd: pos?.notionalUsd ?? null });
      return { taskId: null, error: "Waiting for the wallet passphrase to execute" };
    }
    signer = await resolveSigningKey(strategy.agentId);
  }
  const placed = await placeAiAction(strategy, action, pos, signer);
  if (!placed) return { taskId: null, error: null };
  if ("error" in placed) return { taskId: null, error: placed.error };
  return { taskId: placed.taskId, error: null };
}

type AiRecord = Partial<Parameters<typeof recordAiDecision>[1]>;
function recordFor(strategyId: string) {
  return (d: AiRecord) => recordAiDecision(strategyId, {
    decision: null, action: "hold", reasoning: "", model: null, price: null, equity: null, taskId: null, error: null, ...d,
  });
}

/**
 * One AI Trader round for one bot. Never runs a model: it puts the round's
 * question to the agent as an AiRequest, and the agent's own daemon answers
 * through POST /ai/requests/:id/answer (applyAiAnswer). A round the agent
 * doesn't answer within AI_ANSWER_WINDOW_MS is skipped.
 */
async function runAiStrategy(strategy: Strategy): Promise<"asked" | "decided" | "skipped" | "error"> {
  const params = strategy.params as AiParams;
  const record = recordFor(strategy.id);

  // A round already out with the agent: wait, or skip it once it's expired.
  if (params.openRequestId) {
    const open = await getAiRequest(params.openRequestId);
    if (open?.status === "open" && open.expiresAt.getTime() > Date.now()) return "skipped";
    if (open?.status === "open") await expireAiRequest(open.id);
    await touchStrategyRun(strategy.id, { ...params, openRequestId: null });
    if (open?.status !== "answered") {
      await record({ error: "The agent didn't answer this round in time — is its daemon (agent-guild daemon) running?" });
      return "skipped";
    }
    return "skipped";
  }

  const acct = await aiAccountState(strategy);
  if ("error" in acct) {
    await touchStrategyRun(strategy.id);
    await record({ error: acct.error });
    return "error";
  }
  const { accountValue, held, network } = acct;

  // Second half of a flip: open the new side once the old one is gone.
  if (params.flipTo) {
    const wantLong = params.flipTo === "long";
    if (held && held.position.isLong === wantLong) {
      await touchStrategyRun(strategy.id, { ...params, flipTo: null });
      return "skipped";
    }
    if (held) {
      if (Date.now() - (strategy.lastRunAt?.getTime() ?? 0) > FLIP_GIVE_UP_MS) {
        await touchStrategyRun(strategy.id, { ...params, flipTo: null });
        await record({ error: "The flip's close never filled — gave up opening the new side." });
        return "error";
      }
      return "skipped"; // close still in flight
    }
    await touchStrategyRun(strategy.id, { ...params, flipTo: null });
    const action: AiAction = wantLong ? "open-long" : "open-short";
    const sent = await executeOrQueueAiAction({ ...strategy, params: { ...params, flipTo: null } }, action, null);
    await record({ action, reasoning: "Second half of the flip — opening the new side.", equity: accountValue, ...sent });
    return "decided";
  }

  // Claim the round so an overlapping tick can't ask twice.
  await touchStrategyRun(strategy.id);

  // Drawdown elimination — permanent, like a blown-up account.
  const startEquity = params.startEquity ?? (accountValue > 0 ? accountValue : undefined);
  if (startEquity != null && accountValue <= startEquity * (1 - params.maxDrawdownPct / 100)) {
    const sent = held
      ? await executeOrQueueAiAction(strategy, "close", heldFor(held))
      : { taskId: null, error: null };
    await touchStrategyRun(strategy.id, { ...params, startEquity, eliminated: true });
    await toggleStrategy(strategy.id, false);
    await record({
      action: held ? "close" : "hold",
      reasoning: `Eliminated: equity ${accountValue.toFixed(2)} is ${params.maxDrawdownPct}% or more below the starting ${startEquity.toFixed(2)}.`,
      equity: accountValue, ...sent,
    });
    return "decided";
  }
  if (accountValue < 10) {
    await record({
      error: strategy.paper
        ? `Paper account holds $${accountValue.toFixed(2)} — reset it to keep trading.`
        : `Wallet holds $${accountValue.toFixed(2)} — fund it with at least $10 on Hyperliquid ${network} to trade.`,
      equity: accountValue,
    });
    return "skipped";
  }

  const interval = candleIntervalFor(params.intervalMs);
  const [candles, book, market] = await Promise.all([
    fetchCandles(strategy.coin, interval, AI_SNAPSHOT_HISTORY, network),
    hlInfo<{ levels: { px: string }[][] }>({ type: "l2Book", coin: strategy.coin }, network).catch(() => null),
    getMarketOverview(network).catch(() => []),
  ]);
  if (candles.length < 20) {
    await record({ error: `Not enough ${strategy.coin} price history to decide.` });
    return "error";
  }
  const coinInfo = market.find((m) => m.coin === strategy.coin);
  const snapshot = buildSnapshot({
    coin: strategy.coin, candles, interval,
    bid: book?.levels?.[0]?.[0] ? Number(book.levels[0][0].px) : null,
    ask: book?.levels?.[1]?.[0] ? Number(book.levels[1][0].px) : null,
    fundingRatePct: coinInfo?.fundingRatePct ?? null,
    openInterestUsd: coinInfo?.openInterestUsd ?? null,
  });
  const requestId = await createAiRequest({
    agentId: strategy.agentId, orgId: strategy.orgId, purpose: "live", strategyId: strategy.id, coin: strategy.coin,
    ...decisionRequest(strategy.coin, snapshot, held?.position ?? null, params.goal),
    expiresAt: new Date(Date.now() + aiAnswerWindow(strategy.paper, params.intervalMs)),
  });
  await touchStrategyRun(strategy.id, { ...params, ...(startEquity != null ? { startEquity } : {}), openRequestId: requestId });
  return "asked";
}

/**
 * The agent answered a live round: trade it. The position is re-read now, not
 * taken from when the question was asked, so e.g. a CLOSE after the owner
 * already closed by hand does nothing.
 */
async function applyAiAnswer(req: AiRequest, decision: AiDecision, reasoning: string): Promise<{ action: AiAction; taskId: string | null; error: string | null }> {
  const strategy = req.strategyId ? await getStrategy(req.strategyId) : null;
  if (!strategy || strategy.type !== "ai") return { action: "hold", taskId: null, error: "Bot no longer exists" };
  const params = strategy.params as AiParams;
  const record = recordFor(strategy.id);
  if (params.openRequestId === req.id) await touchStrategyRun(strategy.id, { ...params, openRequestId: null });
  if (!strategy.enabled) {
    await record({ decision, action: "hold", reasoning, error: "Bot was stopped before the answer arrived — not traded." });
    return { action: "hold", taskId: null, error: "Bot is stopped" };
  }

  const acct = await aiAccountState(strategy);
  if ("error" in acct) {
    await record({ decision, reasoning, error: acct.error });
    return { action: "hold", taskId: null, error: "No trading wallet" };
  }
  const { accountValue, held, network } = acct;
  const action = decisionToAction(decision, held?.position ?? null);
  const sent = action === "hold"
    ? { taskId: null, error: null }
    : await executeOrQueueAiAction(strategy, action, heldFor(held));
  const price = await getMidPrice(strategy.coin, network).catch(() => null);
  await record({ decision, action, reasoning, model: "agent", price, equity: accountValue, ...sent });
  return { action, ...sent };
}

/**
 * Hub tick phase for AI Trader bots: puts a question to every bot whose
 * interval is up, retires rounds the agent didn't answer, and opens the
 * second side of any flip. Fast — no model runs here; the agents answer on
 * their own time.
 */
export async function runAiTraderTick(): Promise<{ due: number; asked: number; errors: number }> {
  const now = Date.now();
  const due = (await getEnabledStrategies())
    .filter((s) => s.type === "ai" && !s.pendingSignal)
    .filter((s) => {
      const p = s.params as AiParams;
      if (p.eliminated) return false;
      if (p.flipTo || p.openRequestId) return true;
      return now - (s.lastRunAt?.getTime() ?? 0) >= p.intervalMs;
    });

  const results = await Promise.allSettled(due.map(runAiStrategy));
  let asked = 0;
  let errors = 0;
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      errors++;
      console.error(`[hyperliquid-ai] ${due[i].id} failed:`, r.reason);
    } else if (r.value === "asked") asked++;
    else if (r.value === "error") errors++;
  });
  return { due: due.length, asked, errors };
}

/**
 * Evaluated once per Hub tick (see the mod's added phase in
 * `/api/internal/tick/route.ts`). DCA fires on a fixed interval; grid fires
 * when the mid price crosses a level it hasn't visited yet; sniper fires
 * on a new Hyperliquid listing or a price break, then auto-disarms. None of
 * them can place the trade itself — there's no passphrase available inside a
 * scheduled tick to decrypt the agent's wallet with (see the wallet note in
 * hyperliquid-store.ts) — so this only flips the strategy to `pendingSignal`.
 * The agent's own process is expected to poll GET /strategy/:agentId/pending
 * and call POST /strategy/:id/execute-pending with its passphrase to
 * actually fire it — except for an agent on instant trading, whose trade
 * the tick places itself right after flagging it.
 */
export async function runHyperliquidStrategyTick(): Promise<{ evaluated: number; markedPending: number; executed: number; errors: number }> {
  const strategies = await getEnabledStrategies();
  let markedPending = 0;
  let executed = 0;
  let errors = 0;

  for (const strategy of strategies) {
    if (strategy.pendingSignal) continue; // already waiting on the agent — don't re-trigger
    if (strategy.type === "ai") continue; // decided by runAiTraderTick
    try {
      if (strategy.type === "dca") {
        const params = strategy.params as DcaParams;
        const last = strategy.lastRunAt?.getTime() ?? 0;
        if (Date.now() - last < params.intervalMs) continue;

        await markStrategyPending(strategy.id, {});
        markedPending++;
      } else if (strategy.type === "grid") {
        const params = strategy.params as GridParams;
        const network = await strategyNetwork(strategy);
        if (!network) continue; // nothing to trade with yet — agent hasn't set a wallet
        const price = await getMidPrice(strategy.coin, network);
        if (price < params.lowerPrice || price > params.upperPrice) continue;

        const step = (params.upperPrice - params.lowerPrice) / params.levels;
        const level = Math.round((price - params.lowerPrice) / step);
        const visited = params.visitedLevels ?? [];
        if (visited.includes(level)) continue;

        await markStrategyPending(strategy.id, { level });
        markedPending++;
      } else if (strategy.type === "sniper") {
        const params = strategy.params as SniperParams;
        const network = await strategyNetwork(strategy);
        if (!network) continue; // nothing to trade with yet — agent hasn't set a wallet

        if (params.mode === "new-listing") {
          const known = await getKnownCoins(network);
          const current = await getUniverseCoins(network);
          if (known === null) {
            // First run for this network — seed the baseline instead of
            // treating Hyperliquid's entire existing universe as "new".
            await setKnownCoins(network, current);
            continue;
          }
          const newCoins = current.filter((c) => !known.includes(c));
          if (newCoins.length === 0) continue;
          await setKnownCoins(network, current);

          const target = strategy.coin === "ANY" ? newCoins[0] : (newCoins.includes(strategy.coin) ? strategy.coin : null);
          if (!target) continue;
          await markStrategyPending(strategy.id, { detectedCoin: target });
        } else {
          if (params.targetPrice == null) continue;
          const price = await getMidPrice(strategy.coin, network);
          const triggered = params.mode === "price-above" ? price >= params.targetPrice : price <= params.targetPrice;
          if (!triggered) continue;
          await markStrategyPending(strategy.id, { triggerPrice: price });
        }
        markedPending++;
      }
      // "signal" strategies never fire from the tick — only via POST /strategy/:id/signal or the public webhook.
      // Reaching here means a dca/grid/sniper strategy was just flagged (every
      // non-trigger path above `continue`s).
      // A paper bot needs no signer, so it always places its own trade.
      if (strategy.type !== "signal" && (strategy.paper || (await getInstantTrading(strategy.agentId)))) {
        const flagged = await getStrategy(strategy.id); // re-read for the pendingContext just written
        if (flagged) {
          const fired = await executePendingStrategy(flagged);
          if ("status" in fired) {
            // Left pending — the signal stays visible in the panel instead of vanishing.
            console.warn(`[hyperliquid-strategy] ${strategy.id} instant execution refused: ${fired.body.error}`);
          } else {
            executed++;
          }
        }
      }
    } catch (err) {
      console.error(`[hyperliquid-strategy] ${strategy.id} failed:`, err);
      errors++;
    }
  }

  return { evaluated: strategies.length, markedPending, executed, errors };
}

const TRADING_CAPABILITIES = [
  "hyperliquid-trade",
  "hyperliquid-close",
  "hyperliquid-configure-risk",
  "hyperliquid-run-strategy",
  "hyperliquid-webhook",
] as const;

const HL_REGISTRY_MOD_ID = "mod-hyperliquid-trading";

/**
 * The Market install only writes inventory. Capabilities live on a separate
 * install doc, so an installed mod can still fail enforceCapability until the
 * owner grants them. A signed-in owner starting a bot or a paper session
 * turns the whole mod on. Anyone else gets the same error as before.
 */
async function ensureRunStrategy(ctx: RouteContext, agentId: string, orgId: string): Promise<string | null> {
  const granted = async () => {
    try {
      await enforceCapability(agentId, orgId, "hyperliquid-run-strategy");
      return true;
    } catch {
      return false;
    }
  };
  if (await granted()) return null;

  const session = ctx.session;
  if (!session || ctx.agent) {
    return `Agent ${agentId} does not have capability "hyperliquid-run-strategy". Install the required mod or assign the capability to this agent.`;
  }
  const membership = await requireOrgMembershipByAddress(session.address, orgId);
  const owner = membership.ok ? membership.org?.ownerAddress : null;
  if (!owner || canonicalizeWalletAddress(owner) !== canonicalizeWalletAddress(session.address)) {
    return "Hyperliquid is installed for this org, but trading is still off. The org owner has to start paper training once to turn it on.";
  }
  const out = await enableModCapabilities(orgId, HL_REGISTRY_MOD_ID, TRADING_CAPABILITIES);
  if (!out.installed) return "Install Hyperliquid Trading from the Market first.";
  if (await granted()) return null;
  return `Agent ${agentId} does not have capability "hyperliquid-run-strategy". Install the required mod or assign the capability to this agent.`;
}

interface AgentTool {
  name: string;
  description: string;
  method: "GET" | "POST";
  /** Relative to /api/mods/hyperliquid-trading/. `{x}` segments come from the input of the same name. */
  path: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

/**
 * The agent-facing surface of this mod, as tool definitions an LLM agent can
 * load directly (`input_schema` is the Anthropic tool shape; OpenAI takes it
 * as `parameters`). `method`/`path` tell the agent's runtime which route to
 * call. masterSecret is deliberately absent from every schema: the runtime
 * injects it from its own environment so the passphrase never passes
 * through the model's context. orgId/agentId are absent too — the agent's
 * signature or token supplies them.
 */
const AGENT_TOOLS: AgentTool[] = [
  {
    name: "hyperliquid_market",
    description: "Whole-market snapshot of every tradeable Hyperliquid perp: mark price, 24h change, 24h volume, open interest, funding rate, max leverage. Sorted by volume.",
    method: "GET",
    path: "market",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "hyperliquid_price",
    description: "Current mid price for one coin.",
    method: "GET",
    path: "price/{coin}",
    input_schema: { type: "object", properties: { coin: { type: "string", description: "Perp symbol, e.g. ETH, BTC, SOL" } }, required: ["coin"] },
  },
  {
    name: "hyperliquid_oracle",
    description: "Validator oracle price for one perp (the price funding and mark are anchored to; updates every ~3s). Read on-chain from the HyperEVM precompile by default.",
    method: "GET",
    path: "oracle/{coin}",
    input_schema: { type: "object", properties: { coin: { type: "string", description: "Perp symbol, e.g. ETH, BTC, SOL" } }, required: ["coin"] },
  },
  {
    name: "hyperliquid_account",
    description: "Account value and margin used for a Hyperliquid wallet address.",
    method: "GET",
    path: "account/{wallet}",
    input_schema: { type: "object", properties: { wallet: { type: "string", description: "0x address of the trading wallet" } }, required: ["wallet"] },
  },
  {
    name: "hyperliquid_positions",
    description: "Open positions (size, notional, entry price, unrealized PnL) for a Hyperliquid wallet address.",
    method: "GET",
    path: "positions/{wallet}",
    input_schema: { type: "object", properties: { wallet: { type: "string", description: "0x address of the trading wallet" } }, required: ["wallet"] },
  },
  {
    name: "hyperliquid_trade",
    description: "Place an order with this agent's own wallet. Rejected if it breaks the agent's risk limits (max position, daily loss). Returns a taskId; poll hyperliquid_trade_status for the fill.",
    method: "POST",
    path: "trade",
    input_schema: {
      type: "object",
      properties: {
        coin: { type: "string", description: "Perp symbol, e.g. ETH" },
        isBuy: { type: "boolean", description: "true = long/buy, false = short/sell" },
        sizeUsd: { type: "number", description: "Order size in USD notional" },
        orderType: { type: "string", enum: ["market", "limit"] },
        limitPrice: { type: "number", description: "Required when orderType is limit" },
        leverage: { type: "number" },
        stopLossPct: { type: "number", description: "Stop-loss distance from entry, in percent" },
        takeProfitPct: { type: "number", description: "Take-profit distance from entry, in percent" },
      },
      required: ["coin", "isBuy", "sizeUsd"],
    },
  },
  {
    name: "hyperliquid_close",
    description: "Close this agent's entire open position in one coin with a reduce-only market order.",
    method: "POST",
    path: "close",
    input_schema: {
      type: "object",
      properties: {
        coin: { type: "string" },
      },
      required: ["coin"],
    },
  },
  {
    name: "hyperliquid_trade_status",
    description: "Execution state of a trade task returned by hyperliquid_trade or hyperliquid_close.",
    method: "GET",
    path: "status/{taskId}",
    input_schema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  },
  {
    name: "hyperliquid_history",
    description: "This agent's settled trade log plus total PnL and win rate.",
    method: "GET",
    path: "history/{agentId}",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "hyperliquid_paper_account",
    description: "This agent's paper (virtual USDC) account: balance, equity, margin, open paper positions marked to mainnet prices, and resting paper limit orders. Paper trading moves no real money.",
    method: "GET",
    path: "paper/{agentId}",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "hyperliquid_paper_trade",
    description: "Place a paper order: filled against the real Hyperliquid mainnet order book with real fees, on this agent's virtual account — no wallet, no real money. Same risk limits as live. A limit order that doesn't fill right away rests until the price reaches it.",
    method: "POST",
    path: "paper/trade",
    input_schema: {
      type: "object",
      properties: {
        coin: { type: "string", description: "Perp symbol, e.g. ETH" },
        isBuy: { type: "boolean", description: "true = long/buy, false = short/sell" },
        sizeUsd: { type: "number", description: "Order size in USD notional" },
        orderType: { type: "string", enum: ["market", "limit"] },
        limitPrice: { type: "number", description: "Required when orderType is limit" },
        leverage: { type: "number" },
        stopLossPct: { type: "number", description: "Stop-loss distance from entry, in percent" },
        takeProfitPct: { type: "number", description: "Take-profit distance from entry, in percent" },
        trailingStopPct: { type: "number", description: "Trailing stop: the stop follows the best price by this percent and never loosens. Replaces stopLossPct. Paper only." },
      },
      required: ["coin", "isBuy", "sizeUsd"],
    },
  },
  {
    name: "hyperliquid_paper_close",
    description: "Close this agent's entire paper position in one coin at market.",
    method: "POST",
    path: "paper/close",
    input_schema: { type: "object", properties: { coin: { type: "string" } }, required: ["coin"] },
  },
  {
    name: "hyperliquid_paper_cancel",
    description: "Cancel one resting paper limit order.",
    method: "POST",
    path: "paper/orders/{id}/cancel",
    input_schema: { type: "object", properties: { id: { type: "string", description: "orderId from hyperliquid_paper_account" } }, required: ["id"] },
  },
  {
    name: "hyperliquid_paper_train",
    description: "Start paper training from an idea or goal the operator just gave you. Each round your own model decides LONG, SHORT, CLOSE, or NOTHING toward that goal, and the fill lands on the virtual account. No wallet and no real money. One running paper trainer per coin.",
    method: "POST",
    path: "paper/train",
    input_schema: {
      type: "object",
      properties: {
        coin: { type: "string", description: "Perp symbol, e.g. BTC" },
        goal: { type: "string", description: "The idea to practice, in plain language. 8–800 characters." },
        sizeUsd: { type: "number", description: "USD notional per order. Default 25. Minimum 10." },
        intervalMs: { type: "number", description: "How often to decide, in milliseconds. Default and minimum 1 minute. Live bots stay at 15 minutes." },
        maxDrawdownPct: { type: "number", description: "Stop for good if equity falls this percent from the start. Default 10." },
      },
      required: ["coin", "goal"],
    },
  },
  {
    name: "hyperliquid_ai_requests",
    description: "Questions waiting for you from your AI Trader bots and backtests: each has a system prompt and a market snapshot. Decide each one and answer with hyperliquid_ai_answer before it expires.",
    method: "GET",
    path: "ai/requests",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "hyperliquid_ai_answer",
    description: "Answer one AI Trader question. A paper bot's answer fills the virtual account. A live bot's answer is traded from your wallet, within your risk limits.",
    method: "POST",
    path: "ai/requests/{id}/answer",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The request id from hyperliquid_ai_requests" },
        decision: { type: "string", enum: ["LONG", "SHORT", "CLOSE", "NOTHING"] },
        reasoning: { type: "string", description: "A few sentences on why" },
      },
      required: ["id", "decision"],
    },
  },
];

/**
 * Trading runs as a GatewayAgent job (taskType "hyperliquid", see
 * GatewayAgent/scripts/executors/hyperliquid.mjs) rather than inline in the
 * Next.js server — placing an order needs the official Hyperliquid Python
 * SDK for request signing, which the executor runs in a Docker container,
 * the same pattern already used for taskType "comfyui". This mod just
 * enqueues the job and, once it completes, can commit the fill as a
 * receipt through the same settlement adapters the compute-job mods use.
 */
export default defineServerMod({
  setup(ctx) {
    ctx.log.info("hyperliquid-trading mod loaded");
  },

  routes: {
    /**
     * GET /agent/tools — the tool manifest above, for an agent runtime to
     * load at startup. Public: it describes routes, it grants nothing.
     */
    "GET /agent/tools": {
      public: true,
      handler: async () => Response.json({
        mod: "hyperliquid-trading",
        basePath: "/api/mods/hyperliquid-trading",
        auth: "Authorization: Bearer agt_… (mods:call scope), Ed25519 agent/sig/ts, or agentId/apiKey",
        injected: {
          masterSecret: "Added to every POST body by the runtime, from its own environment",
          agentId: "Filled into {agentId} path segments from GET /me",
        },
        tools: AGENT_TOOLS,
      }),
    },

    /**
     * GET /me — the "is my agent plugged in?" check. An agent calls it with
     * its own signature/token; a signed-in operator passes ?agentId=. Reports
     * which trading capabilities are granted, whether a wallet is set, the
     * risk limits, and how many strategy signals are waiting on the agent.
     */
    "GET /me": async (req, ctx) => {
      const agentId = ctx.agent?.agentId ?? new URL(req.url).searchParams.get("agentId");
      if (!agentId) return Response.json({ error: "agentId query param is required for a browser session" }, { status: 400 });
      const access = await requireAgentOrgAccess(ctx, agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });

      const [caps, wallet, risk, pending] = await Promise.all([
        getAgentCapabilities(agentId, access.orgId),
        getTradingWallet(agentId),
        getRiskConfig(agentId),
        getPendingStrategies(agentId),
      ]);
      const granted = new Set(caps.map((c) => c.key));
      const capabilities = Object.fromEntries(TRADING_CAPABILITIES.map((k) => [k, granted.has(k)]));

      return Response.json({
        agentId,
        orgId: access.orgId,
        via: ctx.agent ? "agent" : "session",
        capabilities,
        wallet: { configured: !!wallet, network: wallet?.network ?? null, instant: wallet?.instant ?? false },
        risk: risk ? {
          leverage: risk.leverage,
          maxPositionUsd: risk.maxPositionUsd,
          maxDailyLossUsd: risk.maxDailyLossUsd,
        } : null,
        pendingStrategies: pending.length,
        readyToTrade: !!wallet && capabilities["hyperliquid-trade"],
        // Paper needs no wallet — only the trade capability.
        readyToPaperTrade: capabilities["hyperliquid-trade"],
      });
    },

    /**
     * POST /wallet — set or rotate an agent's own Hyperliquid key. Each
     * agent has its own distinct, separately-keyed wallet — never a shared
     * platform/worker key. The key is encrypted with `masterSecret`, a
     * passphrase only its owner knows; it is never stored and must be
     * supplied again on every call that needs to sign a trade.
     *
     * orgId/agentId fall back to the body only for browser-session calls —
     * a verified agent signature (ctx.agent) always takes precedence, same
     * as every other route here. A browser-session call is authorized by
     * requireOrgAccess instead: the caller must be a member of orgId, not
     * merely signed in to the platform — this is any caller in the same org
     * setting the agent's wallet, not a cryptographic guarantee that only
     * the agent itself does.
     * Body: { orgId, agentId, privateKey, masterSecret, network? }
     */
    "POST /wallet": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { privateKey, masterSecret, network = "testnet" } = body;

      if (!orgId || !agentId || !privateKey || !masterSecret) {
        return Response.json({ error: "orgId, agentId, privateKey, masterSecret are required" }, { status: 400 });
      }
      if (network !== "testnet" && network !== "mainnet") {
        return Response.json({ error: "network must be testnet or mainnet" }, { status: 400 });
      }

      const denied = await requireOrgAccess(ctx, orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });

      let address: string;
      try {
        address = new EvmWallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`).address;
      } catch {
        return Response.json({ error: "privateKey is not a valid EVM private key" }, { status: 400 });
      }

      const { encryptedValue, iv } = encryptValue(privateKey, agentId, masterSecret);
      await setAgentWallet(agentId, { orgId, encryptedValue, iv, network, address });
      return Response.json({ ok: true });
    },

    /**
     * GET /my-agents — every agent in every org the signed-in operator
     * belongs to, with its trading wallet (address + network) when one is
     * set, so the panel can offer a pick-an-agent list instead of making
     * the operator type org/agent IDs and a wallet address. Session only.
     */
    "GET /my-agents": async (_req, ctx) => {
      const session = ctx.session;
      if (!session) return Response.json({ error: "Sign in to list your agents" }, { status: 401 });
      const orgs = await getOrganizationsByWalletAdmin(session.address);
      const perOrg = await Promise.all(orgs.map(async (org) => {
        const agents = await getAgentsByOrg(org.id);
        return Promise.all(agents.map(async (agent) => {
          const wallet = await getTradingWallet(agent.id);
          return {
            agentId: agent.id,
            name: agent.name,
            orgId: org.id,
            orgName: org.name || org.id,
            status: agent.status,
            wallet,
            // Only the org owner can switch an agent to instant trading (POST /instant-trading).
            isOwner: !!org.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === canonicalizeWalletAddress(session.address),
          };
        }));
      }));
      return Response.json({ agents: perOrg.flat() });
    },

    /**
     * POST /instant-trading — let an agent trade with no passphrase. Org
     * owner only, from a signed-in session — never an agent signature or
     * token: an agent can't hand the platform signing authority over its
     * own funds. Uses the agent's platform-held EVM wallet, creating one if
     * it has none, and sets default risk limits if it has none so platform
     * signing is never unbounded.
     * Body: { agentId, network? }
     */
    "POST /instant-trading": async (req, ctx) => {
      const session = ctx.session;
      if (!session || ctx.agent) {
        return Response.json({ error: "Only the org owner, signed in, can turn on instant trading" }, { status: 403 });
      }
      const body = await req.json().catch(() => ({}));
      const agentId: string | undefined = body.agentId;
      const network: HlNetwork = body.network === "mainnet" ? "mainnet" : "testnet";
      if (!agentId) return Response.json({ error: "agentId is required" }, { status: 400 });

      const agent = await getAgent(agentId);
      if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
      const membership = await requireOrgMembershipByAddress(session.address, agent.orgId);
      if (!membership.ok) return Response.json({ error: membership.error }, { status: membership.status ?? 403 });
      const ownerAddress = membership.org?.ownerAddress;
      if (!ownerAddress || canonicalizeWalletAddress(ownerAddress) !== canonicalizeWalletAddress(session.address)) {
        return Response.json({ error: "Only the org owner can turn on instant trading" }, { status: 403 });
      }

      let wallet = (await listAgentWallets(agentId)).find((w) => w.chain === "evm");
      if (!wallet) {
        wallet = await generateAgentWallet(agentId, agent.orgId, session.address, { chain: "evm", label: "Hyperliquid trading" });
      }
      await setInstantTrading(agentId, {
        orgId: agent.orgId, walletId: wallet.id, address: wallet.publicKey, network, enabledBy: session.address,
      });

      if (!(await getRiskConfig(agentId))) {
        await setRiskConfig(agentId, { orgId: agent.orgId, ...INSTANT_DEFAULT_RISK });
      }
      ctx.log.info(`instant trading ON for agent ${agentId} (${network}) by ${session.address}`);
      return Response.json({ ok: true, address: wallet.publicKey, network, risk: await getRiskConfig(agentId) });
    },

    /**
     * DELETE /instant-trading/:agentId — back to the passphrase model. Any
     * org member (or the agent itself) may switch it off — removing
     * authority needs less trust than granting it.
     */
    "DELETE /instant-trading/:agentId": async (_req, ctx) => {
      const access = await requireAgentOrgAccess(ctx, ctx.params.agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      await deleteInstantTrading(ctx.params.agentId);
      ctx.log.info(`instant trading OFF for agent ${ctx.params.agentId}`);
      return Response.json({ ok: true });
    },

    /** GET /wallet/:agentId — whether a wallet is configured, and which network. Never returns key material. */
    "GET /wallet/:agentId": async (_req, ctx) => {
      const access = await requireAgentOrgAccess(ctx, ctx.params.agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      const wallet = await getTradingWallet(ctx.params.agentId);
      return Response.json({
        hasWallet: !!wallet,
        network: wallet?.network ?? null,
        instant: wallet?.instant ?? false,
        address: wallet?.address ?? null,
      });
    },

    /** DELETE /wallet/:agentId — same org-membership check as POST /wallet above. */
    "DELETE /wallet/:agentId": async (_req, ctx) => {
      const agentId = ctx.agent?.agentId ?? ctx.params.agentId;
      const access = await requireAgentOrgAccess(ctx, agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      await deleteAgentWallet(agentId);
      return Response.json({ ok: true });
    },

    /**
     * POST /trade — enqueue an order for a GatewayAgent worker to execute,
     * signed with the calling agent's own wallet. Requires the "hyperliquid-trade"
     * capability and a wallet already set via POST /wallet.
     * orgId/agentId fall back to the body only for browser-session calls —
     * a verified agent signature (ctx.agent) always takes precedence.
     * Body: { orgId, agentId, masterSecret?, coin, isBuy, sizeUsd, orderType?,
     *         limitPrice?, leverage?, stopLossPct?, takeProfitPct? }
     * Rejected (400) if it would exceed the agent's configured risk limits.
     */
    "POST /trade": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { coin, isBuy, sizeUsd, orderType = "market", limitPrice, leverage, stopLossPct, takeProfitPct, masterSecret } = body;

      if (!orgId || !agentId || !coin || isBuy == null || !sizeUsd) {
        return Response.json({ error: "orgId, agentId, coin, isBuy, sizeUsd are required" }, { status: 400 });
      }
      if (orderType === "limit" && !limitPrice) {
        return Response.json({ error: "limitPrice is required for limit orders" }, { status: 400 });
      }

      const denied = await requireOrgAccess(ctx, orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });

      try {
        await enforceCapability(agentId, orgId, "hyperliquid-trade");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      let privateKey: string, network: HlNetwork;
      try {
        ({ privateKey, network } = await resolveSigningKey(agentId, masterSecret));
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 400 });
      }

      const result = await enforceRiskAndEnqueue({
        orgId, agentId, coin, isBuy, sizeUsd, privateKey, network, orderType, limitPrice, leverage, stopLossPct, takeProfitPct,
      });
      if ("error" in result) return Response.json(result, { status: 400 });
      return Response.json(result);
    },

    /** GET /status/:taskId — poll a trade's execution state. */
    "GET /status/:taskId": async (_req, ctx) => {
      const task = await getTask(ctx.params.taskId);
      if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
      const denied = await requireOrgAccess(ctx, task.orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });
      return Response.json({ status: task.status, result: task.result, error: task.error });
    },

    /** GET /price/:coin?network=testnet|mainnet — current mid price, for the client's live-price polling. */
    "GET /price/:coin": async (req, { params }) => {
      try {
        const network = (new URL(req.url).searchParams.get("network") as HlNetwork | null) ?? defaultNetwork();
        const price = await getMidPrice(params.coin, network);
        return Response.json({ coin: params.coin, price });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /** GET /oracle/:coin?network=testnet|mainnet&source=onchain|api — validator oracle price (HyperEVM precompile by default). */
    "GET /oracle/:coin": async (req, { params }) => {
      try {
        const url = new URL(req.url);
        const network = (url.searchParams.get("network") as HlNetwork | null) ?? defaultNetwork();
        const source = url.searchParams.get("source") === "api" ? "api" : "onchain";
        return Response.json(await getOraclePrice(params.coin, network, source));
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /** GET /market?network=testnet|mainnet — whole-market overview (price, 24h change, volume, OI, funding) across every tradeable perp. */
    "GET /market": async (req) => {
      try {
        const network = (new URL(req.url).searchParams.get("network") as HlNetwork | null) ?? defaultNetwork();
        const coins = await getMarketOverview(network);
        return Response.json({ coins });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /**
     * GET /candles/:coin?interval=15m&network=&bars=120&end= — OHLCV candles
     * for the terminal's chart (default last 120 bars) and the backtester
     * (up to 1000 bars, optionally ending at `end` ms), from the public Info API.
     */
    "GET /candles/:coin": async (req, { params }) => {
      try {
        const url = new URL(req.url);
        const network = (url.searchParams.get("network") as HlNetwork | null) ?? defaultNetwork();
        const interval = url.searchParams.get("interval") ?? "15m";
        const ms = CANDLE_INTERVAL_MS[interval];
        if (!ms) return Response.json({ error: `interval must be one of ${Object.keys(CANDLE_INTERVAL_MS).join(", ")}` }, { status: 400 });
        const bars = Math.min(1000, Math.max(10, Number(url.searchParams.get("bars")) || 120));
        const endTime = Number(url.searchParams.get("end")) || Date.now();
        const candles = await fetchCandles(params.coin, interval, bars, network, endTime);
        return Response.json({ coin: params.coin, interval, candles });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /** GET /book/:coin?network= — top of the L2 order book (bids and asks, best first). */
    "GET /book/:coin": async (req, { params }) => {
      try {
        const network = (new URL(req.url).searchParams.get("network") as HlNetwork | null) ?? defaultNetwork();
        const book = await hlInfo<{ levels: { px: string; sz: string }[][] }>({ type: "l2Book", coin: params.coin }, network);
        const side = (levels: { px: string; sz: string }[] = []) => levels.slice(0, 12).map((l) => ({ px: Number(l.px), sz: Number(l.sz) }));
        return Response.json({ coin: params.coin, bids: side(book.levels?.[0]), asks: side(book.levels?.[1]) });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /** GET /positions/:wallet?network=testnet|mainnet — open positions, read directly from Hyperliquid's public Info API. */
    "GET /positions/:wallet": async (req, { params }) => {
      try {
        const network = (new URL(req.url).searchParams.get("network") as HlNetwork | null) ?? defaultNetwork();
        const state = await hlInfo<ClearinghouseState>({ type: "clearinghouseState", user: params.wallet }, network);
        const positions = state.assetPositions.map((p) => ({
          coin: p.position.coin,
          size: Number(p.position.szi),
          notionalUsd: Number(p.position.positionValue),
          entryPrice: Number(p.position.entryPx),
          unrealizedPnl: Number(p.position.unrealizedPnl),
        }));
        return Response.json({ positions });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /** GET /account/:wallet?network=testnet|mainnet — margin/equity summary, same public Info API. */
    "GET /account/:wallet": async (req, { params }) => {
      try {
        const network = (new URL(req.url).searchParams.get("network") as HlNetwork | null) ?? defaultNetwork();
        // Unified accounts (Hyperliquid's default for new accounts) keep idle
        // USDC on the spot side, so perps accountValue alone reads ~$0 for a
        // freshly funded wallet. Equity = perps value + free spot USDC.
        const { state, perpsValue, spotUsdc, accountValue } = await accountEquity(params.wallet, network);
        return Response.json({
          accountValue,
          perpsValue,
          spotUsdc,
          marginUsed: Number(state.marginSummary.totalMarginUsed),
          totalPositionValue: Number(state.marginSummary.totalNtlPos),
        });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /**
     * POST /close — closes an open position. Reads the current position to
     * determine side and size (a short is closed by buying, a long by
     * selling) rather than trusting the caller to get the direction right,
     * then enqueues a reduce-only order the same way /trade does. Requires
     * the calling agent to hold the "hyperliquid-close" capability and a
     * wallet set via POST /wallet. As with /trade, a verified agent
     * signature (ctx.agent) always wins over the body.
     * Body: { orgId, agentId, masterSecret?, coin, wallet? } — wallet defaults
     * to the address recorded with the agent's key; masterSecret isn't
     * needed for an agent on instant trading.
     */
    "POST /close": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { coin, masterSecret } = body;
      if (!orgId || !agentId || !coin) {
        return Response.json({ error: "orgId, agentId, coin are required" }, { status: 400 });
      }

      const denied = await requireOrgAccess(ctx, orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });

      try {
        await enforceCapability(agentId, orgId, "hyperliquid-close");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      let privateKey: string, network: HlNetwork;
      try {
        ({ privateKey, network } = await resolveSigningKey(agentId, masterSecret));
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 400 });
      }

      // The wallet whose position gets read: the caller's, else the address
      // recorded with this agent's key (instant wallet, POST /wallet, or a generated wallet).
      const wallet: string | undefined = body.wallet ?? (await getTradingWallet(agentId))?.address ?? undefined;
      if (!wallet) {
        return Response.json({ error: "wallet is required — this agent's wallet address isn't on record" }, { status: 400 });
      }

      const state = await hlInfo<ClearinghouseState>({ type: "clearinghouseState", user: wallet }, network);
      const open = state.assetPositions.find((p) => p.position.coin === coin);
      if (!open || Number(open.position.szi) === 0) {
        return Response.json({ error: `No open ${coin} position for ${wallet}` }, { status: 404 });
      }

      const isLong = Number(open.position.szi) > 0;
      const sizeUsd = Math.abs(Number(open.position.positionValue));

      const result = await enforceRiskAndEnqueue({
        orgId, agentId, coin, isBuy: !isLong, sizeUsd, privateKey, network, orderType: "market", reduceOnly: true,
      });
      if ("error" in result) return Response.json(result, { status: 400 });
      return Response.json({ ...result, closing: { coin, side: isLong ? "long" : "short", sizeUsd } });
    },

    /**
     * POST /settle-trade — once a trade task has completed, commit its
     * fill as an on-chain receipt (same mechanism the compute-settlement
     * mods use), so a trade's proof-of-execution lives next to a job's,
     * and record it in the trade history used by GET /history/:agentId.
     * agentId/orgId are read from the task record itself, never the request
     * body — the body previously supplied its own agentId, letting any
     * caller who knew a completed taskId attribute someone else's real fill
     * (and its referral reward) to an agentId/org they don't control.
     * Body: { agentWallet, taskId, chains, creditScore?, trustScore? }
     */
    "POST /settle-trade": async (req, ctx) => {
      const body = await req.json();
      const { agentWallet, taskId, chains = ["solana"], creditScore, trustScore } = body;

      const task = await getTask(taskId);
      if (!task || task.status !== "completed") {
        return Response.json({ error: "Task not completed yet" }, { status: 409 });
      }

      const agentId = (task.payload as { agentId?: string }).agentId;
      const orgId = task.orgId;
      if (!agentId) {
        return Response.json({ error: "Task has no agentId in its payload" }, { status: 500 });
      }

      const denied = await requireOrgAccess(ctx, orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });

      const result = task.result as {
        exitCode?: number;
        executionTimeMs?: number;
        stdout?: string;
        data?: {
          coin?: string; isBuy?: boolean; sizeUsd?: number;
          fill?: { raw?: { avgPx?: string; totalSz?: string }; realizedPnl?: string };
        };
      } | undefined;

      const resultHash = hashJobResult({
        taskId,
        exitCode: result?.exitCode ?? 0,
        executionTimeMs: result?.executionTimeMs ?? 0,
        stdout: result?.stdout,
      });

      const { receipts, errors } = await settleOnChains(chains, {
        agentId,
        agentWallet,
        taskId,
        resultHash,
        amountUsdc: 0, // trade settlement commits the fill receipt, not a new payment
        creditScore: creditScore ?? 680,
        trustScore: trustScore ?? 50,
      });

      if (receipts.length === 0) {
        return Response.json({ error: "Receipt commit failed", details: errors }, { status: 502 });
      }

      const data = result?.data;
      if (data?.coin && data.isBuy != null && data.sizeUsd != null) {
        const status = (task.payload as { reduceOnly?: boolean })?.reduceOnly ? "closed" : "opened";
        await recordTrade({
          orgId: task.orgId,
          agentId,
          taskId,
          coin: data.coin,
          isBuy: data.isBuy,
          sizeUsd: data.sizeUsd,
          orderType: (task.payload as { orderType?: string })?.orderType ?? "market",
          fillPrice: data.fill?.raw?.avgPx ? Number(data.fill.raw.avgPx) : undefined,
          realizedPnl: data.fill?.realizedPnl ? Number(data.fill.realizedPnl) : undefined,
          status,
        });
        // Referral reward accrues on volume opened, not on the closing leg of
        // the same position — otherwise a single trade would count twice.
        if (status === "opened") {
          await accrueReferralReward(agentId, data.sizeUsd);
        }
      }

      return Response.json({ receipts, errors });
    },

    /** GET /history/:agentId — trade log + aggregate PnL/win-rate stats. */
    "GET /history/:agentId": async (_req, ctx) => {
      const access = await requireAgentOrgAccess(ctx, ctx.params.agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      const history = await getTradeHistory(ctx.params.agentId);
      return Response.json(history);
    },

    /**
     * POST /risk-config — set leverage, position, and daily-loss limits for
     * an agent. Every enqueued trade (manual or strategy-fired) is checked
     * against this. Requires the "hyperliquid-configure-risk" capability.
     * Body: { orgId, agentId, leverage, maxPositionUsd, maxDailyLossUsd,
     *         defaultStopLossPct?, defaultTakeProfitPct? }
     */
    "POST /risk-config": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { leverage, maxPositionUsd, maxDailyLossUsd, defaultStopLossPct, defaultTakeProfitPct } = body;

      if (!orgId || !agentId || !leverage || !maxPositionUsd || !maxDailyLossUsd) {
        return Response.json({ error: "orgId, agentId, leverage, maxPositionUsd, maxDailyLossUsd are required" }, { status: 400 });
      }

      const denied = await requireOrgAccess(ctx, orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });

      try {
        await enforceCapability(agentId, orgId, "hyperliquid-configure-risk");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      await setRiskConfig(agentId, { orgId, leverage, maxPositionUsd, maxDailyLossUsd, defaultStopLossPct, defaultTakeProfitPct });
      return Response.json({ ok: true });
    },

    /** GET /risk-config/:agentId */
    "GET /risk-config/:agentId": async (_req, ctx) => {
      const access = await requireAgentOrgAccess(ctx, ctx.params.agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      const config = await getRiskConfig(ctx.params.agentId);
      return Response.json({ config });
    },

    /** GET /strategy/:agentId — list an agent's strategies. */
    "GET /strategy/:agentId": async (_req, ctx) => {
      const access = await requireAgentOrgAccess(ctx, ctx.params.agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      const strategies = await getStrategies(ctx.params.agentId);
      return Response.json({ strategies });
    },

    /**
     * POST /strategy — create a DCA, grid, signal, sniper, or ai strategy.
     * Requires the "hyperliquid-run-strategy" capability. DCA/grid/sniper are
     * evaluated by the tick phase in /api/internal/tick and ai by its AI
     * Trader phase, which asks the agent's own model each round (params:
     * intervalMs ≥ 1 min on paper, ≥ 15 min live, maxDrawdownPct, leverage?); signal only fires via POST /strategy/:id/signal or the
     * public POST /webhook/:id.
     * Body: { orgId, agentId, wallet, type, coin, sizeUsd, params, paper? }
     * paper: true runs the bot on the agent's paper account (no wallet needed).
     * For a sniper strategy, coin may be "ANY" (new-listing mode only, to
     * catch whichever coin lists next rather than a specific one).
     */
    "POST /strategy": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { wallet, type, coin, sizeUsd, params } = body;
      const paper = body.paper === true;

      if (!orgId || !agentId || (!wallet && !paper) || !type || !coin || !sizeUsd) {
        return Response.json({ error: "orgId, agentId, wallet (unless paper), type, coin, sizeUsd are required" }, { status: 400 });
      }
      if (!["dca", "grid", "signal", "sniper", "ai"].includes(type)) {
        return Response.json({ error: "type must be dca, grid, signal, sniper, or ai" }, { status: 400 });
      }
      let storedParams = params ?? {};
      if (type === "ai") {
        if (coin === "ANY") return Response.json({ error: "an ai strategy needs a specific coin" }, { status: 400 });
        const built = buildAiParams(params, paper ? PAPER_MIN_INTERVAL_MS : AI_MIN_INTERVAL_MS);
        if ("error" in built) return Response.json({ error: built.error }, { status: 400 });
        storedParams = built;
      }
      if (type === "dca" && !params?.intervalMs) {
        return Response.json({ error: "params.intervalMs is required for a dca strategy" }, { status: 400 });
      }
      if (type === "grid" && !(params?.lowerPrice && params?.upperPrice && params?.levels)) {
        return Response.json({ error: "params.lowerPrice, upperPrice, levels are required for a grid strategy" }, { status: 400 });
      }
      if (type === "sniper") {
        if (!["new-listing", "price-above", "price-below"].includes(params?.mode)) {
          return Response.json({ error: "params.mode must be new-listing, price-above, or price-below for a sniper strategy" }, { status: 400 });
        }
        if (params.mode !== "new-listing" && params?.targetPrice == null) {
          return Response.json({ error: "params.targetPrice is required for price-above/price-below sniper modes" }, { status: 400 });
        }
        if (params.mode !== "new-listing" && coin === "ANY") {
          return Response.json({ error: "coin \"ANY\" is only valid for new-listing sniper mode" }, { status: 400 });
        }
      }

      const denied = await requireOrgAccess(ctx, orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });

      const strategyCap = await ensureRunStrategy(ctx, agentId, orgId);
      if (strategyCap) return Response.json({ error: strategyCap }, { status: 403 });

      const id = await createStrategy({ orgId, agentId, wallet: wallet ?? "", type, coin, sizeUsd, enabled: true, params: storedParams, paper });
      return Response.json({ id });
    },

    /** GET /strategy/:id/decisions — an AI Trader bot's decision log, newest first (decision, action, reasoning, outcome). */
    "GET /strategy/:id/decisions": async (_req, ctx) => {
      const strategy = await getStrategy(ctx.params.id);
      if (!strategy) return Response.json({ error: "Strategy not found" }, { status: 404 });
      const access = await requireAgentOrgAccess(ctx, strategy.agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      return Response.json({ decisions: await getAiDecisions(strategy.id) });
    },

    /**
     * GET /ai/requests — the questions waiting for this agent's own model
     * (AI Trader rounds and backtest bars), oldest first. Agent-signed only:
     * this is the agent's work queue, which its daemon polls.
     */
    "GET /ai/requests": async (_req, ctx) => {
      if (!ctx.agent) return Response.json({ error: "Agent signature or token required" }, { status: 401 });
      const open = await listOpenAiRequests(ctx.agent.agentId);
      return Response.json({
        requests: open.map((r) => ({
          id: r.id, purpose: r.purpose, coin: r.coin, system: r.system, prompt: r.prompt,
          expiresAt: r.expiresAt.toISOString(), answer: "POST ai/requests/{id}/answer { decision, reasoning } or { text }",
        })),
      });
    },

    /**
     * POST /ai/requests/:id/answer — the agent's answer to one question.
     * Body: { decision: LONG|SHORT|CLOSE|NOTHING, reasoning? } or { text }
     * (free text from the model — the last decision word in it wins). Only
     * the agent the question was asked of may answer, once, before it
     * expires. A live round is traded straight away.
     */
    "POST /ai/requests/:id/answer": async (req, ctx) => {
      if (!ctx.agent) return Response.json({ error: "Agent signature or token required" }, { status: 401 });
      const request = await getAiRequest(ctx.params.id);
      if (!request || request.agentId !== ctx.agent.agentId) {
        return Response.json({ error: "Request not found" }, { status: 404 });
      }
      const body = await req.json().catch(() => ({}));
      const text = typeof body.text === "string" ? body.text : "";
      const inPosition = /Current position: (LONG|SHORT)/.test(request.prompt);
      const decision = typeof body.decision === "string" && ["LONG", "SHORT", "CLOSE", "NOTHING"].includes(body.decision.toUpperCase())
        ? parseDecision(body.decision, inPosition)
        : parseDecision(text, inPosition);
      if (!decision) {
        return Response.json({ error: "No decision found — answer LONG, SHORT, CLOSE or NOTHING" }, { status: 400 });
      }
      const reasoning = String(body.reasoning ?? text).trim().slice(0, 2000);
      const answered = await answerAiRequest(request.id, decision, reasoning);
      if (!answered) return Response.json({ error: "This question was already answered or has expired" }, { status: 409 });
      if (answered.purpose !== "live") return Response.json({ ok: true, decision });
      const outcome = await applyAiAnswer(answered, decision, reasoning);
      return Response.json({ ok: true, decision, ...outcome });
    },

    /**
     * POST /ai/ask — put one backtest bar's question to the agent's own model
     * (same snapshot and prompt as a live round). Returns { id }; poll
     * GET /ai/requests/:id for the answer.
     * Body: { agentId, coin, interval, candles: Candle[] (oldest first, ≤ 200), position? }
     */
    "POST /ai/ask": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const agentId: string | undefined = ctx.agent?.agentId ?? body.agentId;
      if (!agentId) return Response.json({ error: "agentId is required" }, { status: 400 });
      const access = await requireAgentOrgAccess(ctx, agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });

      const coin = typeof body.coin === "string" ? body.coin : "";
      const interval = typeof body.interval === "string" && CANDLE_INTERVAL_MS[body.interval] ? body.interval : null;
      const raw: unknown[] = Array.isArray(body.candles) ? body.candles : [];
      const candles: Candle[] = raw.slice(-200).map((k) => {
        const c = k as Record<string, unknown>;
        return { t: Number(c.t), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) };
      }).filter((c) => [c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite));
      if (!coin || !interval || candles.length < 20) {
        return Response.json({ error: "coin, interval and at least 20 candles are required" }, { status: 400 });
      }
      const p = body.position as Record<string, unknown> | null | undefined;
      const position: AiPosition | null = p && Number(p.size)
        ? { isLong: Number(p.size) > 0, size: Number(p.size), entryPx: Number(p.entryPx), unrealizedPnl: Number(p.unrealizedPnl) || 0 }
        : null;

      const goal = normalizeGoal(body.goal);
      if (goal.error) return Response.json({ error: goal.error }, { status: 400 });
      const id = await createAiRequest({
        agentId, orgId: access.orgId, purpose: "backtest", strategyId: null, coin,
        ...decisionRequest(coin, buildSnapshot({ coin, candles, interval }), position, goal.goal),
        expiresAt: new Date(Date.now() + AI_BACKTEST_ANSWER_MS),
      });
      return Response.json({ id });
    },

    /** GET /ai/requests/:id — one question's status and, once answered, the agent's decision and reasoning. */
    "GET /ai/requests/:id": async (_req, ctx) => {
      const request = await getAiRequest(ctx.params.id);
      if (!request) return Response.json({ error: "Request not found" }, { status: 404 });
      const access = await requireAgentOrgAccess(ctx, request.agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      const expired = request.status === "expired" || (request.status === "open" && request.expiresAt.getTime() <= Date.now());
      return Response.json({
        id: request.id, status: expired ? "expired" : request.status, decision: request.decision, reasoning: request.reasoning,
      });
    },

    /** POST /strategy/:id/toggle — enable/disable a strategy. Body: { enabled } */
    "POST /strategy/:id/toggle": async (req, ctx) => {
      const body = await req.json();
      const strategy = await getStrategy(ctx.params.id);
      if (!strategy) return Response.json({ error: "Strategy not found" }, { status: 404 });
      const denied = await requireOrgAccess(ctx, strategy.orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });
      await toggleStrategy(strategy.id, Boolean(body.enabled));
      return Response.json({ ok: true });
    },

    /**
     * POST /strategy/:id/signal — fire a "signal" strategy immediately (an
     * agent calling in from outside the tick evaluator, from inside the
     * platform). For a third-party TradingView-style alert, use the public
     * POST /webhook/:id route instead — this one is session/agent-gated.
     * Body: { masterSecret, isBuy? } — isBuy defaults to the strategy's
     * configured direction. Needs the strategy's agent to already have a
     * wallet set via POST /wallet.
     */
    "POST /strategy/:id/signal": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const strategy = await getStrategy(ctx.params.id);
      if (!strategy) return Response.json({ error: "Strategy not found" }, { status: 404 });
      const denied = await requireOrgAccess(ctx, strategy.orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });
      const result = await fireSignalStrategy(strategy, body);
      if ("status" in result) return Response.json(result.body, { status: result.status });
      return Response.json(result);
    },

    /**
     * POST /webhook/:id?token=… — public counterpart to /strategy/:id/signal,
     * built for third-party alert sources (TradingView, a custom script) that
     * can't carry a platform session. `public: true` because that caller has
     * no session — the webhook token (scoped to this one strategy, issued via
     * POST /strategy/:id/webhook-token) is the auth instead. It does not
     * replace the masterSecret requirement: the token only proves "this
     * caller may try to fire strategy :id", the agent's own passphrase is
     * still required to actually decrypt its wallet and sign (see
     * resolveAgentWallet) — same zero-knowledge-wallet guarantee as every
     * other trade-initiating route in this mod.
     * Body: { masterSecret, isBuy? } — same contract as /strategy/:id/signal.
     */
    "POST /webhook/:id": {
      public: true,
      handler: async (req, { params }) => {
        const token = new URL(req.url).searchParams.get("token");
        if (!token) return Response.json({ error: "token query param is required" }, { status: 401 });

        const strategy = await getStrategyByWebhookToken(params.id, token);
        if (!strategy) return Response.json({ error: "Not found" }, { status: 404 });

        const body = await req.json().catch(() => ({}));
        const result = await fireSignalStrategy(strategy, body);
        if ("status" in result) return Response.json(result.body, { status: result.status });
        return Response.json(result);
      },
    },

    /**
     * POST /strategy/:id/webhook-token — issue (or rotate) the token gating
     * POST /webhook/:id for a "signal" strategy. Requires the
     * "hyperliquid-webhook" capability. Returns the full URL to paste into an
     * external alert source — note it still expects `masterSecret` in every
     * call's body, same as any other trade-initiating route. agentId/orgId
     * are always the strategy's own (never a body override) — otherwise any
     * signed-in caller could rotate or revoke another org's webhook token by
     * knowing/guessing a strategy id.
     */
    "POST /strategy/:id/webhook-token": async (_req, ctx) => {
      const strategy = await getStrategy(ctx.params.id);
      if (!strategy) return Response.json({ error: "Strategy not found" }, { status: 404 });
      if (strategy.type !== "signal") {
        return Response.json({ error: "Only signal strategies can have a webhook" }, { status: 400 });
      }

      const denied = await requireOrgAccess(ctx, strategy.orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });

      try {
        await enforceCapability(strategy.agentId, strategy.orgId, "hyperliquid-webhook");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      const token = crypto.randomBytes(24).toString("hex");
      await setStrategyWebhookToken(strategy.id, token);
      return Response.json({ token, path: `/api/mods/hyperliquid-trading/webhook/${strategy.id}?token=${token}` });
    },

    /** DELETE /strategy/:id/webhook-token — revoke a strategy's webhook. */
    "DELETE /strategy/:id/webhook-token": async (_req, ctx) => {
      const strategy = await getStrategy(ctx.params.id);
      if (!strategy) return Response.json({ error: "Strategy not found" }, { status: 404 });
      const denied = await requireOrgAccess(ctx, strategy.orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });
      await setStrategyWebhookToken(strategy.id, null);
      return Response.json({ ok: true });
    },

    /** GET /strategy/:agentId/pending — dca/grid strategies waiting for this agent to execute. */
    "GET /strategy/:agentId/pending": async (_req, ctx) => {
      const access = await requireAgentOrgAccess(ctx, ctx.params.agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      const strategies = await getPendingStrategies(ctx.params.agentId);
      return Response.json({ strategies });
    },

    /**
     * POST /strategy/:id/execute-pending — the agent's own process polls
     * GET /strategy/:agentId/pending, then calls this with its passphrase to
     * actually place the trade the tick evaluator flagged. Uses the price
     * level/context captured at trigger time (strategy.pendingContext), not
     * a fresh read, since price may have moved since the tick ran.
     * Body: { masterSecret? } — not needed for an agent on instant trading.
     */
    "POST /strategy/:id/execute-pending": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const strategy = await getStrategy(ctx.params.id);
      if (!strategy) return Response.json({ error: "Strategy not found" }, { status: 404 });
      const denied = await requireOrgAccess(ctx, strategy.orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });
      const result = await executePendingStrategy(strategy, body.masterSecret);
      if ("status" in result) return Response.json(result.body, { status: result.status });
      return Response.json(result);
    },

    // ── Paper trading ──────────────────────────────────────────────────────

    /**
     * POST /paper/train — start a paper AI trader from an operator goal.
     * Body: { orgId, agentId, coin, goal, sizeUsd?, intervalMs?, maxDrawdownPct?, leverage? }
     * No wallet. The first round is asked immediately; the hub tick keeps asking.
     * The agent's daemon answers, and the fill lands on the paper account.
     */
    "POST /paper/train": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const coin = cleanTrainCoin(body.coin);
      if (!orgId || !agentId) return Response.json({ error: "orgId and agentId are required" }, { status: 400 });
      if (!coin) return Response.json({ error: "coin must be a perp symbol such as BTC" }, { status: 400 });
      const goal = normalizeGoal(body.goal);
      if (goal.error) return Response.json({ error: goal.error }, { status: 400 });
      if (!goal.goal) return Response.json({ error: "A goal is required — write the idea this agent should practice" }, { status: 400 });

      const sizeUsd = body.sizeUsd == null || body.sizeUsd === "" ? TRAIN_DEFAULT_SIZE_USD : Number(body.sizeUsd);
      if (!(sizeUsd >= MIN_ORDER_USD && sizeUsd <= TRAIN_MAX_SIZE_USD)) {
        return Response.json({ error: `sizeUsd must be between ${MIN_ORDER_USD} and ${TRAIN_MAX_SIZE_USD}` }, { status: 400 });
      }
      const built = buildAiParams({
        intervalMs: body.intervalMs ?? TRAIN_DEFAULT_INTERVAL_MS,
        maxDrawdownPct: body.maxDrawdownPct ?? TRAIN_DEFAULT_DRAWDOWN_PCT,
        leverage: body.leverage,
        goal: goal.goal,
      }, PAPER_MIN_INTERVAL_MS);
      if ("error" in built) return Response.json({ error: built.error }, { status: 400 });

      const denied = await requireOrgAccess(ctx, orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });
      const strategyCap = await ensureRunStrategy(ctx, agentId, orgId);
      if (strategyCap) return Response.json({ error: strategyCap }, { status: 403 });

      const existing = await getStrategies(agentId);
      const clash = existing.find((s) => s.enabled && s.paper && s.type === "ai" && s.coin === coin);
      if (clash) {
        return Response.json({
          error: `This agent already has a paper trainer on ${coin}. Stop it before starting another goal.`,
          strategyId: clash.id,
        }, { status: 409 });
      }

      const id = await createStrategy({
        orgId, agentId, wallet: "", type: "ai", coin, sizeUsd, enabled: true, params: built, paper: true,
      });

      let firstRound: "asked" | "waiting" | "error" = "waiting";
      try {
        const created = await getStrategy(id);
        if (created) {
          const round = await runAiStrategy(created);
          firstRound = round === "asked" ? "asked" : round === "error" ? "error" : "waiting";
        }
      } catch (err) {
        console.error(`[hyperliquid-paper] train ${id} first round failed:`, err);
        firstRound = "error";
      }

      return Response.json({
        id, paper: true, coin, goal: goal.goal, sizeUsd,
        intervalMs: built.intervalMs, maxDrawdownPct: built.maxDrawdownPct, firstRound,
      });
    },

    /**
     * GET /paper/:agentId — the agent's paper account marked to mainnet mids:
     * balance, equity, margin, open positions and resting limit orders.
     * Opens the account (PAPER_START_BALANCE virtual USDC) on first read.
     */
    "GET /paper/:agentId": async (_req, ctx) => {
      const access = await requireAgentOrgAccess(ctx, ctx.params.agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      try {
        const [summary, orders] = await Promise.all([
          getPaperSummary(ctx.params.agentId, access.orgId),
          listPaperOrders(ctx.params.agentId),
        ]);
        const { account, ...marked } = summary;
        return Response.json({
          network: PAPER_NETWORK,
          startBalance: account.startBalance,
          dailyPnl: account.dailyPnl,
          ...marked,
          orders: orders.map((o) => ({
            orderId: o.id, coin: o.coin, isBuy: o.isBuy, sz: o.sz, limitPx: o.limitPx, leverage: o.leverage,
            reduceOnly: o.reduceOnly, strategyId: o.strategyId, createdAt: o.createdAt?.toISOString() ?? null,
          })),
        });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /**
     * POST /paper/trade — a paper order, same body and same checks (capability,
     * risk limits) as POST /trade, but no wallet or passphrase: it fills on the
     * agent's virtual account against the real mainnet book, synchronously.
     * Body: { orgId, agentId, coin, isBuy, sizeUsd, orderType?, limitPrice?, leverage?, stopLossPct?, takeProfitPct?, trailingStopPct? }
     * trailingStopPct is paper-only (Hyperliquid has no native trailing stop) and replaces stopLossPct.
     */
    "POST /paper/trade": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { coin, isBuy, sizeUsd, orderType = "market", limitPrice, leverage, stopLossPct, takeProfitPct, trailingStopPct } = body;
      if (!orgId || !agentId || !coin || isBuy == null || !(Number(sizeUsd) > 0)) {
        return Response.json({ error: "orgId, agentId, coin, isBuy, sizeUsd are required" }, { status: 400 });
      }
      if (orderType !== "market" && orderType !== "limit") {
        return Response.json({ error: "orderType must be market or limit" }, { status: 400 });
      }
      if (orderType === "limit" && !(Number(limitPrice) > 0)) {
        return Response.json({ error: "limitPrice is required for limit orders" }, { status: 400 });
      }
      if (trailingStopPct != null && trailingStopPct !== "" && !(Number(trailingStopPct) > 0 && Number(trailingStopPct) <= MAX_TRAILING_STOP_PCT)) {
        return Response.json({ error: `trailingStopPct must be above 0 and at most ${MAX_TRAILING_STOP_PCT}` }, { status: 400 });
      }

      const denied = await requireOrgAccess(ctx, orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });
      try {
        await enforceCapability(agentId, orgId, "hyperliquid-trade");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      const num = (v: unknown) => (v == null || v === "" ? undefined : Number(v) || undefined);
      const result = await placePaperOrder({
        orgId, agentId, coin: String(coin), isBuy: Boolean(isBuy), sizeUsd: Number(sizeUsd), orderType,
        limitPrice: num(limitPrice), leverage: num(leverage), stopLossPct: num(stopLossPct), takeProfitPct: num(takeProfitPct),
        trailingStopPct: num(trailingStopPct),
      });
      if ("error" in result) return Response.json(result, { status: 400 });
      return Response.json(result);
    },

    /** POST /paper/close — close the agent's whole paper position in `coin` at market. Body: { orgId, agentId, coin } */
    "POST /paper/close": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { coin } = body;
      if (!orgId || !agentId || !coin) {
        return Response.json({ error: "orgId, agentId, coin are required" }, { status: 400 });
      }
      const denied = await requireOrgAccess(ctx, orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });
      try {
        await enforceCapability(agentId, orgId, "hyperliquid-close");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      const open = (await listPaperPositions(agentId)).find((p) => p.coin === coin);
      if (!open) return Response.json({ error: `No open ${coin} paper position` }, { status: 404 });
      const result = await placePaperOrder({
        orgId, agentId, coin, isBuy: open.szi < 0, sz: Math.abs(open.szi), sizeUsd: Math.abs(open.szi) * open.entryPx, reduceOnly: true,
      });
      if ("error" in result) return Response.json(result, { status: 400 });
      return Response.json({ ...result, closing: { coin, side: open.szi > 0 ? "long" : "short", sz: Math.abs(open.szi) } });
    },

    /** POST /paper/orders/:id/cancel — cancel one resting paper limit order. */
    "POST /paper/orders/:id/cancel": async (_req, ctx) => {
      const order = await getPaperOrder(ctx.params.id);
      if (!order) return Response.json({ error: "Order not found" }, { status: 404 });
      const access = await requireAgentOrgAccess(ctx, order.agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      await deletePaperOrder(order.id);
      return Response.json({ ok: true });
    },

    /**
     * POST /paper/reset — back to a clean paper account: positions and resting
     * orders dropped, balance set to startBalance (default 10,000). History is kept.
     * Body: { orgId, agentId, startBalance? }
     */
    "POST /paper/reset": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      if (!orgId || !agentId) return Response.json({ error: "orgId, agentId are required" }, { status: 400 });
      const startBalance = body.startBalance == null ? PAPER_START_BALANCE : Number(body.startBalance);
      if (!(startBalance >= 100 && startBalance <= 10_000_000)) {
        return Response.json({ error: "startBalance must be between 100 and 10,000,000" }, { status: 400 });
      }
      const denied = await requireOrgAccess(ctx, orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });
      await resetPaperAccount(agentId, orgId, startBalance);
      return Response.json({ ok: true, balance: startBalance });
    },

    /**
     * GET /paper/history/:agentId — paper fills (newest first) plus performance
     * since the last reset: net PnL, win rate, profit factor, expectancy, max
     * drawdown and the equity curve.
     */
    "GET /paper/history/:agentId": async (_req, ctx) => {
      const access = await requireAgentOrgAccess(ctx, ctx.params.agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      const account = await getPaperAccount(ctx.params.agentId, access.orgId);
      return Response.json(await getPaperTradeHistory(ctx.params.agentId, undefined, { since: account.resetAt, startBalance: account.startBalance }));
    },

    // ── Referrals ──────────────────────────────────────────────────────────

    /**
     * GET /referral/:agentId — an agent's referral code (its own agentId),
     * who referred it (if anyone), and accrued stats. Lazily creates the
     * referral doc on first read, using the agent's own org (resolved
     * server-side, never a client-supplied `orgId` query param).
     */
    "GET /referral/:agentId": async (_req, ctx) => {
      const access = await requireAgentOrgAccess(ctx, ctx.params.agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      await ensureReferral(ctx.params.agentId, access.orgId);
      const referral = await getReferral(ctx.params.agentId);
      return Response.json({
        code: ctx.params.agentId,
        referredBy: referral?.referredBy ?? null,
        referredCount: referral?.referredCount ?? 0,
        totalVolumeUsd: referral?.totalVolumeUsd ?? 0,
        rewardUsd: referral?.rewardUsd ?? 0,
      });
    },

    /**
     * POST /referral/apply — attribute this agent to another agent's
     * referral code (its agentId), one time only. It moves no funds on its
     * own; it only sets who future trade-volume rewards
     * (accrueReferralReward) credit — but since that attribution is
     * permanent (first code wins), requireOrgAccess still gates it: without
     * it, any signed-in caller could hijack a victim agent's referral
     * attribution before its real referrer applies (agentIds aren't secret —
     * they're shown in the UI and used as the referral code itself).
     * Body: { orgId, agentId, referralCode }
     */
    "POST /referral/apply": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { referralCode } = body;
      if (!orgId || !agentId || !referralCode) {
        return Response.json({ error: "orgId, agentId, referralCode are required" }, { status: 400 });
      }

      const denied = await requireOrgAccess(ctx, orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });

      const result = await applyReferralCode(agentId, orgId, referralCode);
      if ("error" in result) return Response.json(result, { status: 400 });
      return Response.json(result);
    },
  },
});
