/**
 * GET /api/v1/messages?agent=<agentId>&since=<timestampMs>&sig=<signature>&ts=<timestampMs>&nonce=<uuid>
 *
 * Poll for new messages. Signature-verified.
 * Signature = Ed25519.sign("GET:/v1/messages:<since>:<ts>:<nonce>")
 *
 * `since` is a cursor (last poll watermark) and can legitimately repeat
 * across calls (an empty poll doesn't advance it) — it must never be the
 * value replay protection keys on. `ts`+`nonce` are a fresh-per-attempt pair
 * so the signed message (and therefore the signature) differs on every call
 * even when `since` doesn't move.
 *
 * Legacy support: a CLI that still signs the old two-part form
 * `GET:/v1/messages:<since>` (no ts/nonce) is accepted for one release, but
 * with replay tracking skipped for that call — see the nonce-tracking note
 * in verify.ts for why the old form can't be replay-checked without false
 * positives.
 */
import { NextRequest } from "next/server";
import { verifyAgentRequestDetailed, isTimestampFresh, unauthorized, unauthorizedFor, configUnavailable, isAdminConfigError } from "../verify";
import { rateLimit } from "../rate-limit";
import { adminDb } from "@/lib/firebase-admin";
import { Timestamp, type Query } from "firebase-admin/firestore";

const MAX_MESSAGES = 100;
const IN_QUERY_MAX = 30;

// Which channels an agent polls changes rarely (project membership, a new
// DM), but the CLI polls every few seconds. Re-deriving it each time cost an
// agent doc read plus 3+ channel queries per poll, so keep it per warm
// instance for a minute. A new channel shows up within SCOPE_TTL_MS.
const SCOPE_TTL_MS = 60_000;
type ChannelScope = {
    channelIds: string[];
    channelMeta: Record<string, { name: string; projectId: string }>;
};
const scopeCache = new Map<string, { scope: ChannelScope; expiresAt: number }>();

async function getChannelScope(agentId: string, fallbackOrgId: string): Promise<ChannelScope | null> {
    const cached = scopeCache.get(agentId);
    if (cached && cached.expiresAt > Date.now()) return cached.scope;

    const agentSnap = await adminDb().collection("agents").doc(agentId).get();
    if (!agentSnap.exists) {
        scopeCache.delete(agentId);
        return null;
    }
    const agentData = agentSnap.data()!;
    const projectIds: string[] = agentData.projectIds || [];
    const orgId = agentData.orgId || fallbackOrgId;

    const channelIds: string[] = [];
    const channelMeta: ChannelScope["channelMeta"] = {};

    for (const projectId of projectIds.slice(0, 10)) {
        const channelsSnap = await adminDb().collection("channels").where("projectId", "==", projectId).get();
        for (const chDoc of channelsSnap.docs) {
            channelIds.push(chDoc.id);
            channelMeta[chDoc.id] = {
                name: chDoc.data().name || "Channel",
                projectId,
            };
        }
    }

    // Always include the Agent Hub channel (org-wide, no projectId)
    if (orgId) {
        const hubSnap = await adminDb().collection("channels")
            .where("orgId", "==", orgId)
            .where("name", "==", "Agent Hub")
            .get();
        if (!hubSnap.empty) {
            const hubDoc = hubSnap.docs[0];
            if (!channelIds.includes(hubDoc.id)) {
                channelIds.push(hubDoc.id);
                channelMeta[hubDoc.id] = {
                    name: "Agent Hub",
                    projectId: "org",
                };
            }
        }
    }

    // Always include this agent's own private DM channel (orgId + agentId
    // match). ensureAgentPrivateChannel creates these with no projectId and
    // a name that isn't "Agent Hub", so neither block above would ever
    // return them — a human message sent there was previously invisible
    // to this poll (PRD-REPLY §3). Other agents' DMs stay excluded because
    // the query is scoped to this agent's own agentId.
    if (orgId) {
        const dmSnap = await adminDb().collection("channels")
            .where("orgId", "==", orgId)
            .where("agentId", "==", agentId)
            .get();
        for (const dmDoc of dmSnap.docs) {
            if (!channelIds.includes(dmDoc.id)) {
                channelIds.push(dmDoc.id);
                channelMeta[dmDoc.id] = {
                    name: dmDoc.data().name || "DM",
                    projectId: "dm",
                };
            }
        }
    }

    const scope = { channelIds, channelMeta };
    scopeCache.set(agentId, { scope, expiresAt: Date.now() + SCOPE_TTL_MS });
    return scope;
}

export async function GET(request: NextRequest) {
    const { searchParams } = request.nextUrl;
    const agentId = searchParams.get("agent");
    const sinceParam = searchParams.get("since") || "0";
    const sig = searchParams.get("sig");
    const tsParam = searchParams.get("ts");
    const nonceParam = searchParams.get("nonce");

    const limited = await rateLimit(agentId || "anon");
    if (limited) return limited;

    if (!agentId || !sig) {
        return unauthorized("agent and sig parameters are required");
    }

    const hasFreshAttemptId = !!(tsParam && nonceParam);

    if (tsParam) {
        const tsNum = parseInt(tsParam, 10);
        if (!isTimestampFresh(tsNum)) {
            return unauthorized("Stale timestamp", "STALE_TIMESTAMP");
        }
    }

    // Verify signature: agent signed "GET:/v1/messages:<since>:<ts>:<nonce>",
    // or the legacy "GET:/v1/messages:<since>" form (replay check skipped).
    const signedMessage = hasFreshAttemptId
        ? `GET:/v1/messages:${sinceParam}:${tsParam}:${nonceParam}`
        : `GET:/v1/messages:${sinceParam}`;
    let agent;
    try {
        const result = await verifyAgentRequestDetailed(agentId, signedMessage, sig, {
            skipReplayCheck: !hasFreshAttemptId,
        });
        if (!result.ok) return unauthorizedFor(result.reason);
        agent = result;
    } catch (err) {
        if (isAdminConfigError(err)) return configUnavailable();
        return unauthorized();
    }

    // Note: `since` is a query cursor (last poll timestamp), NOT a request
    // timestamp. An agent that polls hourly or daily will have an old `since`
    // and that's fine. Replay protection is handled by `ts`+`nonce` above,
    // not by `since`.
    const sinceMs = parseInt(sinceParam, 10);

    try {
        const scope = await getChannelScope(agent.agentId, agent.orgId);
        if (!scope) {
            return Response.json({ error: "Agent not found" }, { status: 404 });
        }
        const { channelIds, channelMeta } = scope;

        if (channelIds.length === 0) {
            return Response.json({ messages: [], channels: [] });
        }

        // Fetch messages
        const messages: Array<{
            id: string;
            channelId: string;
            channelName: string;
            from: string;
            fromType: string;
            text: string;
            timestamp: number;
            attachments?: Array<{ url: string; name: string; type: string; size: number }>;
        }> = [];

        // One `in` query per 30 channels instead of one query per channel —
        // Firestore bills a read for every query even when it comes back
        // empty, and an idle poll is almost always empty. With a cursor the
        // oldest 100 come back first so the caller's watermark pages forward;
        // without one, keep the newest 100 as before.
        for (let i = 0; i < channelIds.length; i += IN_QUERY_MAX) {
            const chunk = channelIds.slice(i, i + IN_QUERY_MAX);
            let messagesQ: Query = adminDb().collection("messages").where("channelId", "in", chunk);
            if (sinceMs > 0) {
                messagesQ = messagesQ
                    .where("createdAt", ">", Timestamp.fromMillis(sinceMs))
                    .orderBy("createdAt", "asc");
            } else {
                messagesQ = messagesQ.orderBy("createdAt", "desc");
            }
            messagesQ = messagesQ.limit(MAX_MESSAGES);

            const msgsSnap = await messagesQ.get();
            for (const mDoc of msgsSnap.docs) {
                const m = mDoc.data();
                if (m.senderId === agent.agentId) continue;
                const channelId = m.channelId as string;

                const msg: typeof messages[number] = {
                    id: mDoc.id,
                    channelId,
                    channelName: channelMeta[channelId]?.name || channelId,
                    from: m.senderName || m.senderId || "unknown",
                    fromType: m.senderType || "user",
                    text: m.content || m.text || "",
                    timestamp: m.createdAt?.toMillis?.() || m.ts || 0,
                };
                if (m.attachments && Array.isArray(m.attachments)) {
                    msg.attachments = m.attachments;
                }
                messages.push(msg);
            }
        }
        messages.sort((a, b) => a.timestamp - b.timestamp);

        // Cap at 100
        const capped = sinceMs > 0 ? messages.slice(0, MAX_MESSAGES) : messages.slice(-MAX_MESSAGES);

        return Response.json({
            messages: capped,
            channels: Object.entries(channelMeta).map(([id, meta]) => ({
                id,
                ...meta,
            })),
            polledAt: Date.now(),
        });
    } catch (err) {
        console.error("v1/messages error:", err);
        return Response.json(
            { error: "Internal server error" },
            { status: 500 }
        );
    }
}
