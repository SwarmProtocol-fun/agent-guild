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
  updateStrategy,
  deleteStrategy,
  stopStrategies,
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
  type StoredPairsParams,
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
  listOrgStrategies,
  listOrgPaperAccounts,
  listOrgPaperFills,
  type PaperPositionDoc,
  bookPaperSpotFill,
  logBotOrder,
  listPendingBotOrders,
  settleBotOrder,
  listOrgBotFills,
  type RuleBotExtras,
  type StoredBreakoutParams,
  type StoredBasisParams,
} from "@/lib/mods/hyperliquid-store";
import crypto from "crypto";
import {
  buildCoinBlock,
  buildSnapshot,
  decisionRequest,
  multiDecisionRequest,
  parseMultiDecision,
  MULTI_MAX_COINS,
  decisionToAction,
  normalizeGoal,
  parseDecision,
  type AiAction,
  type AiDecision,
  type AiPosition,
} from "./ai-trader-core";
import type { Candle } from "./indicators";
import { rankAccounts, rankBots } from "./leaderboard";
import { applyBotEdit, withRuntimeState } from "./bot-edit";
import { buildPairsParams, decidePairs, type OpenPair } from "./pairs";
import { breakoutHistory, buildBreakoutParams, decideBreakout } from "./breakout";
import { buildSmartDca, smartDcaSize, smartDcaTakeProfit } from "./smart-dca";
import { buildBasisParams, decideBasis, findBasis, mapSpotMarkets, type OpenBasis, type SpotCtx, type SpotMarket, type SpotPair, type SpotToken } from "./basis";
import { bookImbalance } from "./signals";
import { coinContextLine, getCoinContexts, getGlobalContext, globalContextLine } from "./cmc";
import { intelSection } from "./intel";
import { getMarketIntel, getMarketIntelWithin } from "./intel-fetch";

/** How long an AI round waits on the free data outlets before asking without them. */
const AI_INTEL_WAIT_MS = 8_000;

/** The intel lines for an AI prompt, or "" when the outlets are slow or down — a round never waits on them. */
async function intelFor(coins: string[]): Promise<string> {
  const intel = await getMarketIntelWithin(coins, AI_INTEL_WAIT_MS);
  return intel ? intelSection(intel, coins) : "";
}
import {
  findFundingArbs,
  findPairSpreads,
  findPremiumOutliers,
  parsePredictedFundings,
  scannerSection,
  type PredictedFundingsRaw,
  type ScannerResult,
} from "./scanner";
import { findPerpAsset, readOraclePxOnchain, type PerpAssetMeta } from "./oracle";
import { placeOrder as placeHlOrder, MARKET_SLIPPAGE, MIN_ORDER_USD, type PlaceOrderResult } from "./exchange";
import {
  MAKER_FEE_RATE,
  PAPER_START_BALANCE,
  SPOT_TAKER_FEE_RATE,
  TAKER_FEE_RATE,
  spotValue,
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
  oraclePx: number;
  /** (mark − oracle) / oracle, in percent. */
  premiumPct: number;
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
  type AssetCtx = { funding: string; openInterest: string; prevDayPx: string; dayNtlVlm: string; markPx: string; oraclePx?: string };
  type UniverseAsset = { name: string; maxLeverage: number; isDelisted?: boolean };
  const [meta, ctxs] = await hlInfo<[{ universe: UniverseAsset[] }, AssetCtx[]]>({ type: "metaAndAssetCtxs" }, network);

  const coins: MarketCoin[] = [];
  meta.universe.forEach((asset, i) => {
    const ctx = ctxs[i];
    if (!ctx || asset.isDelisted) return;
    const markPx = Number(ctx.markPx);
    const prevDayPx = Number(ctx.prevDayPx);
    const oraclePx = Number(ctx.oraclePx) || 0;
    coins.push({
      coin: asset.name,
      markPx,
      change24hPct: prevDayPx ? ((markPx - prevDayPx) / prevDayPx) * 100 : 0,
      volume24hUsd: Number(ctx.dayNtlVlm),
      openInterestUsd: Number(ctx.openInterest) * markPx,
      fundingRatePct: Number(ctx.funding) * 100,
      maxLeverage: asset.maxLeverage,
      oraclePx,
      premiumPct: oraclePx ? ((markPx - oraclePx) / oraclePx) * 100 : 0,
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
  /** The bot placing it, if any — logged so the leaderboard can rank live bots. */
  strategyId?: string;
}): Promise<{ taskId: string } | { error: string }> {
  const { orgId, agentId, coin, isBuy, sizeUsd, privateKey, network, orderType = "market", limitPrice, reduceOnly = false, strategyId } = params;

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
      ...(strategyId ? { strategyId } : {}),
    },
    priority: "normal",
    resources: { requiredTags: ["hyperliquid"] },
    timeoutMs: 30000,
    maxRetries: reduceOnly ? 0 : 2,
  });

  if (strategyId) {
    try {
      await logBotOrder({ orgId, agentId, strategyId, coin, isBuy, sizeUsd, reduceOnly, network, taskId });
    } catch (err) {
      console.error(`[hyperliquid] bot order ${taskId} sent but not logged:`, err);
    }
  }
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

/** The paper account marked to the current mainnet mids. allMids carries spot pairs too ("@142"), so spot holdings are marked from it. */
async function getPaperSummary(agentId: string, orgId: string) {
  const [account, positions, market] = await Promise.all([getPaperAccount(agentId, orgId), listPaperPositions(agentId), getPaperMarket()]);
  const spot = Object.values(account.spot ?? {}).map((h) => {
    const markPx = market.mids[h.pair] || h.avgPx;
    return { ...h, markPx, valueUsd: h.sz * markPx, unrealizedPnl: h.sz * (markPx - h.avgPx) };
  });
  return { account, spot, ...summarize(account.balance, positions, market.mids, market.meta, spotValue(account.spot ?? {}, market.mids)) };
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
      { orgId: p.orgId, reason: p.strategyId ? "strategy" : "manual", strategyId: p.strategyId ?? null, spotMids: market.mids },
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
  let spotMids: Record<string, number> | null = null;
  for (const [agentId, held] of byAgent) {
    try {
      const account = await getPaperAccount(agentId, held[0].orgId);
      if (Object.keys(account.spot ?? {}).length && !spotMids) {
        spotMids = await hlInfo<Record<string, string>>({ type: "allMids" }, PAPER_NETWORK)
          .then((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Number(v)])))
          .catch(() => ({}));
      }
      if (!isLiquidatable(summarize(account.balance, held, marks, coinMeta, spotValue(account.spot ?? {}, spotMids ?? {})))) continue;
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
  order: { coin: string; isBuy: boolean; sizeUsd: number; leverage?: number; reduceOnly?: boolean; sz?: number; stopLossPct?: number; takeProfitPct?: number },
): Promise<{ taskId: string } | { error: string }> {
  if (strategy.paper) {
    return placePaperOrder({ orgId: strategy.orgId, agentId: strategy.agentId, strategyId: strategy.id, ...order });
  }
  if (!signer) return { error: "No signing key for a live order" };
  const { coin, isBuy, sizeUsd, leverage, reduceOnly, stopLossPct, takeProfitPct } = order;
  return enforceRiskAndEnqueue({
    orgId: strategy.orgId, agentId: strategy.agentId, coin, isBuy, sizeUsd, leverage, reduceOnly, stopLossPct, takeProfitPct, strategyId: strategy.id, ...signer,
  });
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
  // A stopped bot (paused, or an emergency stop) ignores its webhook and manual fires until turned back on.
  if (!strategy.enabled) {
    return { status: 409, body: { error: "This bot is stopped — turn it back on to fire it" } };
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
  const pending = (strategy.pendingContext ?? {}) as { detectedCoin?: string; sizeUsd?: number; action?: string; sz?: number; isLong?: boolean; notionalUsd?: number };
  const coin = strategy.type === "sniper" && pending.detectedCoin ? pending.detectedCoin : strategy.coin;
  const extras = strategy.params as RuleBotExtras;

  // A smart DCA take profit: close the whole stack, sized when it was flagged.
  if (strategy.type === "dca" && pending.action === "close") {
    if (!pending.sz) return { status: 400, body: { error: "Pending close has no size" } };
    const closed = await sendStrategyOrder(strategy, signer, {
      coin, isBuy: !pending.isLong, sizeUsd: pending.notionalUsd ?? 0, reduceOnly: true, sz: pending.sz,
    });
    if ("error" in closed) return { status: 400, body: closed };
    await clearStrategyPending(strategy.id);
    return closed;
  }

  const result = await sendStrategyOrder(strategy, signer, {
    coin, isBuy: extras.direction !== "short", sizeUsd: pending.sizeUsd ?? strategy.sizeUsd,
    stopLossPct: extras.stopLossPct, takeProfitPct: extras.takeProfitPct,
  });
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
  coin = strategy.coin,
): Promise<{ taskId: string; params?: AiParams } | { error: string } | null> {
  const params = strategy.params as AiParams;
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
    const side = action === "flip-long" ? "long" : "short";
    const flipped: AiParams = isBasket(strategy)
      ? { ...params, flips: { ...(params.flips ?? {}), [coin]: side } }
      : { ...params, flipTo: side };
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
    hlInfo<{ levels: { px: string; sz: string }[][] }>({ type: "l2Book", coin: strategy.coin }, network).catch(() => null),
    getMarketOverview(network).catch(() => []),
  ]);
  if (candles.length < 20) {
    await record({ error: `Not enough ${strategy.coin} price history to decide.` });
    return "error";
  }
  const coinInfo = market.find((m) => m.coin === strategy.coin);
  const [intel, cmc, imbalance] = await Promise.all([intelFor([strategy.coin]), cmcFor([strategy.coin]), bookImbalanceFor(strategy.coin, network, book)]);
  const snapshot = buildSnapshot({
    coin: strategy.coin, candles, interval,
    bid: book?.levels?.[0]?.[0] ? Number(book.levels[0][0].px) : null,
    ask: book?.levels?.[1]?.[0] ? Number(book.levels[1][0].px) : null,
    fundingRatePct: coinInfo?.fundingRatePct ?? null,
    openInterestUsd: coinInfo?.openInterestUsd ?? null,
    bookImbalance: imbalance,
    marketContext: cmc.coin.get(strategy.coin) ?? null,
    globalContext: cmc.global,
  }) + (intel ? `\n\n${intel}` : "");
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

// ── Basket bots and the cross-market scanner ────────────────────────────────
//
// A basket bot (AiParams.coins or scanTop) isn't tied to one pair: each round
// it sees every coin in its basket plus the scanner's funding, premium and
// pair-spread rows for them, and may act on several coins at once — both legs
// of a pair trade, a funding carry, or one directional trade. Live baskets
// need instant trading: there's no pending queue for several actions.

export function isBasket(s: Strategy): boolean {
  if (s.type !== "ai") return false;
  const p = (s.params ?? {}) as AiParams;
  return (Array.isArray(p.coins) && p.coins.length > 0) || (p.scanTop ?? 0) > 0;
}

/** The coins an AI bot claims on its agent's account, so two bots never trade the same position. */
function aiCoinsOf(s: Strategy): string[] {
  const p = (s.params ?? {}) as AiParams;
  if (Array.isArray(p.coins) && p.coins.length) return p.coins;
  if ((p.scanTop ?? 0) > 0) return p.owned ?? [];
  return [s.coin];
}

/**
 * An enabled AI bot (same paper/live account) that already claims one of
 * `want`'s coins. Two scanning bots always clash: each would take the same top N.
 */
function findAiClash(existing: Strategy[], paper: boolean, want: { coins?: string[]; scanTop?: number }): { strategy: Strategy; coin: string } | null {
  for (const s of existing) {
    if (!s.enabled || (s.type !== "ai" && s.type !== "pairs") || s.paper !== paper) continue;
    const p = (s.params ?? {}) as AiParams;
    if (want.scanTop && s.type === "ai" && (p.scanTop ?? 0) > 0) return { strategy: s, coin: s.coin };
    const hit = claimedCoins(s).find((c) => want.coins?.includes(c));
    if (hit) return { strategy: s, coin: hit };
  }
  return null;
}

/**
 * Validates a basket from a request body: `coins` (array or "BTC,ETH") or
 * `scanTop` (how many of the most-traded perps to scan each round).
 * Null when the body asks for neither, i.e. a single-coin bot.
 */
function parseBasket(body: Record<string, unknown>): { coins?: string[]; scanTop?: number; label: string } | { error: string } | null {
  const rawCoins = typeof body.coins === "string" ? body.coins.split(/[\s,/]+/) : Array.isArray(body.coins) ? body.coins : null;
  if (rawCoins && rawCoins.filter((c) => String(c ?? "").trim()).length) {
    const coins = [...new Set(rawCoins.map(cleanTrainCoin).filter((c): c is string => c != null))];
    if (coins.length !== rawCoins.filter((c) => String(c ?? "").trim()).length) return { error: "every coin must be a perp symbol such as BTC" };
    if (coins.length < 2 || coins.length > MULTI_MAX_COINS) return { error: `a basket needs 2 to ${MULTI_MAX_COINS} coins` };
    return { coins, label: coins.join("/") };
  }
  if (body.scanTop != null && body.scanTop !== "") {
    const n = Number(body.scanTop);
    if (!Number.isInteger(n) || n < 2 || n > MULTI_MAX_COINS) return { error: `scanTop must be a whole number from 2 to ${MULTI_MAX_COINS}` };
    return { scanTop: n, label: `TOP${n}` };
  }
  return null;
}

/**
 * The coins this round looks at. A fixed basket is its list (minus anything
 * delisted). A scan takes the N most-traded perps no other bot of this agent
 * claims, and always keeps the coins it already holds so it can manage them.
 */
export function pickBasketCoins(params: AiParams, market: { coin: string }[], held: string[], taken: Set<string>): string[] {
  const tradeable = new Set(market.map((m) => m.coin));
  if (params.coins?.length) return params.coins.filter((c) => tradeable.has(c));
  const n = Math.min(params.scanTop ?? 0, MULTI_MAX_COINS);
  const mine = held.filter((c) => tradeable.has(c) && (params.owned ?? []).includes(c));
  const top = market.map((m) => m.coin).filter((c) => !taken.has(c) && !mine.includes(c)).slice(0, Math.max(0, n - mine.length));
  return [...mine, ...top];
}

async function coinsTakenByOtherBots(strategy: Strategy): Promise<Set<string>> {
  const others = (await getStrategies(strategy.agentId))
    .filter((s) => s.id !== strategy.id && s.enabled && (s.type === "ai" || s.type === "pairs") && s.paper === strategy.paper);
  return new Set(others.flatMap(claimedCoins));
}

/** Equity and every open position — from the paper account, or read off Hyperliquid for the agent's wallet. */
async function basketAccountState(strategy: Strategy): Promise<
  { accountValue: number; network: HlNetwork; held: Record<string, { position: AiPosition; notionalUsd: number }> } | { error: string }
> {
  if (strategy.paper) {
    const summary = await getPaperSummary(strategy.agentId, strategy.orgId);
    return {
      accountValue: summary.equity,
      network: PAPER_NETWORK,
      held: Object.fromEntries(summary.positions.map((p) => [p.coin, {
        position: { isLong: p.szi > 0, size: p.szi, entryPx: p.entryPx, unrealizedPnl: p.unrealizedPnl }, notionalUsd: p.notionalUsd,
      }])),
    };
  }
  const wallet = await getTradingWallet(strategy.agentId);
  if (!wallet?.address) return { error: "This agent has no trading wallet yet." };
  const { state, accountValue } = await accountEquity(wallet.address, wallet.network);
  const held: Record<string, { position: AiPosition; notionalUsd: number }> = {};
  for (const a of state.assetPositions) {
    const h = positionFor(state, a.position.coin);
    if (h) held[a.position.coin] = h;
  }
  return { accountValue, network: wallet.network, held };
}

/** Places one basket action now. Live needs instant trading — a basket can't wait on a passphrase per coin. */
async function executeBasketAction(
  strategy: Strategy,
  coin: string,
  action: AiAction,
  pos: AiHeld | null,
): Promise<{ taskId: string | null; error: string | null; params?: AiParams }> {
  try {
    await enforceCapability(strategy.agentId, strategy.orgId, "hyperliquid-trade");
  } catch (err) {
    return { taskId: null, error: (err as Error).message };
  }
  let signer: Signer | null = null;
  if (!strategy.paper) {
    if (!(await getInstantTrading(strategy.agentId))) {
      return { taskId: null, error: "A live basket bot trades only with instant trading on for this agent" };
    }
    signer = await resolveSigningKey(strategy.agentId);
  }
  const placed = await placeAiAction(strategy, action, pos, signer, coin);
  if (!placed) return { taskId: null, error: null };
  if ("error" in placed) return { taskId: null, error: placed.error };
  return { taskId: placed.taskId, error: null, ...(placed.params ? { params: placed.params } : {}) };
}

/** Which coins the bot holds after an action — opens and flips add, closes remove. */
function ownedAfter(owned: string[], coin: string, action: AiAction): string[] {
  if (action === "close") return owned.filter((c) => c !== coin);
  if (action === "hold") return owned;
  return owned.includes(coin) ? owned : [...owned, coin];
}

const SCANNER_TTL_MS = 60_000;
const SCANNER_PAIR_BARS = 168;
const scannerCache = new Map<string, { at: number; value: ScannerResult & { coins: string[]; interval: string } }>();

const SPOT_TTL_MS = 60_000;
let spotCache: { at: number; value: Map<string, SpotMarket> } | null = null;

/** Every perp's USDC spot market on Hyperliquid mainnet (BTC → UBTC "@142"). Cached a minute. */
async function getSpotMarkets(): Promise<Map<string, SpotMarket>> {
  if (spotCache && Date.now() - spotCache.at < SPOT_TTL_MS) return spotCache.value;
  const [[meta, ctxs], coins] = await Promise.all([
    hlInfo<[{ tokens: SpotToken[]; universe: SpotPair[] }, SpotCtx[]]>({ type: "spotMetaAndAssetCtxs" }, PAPER_NETWORK),
    getUniverseCoins(PAPER_NETWORK),
  ]);
  spotCache = { at: Date.now(), value: mapSpotMarkets(coins, meta, ctxs) };
  return spotCache.value;
}

/** Book imbalance within ±0.5% of the mid, or null when the book can't be read. */
async function bookImbalanceFor(coin: string, network: HlNetwork, book?: { levels?: { px: string; sz: string }[][] } | null): Promise<number | null> {
  const b = book ?? await hlInfo<{ levels?: { px: string; sz: string }[][] }>({ type: "l2Book", coin }, network).catch(() => null);
  if (!b?.levels) return null;
  const side = (l: { px: string; sz: string }[] = []) => l.map((x) => ({ px: Number(x.px), sz: Number(x.sz) }));
  return bookImbalance(coin, side(b.levels[0]), side(b.levels[1]), 0.5).imbalance;
}

/** How long an AI round waits on CoinMarketCap before asking without it. */
const CMC_WAIT_MS = 5_000;

/** CoinMarketCap lines for `coins` and the whole market; empty when no key is set or CMC is slow. */
async function cmcFor(coins: string[]): Promise<{ coin: Map<string, string>; global: string | null }> {
  const empty = { coin: new Map<string, string>(), global: null };
  const work = (async () => {
    const universe = await getUniverseCoins(PAPER_NETWORK).catch(() => coins);
    const [contexts, global] = await Promise.all([getCoinContexts(universe), getGlobalContext()]);
    const coin = new Map<string, string>();
    for (const c of coins) {
      const line = coinContextLine(contexts?.get(c));
      if (line) coin.set(c, line);
    }
    return { coin, global: globalContextLine(global) };
  })().catch(() => empty);
  return Promise.race([work, new Promise<typeof empty>((r) => setTimeout(() => r(empty), CMC_WAIT_MS))]);
}

async function getPredictedFundings(network: HlNetwork) {
  const raw = await hlInfo<PredictedFundingsRaw>({ type: "predictedFundings" }, network).catch(() => [] as PredictedFundingsRaw);
  return parsePredictedFundings(raw);
}

/**
 * Whole-market funding arbs and premium outliers, plus pair spreads among
 * `coins` (default: the 8 most-traded perps). Cached a minute per query.
 */
async function scanMarket(network: HlNetwork, coins: string[] | null, interval: string) {
  const key = `${network}|${interval}|${coins?.join(",") ?? "top"}`;
  const hit = scannerCache.get(key);
  if (hit && Date.now() - hit.at < SCANNER_TTL_MS) return hit.value;
  const [market, fundings] = await Promise.all([getMarketOverview(network), getPredictedFundings(network)]);
  const tradeable = new Set(market.map((m) => m.coin));
  const pairCoins = (coins ?? market.slice(0, MULTI_MAX_COINS).map((m) => m.coin)).filter((c) => tradeable.has(c)).slice(0, 12);
  const candles = Object.fromEntries(await Promise.all(pairCoins.map(async (c) =>
    [c, await fetchCandles(c, interval, SCANNER_PAIR_BARS, network).catch(() => [] as Candle[])] as const)));
  const value = {
    coins: pairCoins,
    interval,
    fundingArbs: findFundingArbs(fundings, new Map(market.map((m) => [m.coin, m.volume24hUsd]))),
    premiums: findPremiumOutliers(market),
    pairs: findPairSpreads(candles, { minCorrelation: 0.6 }),
    // Spot markets are mainnet-only; testnet's spot books are empty.
    basis: network === "mainnet" ? findBasis(market, await getSpotMarkets().catch(() => new Map())) : [],
    imbalances: (await Promise.all(pairCoins.map(async (c) => {
      const b = await hlInfo<{ levels?: { px: string; sz: string }[][] }>({ type: "l2Book", coin: c }, network).catch(() => null);
      if (!b?.levels) return null;
      const side = (l: { px: string; sz: string }[] = []) => l.map((x) => ({ px: Number(x.px), sz: Number(x.sz) }));
      return bookImbalance(c, side(b.levels[0]), side(b.levels[1]), 0.5);
    }))).filter((x): x is NonNullable<typeof x> => x != null),
  };
  scannerCache.set(key, { at: Date.now(), value });
  return value;
}

/** One basket round: same lifecycle as runAiStrategy, across every coin in the basket. */
async function runBasketStrategy(strategy: Strategy): Promise<"asked" | "decided" | "skipped" | "error"> {
  const params = strategy.params as AiParams;
  const record = recordFor(strategy.id);

  if (params.openRequestId) {
    const open = await getAiRequest(params.openRequestId);
    if (open?.status === "open" && open.expiresAt.getTime() > Date.now()) return "skipped";
    if (open?.status === "open") await expireAiRequest(open.id);
    await touchStrategyRun(strategy.id, { ...params, openRequestId: null });
    if (open?.status !== "answered") {
      await record({ error: "The agent didn't answer this round in time — is its daemon (agent-guild daemon) running?" });
    }
    return "skipped";
  }

  const acct = await basketAccountState(strategy);
  if ("error" in acct) {
    await touchStrategyRun(strategy.id);
    await record({ error: acct.error });
    return "error";
  }
  const { accountValue, held, network } = acct;

  // Live flips: open each coin's new side once its close has filled.
  const flips = params.flips ?? {};
  if (Object.keys(flips).length) {
    const left: Record<string, "long" | "short"> = {};
    let current: AiParams = params;
    let opened = false;
    for (const [coin, side] of Object.entries(flips)) {
      const h = held[coin];
      if (h && h.position.isLong === (side === "long")) continue;
      if (h) {
        if (Date.now() - (strategy.lastRunAt?.getTime() ?? 0) > FLIP_GIVE_UP_MS) {
          await record({ coin, error: "The flip's close never filled — gave up opening the new side." });
        } else left[coin] = side;
        continue;
      }
      const action: AiAction = side === "long" ? "open-long" : "open-short";
      const sent = await executeBasketAction({ ...strategy, params: { ...current, flips: {} } }, coin, action, null);
      current = { ...current, owned: ownedAfter(current.owned ?? [], coin, action) };
      opened = true;
      await record({ coin, action, reasoning: "Second half of the flip — opening the new side.", equity: accountValue, taskId: sent.taskId, error: sent.error });
    }
    await touchStrategyRun(strategy.id, { ...current, flips: left });
    if (Object.keys(left).length) return "skipped";
    if (opened) return "decided";
    strategy = { ...strategy, params: { ...current, flips: {} } };
  }
  const p = strategy.params as AiParams;

  await touchStrategyRun(strategy.id);

  const mine = (c: string) => (p.coins?.length ? p.coins.includes(c) : (p.owned ?? []).includes(c));
  const startEquity = p.startEquity ?? (accountValue > 0 ? accountValue : undefined);
  if (startEquity != null && accountValue <= startEquity * (1 - p.maxDrawdownPct / 100)) {
    for (const coin of Object.keys(held).filter(mine)) {
      const sent = await executeBasketAction(strategy, coin, "close", heldFor(held[coin]));
      await record({ coin, action: "close", reasoning: "Eliminated — closing.", equity: accountValue, taskId: sent.taskId, error: sent.error });
    }
    await touchStrategyRun(strategy.id, { ...p, startEquity, eliminated: true, owned: [] });
    await toggleStrategy(strategy.id, false);
    await record({
      reasoning: `Eliminated: equity ${accountValue.toFixed(2)} is ${p.maxDrawdownPct}% or more below the starting ${startEquity.toFixed(2)}.`,
      equity: accountValue,
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

  const [market, fundings, taken] = await Promise.all([
    getMarketOverview(network),
    getPredictedFundings(network),
    coinsTakenByOtherBots(strategy),
  ]);
  const picked = pickBasketCoins(p, market, Object.keys(held), taken);
  const interval = candleIntervalFor(p.intervalMs);
  const fetched = await Promise.all(picked.map(async (c) => [c, await fetchCandles(c, interval, AI_SNAPSHOT_HISTORY, network).catch(() => [] as Candle[])] as const));
  const candles = Object.fromEntries(fetched.filter(([, k]) => k.length >= 20));
  const coins = picked.filter((c) => candles[c]);
  if (!coins.length) {
    await record({ error: "No coin in this basket has enough price history to decide." });
    return "error";
  }
  const byCoin = new Map(market.map((m) => [m.coin, m]));
  const [cmc, imbalances] = await Promise.all([
    cmcFor(coins),
    Promise.all(coins.map((c) => bookImbalanceFor(c, network))),
  ]);
  const blocks = coins.map((c, i) => buildCoinBlock({
    coin: c, candles: candles[c], interval,
    fundingRatePct: byCoin.get(c)?.fundingRatePct ?? null,
    openInterestUsd: byCoin.get(c)?.openInterestUsd ?? null,
    premiumPct: byCoin.get(c)?.premiumPct ?? null,
    bookImbalance: imbalances[i],
    marketContext: cmc.coin.get(c) ?? null,
  }));
  const inBasket = new Set(coins);
  const scan = scannerSection({
    fundingArbs: findFundingArbs(new Map([...fundings].filter(([c]) => inBasket.has(c))), new Map(), { minSpreadAprPct: 5, minVolumeUsd: 0, limit: coins.length }),
    premiums: findPremiumOutliers(market.filter((m) => inBasket.has(m.coin)), { minAbsPremiumPct: 0.05, minVolumeUsd: 0, limit: coins.length }),
    pairs: findPairSpreads(candles, { minCorrelation: 0.6, limit: 6 }),
  });
  const positions = Object.fromEntries(coins.filter((c) => held[c]).map((c) => [c, held[c].position]));
  const intel = await intelFor(coins);
  const requestId = await createAiRequest({
    agentId: strategy.agentId, orgId: strategy.orgId, purpose: "live", strategyId: strategy.id,
    coin: strategy.coin, coins,
    ...multiDecisionRequest(coins, blocks, [scan, intel].filter(Boolean).join("\n\n"), positions, p.goal, new Date(), cmc.global),
    expiresAt: new Date(Date.now() + aiAnswerWindow(strategy.paper, p.intervalMs)),
  });
  await touchStrategyRun(strategy.id, { ...p, ...(startEquity != null ? { startEquity } : {}), openRequestId: requestId });
  return "asked";
}

/** The agent answered a basket round: trade each coin it named, against positions re-read now. */
async function applyBasketAnswer(
  req: AiRequest,
  decisions: Record<string, Exclude<AiDecision, "NOTHING">>,
  reasoning: string,
): Promise<{ actions: { coin: string; action: AiAction; taskId: string | null; error: string | null }[]; error?: string }> {
  const strategy = req.strategyId ? await getStrategy(req.strategyId) : null;
  if (!strategy || !isBasket(strategy)) return { actions: [], error: "Bot no longer exists" };
  let params = strategy.params as AiParams;
  if (params.openRequestId === req.id) params = { ...params, openRequestId: null };
  const record = recordFor(strategy.id);
  if (!strategy.enabled) {
    await touchStrategyRun(strategy.id, params);
    await record({ reasoning, error: "Bot was stopped before the answer arrived — not traded." });
    return { actions: [], error: "Bot is stopped" };
  }
  const acct = await basketAccountState(strategy);
  if ("error" in acct) {
    await touchStrategyRun(strategy.id, params);
    await record({ reasoning, error: acct.error });
    return { actions: [], error: acct.error };
  }
  const allowed = new Set(req.coins ?? []);
  const actions: { coin: string; action: AiAction; taskId: string | null; error: string | null }[] = [];
  for (const [coin, decision] of Object.entries(decisions)) {
    if (!allowed.has(coin)) continue;
    const h = acct.held[coin] ?? null;
    const action = decisionToAction(decision, h?.position ?? null);
    const sent = action === "hold"
      ? { taskId: null, error: null }
      : await executeBasketAction({ ...strategy, params }, coin, action, heldFor(h));
    if ("params" in sent && sent.params) params = sent.params;
    if (!sent.error) params = { ...params, owned: ownedAfter(params.owned ?? [], coin, action) };
    const price = await getMidPrice(coin, acct.network).catch(() => null);
    await record({ coin, decision, action, reasoning, model: "agent", price, equity: acct.accountValue, taskId: sent.taskId, error: sent.error });
    actions.push({ coin, action, taskId: sent.taskId, error: sent.error });
  }
  if (!actions.length) {
    await record({ decision: "NOTHING", action: "hold", reasoning, model: "agent", equity: acct.accountValue });
  }
  await touchStrategyRun(strategy.id, params);
  return { actions };
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
      if (p.flipTo || p.openRequestId || Object.keys(p.flips ?? {}).length) return true;
      return now - (s.lastRunAt?.getTime() ?? 0) >= p.intervalMs;
    });

  const results = await Promise.allSettled(due.map((s) => (isBasket(s) ? runBasketStrategy(s) : runAiStrategy(s))));
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

// ── Pairs arbitrage bot ──────────────────────────────────────────────────────
//
// Rule-based stat-arb (./pairs.ts): enter the most stretched correlated pair,
// exit both legs together on convergence, stop or timeout. Two legs have to
// move together, so it runs on paper or with instant trading — never as a
// pending signal waiting on a passphrase per leg.

/** How often a pairs bot re-checks its spread: once a bar, at most every 15 minutes. */
function pairsCadenceMs(interval: string): number {
  return Math.min(CANDLE_INTERVAL_MS[interval] ?? 3_600_000, 15 * 60_000);
}
/** A live leg's order rides the task queue; until this long after opening, a missing leg may just be unfilled. */
const PAIRS_FILL_GRACE_MS = 2 * 60_000;

/** The coins a bot trades on its agent's account — two bots never share one. */
function claimedCoins(s: Strategy): string[] {
  if (s.type === "pairs") return ((s.params ?? {}) as StoredPairsParams).coins ?? [];
  if (s.type === "ai") return aiCoinsOf(s);
  return [s.coin];
}

/** Direction and SL/TP shared by dca/grid/sniper. Absent fields stay absent. */
function buildRuleExtras(raw: Record<string, unknown> | undefined): RuleBotExtras | { error: string } {
  const out: RuleBotExtras = {};
  if (raw?.direction != null && raw.direction !== "") {
    if (raw.direction !== "long" && raw.direction !== "short") return { error: "params.direction must be long or short" };
    if (raw.direction === "short") out.direction = "short";
  }
  for (const k of ["stopLossPct", "takeProfitPct"] as const) {
    if (raw?.[k] == null || raw[k] === "" || Number(raw[k]) === 0) continue;
    const v = Number(raw[k]);
    if (!(v > 0 && v < (k === "stopLossPct" ? 100 : 1000))) return { error: `params.${k} must be a positive percent${k === "stopLossPct" ? " under 100" : ""}` };
    out[k] = v;
  }
  return out;
}

/** DCA settings: interval, the rule extras and an optional smart block. */
function buildDcaParams(raw: Record<string, unknown> | undefined): DcaParams | { error: string } {
  const intervalMs = Number(raw?.intervalMs);
  if (!(intervalMs >= 60_000)) return { error: "params.intervalMs must be at least 60000 (1 minute)" };
  const extras = buildRuleExtras(raw);
  if ("error" in extras) return extras;
  const smart = buildSmartDca(raw?.smart);
  if (smart && "error" in smart) return smart;
  return { intervalMs, ...extras, ...(smart ? { smart } : {}) };
}

/** An edit's merged settings, checked with the same per-type rules POST /strategy uses. Runtime state is added back by the caller. */
function validateBotSettings(strategy: Strategy, settings: Record<string, unknown>): Record<string, unknown> | { error: string } {
  const s = settings;
  switch (strategy.type) {
    case "dca": {
      const built = buildDcaParams(s);
      return "error" in built ? built : { ...built };
    }
    case "grid": {
      const lowerPrice = Number(s.lowerPrice), upperPrice = Number(s.upperPrice), levels = Number(s.levels);
      if (!(lowerPrice > 0 && upperPrice > lowerPrice)) return { error: "params.lowerPrice must be above 0 and below upperPrice" };
      if (!(Number.isInteger(levels) && levels >= 2)) return { error: "params.levels must be a whole number of at least 2" };
      const extras = buildRuleExtras(s);
      return "error" in extras ? extras : { lowerPrice, upperPrice, levels, ...extras };
    }
    case "signal":
      if (s.direction != null && s.direction !== "buy" && s.direction !== "sell") return { error: "params.direction must be buy or sell" };
      return s.direction ? { direction: s.direction } : {};
    case "sniper": {
      if (!["new-listing", "price-above", "price-below"].includes(String(s.mode))) {
        return { error: "params.mode must be new-listing, price-above, or price-below" };
      }
      const extras = buildRuleExtras(s);
      if ("error" in extras) return extras;
      if (s.mode === "new-listing") return { mode: s.mode, ...extras };
      if (strategy.coin === "ANY") return { error: "coin \"ANY\" is only valid for new-listing sniper mode" };
      if (!(Number(s.targetPrice) > 0)) return { error: "params.targetPrice is required for price-above/price-below sniper modes" };
      return { mode: s.mode, targetPrice: Number(s.targetPrice), ...extras };
    }
    case "ai": {
      const built = buildAiParams(s, strategy.paper ? PAPER_MIN_INTERVAL_MS : AI_MIN_INTERVAL_MS);
      return "error" in built ? built : { ...built };
    }
    case "pairs": {
      const built = buildPairsParams({ ...s, coins: (strategy.params as StoredPairsParams).coins }, cleanTrainCoin);
      if ("error" in built) return built;
      if (!CANDLE_INTERVAL_MS[built.interval]) {
        return { error: `params.interval must be one of ${Object.keys(CANDLE_INTERVAL_MS).join(", ")}` };
      }
      return { ...built };
    }
    case "breakout": {
      const built = buildBreakoutParams(s, Object.keys(CANDLE_INTERVAL_MS));
      const lev = Number(s.leverage);
      return "error" in built ? built : { ...built, ...(lev > 1 ? { leverage: lev } : {}) };
    }
    case "basis": {
      const built = buildBasisParams(s, strategy.coin);
      return "error" in built ? built : { ...built };
    }
    default:
      return { error: `${strategy.type} bots can't be edited` };
  }
}

interface StopAllOutcome {
  stopped: { id: string; agentId: string; type: string; coin: string; paper: boolean }[];
  closed: { agentId: string; coin: string; paper: boolean; taskId: string }[];
  leftOpen: { agentId: string; coin: string; paper: boolean; reason: string }[];
}

/**
 * Market-closes an agent's positions in `coins` on one account: the paper
 * account, or the live wallet when instant trading can sign without a
 * passphrase. Anything it can't close is reported, never skipped silently.
 */
async function flattenCoins(agentId: string, orgId: string, coins: Set<string>, paper: boolean, out: StopAllOutcome): Promise<void> {
  const leave = (coin: string, reason: string) => out.leftOpen.push({ agentId, coin, paper, reason });
  if (paper) {
    for (const o of await listPaperOrders(agentId)) {
      if (coins.has(o.coin)) await deletePaperOrder(o.id);
    }
    for (const p of await listPaperPositions(agentId)) {
      if (!coins.has(p.coin)) continue;
      const r = await placePaperOrder({ orgId, agentId, coin: p.coin, isBuy: p.szi < 0, sz: Math.abs(p.szi), sizeUsd: Math.abs(p.szi) * p.entryPx, reduceOnly: true });
      if ("error" in r) leave(p.coin, r.error);
      else out.closed.push({ agentId, coin: p.coin, paper, taskId: r.taskId });
    }
    return;
  }
  const wallet = await getTradingWallet(agentId);
  if (!wallet?.address) return;
  const state = await hlInfo<ClearinghouseState>({ type: "clearinghouseState", user: wallet.address }, wallet.network);
  const open = state.assetPositions.filter((p) => coins.has(p.position.coin) && Number(p.position.szi) !== 0);
  if (!open.length) return;
  if (!wallet.instant) {
    for (const p of open) leave(p.position.coin, "Live close needs the wallet passphrase — close it from Positions");
    return;
  }
  try {
    await enforceCapability(agentId, orgId, "hyperliquid-close");
  } catch (err) {
    for (const p of open) leave(p.position.coin, (err as Error).message);
    return;
  }
  const { privateKey, network } = await resolveSigningKey(agentId);
  for (const p of open) {
    const isLong = Number(p.position.szi) > 0;
    const r = await enforceRiskAndEnqueue({
      orgId, agentId, coin: p.position.coin, isBuy: !isLong, sizeUsd: Math.abs(Number(p.position.positionValue)),
      privateKey, network, orderType: "market", reduceOnly: true,
    });
    if ("error" in r) leave(p.position.coin, String(r.error));
    else out.closed.push({ agentId, coin: p.position.coin, paper, taskId: r.taskId });
  }
}

async function runPairsStrategy(strategy: Strategy): Promise<"opened" | "closed" | "held" | "error"> {
  const params = strategy.params as StoredPairsParams;
  const record = recordFor(strategy.id);
  const open = params.open ?? null;
  const now = Date.now();
  const due = now - (strategy.lastRunAt?.getTime() ?? 0) >= pairsCadenceMs(params.interval);
  // A pair with a missing leg is checked every tick, not once a bar.
  if (!due && !open) return "held";

  let signer: Signer | null = null;
  try {
    await enforceCapability(strategy.agentId, strategy.orgId, "hyperliquid-trade");
    if (!strategy.paper) {
      if (!(await getInstantTrading(strategy.agentId))) throw new Error("A live pairs bot trades only with instant trading on for this agent");
      signer = await resolveSigningKey(strategy.agentId);
    }
  } catch (err) {
    await touchStrategyRun(strategy.id, { ...params, lastNote: (err as Error).message });
    if (due) await record({ coin: strategy.coin, error: (err as Error).message });
    return "error";
  }

  const acct = await basketAccountState(strategy);
  if ("error" in acct) {
    await touchStrategyRun(strategy.id, { ...params, lastNote: acct.error });
    return "error";
  }
  const isHeld = (coin: string, long: boolean) => {
    const h = acct.held[coin];
    return !!h && h.position.isLong === long;
  };
  const settling = open != null && now - open.openedAt < PAIRS_FILL_GRACE_MS;
  const heldLegs = open && !settling ? { long: isHeld(open.longLeg, true), short: isHeld(open.shortLeg, false) } : undefined;
  if (!due && !(heldLegs && (!heldLegs.long || !heldLegs.short))) return "held";

  const coins = open ? [open.a, open.b] : params.coins;
  const fetched = await Promise.all(coins.map(async (c) =>
    [c, await fetchCandles(c, params.interval, params.lookbackBars + 2, acct.network).catch(() => [] as Candle[])] as const));
  const decision = decidePairs(params, Object.fromEntries(fetched), open, strategy.sizeUsd, now, heldLegs, CANDLE_INTERVAL_MS[params.interval]);

  if (decision.action === "hold") {
    await touchStrategyRun(strategy.id, { ...params, lastZ: decision.z, lastNote: decision.reason });
    return "held";
  }

  if (decision.action === "close" && open) {
    const outcomes: { coin: string; taskId: string | null; error: string | null }[] = [];
    for (const coin of [open.longLeg, open.shortLeg]) {
      const h = acct.held[coin];
      if (!h) continue;
      const sent = await sendStrategyOrder(strategy, signer, {
        coin, isBuy: !h.position.isLong, sizeUsd: h.notionalUsd, reduceOnly: true, sz: Math.abs(h.position.size),
      });
      outcomes.push({ coin, taskId: "error" in sent ? null : sent.taskId, error: "error" in sent ? sent.error : null });
    }
    const failed = outcomes.filter((o) => o.error);
    // A refused close keeps the pair on record so the next tick tries again.
    await touchStrategyRun(strategy.id, { ...params, open: failed.length ? open : null, lastZ: decision.z, lastNote: decision.reason });
    await record({
      coin: strategy.coin, action: "close", reasoning: decision.reason, equity: acct.accountValue,
      taskId: outcomes.map((o) => o.taskId).filter(Boolean).join(",") || null,
      error: failed.length ? failed.map((o) => `${o.coin}: ${o.error}`).join("; ") : null,
    });
    return failed.length ? "error" : "closed";
  }

  if (decision.action !== "open") return "held";
  const { pair, longUsd, shortUsd } = decision;
  const taken = new Set((await getStrategies(strategy.agentId))
    .filter((s) => s.id !== strategy.id && s.enabled && s.paper === strategy.paper)
    .flatMap(claimedCoins));
  const clash = [pair.longLeg, pair.shortLeg].find((c) => taken.has(c) || acct.held[c]);
  if (clash) {
    const note = `${pair.a}/${pair.b} is stretched, but ${clash} already has a position or another bot — skipping.`;
    await touchStrategyRun(strategy.id, { ...params, lastZ: pair.z, lastNote: note });
    return "held";
  }
  const longSent = await sendStrategyOrder(strategy, signer, { coin: pair.longLeg, isBuy: true, sizeUsd: longUsd });
  if ("error" in longSent) {
    await touchStrategyRun(strategy.id, { ...params, lastZ: pair.z, lastNote: `Long ${pair.longLeg} refused: ${longSent.error}` });
    await record({ coin: strategy.coin, action: "open", reasoning: decision.reason, error: `Long ${pair.longLeg} refused: ${longSent.error}` });
    return "error";
  }
  const shortSent = await sendStrategyOrder(strategy, signer, { coin: pair.shortLeg, isBuy: false, sizeUsd: shortUsd });
  const opened: OpenPair = { a: pair.a, b: pair.b, longLeg: pair.longLeg, shortLeg: pair.shortLeg, entryZ: pair.z, beta: pair.beta, openedAt: now };
  // If the short leg was refused, the pair is still recorded: the next check
  // finds the short leg missing and closes the long, so it is never held alone.
  await touchStrategyRun(strategy.id, { ...params, open: opened, lastZ: pair.z, lastNote: decision.reason });
  await record({
    coin: strategy.coin, action: "open", reasoning: decision.reason, equity: acct.accountValue,
    taskId: [longSent.taskId, "error" in shortSent ? null : shortSent.taskId].filter(Boolean).join(","),
    error: "error" in shortSent ? `Short ${pair.shortLeg} refused: ${shortSent.error} — the long will be closed next check.` : null,
  });
  return "opened";
}

// ── Breakout bot ────────────────────────────────────────────────────────────
//
// Rule-based squeeze breakout (./breakout.ts), checked once a bar on closed
// bars only. Opens and closes need no passphrase prompt mid-trade, so like
// pairs it runs on paper or with instant trading.

async function runBreakoutStrategy(strategy: Strategy): Promise<"opened" | "closed" | "held" | "error"> {
  const params = strategy.params as StoredBreakoutParams;
  const barMs = CANDLE_INTERVAL_MS[params.interval] ?? 3_600_000;
  const now = Date.now();
  if (now - (strategy.lastRunAt?.getTime() ?? 0) < pairsCadenceMs(params.interval)) return "held";
  const record = recordFor(strategy.id);

  let signer: Signer | null = null;
  try {
    await enforceCapability(strategy.agentId, strategy.orgId, "hyperliquid-trade");
    if (!strategy.paper) {
      if (!(await getInstantTrading(strategy.agentId))) throw new Error("A live breakout bot trades only with instant trading on for this agent");
      signer = await resolveSigningKey(strategy.agentId);
    }
  } catch (err) {
    await touchStrategyRun(strategy.id, { ...params, lastNote: (err as Error).message });
    return "error";
  }
  const acct = await basketAccountState(strategy);
  if ("error" in acct) {
    await touchStrategyRun(strategy.id, { ...params, lastNote: acct.error });
    return "error";
  }
  // Closed bars only: the backtest decides at each bar's close, so the live bot does too.
  const raw = await fetchCandles(strategy.coin, params.interval, breakoutHistory(params) + 2, acct.network).catch(() => [] as Candle[]);
  const candles = raw.filter((c) => c.t + barMs <= now).slice(-breakoutHistory(params));
  const h = acct.held[strategy.coin];
  const decision = decideBreakout(params, candles, h ? { isLong: h.position.isLong } : null);

  if (decision.action === "hold") {
    await touchStrategyRun(strategy.id, { ...params, lastNote: decision.reason });
    return "held";
  }
  const price = candles[candles.length - 1]?.c ?? null;
  const sent = decision.action === "close"
    ? (h ? await sendStrategyOrder(strategy, signer, { coin: strategy.coin, isBuy: !h.position.isLong, sizeUsd: h.notionalUsd, reduceOnly: true, sz: Math.abs(h.position.size) }) : null)
    : await sendStrategyOrder(strategy, signer, {
      coin: strategy.coin, isBuy: decision.action === "open-long", sizeUsd: strategy.sizeUsd,
      leverage: (params as { leverage?: number }).leverage, stopLossPct: params.stopLossPct, takeProfitPct: params.takeProfitPct,
    });
  const error = sent && "error" in sent ? sent.error : null;
  await touchStrategyRun(strategy.id, { ...params, lastNote: error ? `${decision.reason} — refused: ${error}` : decision.reason });
  await record({
    coin: strategy.coin, action: decision.action, reasoning: decision.reason, price, equity: acct.accountValue,
    taskId: sent && !("error" in sent) ? sent.taskId : null, error,
  });
  if (error) return "error";
  return decision.action === "close" ? "closed" : "opened";
}

// ── Basis bot (paper) ───────────────────────────────────────────────────────
//
// Cash and carry (./basis.ts): long Hyperliquid spot, short the same size of
// the perp, collect funding. Paper only — live spot orders aren't wired yet.

const BASIS_CADENCE_MS = 5 * 60_000;

/** One paper spot market order against the real mainnet spot book. */
async function placePaperSpotOrder(p: {
  orgId: string; agentId: string; strategyId: string; market: SpotMarket; isBuy: boolean; sizeUsd?: number; sz?: number;
}): Promise<{ taskId: string; sz: number; avgPx: number } | { error: string }> {
  let book: { levels?: { px: string; sz: string }[][] };
  let perps: PaperMarket;
  try {
    [book, perps] = await Promise.all([hlInfo<typeof book>({ type: "l2Book", coin: p.market.pair }, PAPER_NETWORK), getPaperMarket()]);
  } catch (err) {
    return { error: `Couldn't read the ${p.market.token} spot book: ${(err as Error).message}` };
  }
  const mid = perps.mids[p.market.pair] || p.market.midPx;
  const sz = roundSize(p.sz ?? (p.sizeUsd ?? 0) / mid, p.market.szDecimals);
  if (!(sz > 0)) return { error: `Order rounds to zero ${p.market.token}` };
  const limitPx = p.isBuy ? mid * (1 + MARKET_SLIPPAGE) : mid * (1 - MARKET_SLIPPAGE);
  const side = (p.isBuy ? book.levels?.[1] : book.levels?.[0]) ?? [];
  const walk = walkBook(side.map((l) => ({ px: Number(l.px), sz: Number(l.sz) })), sz, p.isBuy, limitPx, p.market.szDecimals);
  if (!(walk.sz > 0)) return { error: `No ${p.market.token} spot liquidity within ${MARKET_SLIPPAGE * 100}% of the mid` };
  const booked = await bookPaperSpotFill(
    p.agentId,
    { pair: p.market.pair, token: p.market.token, isBuy: p.isBuy, sz: walk.sz, px: walk.avgPx, feeRate: SPOT_TAKER_FEE_RATE, szDecimals: p.market.szDecimals },
    perps.mids, perps.meta,
    { orgId: p.orgId, reason: "strategy", strategyId: p.strategyId },
  );
  if ("error" in booked) return booked;
  return { taskId: booked.tradeId, sz: booked.sz, avgPx: walk.avgPx };
}

async function runBasisStrategy(strategy: Strategy): Promise<"opened" | "closed" | "held" | "error"> {
  const params = strategy.params as StoredBasisParams;
  const open = params.open ?? null;
  const now = Date.now();
  if (now - (strategy.lastRunAt?.getTime() ?? 0) < BASIS_CADENCE_MS) return "held";
  const record = recordFor(strategy.id);
  if (!strategy.paper) {
    await touchStrategyRun(strategy.id, { ...params, lastNote: "Basis bots run on paper only for now." });
    return "error";
  }

  const [market, spots, summary] = await Promise.all([
    getMarketOverview(PAPER_NETWORK),
    getSpotMarkets(),
    getPaperSummary(strategy.agentId, strategy.orgId),
  ]);
  const spot = spots.get(strategy.coin) ?? null;
  const row = findBasis(market.filter((m) => m.coin === strategy.coin), spots, { minSpotVolumeUsd: 0 })[0] ?? null;
  const perp = summary.positions.find((p) => p.coin === strategy.coin);
  const held = spot ? summary.account.spot?.[spot.token] : undefined;

  // A leg gone (perp stopped or liquidated, spot sold by hand) unwinds the other.
  const legMissing = open != null && (!perp || perp.szi >= 0 || !held);
  const decision = legMissing
    ? { action: "close" as const, reason: `A leg of the ${strategy.coin} carry is gone — unwinding the other.` }
    : decideBasis(params, row, open, now);

  if (decision.action === "hold") {
    await touchStrategyRun(strategy.id, { ...params, lastNote: decision.reason, lastAprPct: row?.fundingAprPct ?? null });
    return "held";
  }

  if (decision.action === "close") {
    const errors: string[] = [];
    const ids: string[] = [];
    if (perp && perp.szi < 0) {
      const r = await placePaperOrder({ orgId: strategy.orgId, agentId: strategy.agentId, strategyId: strategy.id, coin: strategy.coin, isBuy: true, sz: Math.abs(perp.szi), sizeUsd: perp.notionalUsd, reduceOnly: true });
      if ("error" in r) errors.push(`perp: ${r.error}`);
      else ids.push(r.taskId);
    }
    if (spot && held) {
      const r = await placePaperSpotOrder({ orgId: strategy.orgId, agentId: strategy.agentId, strategyId: strategy.id, market: spot, isBuy: false, sz: Math.min(held.sz, open?.spotSz ?? held.sz) });
      if ("error" in r) errors.push(`spot: ${r.error}`);
      else ids.push(r.taskId);
    }
    await touchStrategyRun(strategy.id, { ...params, open: errors.length ? open : null, lastNote: decision.reason, lastAprPct: row?.fundingAprPct ?? null });
    await record({ coin: strategy.coin, action: "close", reasoning: decision.reason, equity: summary.equity, taskId: ids.join(",") || null, error: errors.join("; ") || null });
    return errors.length ? "error" : "closed";
  }

  if (!spot || !row) return "held";
  if (perp || held) {
    await touchStrategyRun(strategy.id, { ...params, lastNote: `${strategy.coin} already has a perp or spot position — not stacking a carry on it.` });
    return "held";
  }
  const bought = await placePaperSpotOrder({ orgId: strategy.orgId, agentId: strategy.agentId, strategyId: strategy.id, market: spot, isBuy: true, sizeUsd: strategy.sizeUsd });
  if ("error" in bought) {
    await touchStrategyRun(strategy.id, { ...params, lastNote: `Spot buy refused: ${bought.error}` });
    await record({ coin: strategy.coin, action: "open", reasoning: decision.reason, error: `Spot buy refused: ${bought.error}` });
    return "error";
  }
  const shorted = await placePaperOrder({
    orgId: strategy.orgId, agentId: strategy.agentId, strategyId: strategy.id, coin: strategy.coin, isBuy: false, sz: bought.sz, sizeUsd: bought.sz * bought.avgPx, leverage: 1,
  });
  if ("error" in shorted) {
    // Never hold the spot leg unhedged.
    await placePaperSpotOrder({ orgId: strategy.orgId, agentId: strategy.agentId, strategyId: strategy.id, market: spot, isBuy: false, sz: bought.sz });
    await touchStrategyRun(strategy.id, { ...params, lastNote: `Perp short refused (${shorted.error}) — sold the spot back.` });
    await record({ coin: strategy.coin, action: "open", reasoning: decision.reason, error: `Perp short refused: ${shorted.error}. Spot sold back.` });
    return "error";
  }
  const opened: OpenBasis = {
    coin: strategy.coin, openedAt: now, entryBasisPct: row.basisPct, entryFundingAprPct: row.fundingAprPct, spotSz: bought.sz, spotPx: bought.avgPx,
  };
  await touchStrategyRun(strategy.id, { ...params, open: opened, lastNote: decision.reason, lastAprPct: row.fundingAprPct });
  await record({ coin: strategy.coin, action: "open", reasoning: decision.reason, price: bought.avgPx, equity: summary.equity, taskId: [bought.taskId, shorted.taskId].join(","), error: null });
  return "opened";
}

/** A live bot order's task finished: record its fill (or failure) for the leaderboard. */
async function settleBotOrders(): Promise<number> {
  let settled = 0;
  for (const o of await listPendingBotOrders()) {
    try {
      const task = await getTask(o.taskId);
      if (!task) {
        if (o.createdAt && Date.now() - o.createdAt.getTime() > 86_400_000) await settleBotOrder(o.id, { status: "failed" });
        continue;
      }
      if (task.status === "completed") {
        const fill = (task.result as { data?: { fill?: { sz?: number; raw?: { avgPx?: string; totalSz?: string }; realizedPnl?: number | string | null } } } | undefined)?.data?.fill;
        const sz = Number(fill?.raw?.totalSz ?? fill?.sz ?? 0);
        const px = Number(fill?.raw?.avgPx ?? 0);
        if (!(sz > 0 && px > 0)) {
          await settleBotOrder(o.id, { status: "failed" });
        } else {
          await settleBotOrder(o.id, { status: "filled", sz, px, fee: sz * px * TAKER_FEE_RATE, realizedPnl: Number(fill?.realizedPnl ?? 0) || 0 });
        }
        settled++;
      } else if (["failed", "cancelled", "timeout"].includes(task.status)) {
        await settleBotOrder(o.id, { status: "failed" });
        settled++;
      }
    } catch (err) {
      console.error(`[hyperliquid-strategy] settling bot order ${o.id} failed:`, err);
    }
  }
  return settled;
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
      if (strategy.type === "pairs" || strategy.type === "breakout" || strategy.type === "basis") {
        const r = strategy.type === "pairs" ? await runPairsStrategy(strategy)
          : strategy.type === "breakout" ? await runBreakoutStrategy(strategy)
          : await runBasisStrategy(strategy);
        if (r === "opened" || r === "closed") executed++;
        if (r === "error") errors++;
        continue;
      }
      if (strategy.type === "dca") {
        const params = strategy.params as DcaParams;
        const last = strategy.lastRunAt?.getTime() ?? 0;
        const due = Date.now() - last >= params.intervalMs;
        if (!params.smart) {
          if (!due) continue;
          await markStrategyPending(strategy.id, {});
        } else {
          // Smart DCA: size from the stack's average entry; take profit is checked every tick, not once an interval.
          const acct = await basketAccountState(strategy);
          if ("error" in acct) continue;
          const isLong = params.direction !== "short";
          const h = acct.held[strategy.coin];
          const avg = h && h.position.isLong === isLong ? h.position.entryPx : null;
          const price = await getMidPrice(strategy.coin, acct.network);
          if (h && avg != null && smartDcaTakeProfit(params.smart, price, avg, isLong)) {
            await markStrategyPending(strategy.id, { action: "close", sz: Math.abs(h.position.size), isLong: h.position.isLong, notionalUsd: h.notionalUsd, price });
          } else if (due) {
            const next = smartDcaSize(strategy.sizeUsd, params.smart, price, avg, isLong);
            await markStrategyPending(strategy.id, { sizeUsd: +next.sizeUsd.toFixed(2), step: next.step, price });
          } else {
            continue;
          }
        }
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

  try {
    await settleBotOrders();
  } catch (err) {
    console.error("[hyperliquid-strategy] settling bot orders failed:", err);
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
    name: "hyperliquid_leaderboard",
    description: "Where this agent stands in its org's paper arena: every paper bot ranked by return on its order size (with win rate, profit factor and drawdown), and every agent's paper account ranked by return.",
    method: "GET",
    path: "leaderboard/{agentId}",
    input_schema: { type: "object", properties: {} },
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
    description: "Start paper training from an idea or goal the operator just gave you. Each round your own model decides LONG, SHORT, CLOSE, or NOTHING toward that goal, and the fill lands on the virtual account. Give one coin, or a basket (coins, or scanTop to scan the most-traded perps) to trade several coins per round — pair trades, funding carry, arbitrage. No wallet and no real money. One running paper trainer per coin.",
    method: "POST",
    path: "paper/train",
    input_schema: {
      type: "object",
      properties: {
        coin: { type: "string", description: "Perp symbol, e.g. BTC — for a single-coin trainer" },
        coins: { type: "array", items: { type: "string" }, description: "A basket of 2–8 perps to trade together, e.g. [\"BTC\",\"ETH\",\"SOL\"]. Use instead of coin." },
        scanTop: { type: "number", description: "Instead of a fixed basket, scan the N (2–8) most-traded perps each round." },
        goal: { type: "string", description: "The idea to practice, in plain language. 8–800 characters." },
        sizeUsd: { type: "number", description: "USD notional per order. Default 25. Minimum 10." },
        intervalMs: { type: "number", description: "How often to decide, in milliseconds. Default and minimum 1 minute. Live bots stay at 15 minutes." },
        maxDrawdownPct: { type: "number", description: "Stop for good if equity falls this percent from the start. Default 10." },
      },
      required: ["goal"],
    },
  },
  {
    name: "hyperliquid_scanner",
    description: "Scan Hyperliquid for arbitrage and relative-value setups: funding rate gaps against Binance and Bybit (annualised), perps trading off their oracle price, and stretched spreads between correlated coins (z-score, which leg to long and which to short).",
    method: "GET",
    path: "scanner",
    input_schema: {
      type: "object",
      properties: {
        coins: { type: "string", description: "Comma-separated perps to check for pair spreads, e.g. BTC,ETH,SOL. Default: the 8 most-traded." },
        interval: { type: "string", description: "Bar size for pair spreads. Default 1h." },
        network: { type: "string", enum: ["mainnet", "testnet"] },
      },
    },
  },
  {
    name: "hyperliquid_intel",
    description: "Positioning and flow from free public data: what the month's most and least profitable large Hyperliquid accounts hold (smart vs dumb money), Hyperliquid's market-maker vault (HLP) positioning, OKX liquidations by window and long/short account ratio, Fear & Greed, Deribit implied volatility (DVOL) and the Coinbase premium.",
    method: "GET",
    path: "intel",
    input_schema: {
      type: "object",
      properties: { coins: { type: "string", description: "Comma-separated perps, e.g. BTC,ETH,SOL. Default: the 6 most-traded." } },
    },
  },
  {
    name: "hyperliquid_pairs_bot",
    description: "Start a rule-based pairs-arbitrage bot. Among its coins it finds the correlated pair whose spread is most stretched; past ±entryZ it longs the cheap coin and shorts the rich one (beta-weighted), and closes both legs together when the spread converges, hits ±stopZ, or after maxHoldBars. Check hyperliquid_scanner first. paper: true trades the virtual account; live needs instant trading.",
    method: "POST",
    path: "strategy",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["pairs"] },
        coins: { type: "array", items: { type: "string" }, description: "2 coins for a fixed pair, or up to 8 to let the bot pick the most stretched pair, e.g. [\"BTC\",\"ETH\",\"SOL\"]" },
        sizeUsd: { type: "number", description: "USD notional of the first leg; the other leg is beta-weighted. Minimum 10." },
        paper: { type: "boolean", description: "true = paper account (recommended to start)" },
        interval: { type: "string", description: "Bar size for the spread. Default 1h." },
        entryZ: { type: "number", description: "Enter past this z-score. Default 2." },
        exitZ: { type: "number", description: "Take profit back inside this z. Default 0.5." },
        stopZ: { type: "number", description: "Stop out past this z. Default 4." },
        maxHoldBars: { type: "number", description: "Close after this many bars. Default 72." },
      },
      required: ["type", "coins", "sizeUsd"],
    },
  },
  {
    name: "hyperliquid_breakout_bot",
    description: "Start a rule-based squeeze-breakout bot on one coin. It waits for the Bollinger Bands to squeeze to their narrowest in a while, then enters on a close outside the bands with ADX confirming the trend (long above, short below if allowShort). It exits when the close falls back through the middle band, or at its stop loss / take profit. Backtest it first in the panel. paper: true trades the virtual account; live needs instant trading.",
    method: "POST",
    path: "strategy",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["breakout"] },
        coin: { type: "string", description: "Perp symbol, e.g. BTC" },
        sizeUsd: { type: "number", description: "USD notional per entry. Minimum 10." },
        paper: { type: "boolean", description: "true = paper account (recommended to start)" },
        interval: { type: "string", description: "Bar size: 15m, 1h, 4h or 1d. Default 4h — on 1h bars a setup is rare." },
        minAdx: { type: "number", description: "Minimum ADX to count as a trend. Default 20." },
        allowShort: { type: "boolean", description: "Also short breakdowns. Default true." },
        stopLossPct: { type: "number", description: "Stop loss, % from entry. Default 3." },
        takeProfitPct: { type: "number", description: "Take profit, % from entry. Default 6." },
        leverage: { type: "number", description: "Leverage for entries. Default: the agent's risk config." },
      },
      required: ["type", "coin", "sizeUsd"],
    },
  },
  {
    name: "hyperliquid_basis_bot",
    description: "Start a paper spot-perp basis (cash and carry) bot: when the coin's Hyperliquid funding pays shorts at least entryAprPct a year, it buys the coin on Hyperliquid spot and shorts the same size of its perp, collecting funding with price risk hedged out. It unwinds both legs when funding drops under exitAprPct or after maxHoldHours. Check the basis rows from hyperliquid_scanner first. Paper only.",
    method: "POST",
    path: "strategy",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["basis"] },
        coin: { type: "string", description: "Perp symbol with a Hyperliquid spot market, e.g. BTC (spot UBTC), ETH, SOL, HYPE" },
        sizeUsd: { type: "number", description: "USD of spot bought; the perp short matches it. Minimum 10." },
        paper: { type: "boolean", enum: [true], description: "Must be true — basis bots are paper only" },
        entryAprPct: { type: "number", description: "Enter when funding pays shorts at least this % a year. Default 15." },
        exitAprPct: { type: "number", description: "Unwind when funding falls under this % a year. Default 3." },
        maxHoldHours: { type: "number", description: "Unwind after this long. Default 168." },
      },
      required: ["type", "coin", "sizeUsd", "paper"],
    },
  },
  {
    name: "hyperliquid_edit_bot",
    description: "Change one of your bots' settings or order size; it keeps running and keeps its open positions. Editable per type — dca: intervalMs, direction, stopLossPct, takeProfitPct, smart; grid: lowerPrice, upperPrice, levels, direction, stopLossPct, takeProfitPct; signal: direction; sniper: mode, targetPrice, direction, stopLossPct, takeProfitPct; ai: intervalMs, maxDrawdownPct, leverage, goal; pairs: interval, lookbackBars, entryZ, exitZ, stopZ, maxHoldBars, minCorrelation; breakout: interval, bbLength, bbMult, squeezeLookback, squeezeWithin, adxLength, minAdx, allowShort, exitOnMid, stopLossPct, takeProfitPct, leverage; basis: entryAprPct, exitAprPct, minBasisPct, maxHoldHours. Type, coin and paper/live can't change.",
    method: "POST",
    path: "strategy/{id}/edit",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The bot's id" },
        sizeUsd: { type: "number", description: "New order size in USD (minimum 10)" },
        params: { type: "object", description: "Only the settings to change" },
      },
      required: ["id"],
    },
  },
  {
    name: "hyperliquid_delete_bot",
    description: "Delete one of your bots and its decision log. Positions it opened stay open — close them separately.",
    method: "POST",
    path: "strategy/{id}/delete",
    input_schema: { type: "object", properties: { id: { type: "string", description: "The bot's id" } }, required: ["id"] },
  },
  {
    name: "hyperliquid_stop_all_bots",
    description: "Emergency stop: turn off all of your bots at once and drop any signal waiting to execute. closePositions: true also market-closes the coins those bots trade (paper, or live with instant trading).",
    method: "POST",
    path: "strategy/stop-all",
    input_schema: { type: "object", properties: { closePositions: { type: "boolean" } } },
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
     * GET /scanner?network=&coins=BTC,ETH,SOL&interval=1h — arbitrage and
     * relative-value scan: Hyperliquid funding against Binance/Bybit, perps
     * trading off their oracle, and stretched spreads between correlated
     * pairs among `coins` (default: the 8 most-traded perps). Public data only.
     */
    "GET /scanner": async (req) => {
      try {
        const url = new URL(req.url);
        const network = (url.searchParams.get("network") as HlNetwork | null) ?? defaultNetwork();
        const interval = url.searchParams.get("interval") ?? "1h";
        if (!CANDLE_INTERVAL_MS[interval]) return Response.json({ error: `interval must be one of ${Object.keys(CANDLE_INTERVAL_MS).join(", ")}` }, { status: 400 });
        const raw = url.searchParams.get("coins");
        const coins = raw ? [...new Set(raw.split(",").map(cleanTrainCoin).filter((c): c is string => c != null))].slice(0, 12) : null;
        return Response.json({ network, ...(await scanMarket(network, coins?.length ? coins : null, interval)) });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /**
     * GET /intel?coins=BTC,ETH — positioning and flow from free public data
     * outlets (./intel.ts): smart vs dumb money and HLP positioning from
     * Hyperliquid's leaderboard and vaults, OKX liquidations and long/short
     * ratio, Fear & Greed, Deribit DVOL and the Coinbase premium. Default
     * coins: the 6 most-traded perps. Always mainnet.
     */
    "GET /intel": async (req) => {
      try {
        const raw = new URL(req.url).searchParams.get("coins");
        let coins = raw ? [...new Set(raw.split(",").map(cleanTrainCoin).filter((c): c is string => c != null))].slice(0, 12) : [];
        if (!coins.length) coins = (await getMarketOverview("mainnet")).slice(0, 6).map((m) => m.coin);
        return Response.json(await getMarketIntel(coins));
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

      const wantsBasket = (type === "ai" && (params?.coins != null || params?.scanTop != null)) || type === "pairs";
      if (!orgId || !agentId || (!wallet && !paper) || !type || (!coin && !wantsBasket) || !sizeUsd) {
        return Response.json({ error: "orgId, agentId, wallet (unless paper), type, coin, sizeUsd are required" }, { status: 400 });
      }
      if (!["dca", "grid", "signal", "sniper", "ai", "pairs", "breakout", "basis"].includes(type)) {
        return Response.json({ error: "type must be dca, grid, signal, sniper, ai, pairs, breakout, or basis" }, { status: 400 });
      }
      let storedParams = params ?? {};
      let storedCoin: string = coin;
      if (type === "ai") {
        if (coin === "ANY") return Response.json({ error: "an ai strategy needs a specific coin" }, { status: 400 });
        const built = buildAiParams(params, paper ? PAPER_MIN_INTERVAL_MS : AI_MIN_INTERVAL_MS);
        if ("error" in built) return Response.json({ error: built.error }, { status: 400 });
        storedParams = built;
        const basket = parseBasket(params ?? {});
        if (basket && "error" in basket) return Response.json({ error: basket.error }, { status: 400 });
        if (basket) {
          if (!paper && !(await getInstantTrading(agentId))) {
            return Response.json({ error: "A live basket bot needs instant trading on for this agent — or run it on paper" }, { status: 400 });
          }
          const clash = findAiClash(await getStrategies(agentId), paper, basket);
          if (clash) return Response.json({ error: `This agent already has an AI bot on ${clash.coin}`, strategyId: clash.strategy.id }, { status: 409 });
          storedParams = { ...built, ...(basket.coins ? { coins: basket.coins } : { scanTop: basket.scanTop, owned: [] }) };
          storedCoin = basket.label;
        }
      }
      if (type === "pairs") {
        // Agent tools send a flat body: coins/entryZ/… may sit beside type instead of inside params.
        const built = buildPairsParams(params ?? body, cleanTrainCoin);
        if ("error" in built) return Response.json({ error: built.error }, { status: 400 });
        if (!CANDLE_INTERVAL_MS[built.interval]) {
          return Response.json({ error: `params.interval must be one of ${Object.keys(CANDLE_INTERVAL_MS).join(", ")}` }, { status: 400 });
        }
        if (!(Number(sizeUsd) >= MIN_ORDER_USD)) return Response.json({ error: `sizeUsd must be at least ${MIN_ORDER_USD} per leg` }, { status: 400 });
        if (!paper && !(await getInstantTrading(agentId))) {
          return Response.json({ error: "A live pairs bot needs instant trading on for this agent — or run it on paper" }, { status: 400 });
        }
        const clash = findAiClash(await getStrategies(agentId), paper, { coins: built.coins });
        if (clash) return Response.json({ error: `This agent already has a bot on ${clash.coin}`, strategyId: clash.strategy.id }, { status: 409 });
        storedParams = { ...built, open: null, lastZ: null, lastNote: null } satisfies StoredPairsParams;
        storedCoin = built.coins.join("/");
      }
      if (type === "breakout" || type === "basis") {
        // Agent tools send a flat body, like pairs.
        const raw = params ?? body;
        const built = type === "breakout" ? buildBreakoutParams(raw, Object.keys(CANDLE_INTERVAL_MS)) : buildBasisParams(raw, cleanTrainCoin(coin));
        if ("error" in built) return Response.json({ error: built.error }, { status: 400 });
        if (!(Number(sizeUsd) >= MIN_ORDER_USD)) return Response.json({ error: `sizeUsd must be at least ${MIN_ORDER_USD}` }, { status: 400 });
        if (type === "basis" && !paper) return Response.json({ error: "A basis bot runs on paper only for now" }, { status: 400 });
        if (type === "breakout" && !paper && !(await getInstantTrading(agentId))) {
          return Response.json({ error: "A live breakout bot needs instant trading on for this agent — or run it on paper" }, { status: 400 });
        }
        const lev = Number(raw?.leverage);
        storedParams = type === "breakout"
          ? { ...built, ...(lev > 1 ? { leverage: lev } : {}), lastNote: null }
          : { ...built, open: null, lastNote: null, lastAprPct: null };
        storedCoin = cleanTrainCoin(coin) ?? coin;
      }
      if (type === "dca") {
        if (!params?.intervalMs) return Response.json({ error: "params.intervalMs is required for a dca strategy" }, { status: 400 });
        const built = buildDcaParams(params);
        if ("error" in built) return Response.json({ error: built.error }, { status: 400 });
        storedParams = built;
      }
      if (type === "grid" && !(params?.lowerPrice && params?.upperPrice && params?.levels)) {
        return Response.json({ error: "params.lowerPrice, upperPrice, levels are required for a grid strategy" }, { status: 400 });
      }
      if (type === "grid" || type === "sniper") {
        const extras = buildRuleExtras(params);
        if ("error" in extras) return Response.json({ error: extras.error }, { status: 400 });
        storedParams = { ...params, direction: undefined, stopLossPct: undefined, takeProfitPct: undefined, ...extras };
        for (const k of ["direction", "stopLossPct", "takeProfitPct"]) if (storedParams[k] === undefined) delete storedParams[k];
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

      const id = await createStrategy({ orgId, agentId, wallet: wallet ?? "", type, coin: storedCoin, sizeUsd, enabled: true, params: storedParams, paper });
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
          id: r.id, purpose: r.purpose, coin: r.coin, ...(r.coins ? { coins: r.coins } : {}), system: r.system, prompt: r.prompt,
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
      if (request.coins?.length) {
        // A basket round: { decisions: { ETH: "LONG", ... } } or { text } with a DECISIONS block.
        const given = body.decisions && typeof body.decisions === "object"
          ? Object.entries(body.decisions as Record<string, unknown>).map(([c, d]) => `${c}: ${String(d)}`).join("\n")
          : null;
        const decisions = parseMultiDecision(given != null ? `DECISIONS\n${given}` : text, request.coins);
        if (!decisions) {
          return Response.json({ error: "No decisions found — end with a DECISIONS block (COIN: LONG|SHORT|CLOSE per line) or NOTHING" }, { status: 400 });
        }
        const summary = Object.entries(decisions).map(([c, d]) => `${c}:${d}`).join(" ") || "NOTHING";
        const reasoning = String(body.reasoning ?? text).trim().slice(0, 2000);
        const first = Object.values(decisions)[0] ?? "NOTHING";
        const answered = await answerAiRequest(request.id, first, reasoning);
        if (!answered) return Response.json({ error: "This question was already answered or has expired" }, { status: 409 });
        const outcome = await applyBasketAnswer(answered, decisions, reasoning);
        return Response.json({ ok: true, decision: summary, decisions, ...outcome });
      }
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
     * POST /strategy/:id/edit — edit a bot's settings and/or order size while it
     * keeps its state (open pair, drawdown baseline, the round out with the
     * agent). Type, coin/basket and paper/live can't change: delete and
     * create a new bot for that. Settings are re-checked like POST /strategy.
     * POST rather than PATCH because agent runtimes only send GET and POST.
     * Body: { sizeUsd?, params?: { …editable settings for its type } }
     */
    "POST /strategy/:id/edit": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const strategy = await getStrategy(ctx.params.id);
      if (!strategy) return Response.json({ error: "Strategy not found" }, { status: 404 });
      const denied = await requireOrgAccess(ctx, strategy.orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });
      if (ctx.agent && ctx.agent.agentId !== strategy.agentId) {
        return Response.json({ error: "An agent can only edit its own bots" }, { status: 403 });
      }

      const current = (strategy.params ?? {}) as Record<string, unknown>;
      const edit = applyBotEdit({ ...strategy, params: current }, body);
      if ("error" in edit) return Response.json({ error: edit.error }, { status: 400 });
      if (edit.sizeUsd !== undefined && edit.sizeUsd < MIN_ORDER_USD) {
        return Response.json({ error: `sizeUsd must be at least ${MIN_ORDER_USD}` }, { status: 400 });
      }
      if (strategy.paper && strategy.type === "ai" && edit.sizeUsd !== undefined && edit.sizeUsd > TRAIN_MAX_SIZE_USD) {
        return Response.json({ error: `sizeUsd must be at most ${TRAIN_MAX_SIZE_USD} for a paper AI bot` }, { status: 400 });
      }
      const validated = validateBotSettings(strategy, edit.settings);
      if ("error" in validated) return Response.json({ error: validated.error }, { status: 400 });

      const strategyCap = await ensureRunStrategy(ctx, strategy.agentId, strategy.orgId);
      if (strategyCap) return Response.json({ error: strategyCap }, { status: 403 });

      const params = withRuntimeState(strategy.type, validated, current);
      // A grid whose range or level count moved has new levels; the old visited set no longer lines up.
      if (strategy.type === "grid" && edit.changed.some((k) => k !== "sizeUsd")) delete params.visitedLevels;
      await updateStrategy(strategy.id, { sizeUsd: edit.sizeUsd, params: params as Strategy["params"] });
      return Response.json({ ok: true, id: strategy.id, changed: edit.changed, sizeUsd: edit.sizeUsd ?? strategy.sizeUsd, params });
    },

    /**
     * POST /strategy/:id/delete — remove a bot and its decision log. Positions
     * it opened stay open (closing is a separate, explicit act); for a paper
     * bot the response lists them. An AI round still out with the agent is
     * expired so a late answer can't trade.
     */
    "POST /strategy/:id/delete": async (_req, ctx) => {
      const strategy = await getStrategy(ctx.params.id);
      if (!strategy) return Response.json({ error: "Strategy not found" }, { status: 404 });
      const denied = await requireOrgAccess(ctx, strategy.orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });
      if (ctx.agent && ctx.agent.agentId !== strategy.agentId) {
        return Response.json({ error: "An agent can only delete its own bots" }, { status: 403 });
      }

      const openRequestId = strategy.type === "ai" ? (strategy.params as AiParams).openRequestId : null;
      await toggleStrategy(strategy.id, false); // stop first, so a tick mid-delete can't run it
      if (openRequestId) await expireAiRequest(openRequestId);
      await deleteStrategy(strategy.id);

      const coins = new Set(claimedCoins(strategy));
      const leftOpen = strategy.paper
        ? (await listPaperPositions(strategy.agentId)).filter((p) => coins.has(p.coin)).map((p) => ({ coin: p.coin, szi: p.szi }))
        : null;
      return Response.json({ ok: true, id: strategy.id, paper: strategy.paper, coins: [...coins], leftOpen });
    },

    /**
     * POST /strategy/stop-all — emergency stop. Turns off every bot in scope
     * and drops any signal waiting to execute, in one write; expires AI rounds
     * out with the agent. Scope: one agent (agentId), or the whole org when a
     * signed-in member leaves agentId out. An agent can only stop its own bots.
     * closePositions: true also market-closes what the stopped bots trade —
     * their coins, on their own account (paper, or live with instant trading);
     * manual positions in other coins are left alone. Anything that couldn't
     * be closed comes back in leftOpen.
     * Body: { orgId, agentId?, closePositions? }
     */
    "POST /strategy/stop-all": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const agentId: string | undefined = ctx.agent?.agentId ?? (body.agentId || undefined);
      if (!orgId) return Response.json({ error: "orgId is required" }, { status: 400 });
      const denied = await requireOrgAccess(ctx, orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });

      const inScope = (agentId ? await getStrategies(agentId) : await listOrgStrategies(orgId)).filter((s) => s.orgId === orgId);
      const running = inScope.filter((s) => s.enabled || s.pendingSignal);
      await stopStrategies(running.map((s) => s.id));
      await Promise.all(running.map((s) => {
        const openRequestId = s.type === "ai" ? (s.params as AiParams).openRequestId : null;
        return openRequestId ? expireAiRequest(openRequestId).catch(() => {}) : null;
      }));

      const out: StopAllOutcome = {
        stopped: running.map((s) => ({ id: s.id, agentId: s.agentId, type: s.type, coin: s.coin, paper: s.paper })),
        closed: [],
        leftOpen: [],
      };
      if (body.closePositions === true) {
        // One pass per agent and account, over every coin its stopped bots trade.
        const groups = new Map<string, { agentId: string; paper: boolean; coins: Set<string> }>();
        for (const s of running) {
          const key = `${s.agentId}:${s.paper}`;
          const g = groups.get(key) ?? { agentId: s.agentId, paper: s.paper, coins: new Set<string>() };
          claimedCoins(s).filter((c) => c !== "ANY").forEach((c) => g.coins.add(c));
          groups.set(key, g);
        }
        for (const g of groups.values()) {
          try {
            await flattenCoins(g.agentId, orgId, g.coins, g.paper, out);
          } catch (err) {
            for (const coin of g.coins) out.leftOpen.push({ agentId: g.agentId, coin, paper: g.paper, reason: (err as Error).message });
          }
        }
      }
      ctx.log.warn(`emergency stop in org ${orgId}${agentId ? ` agent ${agentId}` : ""}: ${out.stopped.length} bots stopped, ${out.closed.length} closed, ${out.leftOpen.length} left open`);
      return Response.json({ ok: true, scope: agentId ? "agent" : "org", ...out });
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
      const basket = parseBasket(body);
      if (basket && "error" in basket) return Response.json({ error: basket.error }, { status: 400 });
      const coin = basket ? basket.label : cleanTrainCoin(body.coin);
      if (!orgId || !agentId) return Response.json({ error: "orgId and agentId are required" }, { status: 400 });
      if (!coin) return Response.json({ error: "coin must be a perp symbol such as BTC (or send coins / scanTop for a basket)" }, { status: 400 });
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
      const clash = findAiClash(existing, true, basket ?? { coins: [coin] });
      if (clash) {
        return Response.json({
          error: `This agent already has a paper trainer on ${clash.coin}. Stop it before starting another goal.`,
          strategyId: clash.strategy.id,
        }, { status: 409 });
      }

      const params = basket ? { ...built, ...(basket.coins ? { coins: basket.coins } : { scanTop: basket.scanTop, owned: [] }) } : built;
      const id = await createStrategy({
        orgId, agentId, wallet: "", type: "ai", coin, sizeUsd, enabled: true, params, paper: true,
      });

      let firstRound: "asked" | "waiting" | "error" = "waiting";
      try {
        const created = await getStrategy(id);
        if (created) {
          const round = await (isBasket(created) ? runBasketStrategy(created) : runAiStrategy(created));
          firstRound = round === "asked" ? "asked" : round === "error" ? "error" : "waiting";
        }
      } catch (err) {
        console.error(`[hyperliquid-paper] train ${id} first round failed:`, err);
        firstRound = "error";
      }

      return Response.json({
        id, paper: true, coin, ...(basket ? { basket: basket.coins ?? `top ${basket.scanTop}` } : {}), goal: goal.goal, sizeUsd,
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

    /**
     * GET /leaderboard/:agentId — the paper arena of this agent's org: paper
     * bots ranked by their own fills (return on order size, then drawdown),
     * and agents' paper accounts ranked by return, marked to mainnet mids.
     * Paper only: live trades don't record which bot sent them.
     */
    "GET /leaderboard/:agentId": async (req, ctx) => {
      const access = await requireAgentOrgAccess(ctx, ctx.params.agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      const live = new URL(req.url).searchParams.get("mode") === "live";
      try {
        const [strategies, paper, fills, agents, market] = await Promise.all([
          listOrgStrategies(access.orgId),
          listOrgPaperAccounts(access.orgId),
          live ? listOrgBotFills(access.orgId) : listOrgPaperFills(access.orgId),
          getAgentsByOrg(access.orgId),
          getPaperMarket(),
        ]);
        const nameOf = new Map(agents.map((a) => [a.id, a.name || a.id]));
        const bots = rankBots(
          strategies.filter((s) => s.paper === !live).map((s) => ({
            id: s.id, agentId: s.agentId, agentName: nameOf.get(s.agentId) ?? s.agentId, type: s.type, coin: s.coin, sizeUsd: s.sizeUsd,
            enabled: s.enabled, eliminated: s.type === "ai" && (s.params as AiParams).eliminated === true,
            goal: s.type === "ai" ? (s.params as AiParams).goal ?? null : null,
          })),
          fills,
        );
        const accounts = rankAccounts(paper.accounts.map((a) => {
          const held = paper.positions.filter((p) => p.agentId === a.agentId);
          return {
            agentId: a.agentId, agentName: nameOf.get(a.agentId) ?? a.agentId, startBalance: a.startBalance,
            equity: summarize(a.balance, held, market.mids, market.meta).equity, openPositions: held.length,
          };
        }));
        return Response.json({ orgId: access.orgId, you: ctx.params.agentId, mode: live ? "live" : "paper", bots, accounts, fillsCounted: fills.length });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
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
