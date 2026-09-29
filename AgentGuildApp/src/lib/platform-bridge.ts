/**
 * Platform Bridge — Unified Interface for Multi-Platform Messaging
 *
 * Connects Telegram, Discord, and Slack to Agent Guild channels.
 * Enables agents to send/receive messages across all platforms.
 */

import { adminDb } from "./firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { encryptValue, decryptValue } from "./secrets";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type PlatformType = "native" | "telegram" | "discord" | "slack";

export interface PlatformConnection {
  id: string;
  orgId: string;
  platform: "telegram" | "discord" | "slack";
  /** Encrypted bot token or OAuth credentials (AES-256-GCM) */
  credentials: string;
  /** Initialization vector for AES-256-GCM decryption */
  credentialsIV: string;
  webhookUrl?: string;
  connectedAt: Date | null;
  active: boolean;
  metadata?: {
    botUsername?: string;
    botId?: string;
    guildId?: string;
    teamId?: string;
  };
}

export interface BridgedChannel {
  id: string;
  orgId: string;
  agentGuildChannelId: string;
  platformType: PlatformType;
  platformChannelId: string;
  platformMetadata?: {
    chatId?: string | number; // Telegram
    channelName?: string; // All platforms
    guildId?: string; // Discord
    teamId?: string; // Slack
  };
  createdAt: Date | null;
}

export interface BridgedMessage {
  id: string;
  agentGuildMessageId?: string;
  platformMessageId: string;
  channelId: string;
  platform: PlatformType;
  senderId: string;
  senderName: string;
  content: string;
  attachments?: Array<{
    url: string;
    type: string;
    name: string;
  }>;
  timestamp: Date | null;
  direction: "inbound" | "outbound";
}

// ═══════════════════════════════════════════════════════════════
// Platform Connection Management
// ═══════════════════════════════════════════════════════════════

export async function createPlatformConnection(
  orgId: string,
  platform: "telegram" | "discord" | "slack",
  credentials: string,
  masterSecret: string,
  metadata?: Record<string, unknown>
): Promise<string> {
  // Encrypt credentials before storage (AES-256-GCM)
  const { encryptedValue, iv } = encryptValue(credentials, orgId, masterSecret);

  const ref = await adminDb().collection("platformConnections").add({
    orgId,
    platform,
    credentials: encryptedValue,
    credentialsIV: iv,
    webhookUrl: "",
    connectedAt: FieldValue.serverTimestamp(),
    active: true,
    metadata: metadata || {},
  });
  return ref.id;
}

export async function getPlatformConnection(
  orgId: string,
  platform: "telegram" | "discord" | "slack",
  masterSecret: string
): Promise<PlatformConnection | null> {
  const snap = await adminDb()
    .collection("platformConnections")
    .where("orgId", "==", orgId)
    .where("platform", "==", platform)
    .where("active", "==", true)
    .get();
  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data();

  // Decrypt credentials before returning
  const decryptedCredentials = decryptValue(
    data.credentials,
    data.credentialsIV,
    orgId,
    masterSecret
  );

  return {
    id: doc.id,
    orgId: data.orgId,
    platform: data.platform,
    credentials: decryptedCredentials,
    credentialsIV: data.credentialsIV,
    webhookUrl: data.webhookUrl,
    connectedAt: data.connectedAt?.toDate() || null,
    active: data.active,
    metadata: data.metadata,
  };
}

export async function getAllPlatformConnections(
  orgId: string,
  masterSecret: string
): Promise<PlatformConnection[]> {
  const snap = await adminDb()
    .collection("platformConnections")
    .where("orgId", "==", orgId)
    .where("active", "==", true)
    .get();
  return snap.docs.map((d) => {
    const data = d.data();

    // Decrypt credentials before returning
    const decryptedCredentials = decryptValue(
      data.credentials,
      data.credentialsIV,
      orgId,
      masterSecret
    );

    return {
      id: d.id,
      orgId: data.orgId,
      platform: data.platform,
      credentials: decryptedCredentials,
      credentialsIV: data.credentialsIV,
      webhookUrl: data.webhookUrl,
      connectedAt: data.connectedAt?.toDate() || null,
      active: data.active,
      metadata: data.metadata,
    };
  });
}

/**
 * List connections without decrypting credentials (safe for client-facing API).
 * Returns metadata only.
 */
export async function listPlatformConnections(
  orgId: string
): Promise<Omit<PlatformConnection, "credentials" | "credentialsIV">[]> {
  const snap = await adminDb()
    .collection("platformConnections")
    .where("orgId", "==", orgId)
    .where("active", "==", true)
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      orgId: data.orgId,
      platform: data.platform,
      webhookUrl: data.webhookUrl,
      connectedAt: data.connectedAt?.toDate() || null,
      active: data.active,
      metadata: data.metadata,
    };
  });
}

export async function deactivatePlatformConnection(connectionId: string): Promise<void> {
  await adminDb().collection("platformConnections").doc(connectionId).set(
    { active: false },
    { merge: true }
  );
}

// ═══════════════════════════════════════════════════════════════
// Channel Bridging
// ═══════════════════════════════════════════════════════════════

export async function bridgeChannel(
  orgId: string,
  agentGuildChannelId: string,
  platformType: PlatformType,
  platformChannelId: string,
  platformMetadata?: Record<string, unknown>
): Promise<string> {
  const ref = await adminDb().collection("bridgedChannels").add({
    orgId,
    agentGuildChannelId,
    platformType,
    platformChannelId,
    platformMetadata: platformMetadata || {},
    createdAt: FieldValue.serverTimestamp(),
  });

  // Update Agent Guild channel to indicate it's bridged
  await adminDb().collection("channels").doc(agentGuildChannelId).set(
    {
      platformType,
      platformChannelId,
      platformMetadata: platformMetadata || {},
    },
    { merge: true }
  );

  return ref.id;
}

export async function getBridgedChannel(
  agentGuildChannelId: string
): Promise<BridgedChannel | null> {
  let snap = await adminDb()
    .collection("bridgedChannels")
    .where("agentGuildChannelId", "==", agentGuildChannelId)
    .get();
  if (snap.empty) {
    // Legacy field name from before the Swarm Protocol -> Agent Guild rename
    snap = await adminDb()
      .collection("bridgedChannels")
      .where("swarmChannelId", "==", agentGuildChannelId)
      .get();
  }
  if (snap.empty) return null;

  const d = snap.docs[0];
  const data = d.data();
  return {
    id: d.id,
    orgId: data.orgId,
    agentGuildChannelId: data.agentGuildChannelId ?? data.swarmChannelId,
    platformType: data.platformType,
    platformChannelId: data.platformChannelId,
    platformMetadata: data.platformMetadata,
    createdAt: data.createdAt?.toDate() || null,
  };
}

export async function getBridgedChannelByPlatform(
  platform: PlatformType,
  platformChannelId: string
): Promise<BridgedChannel | null> {
  const snap = await adminDb()
    .collection("bridgedChannels")
    .where("platformType", "==", platform)
    .where("platformChannelId", "==", platformChannelId)
    .get();
  if (snap.empty) return null;

  const d = snap.docs[0];
  const data = d.data();
  return {
    id: d.id,
    orgId: data.orgId,
    agentGuildChannelId: data.agentGuildChannelId ?? data.swarmChannelId,
    platformType: data.platformType,
    platformChannelId: data.platformChannelId,
    platformMetadata: data.platformMetadata,
    createdAt: data.createdAt?.toDate() || null,
  };
}

export async function unbridgeChannel(bridgeId: string): Promise<void> {
  // Get the bridge record to find the Agent Guild channel ID
  const bridgeRef = adminDb().collection("bridgedChannels").doc(bridgeId);
  const bridgeDoc = await bridgeRef.get();
  const bridgeData = bridgeDoc.exists ? bridgeDoc.data() : null;

  // Deactivate the bridge
  await bridgeRef.set({ active: false }, { merge: true });

  // Clear platform fields from the Agent Guild channel
  const agentGuildChannelId = bridgeData?.agentGuildChannelId ?? bridgeData?.swarmChannelId;
  if (agentGuildChannelId) {
    await adminDb().collection("channels").doc(agentGuildChannelId).update({
      platformType: FieldValue.delete(),
      platformChannelId: FieldValue.delete(),
      platformMetadata: FieldValue.delete(),
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Message Bridging
// ═══════════════════════════════════════════════════════════════

export async function logBridgedMessage(
  channelId: string,
  platform: PlatformType,
  platformMessageId: string,
  senderId: string,
  senderName: string,
  content: string,
  direction: "inbound" | "outbound",
  agentGuildMessageId?: string,
  attachments?: Array<{ url: string; type: string; name: string }>
): Promise<string> {
  const ref = await adminDb().collection("bridgedMessages").add({
    agentGuildMessageId: agentGuildMessageId || null,
    platformMessageId,
    channelId,
    platform,
    senderId,
    senderName,
    content,
    attachments: attachments || [],
    direction,
    timestamp: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

export function getPlatformIcon(platform: PlatformType): string {
  switch (platform) {
    case "telegram":
      return "📱";
    case "discord":
      return "💬";
    case "slack":
      return "💼";
    case "native":
      return "🌐";
  }
}

export function getPlatformColor(platform: PlatformType): string {
  switch (platform) {
    case "telegram":
      return "text-blue-400";
    case "discord":
      return "text-indigo-400";
    case "slack":
      return "text-purple-400";
    case "native":
      return "text-gray-400";
  }
}
