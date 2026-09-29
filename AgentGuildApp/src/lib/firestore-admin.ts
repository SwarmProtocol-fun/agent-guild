/**
 * Firestore Admin — server-only Firestore reads/writes, via the Admin SDK
 * (bypasses Firestore rules). Originally just for pre-auth needs (login,
 * before a Firebase Auth session exists); also now the home for any other
 * function a verified server-only caller (an API route, or a lib file with
 * no client-reachable import path — check with `next build`, not just a
 * direct-importer grep, since dynamic imports and transitive chains both
 * pull real code into client bundles silently) needs instead of going
 * through src/lib/firestore.ts's rules-scoped client SDK calls.
 *
 * Server-only — never import this from client-facing code, and never from a
 * lib file that might itself be imported by one (directly, transitively, or
 * via a dynamic `import()`). For everything else (post-login, client-side),
 * use src/lib/firestore.ts, which goes through the client SDK and is scoped
 * by Firestore rules.
 */
import { adminDb } from "./firebase-admin";
import { FieldValue, type Query } from "firebase-admin/firestore";
import type {
  Organization,
  Project,
  Agent,
  Task,
  Channel,
  Job,
  Message,
  AgentComm,
  ReportedSkill,
} from "./firestore";
import { estimateCost, type UsageRecord } from "./usage";
import type { ActivityEvent } from "./activity";
import { validateSOUL } from "./soul";
import { parseCronToHuman, type CronJob, type CronJobUpdateInput } from "./cron";
import type { MemoryEntry, MemoryType } from "./memory";
import { calculateDistance, calculateGatewayScore, REGION_LOCATIONS, type Gateway, type GatewayStatus, type GatewaySelectionResult } from "./gateways";
import {
  MOD_REGISTRY,
  CAPABILITY_REGISTRY,
  isSubscriptionActive,
  type CommunityMarketItem,
  type SubscriptionPlan,
  type MarketSubscription,
  type ResolvedCapability,
  type AgentPackage,
  type AgentRating,
  type ModInstallation,
  type AgentSkill,
  type CommunityItemRating,
} from "./skills";

/**
 * Mirrors firestore.ts's getOrganizationsByWallet, but via the Admin SDK so
 * it can run during /api/auth/verify — before any Firebase Auth session
 * exists for the client SDK's rules-scoped version to work against.
 */
export async function getOrganizationsByWalletAdmin(
  walletAddress: string
): Promise<Organization[]> {
  const lower = walletAddress.toLowerCase();
  const variants = new Set([walletAddress, lower]);

  try {
    const { ethers } = await import("ethers");
    variants.add(ethers.getAddress(walletAddress));
  } catch {
    // Invalid address or ethers not available — skip checksummed variant
  }

  const db = adminDb();
  const orgsCol = db.collection("organizations");

  const queries = [...variants].flatMap((addr) => [
    orgsCol.where("ownerAddress", "==", addr).get(),
    orgsCol.where("members", "array-contains", addr).get(),
  ]);

  const snapshots = await Promise.all(queries);

  const orgMap = new Map<string, Organization>();
  for (const snap of snapshots) {
    snap.docs.forEach((d) => {
      if (!orgMap.has(d.id)) {
        orgMap.set(d.id, { id: d.id, ...d.data() } as Organization);
      }
    });
  }

  return Array.from(orgMap.values());
}

// ─── Usage ──────────────────────────────────────────────

/**
 * Mirrors usage.ts's logUsage via the Admin SDK. Needed because the
 * `usageRecords` collection is explicitly denied to the client SDK by
 * Firestore rules (`allow read, write: if false`) — every call from
 * /api/v1/usage was failing before this existed.
 */
export async function logUsage(record: Omit<UsageRecord, "id" | "timestamp">): Promise<string> {
  const ref = await adminDb().collection("usageRecords").add({
    ...record,
    costUsd: record.costUsd || estimateCost(record.model, record.tokensIn, record.tokensOut),
    timestamp: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

// ─── Activity ───────────────────────────────────────────

export async function logActivity(event: Omit<ActivityEvent, "id" | "createdAt">): Promise<string> {
  const ref = await adminDb().collection("activityEvents").add({
    ...event,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

// ─── SOUL Config ────────────────────────────────────────
// NOTE: soul.ts's own getAgentSOUL/updateAgentSOUL must stay on the client
// SDK — updateAgentSOUL is called directly from apply-persona-dialog.tsx.
// These are separate Admin-SDK copies for the two routes that never touch
// the client (/api/agents/[id]/soul, .../soul/validate); validateSOUL and
// getDefaultSOUL are pure, so those routes keep importing them from soul.ts.

export async function getAgentSOUL(agentId: string): Promise<string | null> {
  const agentDoc = await adminDb().collection("agents").doc(agentId).get();
  if (!agentDoc.exists) {
    throw new Error("Agent not found");
  }
  const agent = { id: agentDoc.id, ...agentDoc.data() } as Agent;
  return agent.soulConfig || null;
}

export async function updateAgentSOUL(
  orgId: string,
  agentId: string,
  yamlContent: string
): Promise<void> {
  const validation = validateSOUL(yamlContent);
  if (!validation.valid) {
    throw new Error(
      `Invalid SOUL configuration: ${validation.errors.map((e) => e.message).join(", ")}`
    );
  }

  const agentRef = adminDb().collection("agents").doc(agentId);
  const agentDoc = await agentRef.get();
  if (!agentDoc.exists) {
    throw new Error("Agent not found");
  }

  const agent = { id: agentDoc.id, ...agentDoc.data() } as Agent;
  if (agent.orgId !== orgId) {
    throw new Error("Agent does not belong to this organization");
  }

  const version = validation.parsedConfig?.version || "1.0";

  await agentRef.update({
    soulConfig: yamlContent,
    soulVersion: version,
    soulUpdatedAt: FieldValue.serverTimestamp(),
  });

  await logActivity({
    orgId,
    eventType: "config.changed",
    actorType: "agent",
    actorId: agentId,
    actorName: agent.name,
    description: `SOUL config updated to version ${version}`,
    metadata: {
      configType: "soul",
      version,
    },
  });
}

// ─── Cron Jobs ──────────────────────────────────────────
// NOTE: cron.ts's own updateCronJob must stay on the client SDK — it's
// called directly from cron/page.tsx and dashboard/page.tsx. This is a
// separate Admin-SDK copy for the two routes that never touch the client
// (/api/cron/[id]/pause, .../test).

const CRON_COLLECTION = "cronJobs";

export async function getCronJob(id: string): Promise<CronJob | null> {
  const docSnap = await adminDb().collection(CRON_COLLECTION).doc(id).get();
  if (!docSnap.exists) return null;

  const data = docSnap.data()!;
  return {
    id: docSnap.id,
    orgId: data.orgId,
    projectId: data.projectId,
    name: data.name,
    message: data.message,
    schedule: data.schedule,
    scheduleLabel: data.scheduleLabel,
    targetChannelId: data.targetChannelId,
    agentIds: data.agentIds || [],
    priority: data.priority,
    enabled: data.enabled ?? true,
    paused: data.paused,
    staggerDelayMs: data.staggerDelayMs,
    createdBy: data.createdBy || "",
    lastRun: data.lastRun ? {
      time: data.lastRun.time?.toDate() || new Date(),
      success: data.lastRun.success ?? false,
      error: data.lastRun.error,
      durationMs: data.lastRun.durationMs,
    } : undefined,
    createdAt: data.createdAt?.toDate() || null,
    updatedAt: data.updatedAt?.toDate() || null,
  } as CronJob;
}

export async function updateCronJob(id: string, input: CronJobUpdateInput): Promise<void> {
  await adminDb().collection(CRON_COLLECTION).doc(id).update({
    ...input,
    ...(input.schedule ? { scheduleLabel: input.scheduleLabel || parseCronToHuman(input.schedule) } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

// ─── Agent Memory ───────────────────────────────────────
// NOTE: memory.ts's own getMemoryEntries must stay on the client SDK — it's
// called directly from the /memory dashboard page. Separate Admin-SDK copies
// for the three routes that never touch the client (/api/memory/[agentId]/*).

const MEMORY_COLLECTION = "agentMemories";

export async function addMemoryEntry(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<string> {
  const ref = await adminDb().collection(MEMORY_COLLECTION).add({
    ...entry,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getMemoryEntries(orgId: string, agentId?: string, type?: MemoryType): Promise<MemoryEntry[]> {
  let q: Query = adminDb().collection(MEMORY_COLLECTION).where("orgId", "==", orgId);
  if (agentId) q = q.where("agentId", "==", agentId);
  if (type) q = q.where("type", "==", type);
  q = q.orderBy("updatedAt", "desc");

  const snap = await q.get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id, orgId: data.orgId, agentId: data.agentId, agentName: data.agentName,
      type: data.type, title: data.title, content: data.content,
      filePath: data.filePath, sizeBytes: data.sizeBytes, tags: data.tags || [],
      subtype: data.subtype, structuredData: data.structuredData,
      createdAt: data.createdAt?.toDate?.() || null,
      updatedAt: data.updatedAt?.toDate?.() || null,
    } as MemoryEntry;
  });
}

// ─── Gateways ───────────────────────────────────────────
// NOTE: gateways.ts's own getGateways/addGateway/deleteGateway must stay on
// the client SDK — they're called directly from the /gateways dashboard
// page. Separate Admin-SDK copies below for the three routes that never
// touch the client (/api/gateways, .../select, .../[id]/metrics).

const GATEWAY_COLLECTION = "gateways";

async function getGatewaysAdmin(orgId: string): Promise<Gateway[]> {
  const snap = await adminDb().collection(GATEWAY_COLLECTION).where("orgId", "==", orgId).get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id, orgId: data.orgId, name: data.name, url: data.url,
      status: data.status || "disconnected", apiKey: data.apiKey,
      agentsConnected: data.agentsConnected || 0,
      lastPing: data.lastPing?.toDate?.() || null,
      createdAt: data.createdAt?.toDate?.() || null,
      region: data.region,
      location: data.location,
      metrics: data.metrics,
      capacity: data.capacity,
      lastHeartbeat: data.lastHeartbeat?.toDate?.() || null,
    } as Gateway;
  });
}

async function updateGatewayAdmin(id: string, updates: Partial<Gateway>): Promise<void> {
  const { id: _id, createdAt, ...rest } = updates;
  await adminDb().collection(GATEWAY_COLLECTION).doc(id).update(rest);
}

export async function getAllGatewaysWithHealth(orgId: string): Promise<Gateway[]> {
  const gateways = await getGatewaysAdmin(orgId);

  const STALE_HEARTBEAT_MS = 5 * 60 * 1000; // 5 minutes
  const now = Date.now();

  return gateways.map((gateway) => {
    if (
      gateway.status === "connected" &&
      gateway.lastHeartbeat &&
      now - gateway.lastHeartbeat.getTime() > STALE_HEARTBEAT_MS
    ) {
      return { ...gateway, status: "error" as GatewayStatus };
    }
    return gateway;
  });
}

export async function selectGateway(
  orgId: string,
  userLat?: number,
  userLon?: number
): Promise<GatewaySelectionResult | null> {
  const gateways = await getGatewaysAdmin(orgId);

  const available = gateways.filter((g) => g.status === "connected" && g.lastHeartbeat);
  if (available.length === 0) return null;

  if (!userLat || !userLon) {
    const best = available.reduce((prev, curr) => {
      const prevScore = calculateGatewayScore(prev, 0);
      const currScore = calculateGatewayScore(curr, 0);
      return currScore > prevScore ? curr : prev;
    });

    return {
      gateway: best,
      distance: 0,
      score: calculateGatewayScore(best, 0),
      reason: "Selected based on health metrics (no location provided)",
    };
  }

  const scored = available.map((gateway) => {
    const gatewayLat = gateway.location?.latitude || REGION_LOCATIONS[gateway.region || "us-east"].lat;
    const gatewayLon = gateway.location?.longitude || REGION_LOCATIONS[gateway.region || "us-east"].lon;
    const distance = calculateDistance(userLat, userLon, gatewayLat, gatewayLon);
    const score = calculateGatewayScore(gateway, distance);

    return {
      gateway,
      distance,
      score,
      reason: `Distance: ${distance.toFixed(0)}km, Latency: ${gateway.metrics?.avgLatencyMs || 0}ms`,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

/** Update gateway metrics (called by gateway heartbeat) */
export async function updateGatewayMetrics(
  gatewayId: string,
  metrics: Gateway["metrics"],
  capacity?: Gateway["capacity"]
): Promise<void> {
  const updates: Partial<Gateway> = {
    metrics,
    lastHeartbeat: new Date(),
    status: "connected" as GatewayStatus,
  };

  if (capacity) {
    updates.capacity = capacity;
  }

  await updateGatewayAdmin(gatewayId, updates);
}

// ─── Marketplace / Skills ───────────────────────────────
// NOTE: skills.ts's own getAgentSkills/getModInstallations/etc. must stay on
// the client SDK — several are called directly from dashboard pages
// (agents/[id], market/*). Separate Admin-SDK copies below for the routes
// that never touch the client (mostly /api/v1/marketplace/*, /api/v1/mods,
// /api/v1/mod-installations, /api/v1/capabilities, /api/v1/agents/[id]/capabilities).

const SUBSCRIPTION_COLLECTION = "marketSubscriptions";
const COMMUNITY_COLLECTION = "communityMarketItems";
const MOD_INSTALL_COLLECTION = "modInstallations";
const AGENT_SKILLS_COLLECTION = "agentSkills";
const MARKETPLACE_AGENTS_COLLECTION = "marketplaceAgents";
const AGENT_RATINGS_COLLECTION = "agentRatings";
const COMMUNITY_RATINGS_COLLECTION = "communityItemRatings";

async function getOrgSubscriptions(orgId: string): Promise<MarketSubscription[]> {
  const snap = await adminDb()
    .collection(SUBSCRIPTION_COLLECTION)
    .where("orgId", "==", orgId)
    .where("status", "==", "active")
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      orgId: data.orgId,
      itemId: data.itemId,
      plan: data.plan,
      status: data.status,
      subscribedBy: data.subscribedBy,
      startDate: data.startDate?.toDate?.() || null,
      endDate: data.endDate?.toDate?.() || null,
    } as MarketSubscription;
  });
}

export async function subscribeToItem(
  orgId: string,
  itemId: string,
  plan: SubscriptionPlan,
  subscribedBy: string,
): Promise<string> {
  const now = new Date();
  let endDate: Date | null = null;
  if (plan === "monthly") {
    endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() + 1);
  } else if (plan === "yearly") {
    endDate = new Date(now);
    endDate.setFullYear(endDate.getFullYear() + 1);
  }

  const ref = await adminDb().collection(SUBSCRIPTION_COLLECTION).add({
    orgId,
    itemId,
    plan,
    status: "active",
    subscribedBy,
    startDate: FieldValue.serverTimestamp(),
    endDate: endDate ?? null,
  });
  return ref.id;
}

export async function submitMarketItem(
  data: Omit<CommunityMarketItem, "id" | "submittedAt" | "status">,
  overrides?: { status?: CommunityMarketItem["status"]; stage?: CommunityMarketItem["stage"] },
): Promise<string> {
  const ref = await adminDb().collection(COMMUNITY_COLLECTION).add({
    ...data,
    pricing: data.pricing ?? { model: "free" },
    status: overrides?.status ?? "pending",
    stage: overrides?.stage ?? data.stage ?? "intake",
    publicationStatus: "live",
    reportCount: 0,
    submittedAt: FieldValue.serverTimestamp(),
    lastActiveAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getUserSubmissions(walletAddress: string): Promise<CommunityMarketItem[]> {
  const snap = await adminDb().collection(COMMUNITY_COLLECTION).where("submittedBy", "==", walletAddress).get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      pricing: data.pricing ?? { model: "free" },
      submittedAt: data.submittedAt?.toDate?.() || null,
    } as CommunityMarketItem;
  });
}

export async function getModInstallations(orgId: string): Promise<ModInstallation[]> {
  const snap = await adminDb().collection(MOD_INSTALL_COLLECTION).where("orgId", "==", orgId).get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      modId: data.modId,
      orgId: data.orgId,
      enabled: data.enabled ?? true,
      enabledCapabilities: data.enabledCapabilities ?? [],
      config: data.config ?? {},
      installedBy: data.installedBy,
      installedAt: data.installedAt?.toDate?.() || null,
    } as ModInstallation;
  });
}

async function getAgentSkillsAdmin(agentId: string): Promise<AgentSkill[]> {
  const snap = await adminDb().collection(AGENT_SKILLS_COLLECTION).where("agentId", "==", agentId).get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      agentId: data.agentId,
      skillId: data.skillId,
      orgId: data.orgId,
      installedAt: data.installedAt?.toDate?.() || null,
      installedBy: data.installedBy,
    } as AgentSkill;
  });
}

/** Resolve all capabilities available to a specific agent (mods + legacy skill assignments). */
export async function getAgentCapabilities(
  agentId: string,
  orgId: string,
): Promise<ResolvedCapability[]> {
  const [installations, agentAssignments, subscriptions] = await Promise.all([
    getModInstallations(orgId),
    getAgentSkillsAdmin(agentId),
    getOrgSubscriptions(orgId),
  ]);

  const enabledInstalls = installations.filter((i) => i.enabled);
  const assignedSkillIds = new Set(agentAssignments.map((a) => a.skillId));

  const expiredModIds = new Set<string>();
  for (const install of enabledInstalls) {
    const mod = MOD_REGISTRY.find((m) => m.id === install.modId);
    if (mod?.pricing?.model === "subscription") {
      const sub = subscriptions.find(
        (s) => s.itemId === install.modId || s.itemId === mod.legacySkillId,
      );
      if (!sub || !isSubscriptionActive(sub)) {
        expiredModIds.add(install.modId);
      }
    }
  }

  const capabilityIds = new Set<string>();
  for (const install of enabledInstalls) {
    if (expiredModIds.has(install.modId)) continue;
    for (const capId of install.enabledCapabilities) {
      capabilityIds.add(capId);
    }
  }
  for (const skillId of assignedSkillIds) {
    capabilityIds.add(skillId);
  }

  const resolved: ResolvedCapability[] = [];
  for (const capId of capabilityIds) {
    const cap = CAPABILITY_REGISTRY.find((c) => c.id === capId);
    if (!cap) continue;

    const mod = MOD_REGISTRY.find((m) => m.id === cap.modId);
    resolved.push({
      key: cap.key,
      name: cap.name,
      description: cap.description,
      type: cap.type,
      modId: cap.modId,
      modName: mod?.name ?? "Unknown",
      permissionScopes: cap.permissionScopes,
    });
  }

  return resolved;
}

export async function publishAgentPackage(
  pkg: Omit<AgentPackage, "id" | "publishedAt" | "updatedAt" | "installCount" | "rentalCount" | "hireCount" | "avgRating" | "ratingCount" | "status">,
): Promise<string> {
  const ref = await adminDb().collection(MARKETPLACE_AGENTS_COLLECTION).add({
    ...pkg,
    status: "review",
    installCount: 0,
    rentalCount: 0,
    hireCount: 0,
    avgRating: 0,
    ratingCount: 0,
    publishedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getCreatorPackages(walletAddress: string): Promise<AgentPackage[]> {
  const snap = await adminDb().collection(MARKETPLACE_AGENTS_COLLECTION).where("authorWallet", "==", walletAddress).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as AgentPackage));
}

async function getAgentRatingsAdmin(packageId: string): Promise<AgentRating[]> {
  const snap = await adminDb().collection(AGENT_RATINGS_COLLECTION).where("packageId", "==", packageId).get();
  return snap.docs.map((d) => {
    const data = d.data();
    return { id: d.id, ...data, createdAt: data.createdAt?.toDate?.() || null } as AgentRating;
  });
}

async function recalcAgentRatingAdmin(packageId: string): Promise<void> {
  const ratings = await getAgentRatingsAdmin(packageId);
  const count = ratings.length;
  const avg = count > 0 ? ratings.reduce((s, r) => s + r.rating, 0) / count : 0;
  await adminDb().collection(MARKETPLACE_AGENTS_COLLECTION).doc(packageId).update({
    avgRating: Math.round(avg * 10) / 10,
    ratingCount: count,
  });
}

export async function submitAgentRating(
  packageId: string,
  orgId: string,
  reviewerWallet: string,
  rating: number,
  review?: string,
): Promise<string> {
  const ref = await adminDb().collection(AGENT_RATINGS_COLLECTION).add({
    packageId,
    orgId,
    reviewerWallet,
    rating: Math.max(1, Math.min(5, rating)),
    review: review?.slice(0, 500) || null,
    createdAt: FieldValue.serverTimestamp(),
  });
  await recalcAgentRatingAdmin(packageId);
  return ref.id;
}

async function getCommunityItemRatingsAdmin(itemId: string): Promise<CommunityItemRating[]> {
  const snap = await adminDb().collection(COMMUNITY_RATINGS_COLLECTION).where("itemId", "==", itemId).get();
  return snap.docs.map((d) => {
    const data = d.data();
    return { id: d.id, ...data, createdAt: data.createdAt?.toDate?.() || null } as CommunityItemRating;
  });
}

async function recalcCommunityItemRatingAdmin(itemId: string): Promise<void> {
  const ratings = await getCommunityItemRatingsAdmin(itemId);
  const count = ratings.length;
  const avg = count > 0 ? ratings.reduce((s, r) => s + r.rating, 0) / count : 0;
  await adminDb().collection(COMMUNITY_COLLECTION).doc(itemId).update({
    avgRating: Math.round(avg * 10) / 10,
    ratingCount: count,
  });
}

export async function submitCommunityItemRating(
  itemId: string,
  orgId: string,
  reviewerWallet: string,
  rating: number,
  review?: string,
): Promise<string> {
  const ref = await adminDb().collection(COMMUNITY_RATINGS_COLLECTION).add({
    itemId,
    orgId,
    reviewerWallet,
    rating: Math.max(1, Math.min(5, rating)),
    review: review?.slice(0, 500) || null,
    createdAt: FieldValue.serverTimestamp(),
  });
  await recalcCommunityItemRatingAdmin(itemId);
  return ref.id;
}

// ─── Organizations ──────────────────────────────────────

export async function getOrganization(orgId: string): Promise<Organization | null> {
  const snap = await adminDb().collection("organizations").doc(orgId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as Organization;
}

// ─── Agent invites ──────────────────────────────────────
// Org-admin-issued codes that resolve to a pre-configured agent identity
// (name/type/skills/greeting) for `agent-guild join --code <CODE>` — distinct
// from organizations.inviteCode, which only carries an org id for human
// wallet members self-joining via /api/v1/orgs/join.

export interface AgentInvite {
  id: string;
  code: string;
  orgId: string;
  orgName: string;
  agentName: string;
  agentType: string;
  skills: { id: string; name: string; type: "skill" | "plugin"; version?: string }[];
  greeting?: string;
  createdBy: string;
  createdAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
}

export async function createAgentInvite(
  data: Omit<AgentInvite, "id" | "createdAt">,
): Promise<string> {
  const ref = await adminDb().collection("agentInvites").add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getAgentInviteByCode(code: string): Promise<AgentInvite | null> {
  const snap = await adminDb()
    .collection("agentInvites")
    .where("code", "==", code.toUpperCase())
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() } as AgentInvite;
}

// ─── Agents ─────────────────────────────────────────────

export async function getAgent(agentId: string): Promise<Agent | null> {
  const snap = await adminDb().collection("agents").doc(agentId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as Agent;
}

export async function getAgentsByOrg(orgId: string): Promise<Agent[]> {
  const snap = await adminDb().collection("agents").where("orgId", "==", orgId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Agent));
}

export async function updateAgent(agentId: string, data: Partial<Agent>): Promise<void> {
  await adminDb().collection("agents").doc(agentId).update(data);
}

// ─── Projects ───────────────────────────────────────────

export async function getProjectsByOrg(orgId: string): Promise<Project[]> {
  const snap = await adminDb().collection("projects").where("orgId", "==", orgId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Project));
}

// ─── Tasks ──────────────────────────────────────────────

export async function getTasksByOrg(orgId: string): Promise<Task[]> {
  const snap = await adminDb().collection("tasks").where("orgId", "==", orgId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Task));
}

// ─── Jobs ───────────────────────────────────────────────

export async function getJobsByOrg(orgId: string): Promise<Job[]> {
  const snap = await adminDb().collection("jobs").where("orgId", "==", orgId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Job));
}

// ─── Channels ───────────────────────────────────────────

export async function getChannelsByOrg(orgId: string): Promise<Channel[]> {
  const snap = await adminDb().collection("channels").where("orgId", "==", orgId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Channel));
}

export async function createChannel(data: Omit<Channel, "id">): Promise<string> {
  const ref = await adminDb().collection("channels").add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

const AGENT_GROUP_CHAT_NAME = "Agent Hub";

/** Ensure the org-wide agent group chat channel exists (deduplicates if race created extras) */
export async function ensureAgentGroupChat(orgId: string): Promise<Channel> {
  const snap = await adminDb()
    .collection("channels")
    .where("orgId", "==", orgId)
    .where("name", "==", AGENT_GROUP_CHAT_NAME)
    .get();

  if (!snap.empty) {
    const primary = snap.docs[0];
    if (snap.docs.length > 1) {
      const extras = snap.docs.slice(1);
      await Promise.all(extras.map((d) => adminDb().collection("channels").doc(d.id).delete()));
    }
    return { id: primary.id, ...primary.data() } as Channel;
  }

  const id = await createChannel({
    orgId,
    name: AGENT_GROUP_CHAT_NAME,
    createdAt: new Date(),
  });

  return { id, orgId, name: AGENT_GROUP_CHAT_NAME, createdAt: new Date() };
}

// ─── Messages ───────────────────────────────────────────

export async function sendMessage(data: Omit<Message, "id">): Promise<string> {
  const { createdAt: _ca, ...rest } = data;
  const ref = await adminDb().collection("messages").add({
    ...rest,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

// ─── Agent Communications ───────────────────────────────

export async function sendAgentComm(data: Omit<AgentComm, "id">): Promise<string> {
  const { createdAt: _ca, ...rest } = data;
  const ref = await adminDb().collection("agentComms").add({
    ...rest,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

// ─── Platform Data (full org visibility for agents) ─────

export async function getPlatformSnapshot(orgId: string) {
  const [agents, projects, tasks, jobs, channels] = await Promise.all([
    getAgentsByOrg(orgId),
    getProjectsByOrg(orgId),
    getTasksByOrg(orgId),
    getJobsByOrg(orgId),
    getChannelsByOrg(orgId),
  ]);

  return {
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      status: a.status,
      capabilities: a.capabilities,
      projectIds: a.projectIds,
      reportedSkills: a.reportedSkills ?? [],
      bio: a.bio ?? "",
    })),
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      agentIds: p.agentIds,
    })),
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assigneeAgentId: t.assigneeAgentId,
      projectId: t.projectId,
    })),
    jobs: jobs.map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      priority: j.priority,
      takenByAgentId: j.takenByAgentId,
      reward: j.reward,
      requiredSkills: j.requiredSkills,
    })),
    channels: channels.map((c) => ({
      id: c.id,
      name: c.name,
      projectId: c.projectId,
    })),
    timestamp: Date.now(),
  };
}

/** Agent check-in: posts a status message to the agent group chat, stores reported skills/bio, and logs an AgentComm */
export async function agentCheckIn(
  agent: Agent,
  orgId: string,
  reportedSkills?: ReportedSkill[],
  bio?: string,
): Promise<void> {
  const hub = await ensureAgentGroupChat(orgId);

  // Store reported skills and bio on the agent document if provided
  const updates: Record<string, unknown> = {};
  if (reportedSkills && reportedSkills.length > 0) updates.reportedSkills = reportedSkills;
  if (bio) updates.bio = bio;
  if (Object.keys(updates).length > 0) {
    await updateAgent(agent.id, updates as Partial<Agent>);
  }

  // Build skill summary for the check-in message
  const skillNames = (reportedSkills ?? agent.reportedSkills ?? []).map((s) => s.name);
  const skillSuffix = skillNames.length > 0
    ? ` | Skills: ${skillNames.join(", ")}`
    : "";

  // Post to group chat channel
  await sendMessage({
    channelId: hub.id,
    senderId: agent.id,
    senderName: agent.name,
    senderType: "agent",
    content: `🟢 **${agent.name}** (${agent.type}) is now online and listening.${skillSuffix}`,
    orgId,
    createdAt: new Date(),
  });

  // Also log to agent comms feed
  await sendAgentComm({
    orgId,
    fromAgentId: agent.id,
    fromAgentName: agent.name,
    toAgentId: "group",
    toAgentName: AGENT_GROUP_CHAT_NAME,
    type: "status",
    content: `${agent.name} checked in — online and ready`,
    metadata: {
      event: "check_in",
      agentType: agent.type,
      reportedSkills: reportedSkills ?? agent.reportedSkills ?? [],
    },
    createdAt: new Date(),
  });
}
