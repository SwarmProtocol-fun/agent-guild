import { defineServerMod } from "@agent-guild/sdk";
import { enqueueTask, getTask } from "@/lib/gateway/store";
import { settleOnChains, hashJobResult } from "@/lib/settlement/registry";
import { enforceCapability } from "@/lib/skills";
import { encryptValue, decryptValue } from "@/lib/secrets";
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
  type DcaParams,
  type GridParams,
} from "@/lib/mods/hyperliquid-store";

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

/**
 * Evaluated once per Hub tick (see the mod's added phase in
 * `/api/internal/tick/route.ts`). DCA fires on a fixed interval; grid fires
 * when the mid price crosses a level it hasn't visited yet. Neither can
 * place the trade itself — there's no passphrase available inside a
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
      }
      // "signal" strategies never fire from the tick — only via POST /strategy/:id/signal.
    } catch (err) {
      console.error(`[hyperliquid-strategy] ${strategy.id} failed:`, err);
      errors++;
    }
  }

  return { evaluated: strategies.length, markedPending, errors };
}

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
     * POST /wallet — set or rotate an agent's own Hyperliquid key. Each
     * agent has its own distinct, separately-keyed wallet — never a shared
     * platform/worker key. The key is encrypted with `masterSecret`, a
     * passphrase only its owner knows; it is never stored and must be
     * supplied again on every call that needs to sign a trade.
     *
     * orgId/agentId fall back to the body only for browser-session calls —
     * a verified agent signature (ctx.agent) always takes precedence, same
     * as every other route here. NOTE: ctx.agent isn't wired up by the
     * runtime yet (see RouteContext in sdk.ts) — until it is, this route
     * relies on org-level dashboard access control, same as /risk-config and
     * /strategy, not a cryptographic guarantee that only the agent itself
     * (vs. another caller in the same org) can set its wallet.
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

      const { encryptedValue, iv } = encryptValue(privateKey, agentId, masterSecret);
      await setAgentWallet(agentId, { orgId, encryptedValue, iv, network });
      return Response.json({ ok: true });
    },

    /** GET /wallet/:agentId — whether a wallet is configured, and which network. Never returns key material. */
    "GET /wallet/:agentId": async (_req, { params }) => {
      const wallet = await getAgentWallet(params.agentId);
      return Response.json({ hasWallet: !!wallet, network: wallet?.network ?? null });
    },

    /** DELETE /wallet/:agentId — same access-control caveat as POST /wallet above. */
    "DELETE /wallet/:agentId": async (_req, ctx) => {
      const agentId = ctx.agent?.agentId ?? ctx.params.agentId;
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
    "GET /status/:taskId": async (_req, { params }) => {
      const task = await getTask(params.taskId);
      if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
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
     * Body: { agentId, agentWallet, taskId, chains, creditScore?, trustScore? }
     */
    "POST /settle-trade": async (req) => {
      const body = await req.json();
      const { agentId, agentWallet, taskId, chains = ["solana"], creditScore, trustScore } = body;

      const task = await getTask(taskId);
      if (!task || task.status !== "completed") {
        return Response.json({ error: "Task not completed yet" }, { status: 409 });
      }

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
          status: (task.payload as { reduceOnly?: boolean })?.reduceOnly ? "closed" : "opened",
        });
      }

      return Response.json({ receipts, errors });
    },

    /** GET /history/:agentId — trade log + aggregate PnL/win-rate stats. */
    "GET /history/:agentId": async (_req, { params }) => {
      const history = await getTradeHistory(params.agentId);
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

      try {
        await enforceCapability(agentId, orgId, "hyperliquid-configure-risk");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      await setRiskConfig(agentId, { orgId, leverage, maxPositionUsd, maxDailyLossUsd, defaultStopLossPct, defaultTakeProfitPct });
      return Response.json({ ok: true });
    },

    /** GET /risk-config/:agentId */
    "GET /risk-config/:agentId": async (_req, { params }) => {
      const config = await getRiskConfig(params.agentId);
      return Response.json({ config });
    },

    /** GET /strategy/:agentId — list an agent's strategies. */
    "GET /strategy/:agentId": async (_req, { params }) => {
      const strategies = await getStrategies(params.agentId);
      return Response.json({ strategies });
    },

    /**
     * POST /strategy — create a DCA, grid, or signal strategy. Requires the
     * "hyperliquid-run-strategy" capability. DCA/grid are evaluated by the
     * tick phase in /api/internal/tick; signal only fires via
     * POST /strategy/:id/signal.
     * Body: { orgId, agentId, wallet, type, coin, sizeUsd, params }
     */
    "POST /strategy": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { wallet, type, coin, sizeUsd, params } = body;

      if (!orgId || !agentId || !wallet || !type || !coin || !sizeUsd) {
        return Response.json({ error: "orgId, agentId, wallet, type, coin, sizeUsd are required" }, { status: 400 });
      }
      if (!["dca", "grid", "signal"].includes(type)) {
        return Response.json({ error: "type must be dca, grid, or signal" }, { status: 400 });
      }
      if (type === "dca" && !params?.intervalMs) {
        return Response.json({ error: "params.intervalMs is required for a dca strategy" }, { status: 400 });
      }
      if (type === "grid" && !(params?.lowerPrice && params?.upperPrice && params?.levels)) {
        return Response.json({ error: "params.lowerPrice, upperPrice, levels are required for a grid strategy" }, { status: 400 });
      }

      try {
        await enforceCapability(agentId, orgId, "hyperliquid-run-strategy");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      const id = await createStrategy({ orgId, agentId, wallet, type, coin, sizeUsd, enabled: true, params: params ?? {} });
      return Response.json({ id });
    },

    /** POST /strategy/:id/toggle — enable/disable a strategy. Body: { enabled } */
    "POST /strategy/:id/toggle": async (req, { params }) => {
      const body = await req.json();
      await toggleStrategy(params.id, Boolean(body.enabled));
      return Response.json({ ok: true });
    },

    /**
     * POST /strategy/:id/signal — fire a "signal" strategy immediately
     * (an agent or webhook calling in from outside the tick evaluator).
     * Body: { masterSecret, isBuy? } — isBuy defaults to the strategy's
     * configured direction. Needs the strategy's agent to already have a
     * wallet set via POST /wallet.
     */
    "POST /strategy/:id/signal": async (req, { params }) => {
      const body = await req.json().catch(() => ({}));
      const { masterSecret, isBuy: isBuyOverride } = body;
      const strategy = await getStrategy(params.id);
      if (!strategy) return Response.json({ error: "Strategy not found" }, { status: 404 });
      if (strategy.type !== "signal") {
        return Response.json({ error: "Only signal strategies can be fired via this route" }, { status: 400 });
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

      const signalParams = strategy.params as { direction?: "buy" | "sell" };
      const isBuy = isBuyOverride ?? (signalParams.direction ? signalParams.direction === "buy" : true);

      const result = await enforceRiskAndEnqueue({
        orgId: strategy.orgId, agentId: strategy.agentId, coin: strategy.coin, isBuy, sizeUsd: strategy.sizeUsd, privateKey, network,
      });
      if ("error" in result) return Response.json(result, { status: 400 });
      await touchStrategyRun(strategy.id);
      return Response.json(result);
    },

    /** GET /strategy/:agentId/pending — dca/grid strategies waiting for this agent to execute. */
    "GET /strategy/:agentId/pending": async (_req, { params }) => {
      const strategies = await getPendingStrategies(params.agentId);
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
    "POST /strategy/:id/execute-pending": async (req, { params }) => {
      const body = await req.json().catch(() => ({}));
      const { masterSecret } = body;
      const strategy = await getStrategy(params.id);
      if (!strategy) return Response.json({ error: "Strategy not found" }, { status: 404 });
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

      const result = await enforceRiskAndEnqueue({
        orgId: strategy.orgId, agentId: strategy.agentId, coin: strategy.coin, isBuy: true, sizeUsd: strategy.sizeUsd, privateKey, network,
      });
      if ("error" in result) return Response.json(result, { status: 400 });

      if (strategy.type === "grid") {
        const params_ = strategy.params as GridParams;
        const level = (strategy.pendingContext as { level?: number } | null)?.level;
        const visited = params_.visitedLevels ?? [];
        await clearStrategyPending(strategy.id, level != null ? { ...params_, visitedLevels: [...visited, level] } : undefined);
      } else {
        await clearStrategyPending(strategy.id);
      }

      return Response.json(result);
    },
  },
});
