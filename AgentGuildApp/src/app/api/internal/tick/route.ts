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
  });
}
