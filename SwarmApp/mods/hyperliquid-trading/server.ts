import { defineServerMod } from "@swarm/sdk";
import { enqueueTask, getTask } from "@/lib/gateway/store";
import { settleOnChains, hashJobResult } from "@/lib/settlement/registry";
import { enforceCapability } from "@/lib/skills";

const HL_INFO_URL = process.env.HYPERLIQUID_NETWORK === "mainnet"
  ? "https://api.hyperliquid.xyz/info"
  : "https://api.hyperliquid-testnet.xyz/info";

/** Public, unsigned reads against Hyperliquid's Info API — no private key needed. */
async function hlInfo<T>(body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Hyperliquid info request failed: ${resp.status}`);
  return resp.json();
}

interface AssetPosition {
  position: { coin: string; szi: string; positionValue: string; unrealizedPnl: string; entryPx: string };
}
interface ClearinghouseState {
  assetPositions: AssetPosition[];
  marginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string };
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
     * POST /trade — enqueue an order for a GatewayAgent worker to execute.
     * Requires the calling agent to hold the "hyperliquid-trade" capability.
     * orgId/agentId fall back to the body only for browser-session calls —
     * a verified agent signature (ctx.agent) always takes precedence.
     * Body: { orgId, agentId, coin, isBuy, sizeUsd, orderType? }
     */
    "POST /trade": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { coin, isBuy, sizeUsd, orderType = "market" } = body;

      if (!orgId || !agentId || !coin || isBuy == null || !sizeUsd) {
        return Response.json({ error: "orgId, agentId, coin, isBuy, sizeUsd are required" }, { status: 400 });
      }

      try {
        await enforceCapability(agentId, orgId, "hyperliquid-trade");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      const taskId = await enqueueTask({
        orgId,
        taskType: "hyperliquid",
        payload: { agentId, coin, isBuy, sizeUsd, orderType },
        priority: "normal",
        resources: { requiredTags: ["hyperliquid"] },
        timeoutMs: 30000,
        maxRetries: 2,
      });

      return Response.json({ taskId });
    },

    /** GET /status/:taskId — poll a trade's execution state. */
    "GET /status/:taskId": async (_req, { params }) => {
      const task = await getTask(params.taskId);
      if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
      return Response.json({ status: task.status, result: task.result, error: task.error });
    },

    /** GET /positions/:wallet — open positions, read directly from Hyperliquid's public Info API. */
    "GET /positions/:wallet": async (_req, { params }) => {
      try {
        const state = await hlInfo<ClearinghouseState>({ type: "clearinghouseState", user: params.wallet });
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

    /** GET /account/:wallet — margin/equity summary, same public Info API. */
    "GET /account/:wallet": async (_req, { params }) => {
      try {
        const state = await hlInfo<ClearinghouseState>({ type: "clearinghouseState", user: params.wallet });
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
     * the calling agent to hold the "hyperliquid-close" capability. As with
     * /trade, a verified agent signature (ctx.agent) always wins over the body.
     * Body: { orgId, agentId, wallet, coin }
     */
    "POST /close": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { wallet, coin } = body;
      if (!orgId || !agentId || !wallet || !coin) {
        return Response.json({ error: "orgId, agentId, wallet, coin are required" }, { status: 400 });
      }

      try {
        await enforceCapability(agentId, orgId, "hyperliquid-close");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      const state = await hlInfo<ClearinghouseState>({ type: "clearinghouseState", user: wallet });
      const open = state.assetPositions.find((p) => p.position.coin === coin);
      if (!open || Number(open.position.szi) === 0) {
        return Response.json({ error: `No open ${coin} position for ${wallet}` }, { status: 404 });
      }

      const isLong = Number(open.position.szi) > 0;
      const sizeUsd = Math.abs(Number(open.position.positionValue));

      const taskId = await enqueueTask({
        orgId,
        taskType: "hyperliquid",
        payload: { agentId, coin, isBuy: !isLong, sizeUsd, orderType: "market", reduceOnly: true },
        priority: "normal",
        resources: { requiredTags: ["hyperliquid"] },
        timeoutMs: 30000,
        maxRetries: 0, // a filled/failed close shouldn't be retried blind — re-check the position and re-issue instead
      });

      return Response.json({ taskId, closing: { coin, side: isLong ? "long" : "short", sizeUsd } });
    },

    /**
     * POST /settle-trade — once a trade task has completed, commit its
     * fill as an on-chain receipt (same mechanism the compute-settlement
     * mods use), so a trade's proof-of-execution lives next to a job's.
     * Body: { agentId, agentWallet, taskId, chains, creditScore?, trustScore? }
     */
    "POST /settle-trade": async (req) => {
      const body = await req.json();
      const { agentId, agentWallet, taskId, chains = ["solana"], creditScore, trustScore } = body;

      const task = await getTask(taskId);
      if (!task || task.status !== "completed") {
        return Response.json({ error: "Task not completed yet" }, { status: 409 });
      }

      const result = task.result as { exitCode?: number; executionTimeMs?: number; stdout?: string } | undefined;
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
      return Response.json({ receipts, errors });
    },
  },
});
