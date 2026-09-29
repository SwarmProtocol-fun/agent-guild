/**
 * POST /api/workflows/webhook/[policyId] — Receive external webhook events.
 *
 * Auth: HMAC-SHA256 signature in x-webhook-signature header.
 * Modeled after the slots webhook at /api/v1/slots/webhook/[id].
 *
 * Validates the webhook, checks cooldown + idempotency, and starts
 * a workflow run using the trigger policy's configuration.
 */

import { NextRequest } from "next/server";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getTriggerPolicy, checkCooldownFor, checkIdempotencyFor } from "@/lib/workflow/triggers";
import { startRun } from "@/lib/workflow/executor";
import type { WebhookTriggerConfig } from "@/lib/workflow/triggers";
import crypto from "crypto";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ policyId: string }> },
) {
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  const limited = await rateLimit(`wf-webhook:${ip}`);
  if (limited) return limited;

  const { policyId } = await params;
  const policy = await getTriggerPolicy(policyId);
  if (!policy) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (policy.triggerType !== "webhook") {
    return Response.json({ error: "Policy is not a webhook trigger" }, { status: 400 });
  }

  if (!policy.enabled) {
    return Response.json({ error: "Trigger is disabled" }, { status: 403 });
  }

  // Parse body
  let bodyText: string;
  let payload: Record<string, unknown>;
  try {
    bodyText = await req.text();
    payload = JSON.parse(bodyText);
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // HMAC validation
  const config = policy.config as WebhookTriggerConfig;
  if (config.secret) {
    const signature = req.headers.get("x-webhook-signature") || "";
    const expected = crypto
      .createHmac("sha256", config.secret)
      .update(bodyText)
      .digest("hex");

    try {
      if (
        signature.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      ) {
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }
    } catch {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  // IP allowlist
  if (config.allowedIps && config.allowedIps.length > 0) {
    if (!config.allowedIps.includes(ip)) {
      return Response.json({ error: "IP not allowed" }, { status: 403 });
    }
  }

  // Dedup event ID from body hash
  const eventId = `webhook:${policyId}:${crypto.createHash("sha256").update(bodyText).digest("hex").slice(0, 16)}`;

  // Idempotency check
  if (!(await checkIdempotencyFor(policyId, eventId))) {
    return Response.json({ ok: true, duplicate: true });
  }

  // Cooldown check
  if (!(await checkCooldownFor(policy))) {
    return Response.json({ ok: true, cooldown: true });
  }

  // Start workflow run
  try {
    const triggerInput = {
      ...(policy.staticInput || {}),
      _event: {
        name: "webhook:received",
        data: payload,
        eventId,
        triggeredAt: Date.now(),
        sourceIp: ip,
      },
    };

    const runId = await startRun(
      policy.workflowId,
      `trigger:${policy.id}`,
      triggerInput,
    );

    return Response.json({ ok: true, runId });
  } catch (err) {
    console.error("[webhook] Failed to start run:", err);
    return Response.json({ error: "Processing failed" }, { status: 500 });
  }
}
