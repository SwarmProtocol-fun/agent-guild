/**
 * Cron Evaluator — Parses 5-field cron expressions and fires matching triggers.
 *
 * Called by the autonomous tick endpoint every ~30s. Idempotency keys ensure
 * per-minute granularity even if the evaluator runs multiple times per minute.
 *
 * 5-field format: minute hour dayOfMonth month dayOfWeek
 * Supports: *, N, N-M (ranges), N,M (lists), *​/N (steps)
 */

import { adminDb } from "@/lib/firebase-admin";
import type { TriggerPolicy, CronTriggerConfig } from "./triggers";
import { fireEvent } from "./triggers";
import { getRedis } from "@/lib/redis";
import { ensureAgentGroupChat, sendMessage, getAgent } from "@/lib/firestore-admin";
import { generateDailySummary, getDailySummary, formatSummary } from "@/lib/daily-summary";
import { recordCronExecution, type AgentExecutionResult } from "@/lib/cron-history";

// ── Cron Expression Parser ───────────────────────────────────────────────────

/** Check if a single cron field matches a given value */
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  // Wildcard
  if (field === "*") return true;

  // Step: */N
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) return false;
    return (value - min) % step === 0;
  }

  // Comma-separated list: N,M,...
  const parts = field.split(",");
  for (const part of parts) {
    const trimmed = part.trim();

    // Range: N-M
    if (trimmed.includes("-")) {
      const [startStr, endStr] = trimmed.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end) && value >= start && value <= end) {
        return true;
      }
      continue;
    }

    // Exact value
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num === value) return true;
  }

  return false;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const ZONED_FORMAT: Intl.DateTimeFormatOptions = {
  hourCycle: "h23",
  minute: "numeric",
  hour: "numeric",
  day: "numeric",
  month: "numeric",
  weekday: "short",
};

/** Wall-clock fields of `now` in an IANA time zone (falls back to UTC if the zone is invalid). */
function zonedParts(now: Date, timeZone: string) {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { ...ZONED_FORMAT, timeZone });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", { ...ZONED_FORMAT, timeZone: "UTC" });
  }
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    minute: parseInt(parts.minute, 10),
    hour: parseInt(parts.hour, 10),
    dom: parseInt(parts.day, 10),
    month: parseInt(parts.month, 10),
    dow: WEEKDAYS.indexOf(parts.weekday),
  };
}

/**
 * Check if a 5-field cron expression matches a given Date.
 * With `timeZone` (IANA, e.g. "America/New_York") the fields are read in that
 * zone; without it, in the server's local time.
 */
export function cronMatchesNow(cronExpr: string, now: Date, timeZone?: string): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [minuteField, hourField, domField, monthField, dowField] = fields;

  const { minute, hour, dom, month, dow } = timeZone
    ? zonedParts(now, timeZone)
    : {
        minute: now.getMinutes(),
        hour: now.getHours(),
        dom: now.getDate(),
        month: now.getMonth() + 1, // 1-12
        dow: now.getDay(),          // 0=Sunday
      };

  return (
    fieldMatches(minuteField, minute, 0, 59) &&
    fieldMatches(hourField, hour, 0, 23) &&
    fieldMatches(domField, dom, 1, 31) &&
    fieldMatches(monthField, month, 1, 12) &&
    fieldMatches(dowField, dow, 0, 6)
  );
}

// ── Trigger Evaluation ───────────────────────────────────────────────────────

const TRIGGER_POLICIES = "triggerPolicies";

/** Get all enabled cron trigger policies (cross-org). */
async function getEnabledCronPolicies(): Promise<TriggerPolicy[]> {
  const snap = await adminDb()
    .collection(TRIGGER_POLICIES)
    .where("triggerType", "==", "cron")
    .where("enabled", "==", true)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as TriggerPolicy);
}

/**
 * Evaluate all cron trigger policies and fire matching ones.
 *
 * The idempotency key includes the minute timestamp, so duplicate calls
 * within the same minute are safely deduped by the existing checkIdempotency()
 * in triggers.ts (Redis SET NX with 10-min TTL).
 */
export async function evaluateCronTriggers(): Promise<{
  evaluated: number;
  fired: number;
  errors: number;
}> {
  const now = new Date();
  let policies: TriggerPolicy[];

  try {
    policies = await getEnabledCronPolicies();
  } catch (err) {
    console.error("[cron] Failed to fetch cron policies:", err);
    return { evaluated: 0, fired: 0, errors: 1 };
  }

  let fired = 0;
  let errors = 0;

  for (const policy of policies) {
    const config = policy.config as CronTriggerConfig;
    if (!config.schedule) continue;

    if (!cronMatchesNow(config.schedule, now)) continue;

    // Minute-level event ID for idempotency
    const pad = (n: number) => String(n).padStart(2, "0");
    const minuteKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const eventId = `cron:${policy.id}:${minuteKey}`;

    try {
      await fireEvent(policy.orgId, "cron:tick", {
        schedule: config.schedule,
        firedAt: now.toISOString(),
        policyId: policy.id,
      }, eventId);
      fired++;
    } catch (err) {
      console.error(`[cron] Failed to fire trigger for policy ${policy.id}:`, err);
      errors++;
    }
  }

  return { evaluated: policies.length, fired, errors };
}

// ── Regular Cron Job Execution ───────────────────────────────────────────────

interface RawCronJob {
  id: string;
  orgId: string;
  name: string;
  message: string;
  schedule: string;
  agentIds?: string[];
  targetChannelId?: string;
  enabled: boolean;
  paused?: boolean;
  /** IANA zone the schedule is written in; absent on jobs created before zones were stored. */
  timezone?: string;
}

/** Get all enabled cron jobs (cross-org). */
async function getEnabledCronJobs(): Promise<RawCronJob[]> {
  const snap = await adminDb().collection("cronJobs").where("enabled", "==", true).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as RawCronJob);
}

/**
 * Evaluate all regular cronJobs and execute matching ones.
 *
 * For briefing-type jobs: generates a daily summary server-side and posts it
 * to Agent Hub so the user receives it even when the agent isn't running.
 * For all jobs: posts the prompt message to Agent Hub mentioning assigned agents.
 */
export async function evaluateRegularCronJobs(): Promise<{
  evaluated: number;
  fired: number;
  errors: number;
}> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const minuteKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`;

  let jobs: RawCronJob[];
  try {
    jobs = await getEnabledCronJobs();
  } catch (err) {
    console.error("[cron-jobs] Failed to fetch cron jobs:", err);
    return { evaluated: 0, fired: 0, errors: 1 };
  }

  const active = jobs.filter((j) => !j.paused && !!j.schedule);
  let fired = 0;
  let errors = 0;
  const redis = getRedis();

  for (const job of active) {
    if (!cronMatchesNow(job.schedule, now, job.timezone)) continue;

    // Minute-level idempotency via Redis
    const idempotencyKey = `cron-job:${job.id}:${minuteKey}`;
    if (redis) {
      try {
        const acquired = await redis.set(idempotencyKey, "1", { nx: true, ex: 90 });
        if (!acquired) continue; // Already fired this minute
      } catch {
        // Redis unavailable — proceed without dedup
      }
    }

    const startTime = new Date();
    const agentResults: AgentExecutionResult[] = [];
    let jobSuccess = false;

    try {
      const hub = await ensureAgentGroupChat(job.orgId);
      const agentIds = job.agentIds || [];
      const isBriefingJob = /briefing|standup/i.test(job.name);

      if (isBriefingJob && agentIds.length > 0) {
        // Generate and deliver briefing server-side for each assigned agent
        for (const agentId of agentIds) {
          try {
            const agent = await getAgent(agentId);
            const agentName = agent?.name || agentId;
            const today = now.toISOString().split("T")[0];

            // Generate the summary (idempotent — creates a new one each day)
            await generateDailySummary(job.orgId, agentId, agentName);
            const summary = await getDailySummary(job.orgId, agentId, today);

            if (summary) {
              const formatted = formatSummary(summary);
              await sendMessage({
                channelId: hub.id,
                senderId: agentId,
                senderName: agentName,
                senderType: "agent",
                content: formatted,
                orgId: job.orgId,
                createdAt: new Date(),
              });
            }

            agentResults.push({
              agentId,
              agentName,
              success: true,
              responsePreview: `Briefing posted for ${today}`,
              executedAt: Date.now(),
            });
          } catch (err) {
            agentResults.push({
              agentId,
              agentName: agentId,
              success: false,
              error: err instanceof Error ? err.message : "Failed to generate briefing",
              executedAt: Date.now(),
            });
          }
        }
        jobSuccess = agentResults.some((r) => r.success);
      } else {
        // Non-briefing job — post the prompt to Agent Hub for agents to pick up
        const mentions = agentIds.map((id) => `@${id}`).join(" ");
        const content = agentIds.length
          ? `📋 **${job.name}**\n\n${mentions}\n\n${job.message}`
          : `📋 **${job.name}**\n\n${job.message}`;

        await sendMessage({
          channelId: hub.id,
          senderId: "system",
          senderName: "Agent Guild Protocol",
          senderType: "agent",
          content,
          orgId: job.orgId,
          createdAt: new Date(),
        });

        for (const agentId of agentIds) {
          agentResults.push({
            agentId,
            agentName: agentId,
            success: true,
            responsePreview: "Prompt posted to Agent Hub",
            executedAt: Date.now(),
          });
        }
        jobSuccess = true;
      }

      fired++;
    } catch (err) {
      errors++;
      console.error(`[cron-jobs] Failed to execute job ${job.id} (${job.name}):`, err);
    }

    // Record execution history
    const endTime = new Date();
    const runError = jobSuccess ? undefined : "Execution failed";
    try {
      await adminDb().collection("cronJobs").doc(job.id).update({
        lastRun: {
          time: endTime,
          success: jobSuccess,
          durationMs: endTime.getTime() - startTime.getTime(),
          ...(runError ? { error: runError } : {}),
        },
      });
    } catch (err) {
      console.error(`[cron-jobs] Failed to update lastRun for ${job.id}:`, err);
    }
    try {
      await recordCronExecution(
        job.id,
        job.name,
        job.orgId,
        startTime,
        endTime,
        jobSuccess,
        agentResults,
        runError,
      );
    } catch (err) {
      console.error(`[cron-jobs] Failed to record history for ${job.id}:`, err);
    }
  }

  return { evaluated: active.length, fired, errors };
}
