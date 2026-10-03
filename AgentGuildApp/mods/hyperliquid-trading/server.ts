import { defineServerMod, type RouteContext } from "@agent-guild/sdk";
import { enqueueTask, getTask } from "@/lib/gateway/store";
import { settleOnChains, hashJobResult } from "@/lib/settlement/registry";
import { enforceCapability, getAgentCapabilities } from "@/lib/skills";
import { encryptValue, decryptValue } from "@/lib/secrets";
import { getAgent } from "@/lib/firestore-admin";
import { requireOrgMembershipByAddress } from "@/lib/auth-guard";
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
  type DcaParams,
  type GridParams,
  type SniperParams,
  type Strategy,
} from "@/lib/mods/hyperliquid-store";
import crypto from "crypto";

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
  if (!body.masterSecret) {
    return { status: 400, body: { error: "masterSecret is required" } };
  }

  let privateKey: string, network: HlNetwork;
  try {
    ({ privateKey, network } = await resolveAgentWallet(strategy.agentId, body.masterSecret));
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }

  const signalParams = strategy.params as { direction?: "buy" | "sell" };
  const isBuy = body.isBuy ?? (signalParams.direction ? signalParams.direction === "buy" : true);

  const result = await enforceRiskAndEnqueue({
    orgId: strategy.orgId, agentId: strategy.agentId, coin: strategy.coin, isBuy, sizeUsd: strategy.sizeUsd, privateKey, network,
  });
  if ("error" in result) return { status: 400, body: result };
  await touchStrategyRun(strategy.id);
  return result;
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
 * actually fire it.
 */
export async function runHyperliquidStrategyTick(): Promise<{ evaluated: number; markedPending: number; errors: number }> {
  const strategies = await getEnabledStrategies();
  let markedPending = 0;
  let errors = 0;

  for (const strategy of strategies) {
    if (strategy.pendingSignal) continue; // already waiting on the agent — don't re-trigger
    try {
      if (strategy.type === "dca") {
        const params = strategy.params as DcaParams;
        const last = strategy.lastRunAt?.getTime() ?? 0;
        if (Date.now() - last < params.intervalMs) continue;

        await markStrategyPending(strategy.id, {});
        markedPending++;
      } else if (strategy.type === "grid") {
        const params = strategy.params as GridParams;
        const wallet = await getAgentWallet(strategy.agentId);
        if (!wallet) continue; // nothing to trade with yet — agent hasn't set a wallet
        const price = await getMidPrice(strategy.coin, wallet.network);
        if (price < params.lowerPrice || price > params.upperPrice) continue;

        const step = (params.upperPrice - params.lowerPrice) / params.levels;
        const level = Math.round((price - params.lowerPrice) / step);
        const visited = params.visitedLevels ?? [];
        if (visited.includes(level)) continue;

        await markStrategyPending(strategy.id, { level });
        markedPending++;
      } else if (strategy.type === "sniper") {
        const params = strategy.params as SniperParams;
        const wallet = await getAgentWallet(strategy.agentId);
        if (!wallet) continue; // nothing to trade with yet — agent hasn't set a wallet

        if (params.mode === "new-listing") {
          const known = await getKnownCoins(wallet.network);
          const current = await getUniverseCoins(wallet.network);
          if (known === null) {
            // First run for this network — seed the baseline instead of
            // treating Hyperliquid's entire existing universe as "new".
            await setKnownCoins(wallet.network, current);
            continue;
          }
          const newCoins = current.filter((c) => !known.includes(c));
          if (newCoins.length === 0) continue;
          await setKnownCoins(wallet.network, current);

          const target = strategy.coin === "ANY" ? newCoins[0] : (newCoins.includes(strategy.coin) ? strategy.coin : null);
          if (!target) continue;
          await markStrategyPending(strategy.id, { detectedCoin: target });
        } else {
          if (params.targetPrice == null) continue;
          const price = await getMidPrice(strategy.coin, wallet.network);
          const triggered = params.mode === "price-above" ? price >= params.targetPrice : price <= params.targetPrice;
          if (!triggered) continue;
          await markStrategyPending(strategy.id, { triggerPrice: price });
        }
        markedPending++;
      }
      // "signal" strategies never fire from the tick — only via POST /strategy/:id/signal or the public webhook.
    } catch (err) {
      console.error(`[hyperliquid-strategy] ${strategy.id} failed:`, err);
      errors++;
    }
  }

  return { evaluated: strategies.length, markedPending, errors };
}

const TRADING_CAPABILITIES = [
  "hyperliquid-trade",
  "hyperliquid-close",
  "hyperliquid-configure-risk",
  "hyperliquid-run-strategy",
  "hyperliquid-webhook",
] as const;

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
        wallet: { type: "string", description: "0x address of the trading wallet" },
        coin: { type: "string" },
      },
      required: ["wallet", "coin"],
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
        getAgentWallet(agentId),
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
        wallet: { configured: !!wallet, network: wallet?.network ?? null },
        risk: risk ? {
          leverage: risk.leverage,
          maxPositionUsd: risk.maxPositionUsd,
          maxDailyLossUsd: risk.maxDailyLossUsd,
        } : null,
        pendingStrategies: pending.length,
        readyToTrade: !!wallet && capabilities["hyperliquid-trade"],
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

      const { encryptedValue, iv } = encryptValue(privateKey, agentId, masterSecret);
      await setAgentWallet(agentId, { orgId, encryptedValue, iv, network });
      return Response.json({ ok: true });
    },

    /** GET /wallet/:agentId — whether a wallet is configured, and which network. Never returns key material. */
    "GET /wallet/:agentId": async (_req, ctx) => {
      const access = await requireAgentOrgAccess(ctx, ctx.params.agentId);
      if ("error" in access) return Response.json({ error: access.error }, { status: access.status });
      const wallet = await getAgentWallet(ctx.params.agentId);
      return Response.json({ hasWallet: !!wallet, network: wallet?.network ?? null });
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
     * Body: { orgId, agentId, masterSecret, coin, isBuy, sizeUsd, orderType?,
     *         limitPrice?, leverage?, stopLossPct?, takeProfitPct? }
     * Rejected (400) if it would exceed the agent's configured risk limits.
     */
    "POST /trade": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { coin, isBuy, sizeUsd, orderType = "market", limitPrice, leverage, stopLossPct, takeProfitPct, masterSecret } = body;

      if (!orgId || !agentId || !coin || isBuy == null || !sizeUsd || !masterSecret) {
        return Response.json({ error: "orgId, agentId, coin, isBuy, sizeUsd, masterSecret are required" }, { status: 400 });
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
        ({ privateKey, network } = await resolveAgentWallet(agentId, masterSecret));
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
        const state = await hlInfo<ClearinghouseState>({ type: "clearinghouseState", user: params.wallet }, network);
        return Response.json({
          accountValue: Number(state.marginSummary.accountValue),
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
     * Body: { orgId, agentId, masterSecret, wallet, coin }
     */
    "POST /close": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { wallet, coin, masterSecret } = body;
      if (!orgId || !agentId || !wallet || !coin || !masterSecret) {
        return Response.json({ error: "orgId, agentId, wallet, coin, masterSecret are required" }, { status: 400 });
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
        ({ privateKey, network } = await resolveAgentWallet(agentId, masterSecret));
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 400 });
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
     * POST /strategy — create a DCA, grid, signal, or sniper strategy.
     * Requires the "hyperliquid-run-strategy" capability. DCA/grid/sniper are
     * evaluated by the tick phase in /api/internal/tick; signal only fires via
     * POST /strategy/:id/signal or the public POST /webhook/:id.
     * Body: { orgId, agentId, wallet, type, coin, sizeUsd, params }
     * For a sniper strategy, coin may be "ANY" (new-listing mode only, to
     * catch whichever coin lists next rather than a specific one).
     */
    "POST /strategy": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { wallet, type, coin, sizeUsd, params } = body;

      if (!orgId || !agentId || !wallet || !type || !coin || !sizeUsd) {
        return Response.json({ error: "orgId, agentId, wallet, type, coin, sizeUsd are required" }, { status: 400 });
      }
      if (!["dca", "grid", "signal", "sniper"].includes(type)) {
        return Response.json({ error: "type must be dca, grid, signal, or sniper" }, { status: 400 });
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

      try {
        await enforceCapability(agentId, orgId, "hyperliquid-run-strategy");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      const id = await createStrategy({ orgId, agentId, wallet, type, coin, sizeUsd, enabled: true, params: params ?? {} });
      return Response.json({ id });
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
     * Body: { masterSecret }
     */
    "POST /strategy/:id/execute-pending": async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const { masterSecret } = body;
      const strategy = await getStrategy(ctx.params.id);
      if (!strategy) return Response.json({ error: "Strategy not found" }, { status: 404 });
      const denied = await requireOrgAccess(ctx, strategy.orgId);
      if (denied) return Response.json({ error: denied.error }, { status: denied.status });

      // Same gate as POST /trade — uninstalling the mod (or turning off this
      // capability) must stop a daemon that still holds the passphrase.
      // Checked before anything clears pendingSignal, so the signal stays set.
      try {
        await enforceCapability(strategy.agentId, strategy.orgId, "hyperliquid-trade");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      if (!strategy.pendingSignal) {
        return Response.json({ error: "Strategy has no pending signal" }, { status: 400 });
      }
      if (!masterSecret) {
        return Response.json({ error: "masterSecret is required" }, { status: 400 });
      }

      let privateKey: string, network: HlNetwork;
      try {
        ({ privateKey, network } = await resolveAgentWallet(strategy.agentId, masterSecret));
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 400 });
      }

      // A "new-listing ANY" sniper doesn't know its target coin until the
      // tick evaluator catches one — that's what pendingContext.detectedCoin
      // is for. Every other strategy type just trades its own `coin`.
      const detectedCoin = (strategy.pendingContext as { detectedCoin?: string } | null)?.detectedCoin;
      const coin = strategy.type === "sniper" && detectedCoin ? detectedCoin : strategy.coin;

      const result = await enforceRiskAndEnqueue({
        orgId: strategy.orgId, agentId: strategy.agentId, coin, isBuy: true, sizeUsd: strategy.sizeUsd, privateKey, network,
      });
      if ("error" in result) return Response.json(result, { status: 400 });

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

      return Response.json(result);
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
