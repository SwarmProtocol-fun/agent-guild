/**
 * Agent Context (server) — chat-history half of the context library:
 * resolves which channels an agent belongs to and fetches its recent
 * messages across them. Server-only (Admin SDK via adminDb()).
 *
 * This consolidates channel-resolution logic that otherwise exists only
 * inline, duplicated between:
 *   - SwarmApp/src/app/api/v1/messages/route.ts (loops projectIds.slice(0,10)
 *     one-at-a-time; only used by v1/context here, not migrated there yet —
 *     swarm.mjs's daemon/check polling depends on that route's exact current
 *     behavior, so it's left untouched for now)
 *   - hub/index.mjs's getAgentChannels() (a separate .mjs deploy unit that
 *     can't import this file — its own copy stays, this is not shared code)
 *
 * The batched `in`-query approach below (covering all of an agent's
 * projects, not just the first 10) is adapted from hub/index.mjs.
 */
import { adminDb } from "./firebase-admin";
import { Timestamp } from "firebase-admin/firestore";

const AGENT_HUB_CHANNEL_NAME = "Agent Hub";

export interface ResolvedChannel {
  id: string;
  name: string;
  projectId?: string;
}

export interface ContextMessage {
  id: string;
  channelId: string;
  channelName: string;
  from: string;
  fromType: string;
  content: string;
  timestamp: number;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Agent doc → projectIds + orgId → that agent's channels + the org's shared Agent Hub channel. */
export async function resolveAgentChannels(agentId: string): Promise<{ orgId: string; channels: ResolvedChannel[] }> {
  const agentSnap = await adminDb().collection("agents").doc(agentId).get();
  if (!agentSnap.exists) return { orgId: "", channels: [] };

  const agentData = agentSnap.data()!;
  const orgId: string = agentData.orgId || agentData.organizationId || "";
  const projectIds: string[] = agentData.projectIds || [];

  const channels: ResolvedChannel[] = [];
  const seen = new Set<string>();

  if (projectIds.length > 0) {
    for (const batch of chunk(projectIds, 10)) {
      const snap = await adminDb().collection("channels").where("projectId", "in", batch).get();
      for (const doc of snap.docs) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        const d = doc.data();
        channels.push({ id: doc.id, name: d.name || "Channel", projectId: d.projectId });
      }
    }
  }

  if (orgId) {
    const hubSnap = await adminDb()
      .collection("channels")
      .where("orgId", "==", orgId)
      .where("name", "==", AGENT_HUB_CHANNEL_NAME)
      .get();
    for (const doc of hubSnap.docs) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      channels.push({ id: doc.id, name: AGENT_HUB_CHANNEL_NAME });
    }
  }

  return { orgId, channels };
}

/**
 * Most recent `limit` messages across an agent's channels, newest-per-channel
 * bounded (not "load the whole channel then truncate" like v1/messages does),
 * merged and returned oldest-to-newest. Requires the
 * messages(channelId ASC, createdAt DESC) composite index.
 */
export async function getRecentMessagesForAgent(
  agentId: string,
  opts: { limit?: number; sinceMs?: number; includeOwn?: boolean } = {},
): Promise<{ messages: ContextMessage[]; channels: ResolvedChannel[] }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const { channels } = await resolveAgentChannels(agentId);
  if (channels.length === 0) return { messages: [], channels: [] };

  const channelMeta = new Map(channels.map((c) => [c.id, c]));

  const perChannelResults = await Promise.all(
    channels.map(async (ch) => {
      let q = adminDb().collection("messages").where("channelId", "==", ch.id) as FirebaseFirestore.Query;
      if (opts.sinceMs) q = q.where("createdAt", ">", Timestamp.fromMillis(opts.sinceMs));
      q = q.orderBy("createdAt", "desc").limit(limit);
      const snap = await q.get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() } as FirebaseFirestore.DocumentData & { id: string }));
    }),
  );

  const merged: ContextMessage[] = [];
  for (const docs of perChannelResults) {
    for (const m of docs) {
      if (!opts.includeOwn && m.senderId === agentId) continue;
      merged.push({
        id: m.id,
        channelId: m.channelId,
        channelName: channelMeta.get(m.channelId)?.name || m.channelId,
        from: m.senderName || m.senderId || "unknown",
        fromType: m.senderType || "user",
        content: m.content || m.text || "",
        timestamp: m.createdAt?.toMillis?.() || m.ts || 0,
      });
    }
  }

  merged.sort((a, b) => a.timestamp - b.timestamp);
  return { messages: merged.slice(-limit), channels };
}
