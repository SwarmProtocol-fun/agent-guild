/**
 * POST /api/internal/tick — Autonomous workflow advancement + cron triggers.
 *
 * Called every ~30s by the Hub process (or an external scheduler like QStash).
 * Advances all active workflow runs server-side so they complete even when
 * the browser is closed. Also evaluates cron trigger policies.
 *
 * Auth: INTERNAL_SERVICE_SECRET (via x-service-secret header or Bearer token)
 *
 * Response: { workflows: {...}, cron: {...} }
 */

import { NextRequest } from "next/server";
import { requireInternalService } from "@/lib/auth-guard";
import { getGlobalActiveRuns } from "@/lib/workflow/store";
import { advanceRun } from "@/lib/workflow/executor";
import { evaluateCronTriggers, evaluateRegularCronJobs } from "@/lib/workflow/cron-evaluator";
import { getRedis } from "@/lib/redis";
import { runHyperliquidStrategyTick, runAiTraderTick, runHyperliquidPaperTick } from "../../../../../mods/hyperliquid-trading/server";
import { runPolymarketTick } from "../../../../../mods/polymarket-trading/server";
import { sweepStaleAgents } from "@/lib/heartbeat";

/** Max runs to advance per tick (fits within 10s Netlify timeout) */
const BATCH_LIMIT = 20;
/** Bail if this many ms have elapsed (leave headroom for response) */
const TIME_BUDGET_MS = 8000;
/** Redis lock key to prevent concurrent ticks */
const LOCK_KEY = "workflow:tick:lock";
/** Lock TTL — must exceed the max tick duration */
const LOCK_TTL_S = 25;

export async function POST(req: NextRequest) {
  const auth = requireInternalService(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: 401 });
  }

  // ── Acquire distributed lock ────────────────────────────────────────────
  const redis = getRedis();
  if (redis) {
    try {
      const acquired = await redis.set(LOCK_KEY, "1", { nx: true, ex: LOCK_TTL_S });
      if (!acquired) {
        return Response.json({ ok: true, skipped: true, reason: "tick already in progress" });
      }
    } catch {
      // Redis unavailable — proceed without lock (single-instance fallback)
    }
  }

  const startTime = Date.now();

  // ── Phase 1: Advance active workflow runs ───────────────────────────────
  let advanced = 0;
  let completed = 0;
  let failed = 0;
  let workflowErrors = 0;

  try {
    const runs = await getGlobalActiveRuns(BATCH_LIMIT);

    for (const run of runs) {
      if (Date.now() - startTime > TIME_BUDGET_MS) break;

      try {
        const updated = await advanceRun(run.id);
        advanced++;
        if (updated.status === "completed") completed++;
        if (updated.status === "failed") failed++;
      } catch (err) {
        workflowErrors++;
        console.error(`[tick] Failed to advance run ${run.id}:`, err);
      }
    }
  } catch (err) {
    console.error("[tick] Failed to fetch active runs:", err);
  }

  // ── Phase 2: Evaluate cron triggers (workflow trigger policies) ─────────────
  let cronResult = { evaluated: 0, fired: 0, errors: 0 };

  if (Date.now() - startTime < TIME_BUDGET_MS) {
    try {
      cronResult = await evaluateCronTriggers();
    } catch (err) {
      console.error("[tick] Cron evaluation failed:", err);
      cronResult.errors = 1;
    }
  }

  // ── Phase 3: Execute regular cron jobs (briefings, scheduled tasks) ──────────
  let cronJobsResult = { evaluated: 0, fired: 0, errors: 0 };

  if (Date.now() - startTime < TIME_BUDGET_MS) {
    try {
      cronJobsResult = await evaluateRegularCronJobs();
    } catch (err) {
      console.error("[tick] Cron jobs evaluation failed:", err);
      cronJobsResult.errors = 1;
    }
  }

  // ── Phase 4: Evaluate autonomous Hyperliquid strategies (DCA / grid / sniper) ────
  let hyperliquidResult = { evaluated: 0, markedPending: 0, executed: 0, errors: 0 };

  if (Date.now() - startTime < TIME_BUDGET_MS) {
    try {
      hyperliquidResult = await runHyperliquidStrategyTick();
    } catch (err) {
      console.error("[tick] Hyperliquid strategy evaluation failed:", err);
      hyperliquidResult.errors = 1;
    }
  }

  // ── Phase 4b: Hyperliquid paper accounts — resting limit fills, TP/SL,
  // hourly funding and liquidation, all on mainnet prices.
  let hyperliquidPaperResult = { filled: 0, triggered: 0, funded: 0, liquidated: 0, errors: 0 };
  if (Date.now() - startTime < TIME_BUDGET_MS) {
    try {
      hyperliquidPaperResult = await runHyperliquidPaperTick();
    } catch (err) {
      console.error("[tick] Hyperliquid paper evaluation failed:", err);
      hyperliquidPaperResult.errors = 1;
    }
  }

  // ── Phase 5: Presence. A dead daemon stops heartbeating; this is what
  // flips its stored status to offline so the dashboard matches reality.
  let presenceFlipped = 0;
  if (Date.now() - startTime < TIME_BUDGET_MS) {
    try {
      presenceFlipped = await sweepStaleAgents();
    } catch (err) {
      console.error("[tick] Presence sweep failed:", err);
    }
  }

  // ── Phase 6: AI Trader bots. Puts each due bot's question to its agent
  // (the agent's own daemon answers it — no model runs here) and retires
  // rounds the agent didn't answer in time.
  let aiTraderResult = { due: 0, asked: 0, errors: 0 };
  try {
    aiTraderResult = await runAiTraderTick();
  } catch (err) {
    console.error("[tick] AI Trader evaluation failed:", err);
    aiTraderResult.errors = 1;
  }

  // ── Phase 7: Polymarket. Pays out resolved paper positions and runs every
  // enabled bot (BTC 5-minute bots, price triggers, AI Predictor questions).
  let polymarketResult = { bots: 0, entered: 0, asked: 0, settled: 0, errors: 0 };
  try {
    polymarketResult = await runPolymarketTick();
  } catch (err) {
    console.error("[tick] Polymarket evaluation failed:", err);
    polymarketResult.errors = 1;
  }

  // ── Release lock ────────────────────────────────────────────────────────
  if (redis) {
    try {
      await redis.del(LOCK_KEY);
    } catch {
      // Lock will auto-expire
    }
  }

  return Response.json({
    ok: true,
    elapsed: Date.now() - startTime,
    workflows: { advanced, completed, failed, errors: workflowErrors },
    cron: cronResult,
    cronJobs: cronJobsResult,
    hyperliquidStrategies: hyperliquidResult,
    hyperliquidPaper: hyperliquidPaperResult,
    aiTraders: aiTraderResult,
    polymarket: polymarketResult,
    presenceFlipped,
  });
}
