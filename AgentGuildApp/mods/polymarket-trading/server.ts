import { defineServerMod, type RouteContext } from "@agent-guild/sdk";
import { enableModCapabilities, enforceCapability, getAgent, getAgentCapabilities, getAgentsByOrg, getModInstallStatus, getOrganizationsByWalletAdmin, postAgentDmMessage } from "@/lib/firestore-admin";
import { MAX_PROMPT_CHARS } from "./agent-prompt";
import { listAgentWallets, generateAgentWallet, getAgentWalletEvmPrivateKey } from "@/lib/agent-wallets";
import { requireOrgMembershipByAddress } from "@/lib/auth-guard";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import {
  ensureAccount,
  getAccount,
  updateAccount,
  resetPaper,
  addPaperFunds,
  listPaperPositions,
  getPaperPosition,
  listAllOpenPaperPositions,
  applyPaperFill,
  settlePaperPosition,
  recordTrade,
  listTrades,
  getDailyRealizedPnl,
  createBot,
  getBot,
  listBots,
  listEnabledBots,
  updateBot,
  deleteBot,
  addBotLog,
  listBotLog,
  createAiRequest,
  getAiRequest,
  listOpenAiRequests,
  answerAiRequest,
  expireAiRequest,
  PaperError,
  PAPER_START_CASH,
  type PmAccount,
  type PmBot,
  type PmAiRequest,
  type PmRisk,
  type MarketRef,
  type BotMarket,
  type PaperPositionDoc,
  type PaperOrder,
  createPaperOrder,
  listOpenPaperOrders,
  listAgentPaperOrders,
  updatePaperOrder,
  applyRestingFill,
  getWhaleUniverse,
  setWhaleUniverse,
  acquireTickLock,
  releaseTickLock,
} from "@/lib/mods/polymarket-store";
import {
  getTrendingEvents,
  searchEvents,
  getMarketByConditionId,
  getBook,
  getPriceHistory,
  getWalletPositions,
  getBtcWindowMarket,
  btcWindow,
  btc15mWindow,
  getTapePrints,
  BTC_WINDOW_MS,
  type BtcWindow,
  type PmMarket,
  type Book,
  type WalletPosition,
} from "./markets";
import { restingFillShares, simulateBuy, simulateSell, takerFeePerShare } from "./paper";
import {
  evaluateMidPrice,
  evaluateStreak,
  evaluateTrigger,
  upDownIndexes,
  MID_PRICE_DEFAULTS,
  STREAK_DEFAULTS,
  type BotType,
  type Decision,
  type MidPriceParams,
  type StreakParams,
  type TriggerParams,
} from "./strategies";
import {
  buildSnapshot,
  decisionRequest,
  decisionToAction,
  INSTRUCTIONS_MAX,
  parseDecision,
  type PredictorDecision,
  type PredictorPosition,
} from "./ai-predictor-core";
import { btcCandles, btcPositions, hlInfo, liquidationTotals, recentBtcLiquidations, refreshWhaleUniverse, type Candle, type Liquidation, type WhalePosition } from "./feeds";
import {
  atr14,
  evaluateBoxArm,
  evaluateBoxBailout,
  evaluateBoxCompletion,
  evaluateCorridor,
  evaluateFlipEntry,
  evaluateLiqCascade,
  evaluateNearLiq,
  evaluateSmallLiq,
  evaluateSpreadQuote,
  flipExitPlan,
  boxQuotes,
  medianWindowAtr4,
  spreadCancelReason,
  volumeRatio,
  windowAtr4,
  BOX_DEFAULTS,
  CASCADE_DEFAULTS,
  CORRIDOR_DEFAULTS,
  FLEET_BOT_TYPES,
  FLIP_DEFAULTS,
  NEAR_LIQ_DEFAULTS,
  SMALL_LIQ_DEFAULTS,
  SPREAD_DEFAULTS,
  type BoxParams,
  type CascadeParams,
  type CorridorParams,
  type FleetBotType,
  type FlipParams,
  type NearLiqParams,
  type SmallLiqParams,
  type SpreadParams,
} from "./fleet";
import { checkGeoblock, ensureApprovals, getLiveWalletState, placeLiveOrder, getLiveOpenOrders, cancelLiveOrder } from "./live";

const MOD_ID = "polymarket-trading";
/** The id installs are stored under (skills.ts prefixes registry entries with "mod-"). */
const REGISTRY_MOD_ID = `mod-${MOD_ID}`;
const CAP_TRADE = "polymarket-trade";
const CAP_BOTS = "polymarket-run-bots";
const TRADING_CAPABILITIES = [CAP_TRADE, CAP_BOTS] as const;

/** Polymarket's floor for a marketable order. */
const MIN_ORDER_USD = 1;
const AI_MIN_INTERVAL_MS = 5 * 60_000;
const AI_ANSWER_WINDOW_MS = 10 * 60_000;
/** A BTC-window AI round must be answered while the window is still young. */
const AI_BTC_ANSWER_MS = 90_000;
const RESOLVE_BATCH = 25;

type Denied = { error: string; status: number };
const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (error: string, status = 400) => json({ error }, status);

// ── Access ──────────────────────────────────────────────────────────────────

/** Same rule as the Hyperliquid mod: an agent may act only as itself; a person only inside an org they belong to. */
async function requireOrgAccess(ctx: RouteContext, orgId: string): Promise<Denied | null> {
  if (ctx.agent) return ctx.agent.orgId === orgId ? null : { error: "Agent signature does not match orgId", status: 403 };
  if (!ctx.session) return { error: "Authentication required", status: 401 };
  const result = await requireOrgMembershipByAddress(ctx.session.address, orgId);
  return result.ok ? null : { error: result.error ?? "Forbidden", status: result.status ?? 403 };
}

/** Resolves the agent's real org from its own record (never a client-supplied orgId) and checks access. */
async function requireAgentAccess(ctx: RouteContext, agentId: string | undefined | null): Promise<{ orgId: string } | Denied> {
  if (!agentId) return { error: "agentId is required", status: 400 };
  if (ctx.agent) {
    if (ctx.agent.agentId !== agentId) return { error: "Agent signature does not match agentId", status: 403 };
    return { orgId: ctx.agent.orgId };
  }
  const agent = await getAgent(agentId);
  if (!agent) return { error: "Agent not found", status: 404 };
  const denied = await requireOrgAccess(ctx, agent.orgId);
  return denied ?? { orgId: agent.orgId };
}

/** Org owner, signed in as a person. Granting live signing over the agent's wallet needs this, never an agent signature. */
async function requireOwner(ctx: RouteContext, agentId: string | undefined): Promise<{ orgId: string } | Denied> {
  if (!ctx.session || ctx.agent) return { error: "Only the org owner, signed in, can do this", status: 403 };
  if (!agentId) return { error: "agentId is required", status: 400 };
  const agent = await getAgent(agentId);
  if (!agent) return { error: "Agent not found", status: 404 };
  const membership = await requireOrgMembershipByAddress(ctx.session.address, agent.orgId);
  if (!membership.ok) return { error: membership.error ?? "Forbidden", status: membership.status ?? 403 };
  const owner = membership.org?.ownerAddress;
  if (!owner || canonicalizeWalletAddress(owner) !== canonicalizeWalletAddress(ctx.session.address)) {
    return { error: "Only the org owner can do this", status: 403 };
  }
  return { orgId: agent.orgId };
}

// ── Positions & risk ────────────────────────────────────────────────────────

function marketRef(market: PmMarket | BotMarket, outcomeIndex: number): MarketRef {
  const outcome = market.outcomes[outcomeIndex];
  return {
    conditionId: market.conditionId,
    question: market.question,
    slug: market.slug,
    endDate: "endDate" in market ? market.endDate : null,
    tokenId: outcome.tokenId,
    outcomeIndex,
    outcome: outcome.name,
  };
}

async function signingKey(account: PmAccount): Promise<`0x${string}`> {
  if (!account.live) throw new Error("Live trading isn't set up for this agent");
  return getAgentWalletEvmPrivateKey(account.live.walletId, account.orgId, account.agentId);
}

/** Shares held of one outcome token, in the account's current mode. */
async function heldShares(account: PmAccount, tokenId: string, walletPositions?: WalletPosition[]): Promise<{ shares: number; avgPrice: number }> {
  if (account.mode === "paper") {
    const p = await getPaperPosition(account.agentId, tokenId);
    return { shares: p?.shares ?? 0, avgPrice: p?.avgPrice ?? 0 };
  }
  const positions = walletPositions ?? (account.live ? await getWalletPositions(account.live.address) : []);
  const p = positions.find((w) => w.tokenId === tokenId);
  return { shares: p?.shares ?? 0, avgPrice: p?.avgPrice ?? 0 };
}

/** Cost basis of everything open — what maxExposureUsd caps. */
async function openExposure(account: PmAccount): Promise<number> {
  if (account.mode === "paper") {
    return (await listPaperPositions(account.agentId)).reduce((s, p) => s + p.shares * p.avgPrice, 0);
  }
  if (!account.live) return 0;
  return (await getWalletPositions(account.live.address)).filter((p) => !p.redeemable).reduce((s, p) => s + p.initialValue, 0);
}

/** Buy-side limits. Sells always pass: getting out must never be blocked by a risk check. */
export async function checkBuyRisk(account: PmAccount, usd: number): Promise<string | null> {
  const risk = account.risk;
  if (usd > risk.maxOrderUsd) return `Order $${usd.toFixed(2)} exceeds the max order size of $${risk.maxOrderUsd}`;
  const daily = await getDailyRealizedPnl(account.agentId, account.mode);
  if (daily <= -risk.maxDailyLossUsd) return `Daily loss limit reached (${daily.toFixed(2)} ≤ −${risk.maxDailyLossUsd}); trading resumes tomorrow (UTC)`;
  const exposure = await openExposure(account);
  if (exposure + usd > risk.maxExposureUsd + 1e-9) {
    return `Open exposure $${exposure.toFixed(2)} + $${usd.toFixed(2)} would exceed the $${risk.maxExposureUsd} limit`;
  }
  return null;
}

// ── Orders ──────────────────────────────────────────────────────────────────

export interface OrderRequest {
  account: PmAccount;
  market: PmMarket;
  outcomeIndex: number;
  side: "buy" | "sell";
  /** BUY: USD to spend. */
  usd?: number;
  /** SELL: shares (default: everything held). Limit BUY may use shares instead of usd. */
  shares?: number;
  kind: "market" | "limit";
  /** Market: worst acceptable price. Limit: the price. */
  limitPrice?: number;
  strategyId?: string | null;
}

export interface OrderResult {
  mode: "paper" | "live";
  side: "buy" | "sell";
  outcome: string;
  shares: number;
  avgPrice: number;
  notional: number;
  fee: number;
  realizedPnl: number;
  orderId: string | null;
  status: string;
}

export class OrderError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Every order path (panel, agent tool, bots) goes through here, so the capability and risk gates can't be skipped. */
export async function executeOrder(req: OrderRequest): Promise<OrderResult> {
  const { account, market, outcomeIndex, side, kind } = req;
  try {
    await enforceCapability(account.agentId, account.orgId, CAP_TRADE);
  } catch (err) {
    throw new OrderError((err as Error).message, 403);
  }
  const outcome = market.outcomes[outcomeIndex];
  if (!outcome) throw new OrderError("Unknown outcome");
  if (market.closed || !market.acceptingOrders) throw new OrderError("This market isn't accepting orders");
  if (req.limitPrice != null && !(req.limitPrice > 0 && req.limitPrice < 1)) throw new OrderError("limitPrice must be between 0 and 1");
  if (kind === "limit" && req.limitPrice == null) throw new OrderError("limitPrice is required for a limit order");

  let shares = req.shares;
  if (side === "buy") {
    const usd = req.usd ?? (shares && req.limitPrice ? shares * req.limitPrice : 0);
    if (!(usd >= MIN_ORDER_USD)) throw new OrderError(`Minimum order is $${MIN_ORDER_USD}`);
    const blocked = await checkBuyRisk(account, usd);
    if (blocked) throw new OrderError(blocked);
  } else {
    const held = await heldShares(account, outcome.tokenId);
    shares = Math.min(shares ?? held.shares, held.shares);
    if (!(shares > 0)) throw new OrderError(`No ${outcome.name} shares to sell`);
  }

  const ref = marketRef(market, outcomeIndex);
  const base = {
    agentId: account.agentId, orgId: account.orgId, mode: account.mode, conditionId: market.conditionId,
    question: market.question, tokenId: outcome.tokenId, outcome: outcome.name, side, strategyId: req.strategyId ?? null,
  };

  if (account.mode === "paper") {
    // Paper fills only what the real book can take right now (fill-and-kill); a paper limit order never rests.
    const book = await getBook(outcome.tokenId);
    const fill = side === "buy"
      ? simulateBuy(book.asks, req.usd ?? (shares ?? 0) * (req.limitPrice ?? 0), market.fee, req.limitPrice)
      : simulateSell(book.bids, shares!, market.fee, req.limitPrice);
    if (fill.shares <= 0) {
      throw new OrderError(req.limitPrice != null
        ? `Nothing on the book at or ${side === "buy" ? "under" : "over"} ${req.limitPrice.toFixed(2)} (paper orders don't rest)`
        : "No liquidity on the book");
    }
    let realized: number;
    try {
      ({ realized } = await applyPaperFill(account.agentId, account.orgId, ref, side, fill, req.strategyId ?? null));
    } catch (err) {
      if (err instanceof PaperError) throw new OrderError(err.message);
      throw err;
    }
    await recordTrade({
      ...base, shares: fill.shares, price: fill.avgPrice, notional: fill.notional, fee: fill.fee, realizedPnl: realized,
      orderId: null, status: "filled",
    });
    return {
      mode: "paper", side, outcome: outcome.name, shares: fill.shares, avgPrice: fill.avgPrice, notional: fill.notional,
      fee: fill.fee, realizedPnl: realized, orderId: null, status: "filled",
    };
  }

  // Live
  const privateKey = await signingKey(account);
  const before = side === "sell" ? await heldShares(account, outcome.tokenId) : null;
  let placed;
  try {
    placed = await placeLiveOrder(privateKey, {
      tokenId: outcome.tokenId, side, usd: req.usd, shares, limitPrice: req.limitPrice, kind,
      tickSize: market.tickSize, negRisk: market.negRisk,
    });
  } catch (err) {
    throw new OrderError((err as Error).message);
  }
  // Fees are taken by the exchange; this is the schedule's estimate for the matched part (makers pay none).
  const fee = placed.shares * takerFeePerShare(placed.avgPrice, market.fee);
  const realized = side === "sell" && before ? placed.notional - placed.shares * before.avgPrice - fee : -fee;
  if (placed.shares > 0 || kind === "limit") {
    await recordTrade({
      ...base, shares: placed.shares, price: placed.avgPrice, notional: placed.notional, fee,
      realizedPnl: placed.shares > 0 ? realized : 0, orderId: placed.orderId, status: placed.status,
    });
  }
  return {
    mode: "live", side, outcome: outcome.name, shares: placed.shares, avgPrice: placed.avgPrice, notional: placed.notional,
    fee, realizedPnl: placed.shares > 0 ? realized : 0, orderId: placed.orderId, status: placed.status,
  };
}

// ── Paper resolution ────────────────────────────────────────────────────────

/** Pays out paper positions whose markets have resolved. Live positions are redeemed on-chain, not here. */
export async function resolvePaperPositions(now = Date.now()): Promise<{ checked: number; settled: number }> {
  return settleDuePaperPositions(await listAllOpenPaperPositions(), now);
}

/**
 * Same sweep for one agent. Runs whenever its account is read, so a winner is
 * paid even when no hub is calling the tick.
 */
export async function resolveAgentPaperPositions(agentId: string, now = Date.now()): Promise<{ checked: number; settled: number }> {
  return settleDuePaperPositions(await listPaperPositions(agentId), now);
}

/**
 * Checks every open position, not just ones past their end date: markets like
 * "…by December 31?" resolve early. Past-due markets go first (oldest end date
 * first) so the batch cap never starves a market that has already closed.
 */
async function settleDuePaperPositions(open: PaperPositionDoc[], now: number): Promise<{ checked: number; settled: number }> {
  const endMs = (p: PaperPositionDoc) => (p.endDate ? Date.parse(p.endDate) : 0) || 0;
  const ordered = [...open].sort((a, b) => {
    const aDue = endMs(a) <= now, bDue = endMs(b) <= now;
    if (aDue !== bDue) return aDue ? -1 : 1;
    return endMs(a) - endMs(b);
  });
  const byMarket = new Map<string, PaperPositionDoc[]>();
  for (const p of ordered) byMarket.set(p.conditionId, [...(byMarket.get(p.conditionId) ?? []), p]);

  let settled = 0;
  const markets = [...byMarket.keys()].slice(0, RESOLVE_BATCH);
  await Promise.all(markets.map(async (conditionId) => {
    const market = await getMarketByConditionId(conditionId).catch(() => null);
    if (!market || market.winnerIndex == null) return; // not resolved yet
    for (const p of byMarket.get(conditionId)!) {
      const won = p.outcomeIndex === market.winnerIndex;
      const result = await settlePaperPosition(p.id, won);
      if (!result) continue;
      settled++;
      await recordTrade({
        agentId: p.agentId, orgId: p.orgId, mode: "paper", conditionId, question: p.question, tokenId: p.tokenId,
        outcome: p.outcome, side: "resolve", shares: p.shares, price: won ? 1 : 0, notional: result.payout, fee: 0,
        realizedPnl: result.realized, strategyId: p.strategyId, orderId: null, status: won ? "won" : "lost",
      });
      if (p.strategyId) {
        await addBotLog(p.strategyId, {
          kind: "resolve", reason: `${p.question}: ${p.outcome} ${won ? "won" : "lost"}, PnL ${result.realized >= 0 ? "+" : ""}${result.realized.toFixed(2)} (paper)`,
          price: won ? 1 : 0, shares: p.shares, usd: result.payout,
        });
      }
    }
  }));
  return { checked: markets.length, settled };
}

// ── BTC 5-minute context (shared by every BTC bot in one tick) ──────────────

interface BtcContext {
  win: ReturnType<typeof btcWindow>;
  market: PmMarket;
  /** [up, down] outcome indexes in the market. */
  idx: [number, number];
  books: [Book, Book];
  spot: number;
  strike: number;
  /** Closed 5-minute windows, oldest first. */
  windows: Candle[];
}

/**
 * Everything the BTC bots read, fetched once per tick. BTC price comes from
 * Hyperliquid (free, already used by this platform); the market itself
 * resolves on Chainlink's BTC/USD TWAP, which tracks it closely but not
 * exactly. The strike is Polymarket's own priceToBeat when published, else
 * the 1-minute open at the window start.
 */
async function loadBtcContext(now = Date.now()): Promise<BtcContext | string> {
  const win = btcWindow(now);
  const market = await getBtcWindowMarket(win);
  if (!market) return `Polymarket hasn't listed ${win.slug}`;
  const idx = upDownIndexes(market.outcomes);
  if (!idx) return `Unexpected outcomes on ${win.slug}`;
  const [up, down, mids, minute, fives] = await Promise.all([
    getBook(market.outcomes[idx[0]].tokenId),
    getBook(market.outcomes[idx[1]].tokenId),
    hlInfo<Record<string, string>>({ type: "allMids" }),
    market.priceToBeat ? Promise.resolve([] as Candle[]) : btcCandles("1m", win.startMs, win.startMs + 60_000),
    btcCandles("5m", win.startMs - 16 * BTC_WINDOW_MS, win.startMs - 1),
  ]);
  const spot = Number(mids.BTC);
  const strike = market.priceToBeat ?? minute.find((c) => c.t === win.startMs)?.o ?? null;
  if (!spot || !strike) return "BTC price unavailable";
  return {
    win, market, idx, books: [up, down], spot, strike,
    windows: fives.filter((c) => c.t + BTC_WINDOW_MS <= win.startMs),
  };
}

// ── Bots ────────────────────────────────────────────────────────────────────

const windowLabel = (ms: number) => new Date(ms).toISOString().slice(11, 16);

async function botAccount(bot: PmBot): Promise<PmAccount> {
  return ensureAccount(bot.agentId, bot.orgId);
}

type TakerDecision = Decision | { action: "buy"; outcomeIndex: number; limitPrice: number; reason: string; sizeMult?: number };

const asksOf = (ctx: BtcContext): [number | null, number | null] => [ctx.books[0].asks[0]?.price ?? null, ctx.books[1].asks[0]?.price ?? null];
const bidsOf = (ctx: BtcContext): [number | null, number | null] => [ctx.books[0].bids[0]?.price ?? null, ctx.books[1].bids[0]?.price ?? null];

/** What a once-per-window taker bot wants to do this tick, in [Up, Down] space. */
function takerDecision(bot: PmBot, ctx: BtcContext, data: FleetData, now: number): TakerDecision {
  const { win } = ctx;
  const asks = asksOf(ctx);
  const p = bot.params;
  const liqs = () => (typeof data.liquidations === "string" ? data.liquidations : data.liquidations ?? []);
  switch (bot.type as BotType) {
    case "mid-price":
      return evaluateMidPrice({ spot: ctx.spot, strike: ctx.strike, elapsedMs: win.elapsedMs, remainingMs: win.remainingMs, asks, params: { ...MID_PRICE_DEFAULTS, ...(p as Partial<MidPriceParams>) } });
    case "streak-fade":
      return evaluateStreak({ windows: ctx.windows, elapsedMs: win.elapsedMs, asks, params: { ...STREAK_DEFAULTS, ...(p as Partial<StreakParams>) } });
    case "flip-harvest":
      return evaluateFlipEntry({
        remainingMs: win.remainingMs, spot: ctx.spot, strike: ctx.strike, atr4: windowAtr4(data.bars1m, win.startMs, now), asks,
        params: { ...FLIP_DEFAULTS, ...(p as Partial<FlipParams>) },
      });
    case "liq-cascade": {
      const l = liqs();
      if (typeof l === "string") return { action: "skip", reason: l };
      return evaluateLiqCascade({
        elapsedMs: win.elapsedMs, spot: ctx.spot, strike: ctx.strike, flow: liquidationTotals(l, now), volRatio: volumeRatio(data.bars1m, now), asks,
        params: { ...CASCADE_DEFAULTS, ...(p as Partial<CascadeParams>) },
      });
    }
    case "small-liq": {
      const l = liqs();
      if (typeof l === "string") return { action: "skip", reason: l };
      return evaluateSmallLiq({ remainingMs: win.remainingMs, flow: liquidationTotals(l, now), asks, params: { ...SMALL_LIQ_DEFAULTS, ...(p as Partial<SmallLiqParams>) } });
    }
    case "near-liq": {
      const l = liqs();
      if (typeof l === "string") return { action: "skip", reason: l };
      if (typeof data.whales === "string") return { action: "skip", reason: data.whales };
      return evaluateNearLiq({ now, spot: ctx.spot, whales: data.whales ?? [], liquidations: l, asks, params: { ...NEAR_LIQ_DEFAULTS, ...(p as Partial<NearLiqParams>) } });
    }
    default:
      return { action: "skip", reason: `Not a taker bot: ${bot.type}` };
  }
}

/** Starts a new window in the bot's state, logging the last one's verdict if it ended without a trade. */
async function rollWindow(bot: PmBot, windowStart: number): Promise<void> {
  const state = bot.state;
  if (state.window === windowStart) return;
  if (state.window && state.enteredWindow !== state.window && state.lastReason) {
    await addBotLog(bot.id, { kind: "skip", reason: `${windowLabel(state.window)} UTC window: ${state.lastReason}` });
  }
  state.window = windowStart;
  state.lastReason = null;
  state.fleet = null;
}

/** One tick of a BTC 5-minute taker bot: at most one entry per window, every window's outcome logged. */
async function runBtcBot(bot: PmBot, ctx: BtcContext, data: FleetData = EMPTY_FLEET_DATA, now = Date.now()): Promise<"entered" | "skipped" | "error"> {
  const { win } = ctx;
  const state = bot.state;
  await rollWindow(bot, win.startMs);
  if (state.enteredWindow === win.startMs) return "skipped";

  const decision = takerDecision(bot, ctx, data, now);
  if (decision.action !== "buy") {
    await updateBot(bot.id, { state: { window: state.window, lastReason: decision.reason, lastEvalAt: Date.now() } });
    return "skipped";
  }
  // Decisions come back in [Up, Down] space; map to the market's outcome order.
  const outcomeIndex = ctx.idx[decision.outcomeIndex];
  const usdSize = Math.round(bot.sizeUsd * ("sizeMult" in decision && decision.sizeMult ? decision.sizeMult : 1) * 100) / 100;
  try {
    const account = await botAccount(bot);
    const fill = await executeOrder({
      account, market: ctx.market, outcomeIndex, side: "buy", usd: usdSize, kind: "market",
      limitPrice: decision.limitPrice, strategyId: bot.id,
    });
    await updateBot(bot.id, { touch: true, state: { window: state.window, enteredWindow: win.startMs, lastReason: decision.reason, lastEvalAt: Date.now() } });
    await addBotLog(bot.id, {
      kind: "entry", reason: `${decision.reason} → bought ${fill.shares} ${fill.outcome} @ ${fill.avgPrice.toFixed(3)} (${fill.mode})`,
      price: fill.avgPrice, shares: fill.shares, usd: fill.notional,
    });
    if (bot.type === "flip-harvest") await placeFlipExit(bot, account, ctx, data, outcomeIndex, fill.shares, now);
    return "entered";
  } catch (err) {
    // One error row per window; the bot sits the rest of the window out rather than retrying every tick.
    const message = (err as Error).message;
    await updateBot(bot.id, { state: { window: state.window, enteredWindow: win.startMs, lastReason: `Entry failed: ${message}`, lastEvalAt: Date.now() } });
    await addBotLog(bot.id, { kind: "error", reason: `${decision.reason}, but the order failed: ${message}` });
    return "error";
  }
}

// ── Moon Dev fleet (fleet.ts) ───────────────────────────────────────────────

interface CorridorContext {
  win15: BtcWindow;
  market15: PmMarket;
  /** [up, down] outcome indexes in the 15m market. */
  idx15: [number, number];
  asks15: [number | null, number | null];
}

/** Shared per-tick inputs for the fleet bots; each piece is loaded only when an enabled bot needs it. */
interface FleetData {
  /** 1-minute BTC bars, last ~40 minutes (ATR4, ATR14, volume). */
  bars1m: Candle[];
  /** 1-minute BTC bars, last 24h (the flip harvester's volatility regime). */
  bars24h: Candle[] | null;
  liquidations: Liquidation[] | string | null;
  whales: WhalePosition[] | string | null;
  corridor: CorridorContext | string | null;
}

const EMPTY_FLEET_DATA: FleetData = { bars1m: [], bars24h: null, liquidations: null, whales: null, corridor: null };
const PAPER_ONLY = "Maker bots run on paper only for now (switch the account to paper)";
const floor2 = (n: number) => Math.floor(n * 100 + 1e-9) / 100;

async function loadWhales(): Promise<WhalePosition[] | string> {
  const { addresses } = await getWhaleUniverse();
  if (!addresses.length) return "Whale list not built yet (it refreshes every 6 hours)";
  return btcPositions(addresses);
}

async function loadCorridor(now: number): Promise<CorridorContext | string> {
  const win15 = btc15mWindow(now);
  const { actFromMs, actUntilMs } = CORRIDOR_DEFAULTS;
  if (win15.elapsedMs < actFromMs - 60_000 || win15.elapsedMs > actUntilMs + 60_000) return `Waits for the 15m window's final third (${Math.round(win15.elapsedMs / 1000)}s in)`;
  const market15 = await getBtcWindowMarket(win15);
  if (!market15) return `Polymarket hasn't listed ${win15.slug}`;
  const idx15 = upDownIndexes(market15.outcomes);
  if (!idx15) return `Unexpected outcomes on ${win15.slug}`;
  const [up, down] = await Promise.all([getBook(market15.outcomes[idx15[0]].tokenId), getBook(market15.outcomes[idx15[1]].tokenId)]);
  return { win15, market15, idx15, asks15: [up.asks[0]?.price ?? null, down.asks[0]?.price ?? null] };
}

async function loadFleetData(types: Set<string>, now: number): Promise<FleetData> {
  const any = (...t: string[]) => t.some((x) => types.has(x));
  const [bars1m, bars24h, liquidations, whales, corridor] = await Promise.all([
    any(...FLEET_BOT_TYPES) ? btcCandles("1m", now - 40 * 60_000, now).catch(() => [] as Candle[]) : Promise.resolve([] as Candle[]),
    any("flip-harvest") ? btcCandles("1m", now - 24 * 3_600_000, now).catch(() => null) : Promise.resolve(null),
    any("liq-cascade", "small-liq", "near-liq") ? recentBtcLiquidations().catch((e: Error) => `Liquidation feed failed: ${e.message}`) : Promise.resolve(null),
    any("near-liq") ? loadWhales().catch((e: Error) => `Whale positions failed: ${e.message}`) : Promise.resolve(null),
    any("corridor") ? loadCorridor(now).catch((e: Error) => `15m market failed: ${e.message}`) : Promise.resolve(null),
  ]);
  return { bars1m, bars24h, liquidations, whales, corridor };
}

/**
 * Rests a limit order for a bot. Paper: a resting paper order the tick fills
 * from the real tape. Live: a GTC order on Polymarket's book (it rests there;
 * Polymarket fills it).
 */
async function restOrder(input: {
  bot: PmBot; account: PmAccount; market: PmMarket; outcomeIndex: number; side: "buy" | "sell"; price: number; shares: number; expiresAt: number; tag: string;
}): Promise<string> {
  const { bot, account, market, outcomeIndex, side, price, shares, expiresAt, tag } = input;
  if (account.mode === "live") {
    const r = await executeOrder({ account, market, outcomeIndex, side, kind: "limit", limitPrice: price, ...(side === "buy" ? { usd: shares * price } : { shares }), strategyId: bot.id });
    return r.orderId ?? "live";
  }
  const order = await createPaperOrder({
    agentId: bot.agentId, orgId: bot.orgId, botId: bot.id, ...marketRef(market, outcomeIndex),
    side, price, shares, checkedTo: Date.now(), expiresAt, tag,
  });
  return order.id;
}

const cancelPaperOrder = (id: string, reason: string) => updatePaperOrder(id, { status: "cancelled", cancelReason: reason });

/** After the flip harvester's dog fills: rest the 62¢ sell on all (high vol) or half (low vol) of it. */
async function placeFlipExit(bot: PmBot, account: PmAccount, ctx: BtcContext, data: FleetData, outcomeIndex: number, filled: number, now: number): Promise<void> {
  const params = { ...FLIP_DEFAULTS, ...(bot.params as Partial<FlipParams>) };
  const atr4 = windowAtr4(data.bars1m, ctx.win.startMs, now);
  const median = data.bars24h ? medianWindowAtr4(data.bars24h) : 0;
  const plan = flipExitPlan(atr4, median, params);
  const shares = floor2(filled * plan.fraction);
  const regime = `${plan.regime} vol (ATR4 $${atr4.toFixed(0)} vs 24h median $${median.toFixed(0)})`;
  if (!(shares > 0)) {
    await addBotLog(bot.id, { kind: "decision", reason: `${regime}: holding everything to resolution` });
    return;
  }
  try {
    await restOrder({ bot, account, market: ctx.market, outcomeIndex, side: "sell", price: plan.price, shares, expiresAt: ctx.win.endMs, tag: "exit" });
    await addBotLog(bot.id, { kind: "decision", reason: `${regime}: resting a sell of ${shares} @ ${plan.price.toFixed(2)}, holding ${floor2(filled - shares)} to resolution` });
  } catch (err) {
    await addBotLog(bot.id, { kind: "error", reason: `Couldn't rest the exit: ${(err as Error).message}. Holding to resolution.` });
  }
}

/** Corridor collector: once per 15-minute window, the 15m leader + the 5m opposite, equal shares. */
async function runCorridorBot(bot: PmBot, btc: BtcContext, data: FleetData, now: number): Promise<"entered" | "skipped" | "error"> {
  const win15 = btc15mWindow(now);
  const state = bot.state;
  await rollWindow(bot, win15.startMs);
  if (state.enteredWindow === win15.startMs) return "skipped";
  const params = { ...CORRIDOR_DEFAULTS, ...(bot.params as Partial<CorridorParams>) };
  const say = async (reason: string) => { await updateBot(bot.id, { state: { window: state.window, lastReason: reason, lastEvalAt: now } }); return "skipped" as const; };

  if (win15.elapsedMs < params.actFromMs || win15.elapsedMs > params.actUntilMs) {
    // Outside the action window: only the verdict from inside it matters for the log.
    if (win15.elapsedMs < params.actFromMs) return "skipped";
    return state.lastReason ? "skipped" : say("Missed the action window (no tick landed in it)");
  }
  if (typeof data.corridor === "string" || !data.corridor) return say(data.corridor ?? "No 15m market data");
  const c = data.corridor;
  if (btc.win.startMs !== win15.startMs + 600_000) return say("The 5m market sharing this close isn't the current one yet");
  const p0 = c.market15.priceToBeat ?? data.bars1m.find((b) => b.t === win15.startMs)?.o ?? 0;
  const decision = evaluateCorridor({
    elapsed15Ms: win15.elapsedMs, p0, p10: btc.strike, atr14: atr14(data.bars1m, win15.startMs + 600_000),
    ask15: c.asks15, ask5: asksOf(btc), params,
  });
  if (decision.action !== "pair") return say(decision.reason);

  const account = await botAccount(bot);
  const shares = floor2(bot.sizeUsd / (decision.limit15 + decision.limit5));
  try {
    const leg1 = await executeOrder({
      account, market: c.market15, outcomeIndex: c.idx15[decision.lead15], side: "buy", usd: shares * decision.limit15, kind: "market", limitPrice: decision.limit15, strategyId: bot.id,
    });
    await updateBot(bot.id, { touch: true, state: { window: state.window, enteredWindow: win15.startMs, lastReason: decision.reason, lastEvalAt: now } });
    try {
      const leg2 = await executeOrder({
        account, market: btc.market, outcomeIndex: btc.idx[decision.opp5], side: "buy", usd: leg1.shares * decision.limit5, kind: "market", limitPrice: decision.limit5, strategyId: bot.id,
      });
      await addBotLog(bot.id, {
        kind: "entry", reason: `${decision.reason} → 15m ${leg1.outcome} ${leg1.shares} @ ${leg1.avgPrice.toFixed(3)} + 5m ${leg2.outcome} ${leg2.shares} @ ${leg2.avgPrice.toFixed(3)} (${leg1.mode})`,
        price: leg1.avgPrice + leg2.avgPrice, shares: leg1.shares, usd: leg1.notional + leg2.notional,
      });
    } catch (err) {
      // An unpaired leg is a bet, not a corridor: flatten it.
      const flat = await executeOrder({ account, market: c.market15, outcomeIndex: c.idx15[decision.lead15], side: "sell", shares: leg1.shares, kind: "market", strategyId: bot.id }).catch(() => null);
      await addBotLog(bot.id, { kind: "error", reason: `Leg 2 failed (${(err as Error).message}); ${flat ? `flattened leg 1 at ${flat.avgPrice.toFixed(3)}` : "couldn't flatten leg 1, it's held"}` });
      return "error";
    }
    return "entered";
  } catch (err) {
    await updateBot(bot.id, { state: { window: state.window, enteredWindow: win15.startMs, lastReason: `Entry failed: ${(err as Error).message}`, lastEvalAt: now } });
    await addBotLog(bot.id, { kind: "error", reason: `${decision.reason}, but leg 1 failed: ${(err as Error).message}` });
    return "error";
  }
}

interface BoxState { phase: "quoted" | "done"; shares: number }

/** Box builder: quote both sides early, complete the box after one fill, bail out a stranded leg at T-90. Paper only. */
async function runBoxBot(bot: PmBot, ctx: BtcContext, data: FleetData, now: number): Promise<"entered" | "skipped" | "error"> {
  const { win } = ctx;
  const state = bot.state;
  await rollWindow(bot, win.startMs);
  const params = { ...BOX_DEFAULTS, ...(bot.params as Partial<BoxParams>) };
  const account = await botAccount(bot);
  const say = async (reason: string, extra: Record<string, unknown> = {}) => {
    await updateBot(bot.id, { state: { window: state.window, lastReason: reason, lastEvalAt: now, ...extra } });
    return "skipped" as const;
  };
  if (account.mode !== "paper") return say(PAPER_ONLY);
  const asks = asksOf(ctx), bids = bidsOf(ctx);
  const box = state.fleet as BoxState | null | undefined;

  if (!box) {
    if (state.enteredWindow === win.startMs) return "skipped";
    const arm = evaluateBoxArm({ elapsedMs: win.elapsedMs, asks, bids, params });
    if (arm.action !== "quote") return say(arm.reason);
    const shares = floor2(bot.sizeUsd / (arm.prices[0] + arm.prices[1]));
    const blocked = await checkBuyRisk(account, bot.sizeUsd);
    if (blocked) return say(blocked);
    const expiresAt = win.endMs - params.cancelRemainingMs;
    for (const i of [0, 1] as const) {
      await restOrder({ bot, account, market: ctx.market, outcomeIndex: ctx.idx[i], side: "buy", price: arm.prices[i], shares, expiresAt, tag: i === 0 ? "up" : "down" });
    }
    await updateBot(bot.id, { touch: true, state: { window: state.window, enteredWindow: win.startMs, lastReason: arm.reason, lastEvalAt: now, fleet: { phase: "quoted", shares } } });
    await addBotLog(bot.id, { kind: "decision", reason: `${arm.reason}; ${shares} shares a side, resting until T-${params.cancelRemainingMs / 1000}s` });
    return "entered";
  }
  if (box.phase === "done") return "skipped";

  const mine = (await listAgentPaperOrders(bot.agentId)).filter((o) => o.botId === bot.id && o.conditionId === ctx.market.conditionId);
  const leg = (tag: string) => mine.find((o) => o.tag === tag) ?? null;
  const up = leg("up"), down = leg("down");
  const filled: [number, number] = [up?.filledShares ?? 0, down?.filledShares ?? 0];
  const open = (o: PaperOrder | null) => o?.status === "open";
  const imbalance = floor2(filled[0] - filled[1]);
  const done = async (reason: string) => {
    for (const o of [up, down]) if (o && open(o)) await cancelPaperOrder(o.id, reason);
    await updateBot(bot.id, { state: { lastReason: reason, lastEvalAt: now, fleet: { ...box, phase: "done" } } });
    await addBotLog(bot.id, { kind: "decision", reason });
    return "skipped" as const;
  };

  if (Math.abs(imbalance) < 0.01) {
    if (filled[0] > 0 && (!open(up) || !open(down))) return done(`Box complete: ${filled[0]} pairs @ ${((up?.price ?? 0) + (down?.price ?? 0)).toFixed(2)}, redeems for $1 each`);
    if (filled[0] === 0 && !open(up) && !open(down)) return done("Neither side filled before the cutoff");
    // Nothing filled yet: keep the quotes near the top of each book.
    if (filled[0] === 0 && win.elapsedMs <= params.quoteUntilMs && up && down && open(up) && open(down) && asks[0] != null && asks[1] != null) {
      const behind = [0, 1].some((i) => (bids[i] ?? 0) - (i === 0 ? up.price : down.price) > params.repriceBehind + 1e-9);
      const next = behind ? boxQuotes(bids, [asks[0], asks[1]], params.bidSumCap) : null;
      if (next) {
        await updatePaperOrder(up.id, { price: next[0] });
        await updatePaperOrder(down.id, { price: next[1] });
        return say(`Repriced to Up ${next[0].toFixed(2)} + Down ${next[1].toFixed(2)}`);
      }
    }
    return say(`Quoted; waiting for fills (Up ${filled[0]}, Down ${filled[1]})`);
  }

  const held: 0 | 1 = imbalance > 0 ? 0 : 1;
  const other: 0 | 1 = held === 0 ? 1 : 0;
  const heldLeg = held === 0 ? up : down;
  const otherLeg = held === 0 ? down : up;
  const naked = Math.abs(imbalance);

  if (win.remainingMs <= params.bailoutRemainingMs) {
    const verdict = evaluateBoxBailout({ heldIndex: held, spot: ctx.spot, strike: ctx.strike, atr4: windowAtr4(data.bars1m, win.startMs, now), params });
    if (verdict.action === "cut") {
      const sold = await executeOrder({ account, market: ctx.market, outcomeIndex: ctx.idx[held], side: "sell", shares: naked, kind: "market", strategyId: bot.id }).catch((e: Error) => e);
      return done(`${verdict.reason}: ${sold instanceof Error ? `sell failed (${sold.message})` : `sold ${sold.shares} @ ${sold.avgPrice.toFixed(3)}`}`);
    }
    return done(verdict.reason);
  }

  const completion = evaluateBoxCompletion({ p1: heldLeg?.price ?? 0, otherAsk: asks[other], otherBestBid: bids[other], currentBid: otherLeg?.price ?? 0, params });
  if (completion.action === "take") {
    try {
      const f = await executeOrder({ account, market: ctx.market, outcomeIndex: ctx.idx[other], side: "buy", usd: naked * completion.limitPrice, kind: "market", limitPrice: completion.limitPrice, strategyId: bot.id });
      await addBotLog(bot.id, { kind: "entry", reason: `${completion.reason} → bought ${f.shares} @ ${f.avgPrice.toFixed(3)}`, price: f.avgPrice, shares: f.shares, usd: f.notional });
      return done("Box completed with a taker leg");
    } catch (err) {
      return say(`Completion buy failed: ${(err as Error).message}`);
    }
  }
  if (completion.action === "rebid" && otherLeg && open(otherLeg)) {
    await updatePaperOrder(otherLeg.id, { price: completion.price });
    return say(completion.reason);
  }
  return say(completion.reason);
}

/** Spread-harvest maker: one underdog bid inside a wide coin-flip book per window, pulled the moment the setup breaks. Paper only. */
async function runSpreadBot(bot: PmBot, ctx: BtcContext, data: FleetData, now: number): Promise<"entered" | "skipped" | "error"> {
  const { win } = ctx;
  const state = bot.state;
  await rollWindow(bot, win.startMs);
  const params = { ...SPREAD_DEFAULTS, ...(bot.params as Partial<SpreadParams>) };
  const account = await botAccount(bot);
  const say = async (reason: string, extra: Record<string, unknown> = {}) => {
    await updateBot(bot.id, { state: { window: state.window, lastReason: reason, lastEvalAt: now, ...extra } });
    return "skipped" as const;
  };
  if (account.mode !== "paper") return say(PAPER_ONLY);
  const atr4 = windowAtr4(data.bars1m, win.startMs, now);
  const asks = asksOf(ctx);
  const quoted = state.fleet as { orderId: string } | null | undefined;

  if (!quoted) {
    if (state.enteredWindow === win.startMs) return "skipped";
    const q = evaluateSpreadQuote({ remainingMs: win.remainingMs, spot: ctx.spot, strike: ctx.strike, atr4, asks, bids: bidsOf(ctx), params });
    if (q.action !== "quote") return say(q.reason);
    const blocked = await checkBuyRisk(account, bot.sizeUsd);
    if (blocked) return say(blocked);
    const orderId = await restOrder({
      bot, account, market: ctx.market, outcomeIndex: ctx.idx[q.outcomeIndex], side: "buy", price: q.price, shares: floor2(bot.sizeUsd / q.price),
      expiresAt: win.endMs - params.quoteMinRemainingMs, tag: "dog",
    });
    await updateBot(bot.id, { touch: true, state: { window: state.window, enteredWindow: win.startMs, lastReason: q.reason, lastEvalAt: now, fleet: { orderId } } });
    await addBotLog(bot.id, { kind: "decision", reason: q.reason });
    return "entered";
  }
  const order = (await listAgentPaperOrders(bot.agentId)).find((o) => o.id === quoted.orderId);
  if (!order || order.status !== "open") return "skipped";
  const reason = spreadCancelReason({ spot: ctx.spot, strike: ctx.strike, atr4, asks, params });
  if (reason) {
    await cancelPaperOrder(order.id, reason);
    await addBotLog(bot.id, { kind: "decision", reason: `Pulled the quote: ${reason}${order.filledShares > 0 ? ` (${order.filledShares} already filled, held)` : ""}` });
    return say(reason);
  }
  return say(`Resting ${order.outcome} ${order.price.toFixed(2)}; ${order.filledShares}/${order.shares} filled`);
}

/**
 * Fills resting paper orders from Polymarket's real trade tape since each was
 * last checked, then expires the ones past their time. Runs at the top of
 * every tick, before the bots look at their orders.
 */
export async function processPaperOrders(now = Date.now()): Promise<{ checked: number; filled: number; expired: number }> {
  const open = await listOpenPaperOrders();
  const byMarket = new Map<string, PaperOrder[]>();
  for (const o of open) byMarket.set(o.conditionId, [...(byMarket.get(o.conditionId) ?? []), o]);
  let filled = 0, expired = 0;
  await Promise.all([...byMarket.entries()].map(async ([conditionId, orders]) => {
    const since = Math.min(...orders.map((o) => o.checkedTo));
    const tape = await getTapePrints(conditionId, since).catch(() => new Map<string, { price: number; size: number; ts: number }[]>());
    const books = new Map<string, Book | null>();
    for (const o of orders) {
      if (now < o.expiresAt && !books.has(o.tokenId)) books.set(o.tokenId, await getBook(o.tokenId).catch(() => null));
    }
    for (const o of orders) {
      const to = Math.min(now, o.expiresAt);
      const shares = to > o.checkedTo
        ? restingFillShares({ side: o.side, price: o.price, remaining: o.shares - o.filledShares }, tape.get(o.tokenId) ?? [], o.checkedTo, to, now < o.expiresAt ? books.get(o.tokenId) ?? null : null)
        : 0;
      if (shares > 0) {
        const r = await applyRestingFill(o.id, shares, to);
        if (r && r.shares > 0) {
          filled++;
          await recordTrade({
            agentId: o.agentId, orgId: o.orgId, mode: "paper", conditionId, question: o.question, tokenId: o.tokenId, outcome: o.outcome,
            side: o.side, shares: r.shares, price: o.price, notional: r.shares * o.price, fee: 0, realizedPnl: r.realized,
            strategyId: o.botId, orderId: o.id, status: "filled",
          });
          if (o.botId) {
            await addBotLog(o.botId, {
              kind: o.side === "buy" ? "entry" : "exit",
              reason: `Resting ${o.side} ${o.outcome} @ ${o.price.toFixed(2)} filled ${r.shares} (maker, paper)${o.side === "sell" ? `, PnL ${r.realized >= 0 ? "+" : ""}${r.realized.toFixed(2)}` : ""}`,
              price: o.price, shares: r.shares, usd: r.shares * o.price,
            });
          }
          if (r.order.status !== "open") continue;
        } else if (r?.order.status === "cancelled") continue;
      } else if (to > o.checkedTo) {
        await updatePaperOrder(o.id, { checkedTo: to });
      }
      if (now >= o.expiresAt) {
        expired++;
        await cancelPaperOrder(o.id, "Expired");
      }
    }
  }));
  return { checked: open.length, filled, expired };
}

async function freshBotMarket(bot: PmBot): Promise<PmMarket | null> {
  return bot.market ? getMarketByConditionId(bot.market.conditionId) : null;
}

async function runTriggerBot(bot: PmBot): Promise<"entered" | "exited" | "skipped" | "error"> {
  const params = bot.params as unknown as TriggerParams;
  const market = await freshBotMarket(bot);
  if (!market || market.closed) {
    await updateBot(bot.id, { enabled: false, state: { lastReason: "Market closed" } });
    await addBotLog(bot.id, { kind: "skip", reason: "Market closed; bot stopped" });
    return "skipped";
  }
  const outcome = market.outcomes[params.outcomeIndex];
  const account = await botAccount(bot);
  const [book, held] = await Promise.all([getBook(outcome.tokenId), heldShares(account, outcome.tokenId)]);
  const decision = evaluateTrigger({
    bestAsk: book.asks[0]?.price ?? null, bestBid: book.bids[0]?.price ?? null, params, holdingShares: held.shares,
  });

  if (decision.action === "skip") {
    if (params.phase === "holding" && held.shares <= 0) {
      await updateBot(bot.id, { enabled: false, params: { ...params, phase: "done" }, state: { lastReason: decision.reason } });
      await addBotLog(bot.id, { kind: "exit", reason: decision.reason });
      return "exited";
    }
    await updateBot(bot.id, { state: { lastReason: decision.reason, lastEvalAt: Date.now() } });
    return "skipped";
  }
  try {
    if (decision.action === "buy") {
      const fill = await executeOrder({
        account, market, outcomeIndex: params.outcomeIndex, side: "buy", usd: bot.sizeUsd, kind: "market",
        limitPrice: decision.limitPrice, strategyId: bot.id,
      });
      const next: TriggerParams = { ...params, phase: params.takeProfit != null || params.stopLoss != null ? "holding" : "done" };
      await updateBot(bot.id, { touch: true, params: { ...next }, enabled: next.phase !== "done", state: { lastReason: decision.reason } });
      await addBotLog(bot.id, {
        kind: "entry", reason: `${decision.reason} → bought ${fill.shares} ${fill.outcome} @ ${fill.avgPrice.toFixed(3)} (${fill.mode})`,
        price: fill.avgPrice, shares: fill.shares, usd: fill.notional,
      });
      return "entered";
    }
    const fill = await executeOrder({
      account, market, outcomeIndex: params.outcomeIndex, side: "sell", shares: held.shares, kind: "market",
      ...(decision.limitPrice != null ? { limitPrice: decision.limitPrice } : {}), strategyId: bot.id,
    });
    await updateBot(bot.id, { touch: true, enabled: false, params: { ...params, phase: "done" }, state: { lastReason: decision.reason } });
    await addBotLog(bot.id, {
      kind: "exit", reason: `${decision.reason} → sold ${fill.shares} @ ${fill.avgPrice.toFixed(3)}, PnL ${fill.realizedPnl.toFixed(2)}`,
      price: fill.avgPrice, shares: fill.shares, usd: fill.notional,
    });
    return "exited";
  } catch (err) {
    await updateBot(bot.id, { state: { lastReason: `Order failed: ${(err as Error).message}`, lastEvalAt: Date.now() } });
    await addBotLog(bot.id, { kind: "error", reason: `${decision.reason}, but the order failed: ${(err as Error).message}` });
    return "error";
  }
}

// AI Predictor ---------------------------------------------------------------

interface AiParams {
  /** "market": the bot's fixed market every intervalMs. "btc-5m": each new BTC 5-minute window, once. */
  target: "market" | "btc-5m";
  intervalMs: number;
  /** Operator's standing instructions for the model, added to every round's system prompt. */
  instructions?: string;
}

async function predictorPosition(account: PmAccount, market: PmMarket): Promise<{ position: PredictorPosition | null; mark: number | null }> {
  const wallet = account.mode === "live" && account.live ? await getWalletPositions(account.live.address).catch(() => []) : undefined;
  for (const i of [0, 1] as const) {
    const held = await heldShares(account, market.outcomes[i].tokenId, wallet);
    if (held.shares > 0) {
      const book = await getBook(market.outcomes[i].tokenId).catch(() => null);
      return { position: { outcomeIndex: i, shares: held.shares, avgPrice: held.avgPrice }, mark: book?.bids[0]?.price ?? null };
    }
  }
  return { position: null, mark: null };
}

/** BTC spot vs. the window's strike and the last hour of 5-minute moves, for an AI round on a BTC window. */
function btcContextLines(ctx: BtcContext): string {
  const movePct = ((ctx.spot - ctx.strike) / ctx.strike) * 100;
  return [
    `BTC spot (Hyperliquid mid) = ${ctx.spot.toFixed(2)}; window strike (price to beat) = ${ctx.strike.toFixed(2)} (${movePct >= 0 ? "+" : ""}${movePct.toFixed(3)}%)`,
    "Last 5-minute BTC windows (time_utc,open,close,move_usd):",
    ...ctx.windows.slice(-12).map((w) => `${new Date(w.t).toISOString().slice(11, 16)},${w.o.toFixed(0)},${w.c.toFixed(0)},${(w.c - w.o >= 0 ? "+" : "")}${(w.c - w.o).toFixed(0)}`),
  ].join("\n");
}

/** Puts one round's question to the agent. The hub never runs a model; the agent's daemon answers. */
async function askPredictor(bot: PmBot, market: PmMarket, expiresInMs: number, btc?: BtcContext | null): Promise<void> {
  const instructions = (bot.params as Partial<AiParams>).instructions ?? null;
  const account = await botAccount(bot);
  const [yesBook, noBook, history, held] = await Promise.all([
    getBook(market.outcomes[0].tokenId),
    getBook(market.outcomes[1].tokenId),
    btc ? getPriceHistory(market.outcomes[0].tokenId, "1h", 1).catch(() => []) : getPriceHistory(market.outcomes[0].tokenId, "1w", 60).catch(() => []),
    predictorPosition(account, market),
  ]);
  const snapshot = buildSnapshot({
    market,
    quotes: [
      { bid: yesBook.bids[0]?.price ?? null, ask: yesBook.asks[0]?.price ?? null },
      { bid: noBook.bids[0]?.price ?? null, ask: noBook.asks[0]?.price ?? null },
    ],
    history,
    context: btc ? btcContextLines(btc) : null,
  });
  const { system, prompt } = decisionRequest(market, snapshot, held.position, held.mark, instructions);
  const requestId = await createAiRequest({
    agentId: bot.agentId, orgId: bot.orgId, botId: bot.id, conditionId: market.conditionId, question: market.question,
    system, prompt, holding: !!held.position, expiresAt: new Date(Date.now() + expiresInMs),
  });
  await updateBot(bot.id, { touch: true, state: { openRequestId: requestId, lastReason: "Asked the agent", lastEvalAt: Date.now() } });
}

async function runAiBot(bot: PmBot, now = Date.now(), btc?: BtcContext | string | null): Promise<"asked" | "skipped" | "error"> {
  const params = { target: "market", intervalMs: 3_600_000, ...(bot.params as Partial<AiParams>) } as AiParams;
  const state = bot.state;

  if (state.openRequestId) {
    const open = await getAiRequest(state.openRequestId);
    if (open?.status === "open" && open.expiresAt.getTime() > now) return "skipped";
    if (open?.status === "open") {
      await expireAiRequest(open.id);
      await addBotLog(bot.id, { kind: "error", reason: "The agent didn't answer in time. Is its daemon (agent-guild daemon) running?" });
    }
    await updateBot(bot.id, { state: { openRequestId: null } });
    return "skipped";
  }

  if (params.target === "btc-5m") {
    const win = btcWindow(now);
    if (state.window === win.startMs || win.elapsedMs > 60_000) return "skipped";
    await updateBot(bot.id, { state: { window: win.startMs } });
    if (typeof btc === "string" || !btc) {
      await addBotLog(bot.id, { kind: "skip", reason: typeof btc === "string" ? btc : "No BTC data" });
      return "skipped";
    }
    await askPredictor(bot, btc.market, Math.min(AI_BTC_ANSWER_MS, win.remainingMs - 30_000), btc);
    return "asked";
  }

  if (now - (bot.lastRunAt?.getTime() ?? 0) < Math.max(AI_MIN_INTERVAL_MS, params.intervalMs)) return "skipped";
  const market = await freshBotMarket(bot);
  if (!market || market.closed || !market.acceptingOrders) {
    await updateBot(bot.id, { enabled: false, touch: true, state: { lastReason: "Market closed" } });
    await addBotLog(bot.id, { kind: "skip", reason: "Market closed; bot stopped" });
    return "skipped";
  }
  await askPredictor(bot, market, Math.min(AI_ANSWER_WINDOW_MS, params.intervalMs));
  return "asked";
}

/** The agent answered a live round: trade it. The position is re-read now, not taken from when the question was asked. */
async function applyAiAnswer(req: PmAiRequest, decision: PredictorDecision, reasoning: string): Promise<{ action: string; error: string | null }> {
  const bot = await getBot(req.botId);
  if (!bot || bot.type !== "ai") return { action: "hold", error: "Bot no longer exists" };
  if (bot.state.openRequestId === req.id) await updateBot(bot.id, { state: { openRequestId: null } });
  const log = (action: string, extra: { error?: string; price?: number; shares?: number; usd?: number } = {}) => addBotLog(bot.id, {
    kind: extra.error ? "error" : "decision", decision,
    reason: `${decision} → ${action}${extra.error ? ` (failed: ${extra.error})` : ""}. ${reasoning}`.slice(0, 2000),
    price: extra.price ?? null, shares: extra.shares ?? null, usd: extra.usd ?? null,
  });
  if (!bot.enabled) {
    await log("not traded (bot was stopped)");
    return { action: "hold", error: "Bot is stopped" };
  }

  const market = await getMarketByConditionId(req.conditionId);
  if (!market) {
    await log("hold", { error: "market not found" });
    return { action: "hold", error: "Market not found" };
  }
  const account = await botAccount(bot);
  const { position } = await predictorPosition(account, market);
  const action = decisionToAction(decision, position);
  const order = (o: Omit<OrderRequest, "account" | "market" | "kind" | "strategyId">) =>
    executeOrder({ account, market, kind: "market", strategyId: bot.id, ...o });

  try {
    if (action === "hold") {
      await log("hold");
    } else if (action === "sell") {
      const f = await order({ outcomeIndex: position!.outcomeIndex, side: "sell", shares: position!.shares });
      await log(`sold ${f.shares} @ ${f.avgPrice.toFixed(3)}`, { price: f.avgPrice, shares: f.shares, usd: f.notional });
    } else {
      const target = action === "buy-yes" || action === "switch-to-yes" ? 0 : 1;
      if (position && position.outcomeIndex !== target) {
        await order({ outcomeIndex: position.outcomeIndex, side: "sell", shares: position.shares });
      }
      const f = await order({ outcomeIndex: target, side: "buy", usd: bot.sizeUsd });
      await log(`${action}: bought ${f.shares} ${f.outcome} @ ${f.avgPrice.toFixed(3)}`, { price: f.avgPrice, shares: f.shares, usd: f.notional });
    }
    return { action, error: null };
  } catch (err) {
    await log(action, { error: (err as Error).message });
    return { action, error: (err as Error).message };
  }
}

/** Stops a bot whose realized loss in the account's current mode has reached its maxLossUsd. */
export async function enforceBotLossLimit(bot: PmBot): Promise<boolean> {
  if (bot.maxLossUsd == null) return false;
  const mode = (await getAccount(bot.agentId))?.mode ?? "paper";
  const pnl = bot.stats[mode].realizedPnl;
  if (pnl > -bot.maxLossUsd) return false;
  const reason = `Loss limit hit: ${mode} realized PnL ${pnl.toFixed(2)} ≤ −${bot.maxLossUsd}. Bot stopped.`;
  await updateBot(bot.id, { enabled: false, state: { lastReason: reason } });
  await addBotLog(bot.id, { kind: "exit", reason });
  return true;
}

/**
 * One minute of Polymarket: fills resting paper orders from the tape, pays out
 * resolved paper positions, then runs every enabled bot. Shared data (BTC
 * window, candles, liquidations, whales, the 15m market) is fetched once.
 * Called by the scheduler (/api/cron/polymarket-tick, every minute) and by
 * the hub tick; a lock keeps two runs from overlapping and double-entering.
 */
export async function runPolymarketTick(now = Date.now()): Promise<{ bots: number; entered: number; asked: number; settled: number; filled: number; errors: number; locked?: boolean }> {
  const holder = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  if (!(await acquireTickLock(holder, 50_000, now))) return { bots: 0, entered: 0, asked: 0, settled: 0, filled: 0, errors: 0, locked: true };
  try {
    return await tickOnce(now);
  } finally {
    try { await releaseTickLock(holder); } catch { /* the lock expires on its own */ }
  }
}

async function tickOnce(now: number): Promise<{ bots: number; entered: number; asked: number; settled: number; filled: number; errors: number }> {
  let errors = 0;
  const orders = await processPaperOrders(now).catch((err) => {
    console.error("[polymarket] resting orders failed:", err);
    errors++;
    return { checked: 0, filled: 0, expired: 0 };
  });
  const resolved = await resolvePaperPositions(now).catch((err) => {
    console.error("[polymarket] resolution sweep failed:", err);
    errors++;
    return { checked: 0, settled: 0 };
  });

  const enabled = (await listEnabledBots()).filter((b) => !b.state.eliminated);
  const stopped = await Promise.all(enabled.map((b) => enforceBotLossLimit(b).catch(() => false)));
  const bots = enabled.filter((_, i) => !stopped[i]);
  const types = new Set<string>(bots.map((b) => b.type));
  const needsBtc = bots.some((b) => b.type !== "ai" && b.type !== "price-trigger") || bots.some((b) => b.type === "ai" && b.params.target === "btc-5m");
  const [btc, data] = await Promise.all([
    needsBtc ? loadBtcContext(now).catch((err: Error) => `BTC data failed: ${err.message}`) : Promise.resolve(null),
    loadFleetData(types, now),
  ]);

  let entered = 0;
  let asked = 0;
  const results = await Promise.allSettled(bots.map(async (bot) => {
    if (bot.type === "ai") return runAiBot(bot, now, btc);
    if (bot.type === "price-trigger") return runTriggerBot(bot);
    if (typeof btc === "string" || !btc) {
      await updateBot(bot.id, { state: { lastReason: btc ?? "No BTC data", lastEvalAt: now } });
      return "skipped";
    }
    if (bot.type === "corridor") return runCorridorBot(bot, btc, data, now);
    if (bot.type === "box-builder") return runBoxBot(bot, btc, data, now);
    if (bot.type === "spread-maker") return runSpreadBot(bot, btc, data, now);
    return runBtcBot(bot, btc, data, now);
  }));
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      errors++;
      console.error(`[polymarket] bot ${bots[i].id} failed:`, r.reason);
    } else if (r.value === "entered") entered++;
    else if (r.value === "asked") asked++;
    else if (r.value === "error") errors++;
  });
  return { bots: bots.length, entered, asked, settled: resolved.settled, filled: orders.filled, errors };
}

/** Rebuilds the near-liquidation bot's whale list (the largest Hyperliquid accounts holding BTC). */
export async function refreshPolymarketWhales(): Promise<{ whales: number }> {
  const addresses = await refreshWhaleUniverse();
  await setWhaleUniverse(addresses);
  return { whales: addresses.length };
}

// ── Agent tool manifest ─────────────────────────────────────────────────────

const AGENT_TOOLS = [
  {
    name: "polymarket_markets",
    description: "Find Polymarket markets: the most active right now, or search by keyword. Each market has a conditionId and its outcomes with prices (a price is the implied probability).",
    method: "GET", path: "markets",
    input_schema: { type: "object", properties: { q: { type: "string", description: "Search text; omit for trending" } } },
  },
  {
    name: "polymarket_market",
    description: "One market in full: question, resolution rules, outcomes with token ids and prices, end date, fees.",
    method: "GET", path: "market/{conditionId}",
    input_schema: { type: "object", properties: { conditionId: { type: "string" } }, required: ["conditionId"] },
  },
  {
    name: "polymarket_book",
    description: "Order book (best bids/asks) for one outcome token.",
    method: "GET", path: "book/{tokenId}",
    input_schema: { type: "object", properties: { tokenId: { type: "string" } }, required: ["tokenId"] },
  },
  {
    name: "polymarket_account",
    description: "Your Polymarket account: mode (paper or live), cash, open positions with marks, risk limits.",
    method: "GET", path: "account/{agentId}",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "polymarket_order",
    description: "Buy or sell outcome shares from your own account, within your risk limits. BUY spends usd; SELL sells shares (default: all). Market orders take liquidity up to limitPrice if given.",
    method: "POST", path: "order",
    input_schema: {
      type: "object",
      properties: {
        conditionId: { type: "string" },
        outcomeIndex: { type: "number", description: "0 = first outcome (usually Yes), 1 = second (usually No)" },
        side: { type: "string", enum: ["buy", "sell"] },
        usd: { type: "number", description: "BUY: dollars to spend" },
        shares: { type: "number", description: "SELL: shares to sell" },
        kind: { type: "string", enum: ["market", "limit"] },
        limitPrice: { type: "number", description: "0–1. Market: worst price you'll accept. Limit: your price." },
      },
      required: ["conditionId", "outcomeIndex", "side"],
    },
  },
  {
    name: "polymarket_trades",
    description: "Your fills and resolutions, newest first, with realized PnL.",
    method: "GET", path: "trades/{agentId}",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "polymarket_bots",
    description: "Your trading bots with their settings, status, last check and results (entries, wins/losses, realized PnL) per mode.",
    method: "GET", path: "bots/{agentId}",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "polymarket_orders",
    description: "Your resting paper limit orders (maker bots and the flip harvester's exits): price, shares filled, status, why cancelled.",
    method: "GET", path: "paper-orders/{agentId}",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "polymarket_bot_create",
    description:
      "Start a bot that trades from your account. Types: 'mid-price' and 'streak-fade' trade each BTC 5-minute Up/Down window; " +
      "'ai' asks you (via polymarket_ai_requests) to decide each round, params { target: 'btc-5m' | 'market', intervalMs, instructions? } — instructions is your operator's standing strategy, shown in every round's prompt; " +
      "'price-trigger' buys when an outcome's ask crosses a price, params { outcomeIndex, when: 'ask-below'|'ask-above', price, takeProfit?, stopLoss? }. " +
      "Moon Dev's BTC fleet (published defaults; params optional): 'corridor' (15m leader + 5m opposite pair, sizeUsd per pair), " +
      "'flip-harvest' (last-minute coin-flip underdog, rests a 62¢ sell), 'box-builder' (bids both sides ≤ 94¢ total; paper only), " +
      "'spread-maker' (one underdog bid inside a wide book; paper only), 'liq-cascade' (≥ $10k one-sided liquidations + move + volume, 50–85¢), " +
      "'small-liq' ($25k–$500k liquidations, 30–45¢), 'near-liq' (whale near liquidation + a same-side liquidation print). " +
      "conditionId is required for price-trigger and for ai with target 'market'. maxLossUsd stops the bot once its realized loss reaches it.",
    method: "POST", path: "bots",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["ai", "mid-price", "streak-fade", "price-trigger", ...FLEET_BOT_TYPES] },
        sizeUsd: { type: "number", description: "USD per trade" },
        conditionId: { type: "string" },
        maxLossUsd: { type: "number" },
        params: { type: "object" },
      },
      required: ["type", "sizeUsd"],
    },
  },
  {
    name: "polymarket_bot_toggle",
    description: "Start (enabled: true) or stop (enabled: false) one of your bots.",
    method: "POST", path: "bots/{id}/toggle",
    input_schema: { type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, required: ["id", "enabled"] },
  },
  {
    name: "polymarket_bot_log",
    description: "One bot's recent log: entries, exits, resolutions, skipped windows with the reason, errors.",
    method: "GET", path: "bots/{id}/log",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "polymarket_ai_requests",
    description: "Questions waiting for you from your AI Predictor bots. Decide each and answer with polymarket_ai_answer before it expires.",
    method: "GET", path: "ai/requests",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "polymarket_ai_answer",
    description: "Answer one AI Predictor question. The answer is traded immediately from your account, within your risk limits.",
    method: "POST", path: "ai/requests/{id}/answer",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        decision: { type: "string", enum: ["BUY_YES", "BUY_NO", "SELL", "HOLD"] },
        reasoning: { type: "string" },
      },
      required: ["id", "decision"],
    },
  },
];

// ── Route helpers ───────────────────────────────────────────────────────────

function publicAccount(account: PmAccount) {
  return {
    agentId: account.agentId, orgId: account.orgId, mode: account.mode, paperCash: account.paperCash,
    paperStartCash: account.paperStartCash, live: account.live ? { address: account.live.address } : null, risk: account.risk,
  };
}

function parseRisk(body: Record<string, unknown>, current: PmRisk): PmRisk | string {
  const next = { ...current };
  for (const key of ["maxOrderUsd", "maxExposureUsd", "maxDailyLossUsd"] as const) {
    if (body[key] == null) continue;
    const v = Number(body[key]);
    if (!Number.isFinite(v) || v <= 0 || v > 1_000_000) return `${key} must be a positive number`;
    next[key] = v;
  }
  if (next.maxOrderUsd > next.maxExposureUsd) return "maxOrderUsd can't exceed maxExposureUsd";
  return next;
}

function toBotMarket(m: PmMarket): BotMarket {
  return { conditionId: m.conditionId, question: m.question, slug: m.slug, outcomes: m.outcomes.map((o) => ({ name: o.name, tokenId: o.tokenId })) };
}

function publicBot(b: PmBot) {
  return {
    id: b.id, type: b.type, enabled: b.enabled, sizeUsd: b.sizeUsd, market: b.market, params: b.params,
    maxLossUsd: b.maxLossUsd, stats: b.stats,
    lastReason: b.state.lastReason ?? null, lastEvalAt: b.state.lastEvalAt ?? null, waitingOnAgent: !!b.state.openRequestId,
    lastRunAt: b.lastRunAt?.toISOString() ?? null, createdAt: b.createdAt?.toISOString() ?? null,
  };
}

const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && v >= lo && v <= hi ? v : undefined);

/** maxLossUsd: undefined → invalid, null → no limit. */
function parseMaxLoss(v: unknown): number | null | undefined {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 && x <= 1_000_000 ? x : undefined;
}

/** Validated, defaulted params for a bot type, or an error message. */
export function parseBotParams(type: BotType, raw: Record<string, unknown>): Record<string, unknown> | string {
  let params: Record<string, unknown>;
  if (type === "ai") {
    const target = raw.target === "btc-5m" ? "btc-5m" : "market";
    if (raw.instructions != null && typeof raw.instructions !== "string") return "params.instructions must be text";
    const instructions = typeof raw.instructions === "string" ? raw.instructions.trim() : "";
    if (instructions.length > INSTRUCTIONS_MAX) return `params.instructions must be at most ${INSTRUCTIONS_MAX} characters`;
    params = {
      target, intervalMs: Math.max(AI_MIN_INTERVAL_MS, num(raw.intervalMs, AI_MIN_INTERVAL_MS, 7 * 86_400_000) ?? 3_600_000),
      ...(instructions ? { instructions } : {}),
    };
  } else if (type === "price-trigger") {
    const price = num(raw.price, 0.01, 0.99);
    if (price == null) return "params.price must be between 0.01 and 0.99";
    const outcomeIndex = raw.outcomeIndex === 1 ? 1 : 0;
    const when = raw.when === "ask-above" ? "ask-above" : "ask-below";
    const takeProfit = num(raw.takeProfit, 0.01, 0.99) ?? null;
    const stopLoss = num(raw.stopLoss, 0.01, 0.99) ?? null;
    if (takeProfit != null && takeProfit <= price) return "takeProfit must be above the entry price";
    if (stopLoss != null && stopLoss >= price) return "stopLoss must be below the entry price";
    params = { outcomeIndex, when, price, takeProfit, stopLoss, phase: "armed" } satisfies TriggerParams;
  } else if (type === "mid-price") {
    params = {
      minMovePct: num(raw.minMovePct, 0.001, 5) ?? MID_PRICE_DEFAULTS.minMovePct,
      minAsk: num(raw.minAsk, 0.01, 0.99) ?? MID_PRICE_DEFAULTS.minAsk,
      maxAsk: num(raw.maxAsk, 0.01, 0.99) ?? MID_PRICE_DEFAULTS.maxAsk,
      entryUntilMs: num(raw.entryUntilMs, 10_000, 290_000) ?? MID_PRICE_DEFAULTS.entryUntilMs,
    } satisfies MidPriceParams;
    if ((params.minAsk as number) >= (params.maxAsk as number)) return "minAsk must be below maxAsk";
  } else if ((FLEET_BOT_TYPES as string[]).includes(type)) {
    const parsed = fleetParams(FLEET_DEFAULTS[type as FleetBotType], raw);
    if (typeof parsed === "string") return parsed;
    params = parsed;
  } else {
    params = {
      minStreak: num(raw.minStreak, 2, 12) ?? STREAK_DEFAULTS.minStreak,
      atrMult: num(raw.atrMult, 0, 20) ?? STREAK_DEFAULTS.atrMult,
      maxAsk: num(raw.maxAsk, 0.01, 0.99) ?? STREAK_DEFAULTS.maxAsk,
      entryUntilMs: num(raw.entryUntilMs, 10_000, 290_000) ?? STREAK_DEFAULTS.entryUntilMs,
    } satisfies StreakParams;
  }
  return params;
}

const BOT_TYPES: BotType[] = ["ai", "mid-price", "streak-fade", "price-trigger", ...FLEET_BOT_TYPES];

const FLEET_DEFAULTS: Record<FleetBotType, object> = {
  "corridor": CORRIDOR_DEFAULTS,
  "flip-harvest": FLIP_DEFAULTS,
  "box-builder": BOX_DEFAULTS,
  "spread-maker": SPREAD_DEFAULTS,
  "liq-cascade": CASCADE_DEFAULTS,
  "small-liq": SMALL_LIQ_DEFAULTS,
  "near-liq": NEAR_LIQ_DEFAULTS,
};

/**
 * A fleet bot's params: Moon Dev's published defaults, with numeric overrides
 * for the same keys only. Times (…Ms) stay inside a 15-minute window, prices
 * and fractions inside 0–1 when the default is one, dollar amounts positive.
 */
export function fleetParams(defaults: object, raw: Record<string, unknown>): Record<string, unknown> | string {
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, def] of Object.entries(defaults)) {
    if (raw[key] == null) continue;
    const v = Number(raw[key]);
    const isMs = key.endsWith("Ms");
    const isUnit = !isMs && typeof def === "number" && def > 0 && def <= 1 && !/Ratio|Mult|Atr|Coa|Bps|Pct/.test(key);
    const max = isMs ? 900_000 : isUnit ? 1 : 1e9;
    if (!Number.isFinite(v) || v < 0 || v > max) return `params.${key} must be between 0 and ${max}`;
    out[key] = v;
  }
  return out;
}

// ── Mod ─────────────────────────────────────────────────────────────────────

export default defineServerMod({
  setup(ctx) {
    ctx.log.info("polymarket-trading mod loaded");
  },

  routes: {
    "GET /agent/tools": {
      public: true,
      handler: async () => json({
        mod: MOD_ID,
        basePath: `/api/mods/${MOD_ID}`,
        auth: "Authorization: Bearer agt_… (mods:call scope), Ed25519 agent/sig/ts, or agentId/apiKey",
        injected: { agentId: "Filled into {agentId} path segments from GET /me" },
        tools: AGENT_TOOLS,
      }),
    },

    /** GET /geo — whether this server can place live Polymarket orders. */
    "GET /geo": async () => json(await checkGeoblock()),

    /** GET /me — capabilities, mode and readiness for one agent (agent signature, or ?agentId= for a person). */
    "GET /me": async (req, ctx) => {
      const agentId = ctx.agent?.agentId ?? new URL(req.url).searchParams.get("agentId");
      const access = await requireAgentAccess(ctx, agentId);
      if ("error" in access) return fail(access.error, access.status);
      const [caps, account, install] = await Promise.all([
        getAgentCapabilities(agentId!, access.orgId),
        ensureAccount(agentId!, access.orgId),
        getModInstallStatus(access.orgId, REGISTRY_MOD_ID),
      ]);
      const granted = new Set(caps.map((c) => c.key));
      const capabilities = Object.fromEntries(TRADING_CAPABILITIES.map((k) => [k, granted.has(k)]));
      return json({
        agentId, orgId: access.orgId, via: ctx.agent ? "agent" : "session", capabilities,
        install: { installed: install.installed, enabled: install.enabled },
        account: publicAccount(account),
      });
    },

    /**
     * POST /grant { agentId } — turn on this mod's trading capabilities for the
     * agent's org (they're org-wide). Owner only, and only for an org that has
     * already installed the mod from the Market.
     */
    /**
     * POST /prompt { agentId, text } — send the agent instructions in its
     * private DM. Owner only: the daemon gives tools (and so trading) only to
     * DMs from the org owner, so anyone else's prompt couldn't act anyway.
     */
    "POST /prompt": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const access = await requireOwner(ctx, body.agentId);
      if ("error" in access) return fail(access.error, access.status);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return fail("text is required");
      if (text.length > MAX_PROMPT_CHARS) return fail(`Keep the prompt under ${MAX_PROMPT_CHARS} characters`);
      const agent = await getAgent(body.agentId);
      const sent = await postAgentDmMessage({
        agentId: body.agentId, orgId: access.orgId, agentName: agent?.name || "Agent",
        senderAddress: ctx.session!.address, text,
      });
      return json(sent);
    },

    "POST /grant": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const access = await requireOwner(ctx, body.agentId);
      if ("error" in access) return fail(access.error, access.status);
      const out = await enableModCapabilities(access.orgId, REGISTRY_MOD_ID, TRADING_CAPABILITIES);
      if (!out.installed) return fail("This org hasn't installed Polymarket Trading. Install it from the Market first.", 404);
      return json(out);
    },

    /** GET /my-agents — agents in the operator's orgs, with their Polymarket mode, for the panel's picker. Session only. */
    "GET /my-agents": async (_req, ctx) => {
      if (!ctx.session) return fail("Sign in to list your agents", 401);
      const orgs = await getOrganizationsByWalletAdmin(ctx.session.address);
      const perOrg = await Promise.all(orgs.map(async (org) => {
        const agents = await getAgentsByOrg(org.id);
        return Promise.all(agents.map(async (agent) => {
          const account = await getAccount(agent.id);
          return {
            agentId: agent.id, name: agent.name, orgId: org.id, orgName: org.name || org.id, status: agent.status,
            mode: account?.mode ?? "paper", liveAddress: account?.live?.address ?? null,
            isOwner: !!org.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === canonicalizeWalletAddress(ctx.session!.address),
          };
        }));
      }));
      return json({ agents: perOrg.flat() });
    },

    /** GET /account/:agentId — cash, open positions with marks, risk; live adds wallet balances and approvals. */
    "GET /account/:agentId": async (_req, ctx) => {
      const access = await requireAgentAccess(ctx, ctx.params.agentId);
      if ("error" in access) return fail(access.error, access.status);
      const account = await ensureAccount(ctx.params.agentId, access.orgId);
      const daily = await getDailyRealizedPnl(account.agentId, account.mode);

      if (account.mode === "paper") {
        await resolveAgentPaperPositions(account.agentId).catch((err) => console.error("[polymarket] resolution failed:", err));
        const positions = await listPaperPositions(account.agentId);
        const marked = await Promise.all(positions.map(async (p) => {
          const book = await getBook(p.tokenId).catch(() => null);
          const mark = book?.bids[0]?.price ?? null;
          return {
            tokenId: p.tokenId, conditionId: p.conditionId, question: p.question, outcome: p.outcome, outcomeIndex: p.outcomeIndex,
            shares: p.shares, avgPrice: p.avgPrice, mark, value: mark != null ? mark * p.shares : null,
            unrealizedPnl: mark != null ? (mark - p.avgPrice) * p.shares : null, endDate: p.endDate, redeemable: false,
          };
        }));
        const value = marked.reduce((s, p) => s + (p.value ?? p.shares * p.avgPrice), 0);
        return json({
          account: publicAccount(account), cash: account.paperCash, equity: account.paperCash + value,
          pnl: account.paperCash + value - account.paperStartCash, dailyRealizedPnl: daily, positions: marked, wallet: null,
        });
      }

      const [wallet, positions, geo] = await Promise.all([
        getLiveWalletState(account.live!.address).catch(() => null),
        getWalletPositions(account.live!.address).catch(() => []),
        checkGeoblock(),
      ]);
      const value = positions.reduce((s, p) => s + p.currentValue, 0);
      return json({
        account: publicAccount(account), cash: wallet?.pusd ?? null, equity: wallet ? wallet.pusd + value : null, pnl: null,
        dailyRealizedPnl: daily,
        positions: positions.map((p) => ({
          tokenId: p.tokenId, conditionId: p.conditionId, question: p.title, outcome: p.outcome, outcomeIndex: p.outcomeIndex,
          shares: p.shares, avgPrice: p.avgPrice, mark: p.curPrice, value: p.currentValue, unrealizedPnl: p.cashPnl,
          endDate: p.endDate, redeemable: p.redeemable,
        })),
        wallet, geo,
      });
    },

    /** POST /mode { agentId, mode } — paper is always allowed; live needs the owner to have set it up (POST /live/enable). */
    "POST /mode": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const agentId = ctx.agent?.agentId ?? body.agentId;
      if (body.mode !== "paper" && body.mode !== "live") return fail("mode must be paper or live");
      if (body.mode === "live") {
        const owner = await requireOwner(ctx, agentId);
        if ("error" in owner) return fail(owner.error, owner.status);
        const account = await ensureAccount(agentId, owner.orgId);
        if (!account.live) return fail("Set up live trading first (POST /live/enable)");
      } else {
        const access = await requireAgentAccess(ctx, agentId);
        if ("error" in access) return fail(access.error, access.status);
        await ensureAccount(agentId, access.orgId);
      }
      await updateAccount(agentId, { mode: body.mode });
      return json({ ok: true, mode: body.mode });
    },

    /**
     * POST /live/enable { agentId } — org owner only. Links the agent's
     * platform-held EVM wallet (creating one if needed) as its Polymarket
     * trading wallet and switches the agent to live. Fund it with pUSD plus a
     * little POL, then POST /live/approve once.
     */
    "POST /live/enable": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const owner = await requireOwner(ctx, body.agentId);
      if ("error" in owner) return fail(owner.error, owner.status);
      const agentId: string = body.agentId;
      await ensureAccount(agentId, owner.orgId);
      let wallet = (await listAgentWallets(agentId)).find((w) => w.chain === "evm");
      if (!wallet) wallet = await generateAgentWallet(agentId, owner.orgId, ctx.session!.address, { chain: "evm", label: "Polymarket trading" });
      await updateAccount(agentId, { mode: "live", live: { walletId: wallet.id, address: wallet.publicKey, enabledBy: ctx.session!.address } });
      ctx.log.info(`live trading ON for agent ${agentId} by ${ctx.session!.address}`);
      return json({ ok: true, address: wallet.publicKey, geo: await checkGeoblock() });
    },

    /** POST /live/disable { agentId } — back to paper and unlink the wallet. Any org member or the agent itself. */
    "POST /live/disable": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const access = await requireAgentAccess(ctx, agentId);
      if ("error" in access) return fail(access.error, access.status);
      await ensureAccount(agentId, access.orgId);
      await updateAccount(agentId, { mode: "paper", live: null });
      ctx.log.info(`live trading OFF for agent ${agentId}`);
      return json({ ok: true });
    },

    /** POST /live/approve { agentId } — owner only: sends the one-time token approvals from the agent's wallet (spends POL gas). */
    "POST /live/approve": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const owner = await requireOwner(ctx, body.agentId);
      if ("error" in owner) return fail(owner.error, owner.status);
      const account = await ensureAccount(body.agentId, owner.orgId);
      if (!account.live) return fail("Live trading isn't set up for this agent");
      try {
        const result = await ensureApprovals(await signingKey(account));
        return json({ ok: true, ...result, wallet: await getLiveWalletState(account.live.address) });
      } catch (err) {
        return fail(`Approval failed: ${(err as Error).message}. The wallet needs a little POL for gas.`);
      }
    },

    /** POST /risk { agentId, maxOrderUsd?, maxExposureUsd?, maxDailyLossUsd? } — people only: an agent can't loosen its own limits. */
    "POST /risk": async (req, ctx) => {
      if (ctx.agent) return fail("Risk limits are set by a person, not the agent", 403);
      const body = await req.json().catch(() => ({}));
      const access = await requireAgentAccess(ctx, body.agentId);
      if ("error" in access) return fail(access.error, access.status);
      const account = await ensureAccount(body.agentId, access.orgId);
      const risk = parseRisk(body, account.risk);
      if (typeof risk === "string") return fail(risk);
      await updateAccount(body.agentId, { risk });
      return json({ ok: true, risk });
    },

    /** POST /paper/reset { agentId, startCash? } — fresh paper cash, paper positions cleared. People only. */
    "POST /paper/reset": async (req, ctx) => {
      if (ctx.agent) return fail("Only a person can reset the paper account", 403);
      const body = await req.json().catch(() => ({}));
      const access = await requireAgentAccess(ctx, body.agentId);
      if ("error" in access) return fail(access.error, access.status);
      const startCash = body.startCash == null ? PAPER_START_CASH : Number(body.startCash);
      if (!(startCash >= 10 && startCash <= 1_000_000)) return fail("startCash must be between 10 and 1,000,000");
      await ensureAccount(body.agentId, access.orgId);
      await resetPaper(body.agentId, startCash);
      return json({ ok: true, cash: startCash });
    },

    /** POST /paper/claim { agentId } — pay out this agent's resolved paper positions now. Members or the agent itself. */
    "POST /paper/claim": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const access = await requireAgentAccess(ctx, agentId);
      if ("error" in access) return fail(access.error, access.status);
      const result = await resolveAgentPaperPositions(agentId);
      const account = await ensureAccount(agentId, access.orgId);
      return json({ ...result, paperCash: account.paperCash });
    },

    /** POST /paper/fund { agentId, amount } — add paper money (1–1,000,000). People only. */
    "POST /paper/fund": async (req, ctx) => {
      if (ctx.agent) return fail("Only a person can add paper funds", 403);
      const body = await req.json().catch(() => ({}));
      const access = await requireAgentAccess(ctx, body.agentId);
      if ("error" in access) return fail(access.error, access.status);
      const amount = Number(body.amount);
      if (!(amount >= 1 && amount <= 1_000_000)) return fail("amount must be between 1 and 1,000,000");
      await ensureAccount(body.agentId, access.orgId);
      return json({ ok: true, cash: await addPaperFunds(body.agentId, amount) });
    },

    /** GET /markets?q= — trending events, or search results. */
    "GET /markets": async (req) => {
      const url = new URL(req.url);
      const q = url.searchParams.get("q")?.trim();
      const tag = url.searchParams.get("tag")?.trim() || undefined;
      try {
        const events = q ? await searchEvents(q) : await getTrendingEvents(40, tag);
        return json({ events });
      } catch (err) {
        return fail((err as Error).message, 502);
      }
    },

    /** GET /markets/btc-5m — the live BTC 5-minute Up/Down window. */
    "GET /markets/btc-5m": async () => {
      const win = btcWindow();
      const market = await getBtcWindowMarket(win).catch(() => null);
      return json({ window: win, market });
    },

    "GET /market/:conditionId": async (_req, ctx) => {
      const market = await getMarketByConditionId(ctx.params.conditionId).catch(() => null);
      return market ? json({ market }) : fail("Market not found", 404);
    },

    "GET /book/:tokenId": async (_req, ctx) => {
      try {
        return json({ book: await getBook(ctx.params.tokenId) });
      } catch (err) {
        return fail((err as Error).message, 502);
      }
    },

    "GET /history/:tokenId": async (req, ctx) => {
      const url = new URL(req.url);
      const interval = url.searchParams.get("interval") ?? "1d";
      if (!["1h", "6h", "1d", "1w", "1m", "max"].includes(interval)) return fail("interval must be 1h, 6h, 1d, 1w, 1m or max");
      const fidelity = Math.max(1, Math.min(1440, Number(url.searchParams.get("fidelity")) || 5));
      try {
        return json({ history: await getPriceHistory(ctx.params.tokenId, interval, fidelity) });
      } catch (err) {
        return fail((err as Error).message, 502);
      }
    },

    /**
     * POST /order — buy or sell outcome shares in the agent's current mode.
     * Body: { agentId, conditionId, outcomeIndex, side, usd?, shares?, kind?, limitPrice? }
     */
    "POST /order": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const access = await requireAgentAccess(ctx, agentId);
      if ("error" in access) return fail(access.error, access.status);
      if (body.side !== "buy" && body.side !== "sell") return fail("side must be buy or sell");
      if (typeof body.conditionId !== "string") return fail("conditionId is required");
      const market = await getMarketByConditionId(body.conditionId).catch(() => null);
      if (!market) return fail("Market not found", 404);
      const account = await ensureAccount(agentId, access.orgId);
      try {
        const result = await executeOrder({
          account, market, outcomeIndex: Number(body.outcomeIndex), side: body.side,
          usd: body.usd != null ? Number(body.usd) : undefined,
          shares: body.shares != null ? Number(body.shares) : undefined,
          kind: body.kind === "limit" ? "limit" : "market",
          limitPrice: body.limitPrice != null ? Number(body.limitPrice) : undefined,
        });
        return json({ ok: true, ...result });
      } catch (err) {
        if (err instanceof OrderError) return fail(err.message, err.status);
        throw err;
      }
    },

    /** GET /orders/:agentId — resting live orders (paper orders never rest). */
    "GET /orders/:agentId": async (_req, ctx) => {
      const access = await requireAgentAccess(ctx, ctx.params.agentId);
      if ("error" in access) return fail(access.error, access.status);
      const account = await ensureAccount(ctx.params.agentId, access.orgId);
      if (account.mode !== "live" || !account.live) return json({ orders: [] });
      try {
        return json({ orders: await getLiveOpenOrders(await signingKey(account)) });
      } catch (err) {
        return fail((err as Error).message, 502);
      }
    },

    "DELETE /orders/:agentId/:orderId": async (_req, ctx) => {
      const access = await requireAgentAccess(ctx, ctx.params.agentId);
      if ("error" in access) return fail(access.error, access.status);
      const account = await ensureAccount(ctx.params.agentId, access.orgId);
      if (!account.live) return fail("Live trading isn't set up for this agent");
      try {
        await cancelLiveOrder(await signingKey(account), ctx.params.orderId);
        return json({ ok: true });
      } catch (err) {
        return fail((err as Error).message, 502);
      }
    },

    "GET /trades/:agentId": async (_req, ctx) => {
      const access = await requireAgentAccess(ctx, ctx.params.agentId);
      if ("error" in access) return fail(access.error, access.status);
      const trades = await listTrades(ctx.params.agentId);
      const settled = trades.filter((t) => t.side !== "buy");
      return json({
        trades: trades.map((t) => ({ ...t, createdAt: t.createdAt?.toISOString() ?? null })),
        stats: {
          realizedPnl: trades.reduce((s, t) => s + t.realizedPnl, 0),
          wins: settled.filter((t) => t.realizedPnl > 0).length,
          losses: settled.filter((t) => t.realizedPnl < 0).length,
        },
      });
    },

    // Bots -------------------------------------------------------------------

    /** GET /paper-orders/:agentId — resting paper orders, newest first (open and recent). */
    "GET /paper-orders/:agentId": async (_req, ctx) => {
      const access = await requireAgentAccess(ctx, ctx.params.agentId);
      if ("error" in access) return fail(access.error, access.status);
      return json({ orders: await listAgentPaperOrders(ctx.params.agentId, 30) });
    },

    /** GET /feeds — health of the fleet's outside data: liquidation feed, whale list, tick lock. Public: no account data. */
    "GET /feeds": {
      public: true,
      handler: async () => {
        const now = Date.now();
        const [liqs, whales] = await Promise.all([
          recentBtcLiquidations().then((l) => ({ ok: true, last2m: liquidationTotals(l, now), newest: l.length ? now - l[l.length - 1].ts : null })).catch((e: Error) => ({ ok: false, error: e.message })),
          getWhaleUniverse(),
        ]);
        return json({ liquidations: liqs, whales: { count: whales.addresses.length, refreshedAt: whales.refreshedAt || null } });
      },
    },

    "GET /bots/:agentId": async (_req, ctx) => {
      const access = await requireAgentAccess(ctx, ctx.params.agentId);
      if ("error" in access) return fail(access.error, access.status);
      return json({ bots: (await listBots(ctx.params.agentId)).map(publicBot) });
    },

    /**
     * POST /bots — create a bot. Body: { agentId, type, sizeUsd, conditionId?, params? }
     * ai: params { target: "market"|"btc-5m", intervalMs }; conditionId required for "market".
     * price-trigger: conditionId + params { outcomeIndex, when, price, takeProfit?, stopLoss? }.
     * mid-price / streak-fade: optional rule overrides in params.
     */
    "POST /bots": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const access = await requireAgentAccess(ctx, agentId);
      if ("error" in access) return fail(access.error, access.status);
      try {
        await enforceCapability(agentId, access.orgId, CAP_BOTS);
      } catch (err) {
        return fail((err as Error).message, 403);
      }
      const type = body.type as BotType;
      if (!BOT_TYPES.includes(type)) return fail(`type must be one of ${BOT_TYPES.join(", ")}`);
      const sizeUsd = Number(body.sizeUsd);
      if (!(sizeUsd >= MIN_ORDER_USD)) return fail(`sizeUsd must be at least $${MIN_ORDER_USD}`);
      const account = await ensureAccount(agentId, access.orgId);
      if (sizeUsd > account.risk.maxOrderUsd) return fail(`sizeUsd exceeds the max order size of $${account.risk.maxOrderUsd}`);
      const raw = (body.params ?? {}) as Record<string, unknown>;

      let market: PmMarket | null = null;
      const needsMarket = type === "price-trigger" || (type === "ai" && raw.target !== "btc-5m");
      if (needsMarket) {
        if (typeof body.conditionId !== "string") return fail("conditionId is required for this bot");
        market = await getMarketByConditionId(body.conditionId).catch(() => null);
        if (!market || market.closed) return fail("Market not found or closed");
        if (market.outcomes.length !== 2) return fail("Only two-outcome markets are supported");
      }

      const params = parseBotParams(type, raw);
      if (typeof params === "string") return fail(params);
      const maxLossUsd = parseMaxLoss(body.maxLossUsd);
      if (maxLossUsd === undefined) return fail("maxLossUsd must be a positive number");

      const id = await createBot({ agentId, orgId: access.orgId, type, sizeUsd, market: market ? toBotMarket(market) : null, params, maxLossUsd });
      return json({ ok: true, bot: publicBot((await getBot(id))!) });
    },

    "POST /bots/:id/toggle": async (req, ctx) => {
      const bot = await getBot(ctx.params.id);
      if (!bot) return fail("Bot not found", 404);
      const access = await requireAgentAccess(ctx, bot.agentId);
      if ("error" in access) return fail(access.error, access.status);
      const body = await req.json().catch(() => ({}));
      const enabled = body.enabled === true;
      if (enabled) {
        try {
          await enforceCapability(bot.agentId, access.orgId, CAP_BOTS);
        } catch (err) {
          return fail((err as Error).message, 403);
        }
        const mode = (await getAccount(bot.agentId))?.mode ?? "paper";
        if (bot.maxLossUsd != null && bot.stats[mode].realizedPnl <= -bot.maxLossUsd) {
          return fail(`This bot hit its $${bot.maxLossUsd} loss limit in ${mode}. Raise or clear the limit to restart it.`);
        }
      }
      if (enabled && bot.type === "price-trigger" && (bot.params as unknown as TriggerParams).phase === "done") {
        await updateBot(bot.id, { enabled, params: { ...bot.params, phase: "armed" } });
      } else {
        await updateBot(bot.id, { enabled, ...(enabled ? { state: { openRequestId: null } } : {}) });
      }
      return json({ ok: true, enabled });
    },

    /**
     * POST /bots/:id/update { sizeUsd?, maxLossUsd?, params? } — params are merged over the current
     * ones and re-validated. An agent may tighten its bot's loss limit but not loosen or clear it.
     */
    "POST /bots/:id/update": async (req, ctx) => {
      const bot = await getBot(ctx.params.id);
      if (!bot) return fail("Bot not found", 404);
      const access = await requireAgentAccess(ctx, bot.agentId);
      if ("error" in access) return fail(access.error, access.status);
      const body = await req.json().catch(() => ({}));
      const patch: { sizeUsd?: number; maxLossUsd?: number | null; params?: Record<string, unknown> } = {};

      if (body.sizeUsd != null) {
        const sizeUsd = Number(body.sizeUsd);
        if (!(sizeUsd >= MIN_ORDER_USD)) return fail(`sizeUsd must be at least $${MIN_ORDER_USD}`);
        const account = await ensureAccount(bot.agentId, access.orgId);
        if (sizeUsd > account.risk.maxOrderUsd) return fail(`sizeUsd exceeds the max order size of $${account.risk.maxOrderUsd}`);
        patch.sizeUsd = sizeUsd;
      }
      if ("maxLossUsd" in body) {
        const maxLossUsd = parseMaxLoss(body.maxLossUsd);
        if (maxLossUsd === undefined) return fail("maxLossUsd must be a positive number");
        if (ctx.agent && bot.maxLossUsd != null && (maxLossUsd == null || maxLossUsd > bot.maxLossUsd)) {
          return fail("An agent can tighten its bot's loss limit, not loosen it", 403);
        }
        patch.maxLossUsd = maxLossUsd;
      }
      if (body.params && typeof body.params === "object") {
        const current = bot.params as Record<string, unknown>;
        if (bot.type === "price-trigger" && current.phase === "holding") return fail("Can't change a price trigger while it holds a position");
        // The AI target decides whether the bot needs a fixed market, so it can't change here.
        const raw = { ...current, ...(body.params as Record<string, unknown>), ...(bot.type === "ai" ? { target: current.target } : {}) };
        const params = parseBotParams(bot.type, raw);
        if (typeof params === "string") return fail(params);
        patch.params = params;
      }
      if (!Object.keys(patch).length) return fail("Nothing to update");
      await updateBot(bot.id, patch);
      return json({ ok: true, bot: publicBot((await getBot(bot.id))!) });
    },

    "DELETE /bots/:id": async (_req, ctx) => {
      const bot = await getBot(ctx.params.id);
      if (!bot) return fail("Bot not found", 404);
      const access = await requireAgentAccess(ctx, bot.agentId);
      if ("error" in access) return fail(access.error, access.status);
      await deleteBot(bot.id);
      return json({ ok: true });
    },

    "GET /bots/:id/log": async (_req, ctx) => {
      const bot = await getBot(ctx.params.id);
      if (!bot) return fail("Bot not found", 404);
      const access = await requireAgentAccess(ctx, bot.agentId);
      if ("error" in access) return fail(access.error, access.status);
      const log = await listBotLog(bot.id);
      return json({ log: log.map((l) => ({ ...l, createdAt: l.createdAt?.toISOString() ?? null })) });
    },

    // AI Predictor queue -------------------------------------------------------

    /** GET /ai/requests — this agent's waiting questions, oldest first. Agent-signed: it's the daemon's work queue. */
    "GET /ai/requests": async (_req, ctx) => {
      if (!ctx.agent) return fail("Agent signature or token required", 401);
      const open = await listOpenAiRequests(ctx.agent.agentId);
      return json({
        requests: open.map((r) => ({
          id: r.id, purpose: "live", coin: r.question.slice(0, 60), question: r.question, system: r.system, prompt: r.prompt,
          expiresAt: r.expiresAt.toISOString(), answer: "POST ai/requests/{id}/answer { decision, reasoning } or { text }",
        })),
      });
    },

    /** POST /ai/requests/:id/answer — { decision: BUY_YES|BUY_NO|SELL|HOLD, reasoning? } or { text }. Traded straight away. */
    "POST /ai/requests/:id/answer": async (req, ctx) => {
      if (!ctx.agent) return fail("Agent signature or token required", 401);
      const request = await getAiRequest(ctx.params.id);
      if (!request || request.agentId !== ctx.agent.agentId) return fail("Request not found", 404);
      const body = await req.json().catch(() => ({}));
      const text = typeof body.text === "string" ? body.text : "";
      const decision = parseDecision(typeof body.decision === "string" ? body.decision : text, request.holding);
      if (!decision) return fail("No decision found: answer BUY_YES, BUY_NO, SELL or HOLD");
      const reasoning = String(body.reasoning ?? text).trim().slice(0, 2000);
      const answered = await answerAiRequest(request.id, decision, reasoning);
      if (!answered) return fail("This question was already answered or has expired", 409);
      const outcome = await applyAiAnswer(answered, decision, reasoning);
      return json({ ok: true, decision, ...outcome });
    },
  },
});

