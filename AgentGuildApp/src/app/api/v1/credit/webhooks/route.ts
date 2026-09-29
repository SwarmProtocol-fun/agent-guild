/**
 * POST /api/v1/credit/webhooks — Register a credit webhook
 * GET  /api/v1/credit/webhooks — List webhooks for the authenticated agent
 * DELETE /api/v1/credit/webhooks — Delete a webhook by ID
 *
 * Auth: platform admin or authenticated agent (agents manage own webhooks).
 */

import { NextRequest } from "next/server";
import { requirePlatformAdminOrAgent, unauthorized } from "@/lib/auth-guard";
import {
    registerWebhook,
    listWebhooks,
    deleteWebhook,
    countWebhooks,
    generateWebhookSecret,
    type CreditWebhookEvent,
} from "@/lib/credit-webhooks";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { isPrivateHostname } from "@/lib/url-validation";

const VALID_EVENTS: CreditWebhookEvent[] = ["score_change", "band_change", "policy_change"];
const MAX_WEBHOOKS_PER_AGENT = 10;

// ─── POST: Register a webhook ──────────────────────────────────

export async function POST(request: NextRequest) {
    const limited = await rateLimit("webhook-register");
    if (limited) return limited;

    const auth = await requirePlatformAdminOrAgent(request, "POST:/v1/credit/webhooks");
    if (!auth.ok) return unauthorized(auth.error);

    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const agentId = body.agentId as string | undefined;
    const url = body.url as string | undefined;
    const events = body.events as string[] | undefined;

    if (!agentId) {
        return Response.json({ error: "agentId is required" }, { status: 400 });
    }
    if (!url) {
        return Response.json({ error: "url is required" }, { status: 400 });
    }

    // Validate URL is HTTPS and not targeting private networks (SSRF protection)
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") {
            return Response.json({ error: "Webhook URL must use HTTPS" }, { status: 400 });
        }
        if (isPrivateHostname(parsed.hostname)) {
            return Response.json({ error: "Webhook URL cannot target private networks" }, { status: 400 });
        }
    } catch {
        return Response.json({ error: "Invalid webhook URL" }, { status: 400 });
    }

    // Validate events
    if (!Array.isArray(events) || events.length === 0) {
        return Response.json(
            { error: `events must be a non-empty array of: ${VALID_EVENTS.join(", ")}` },
            { status: 400 },
        );
    }

    for (const e of events) {
        if (!VALID_EVENTS.includes(e as CreditWebhookEvent)) {
            return Response.json(
                { error: `Invalid event "${e}". Valid events: ${VALID_EVENTS.join(", ")}` },
                { status: 400 },
            );
        }
    }

    // If agent-authed, verify they can only register webhooks for themselves
    if (auth.agent && auth.agent.agentId !== agentId) {
        return Response.json(
            { error: "Agents can only register webhooks for themselves" },
            { status: 403 },
        );
    }

    // Check max webhooks limit
    try {
        const count = await countWebhooks(agentId);
        if (count >= MAX_WEBHOOKS_PER_AGENT) {
            return Response.json(
                { error: `Maximum ${MAX_WEBHOOKS_PER_AGENT} webhooks per agent` },
                { status: 429 },
            );
        }
    } catch (error) {
        console.error("[credit/webhooks] Failed to count webhooks:", error);
    }

    // Generate secret and register
    const secret = generateWebhookSecret();
    const registeredBy = auth.agent?.agentId || "platform_admin";

    try {
        const id = await registerWebhook({
            agentId,
            url,
            events,
            secret,
            registeredBy,
            active: true,
        });

        return Response.json({
            id,
            agentId,
            url,
            events,
            secret, // Only shown once at registration time
            active: true,
            message: "Webhook registered. Save the secret — it will not be shown again.",
        });
    } catch (error) {
        console.error("[credit/webhooks] Registration failed:", error);
        return Response.json(
            { error: "Failed to register webhook", details: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}

// ─── GET: List webhooks ────────────────────────────────────────

export async function GET(request: NextRequest) {
    const limited = await rateLimit("webhook-list");
    if (limited) return limited;

    const auth = await requirePlatformAdminOrAgent(request, "GET:/v1/credit/webhooks");
    if (!auth.ok) return unauthorized(auth.error);

    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get("agentId") || auth.agent?.agentId;

    if (!agentId) {
        return Response.json({ error: "agentId query param required (or use agent auth)" }, { status: 400 });
    }

    // If agent-authed, verify they can only list their own webhooks
    if (auth.agent && auth.agent.agentId !== agentId) {
        return Response.json(
            { error: "Agents can only list their own webhooks" },
            { status: 403 },
        );
    }

    try {
        const webhooks = await listWebhooks(agentId);

        // Mask secrets — only show last 4 characters
        const masked = webhooks.map(wh => ({
            ...wh,
            secret: `****${wh.secret.slice(-4)}`,
        }));

        return Response.json({ webhooks: masked, count: masked.length });
    } catch (error) {
        console.error("[credit/webhooks] List failed:", error);
        return Response.json(
            { error: "Failed to list webhooks", details: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}

// ─── DELETE: Remove a webhook ──────────────────────────────────

export async function DELETE(request: NextRequest) {
    const limited = await rateLimit("webhook-delete");
    if (limited) return limited;

    const auth = await requirePlatformAdminOrAgent(request, "DELETE:/v1/credit/webhooks");
    if (!auth.ok) return unauthorized(auth.error);

    const { searchParams } = new URL(request.url);
    const webhookId = searchParams.get("webhookId");

    if (!webhookId) {
        return Response.json({ error: "webhookId query param required" }, { status: 400 });
    }

    try {
        await deleteWebhook(webhookId);
        return Response.json({ success: true, deleted: webhookId });
    } catch (error) {
        console.error("[credit/webhooks] Delete failed:", error);
        return Response.json(
            { error: "Failed to delete webhook", details: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}
