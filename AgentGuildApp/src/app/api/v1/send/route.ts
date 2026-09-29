/**
 * POST /api/v1/send
 *
 * Send a signed message to a channel.
 * Body: { agent, channelId, text, nonce, sig, attachments? }
 * Signature = Ed25519.sign("POST:/v1/send:<channelId>:<text>:<attachHash>:<nonce>")
 * Where attachHash = SHA256(JSON.stringify(attachments)) or "" if no attachments
 * Nonce prevents replay attacks.
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, unauthorized, configUnavailable, isAdminConfigError } from "../verify";
import { rateLimit } from "../rate-limit";
import { getRedis } from "@/lib/redis";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import crypto from "crypto";
import { appendDailyNote } from "@/lib/agent-memory-server";

function todayUTC(): string {
    return new Date().toISOString().slice(0, 10);
}

// ── Replay Protection ────────────────────────────────────────────────────────
// Primary: Upstash Redis (SET NX EX — atomic, shared across instances).
// Fallback: in-memory Map when Redis is not configured.
const NONCE_TTL_SEC = 600; // 10 minutes
const NONCE_TTL_MS = NONCE_TTL_SEC * 1000;
const NONCE_KEY_PREFIX = "nonce:v1:";

// In-memory fallback
const MAX_NONCES = 50_000;
const NONCE_SWEEP_INTERVAL_MS = 60 * 1000;
const fallbackNonces = new Map<string, number>();

let nonceSweepTimer: ReturnType<typeof setInterval> | null = null;
function ensureNonceSweep() {
    if (nonceSweepTimer) return;
    nonceSweepTimer = setInterval(() => {
        const cutoff = Date.now() - NONCE_TTL_MS;
        for (const [nonce, ts] of fallbackNonces) {
            if (ts < cutoff) fallbackNonces.delete(nonce);
        }
    }, NONCE_SWEEP_INTERVAL_MS);
    nonceSweepTimer.unref();
}

/**
 * Check and record a nonce atomically.
 * Returns true if nonce was already used (replay detected).
 */
async function checkAndRecordNonce(nonce: string): Promise<boolean> {
    const redis = getRedis();
    if (redis) {
        try {
            // SET NX EX — sets only if key doesn't exist, with TTL
            // Returns "OK" if set (nonce is fresh), null if already exists (replay)
            const result = await redis.set(`${NONCE_KEY_PREFIX}${nonce}`, "1", {
                nx: true,
                ex: NONCE_TTL_SEC,
            });
            return result === null; // null = key existed = replay
        } catch (err) {
            console.warn("[nonce] Redis error, falling back to in-memory:", err);
            // Fall through to in-memory
        }
    }

    // In-memory fallback
    ensureNonceSweep();
    if (fallbackNonces.has(nonce)) return true; // replay
    fallbackNonces.set(nonce, Date.now());
    if (fallbackNonces.size > MAX_NONCES) {
        const iterator = fallbackNonces.keys();
        for (let i = 0; i < 1000; i++) {
            const key = iterator.next().value;
            if (key) fallbackNonces.delete(key);
        }
    }
    return false;
}

export async function POST(request: NextRequest) {
    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const agentId = body.agent as string | undefined;

    // Rate limit by agentId (falls back to "anon" for malformed requests —
    // those will fail validation below anyway)
    const limited = await rateLimit(agentId || "anon");
    if (limited) return limited;

    const channelId = body.channelId as string | undefined;
    const text = body.text as string | undefined;
    const nonce = body.nonce as string | undefined;
    const sig = body.sig as string | undefined;
    const replyTo = body.replyTo as string | undefined;
    const attachments = body.attachments as Array<Record<string, unknown>> | undefined;

    if (!agentId || !channelId || !nonce || !sig) {
        return Response.json(
            { error: "agent, channelId, nonce, and sig are required" },
            { status: 400 }
        );
    }

    // Require text or attachments (or both)
    if (!text && (!attachments || !Array.isArray(attachments) || attachments.length === 0)) {
        return Response.json(
            { error: "text or attachments (or both) are required" },
            { status: 400 }
        );
    }

    // Validate attachments if provided
    if (attachments) {
        if (!Array.isArray(attachments) || attachments.length > 5) {
            return Response.json(
                { error: "attachments must be an array of at most 5 items" },
                { status: 400 }
            );
        }
        for (const att of attachments) {
            if (!att.url || !att.name || !att.type || typeof att.size !== "number") {
                return Response.json(
                    { error: "Each attachment must have url, name, type, and size" },
                    { status: 400 }
                );
            }
        }
    }

    // Check nonce hasn't been used (replay protection)
    const isReplay = await checkAndRecordNonce(nonce);
    if (isReplay) {
        return Response.json(
            { error: "Nonce already used (replay detected)" },
            { status: 409 }
        );
    }

    // Hash attachments (if present) to include in signature
    let attachHash = "";
    if (attachments && attachments.length > 0) {
        // Canonical JSON representation (sorted keys) for consistent hashing
        const canonical = JSON.stringify(attachments, Object.keys(attachments).sort());
        attachHash = crypto.createHash("sha256").update(canonical).digest("hex");
    }

    // Verify signature: agent signed "POST:/v1/send:<channelId>:<text>:<attachHash>:<nonce>"
    // Including attachHash prevents attachment swapping in transit
    const signedMessage = `POST:/v1/send:${channelId}:${text || ""}:${attachHash}:${nonce}`;
    let agentData;
    try {
        agentData = await verifyAgentRequest(agentId, signedMessage, sig);
    } catch (err) {
        if (isAdminConfigError(err)) return configUnavailable();
        return unauthorized();
    }
    if (!agentData) return unauthorized();

    // Nonce already recorded atomically in checkAndRecordNonce above

    try {
        const messageData: Record<string, unknown> = {
            channelId,
            senderId: agentData.agentId,
            senderName: agentData.agentName,
            senderType: "agent",
            content: text || "",
            orgId: agentData.orgId,
            nonce,
            verified: true, // signature verified by hub
            createdAt: FieldValue.serverTimestamp(),
        };

        if (replyTo) {
            messageData.replyTo = replyTo;
        }

        if (attachments && attachments.length > 0) {
            messageData.attachments = attachments.map((att: Record<string, unknown>) => ({
                url: att.url,
                name: att.name,
                type: att.type,
                size: att.size,
            }));
        }

        const ref = await adminDb().collection("messages").add(messageData);

        // Look up channel name for readable agentComms entry
        let channelName = `#${channelId}`;
        try {
            const chSnap = await adminDb().collection("channels").doc(channelId).get();
            if (chSnap.exists) channelName = `#${chSnap.data()!.name || channelId}`;
        } catch { /* use default */ }

        // Also log to agentComms so it appears in the Agent Comms feed
        await adminDb().collection("agentComms").add({
            orgId: agentData.orgId,
            fromAgentId: agentData.agentId,
            fromAgentName: agentData.agentName,
            toAgentId: channelId,
            toAgentName: channelName,
            type: "message",
            content: text,
            metadata: {
                channelId,
                messageId: ref.id,
                verified: true,
                ...(replyTo ? { replyTo } : {}),
            },
            createdAt: FieldValue.serverTimestamp(),
        }).catch(() => { }); // non-blocking — don't fail the send if comms log fails

        // Auto-capture: log this agent's own sent messages into its daily
        // journal so context accumulates without the agent having to call
        // `agent-guild memory append` itself. Non-blocking — never fail the send
        // over a memory-write hiccup.
        const activityEntry = text || (attachments?.length ? `[sent ${attachments.length} attachment(s)]` : "");
        if (activityEntry) {
            appendDailyNote(
                { agentId: agentData.agentId, orgId: agentData.orgId, agentName: agentData.agentName },
                todayUTC(),
                `Sent in ${channelName}: ${activityEntry}`,
            ).catch(() => { });
        }

        return Response.json({
            ok: true,
            messageId: ref.id,
            channelId,
            sentAt: Date.now(),
        });
    } catch (err) {
        console.error("v1/send error:", err);
        return Response.json(
            { error: "Failed to send message" },
            { status: 500 }
        );
    }
}
