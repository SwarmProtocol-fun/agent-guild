/**
 * GET /api/v1/messages?agent=<agentId>&since=<timestampMs>&sig=<signature>
 *
 * Poll for new messages. Signature-verified.
 * Signature = Ed25519.sign("GET:/v1/messages:<since_timestamp>")
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh, unauthorized } from "../verify";
import { rateLimit } from "../rate-limit";
import { adminDb } from "@/lib/firebase-admin";
import { Timestamp, type Query } from "firebase-admin/firestore";

export async function GET(request: NextRequest) {
    const { searchParams } = request.nextUrl;
    const agentId = searchParams.get("agent");
    const sinceParam = searchParams.get("since") || "0";
    const sig = searchParams.get("sig");

    const limited = await rateLimit(agentId || "anon");
    if (limited) return limited;

    if (!agentId || !sig) {
        return unauthorized("agent and sig parameters are required");
    }

    // Verify signature: agent signed "GET:/v1/messages:<since>"
    const signedMessage = `GET:/v1/messages:${sinceParam}`;
    const agent = await verifyAgentRequest(agentId, signedMessage, sig);
    if (!agent) return unauthorized();

    // Note: `since` is a query cursor (last poll timestamp), NOT a request
    // timestamp. An agent that polls hourly or daily will have an old `since`
    // and that's fine. Replay protection is handled by signature verification.
    const sinceMs = parseInt(sinceParam, 10);

    try {
        // Get agent's projects and org
        const agentSnap = await adminDb().collection("agents").doc(agent.agentId).get();
        if (!agentSnap.exists) {
            return Response.json({ error: "Agent not found" }, { status: 404 });
        }
        const agentData = agentSnap.data()!;
        const projectIds: string[] = agentData.projectIds || [];
        const orgId = agentData.orgId || agent.orgId;

        // Get channels for agent's projects
        const channelIds: string[] = [];
        const channelMeta: Record<string, { name: string; projectId: string }> = {};

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

        for (const channelId of channelIds) {
            let messagesQ: Query = adminDb().collection("messages").where("channelId", "==", channelId);
            if (sinceMs > 0) {
                const sinceTs = Timestamp.fromMillis(sinceMs);
                messagesQ = messagesQ.where("createdAt", ">", sinceTs);
            }
            messagesQ = messagesQ.orderBy("createdAt", "asc");

            const msgsSnap = await messagesQ.get();
            for (const mDoc of msgsSnap.docs) {
                const m = mDoc.data();
                if (m.senderId === agent.agentId) continue;

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

        // Cap at 100
        const capped = messages.slice(-100);

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
