/**
 * Swarm Compute — Firestore CRUD
 *
 * All Firestore operations for compute collections.
 * Follows the same patterns as src/lib/firestore.ts.
 */

import { adminDb } from "../firebase-admin";
import { FieldValue, Timestamp, type Query } from "firebase-admin/firestore";
import type {
  Workspace,
  Computer,
  ComputerSnapshot,
  ComputerSession,
  ComputerAction,
  ComputeFile,
  ComputeTemplate,
  MemoryEntry,
  EmbedToken,
  UsageRecord,
  BillingLedgerEntry,
  PricingSettings,
  ComputeEntitlement,
  ComputerTransfer,
  ComputerStatus,
  TemplateCategory,
  MemoryScopeType,
  SizeKey,
  Region,
  TransferStatus,
  OpenClawVariant,
  GraphEdge,
  GraphEntityRef,
} from "./types";
import { TRANSFER_FEE_PERCENT } from "./types";

// ═══════════════════════════════════════════════════════════════
// Collection Names
// ═══════════════════════════════════════════════════════════════

const COLLECTIONS = {
  workspaces: "computeWorkspaces",
  members: "computeWorkspaceMembers",
  computers: "computeComputers",
  snapshots: "computeSnapshots",
  sessions: "computeSessions",
  actions: "computeActions",
  files: "computeFiles",
  templates: "computeTemplates",
  memory: "computeMemory",
  embedTokens: "computeEmbedTokens",
  usage: "computeUsage",
  billingLedger: "computeBillingLedger",
  pricingSettings: "computePricingSettings",
  entitlements: "computeEntitlements",
  transfers: "computeTransfers",
  graphEdges: "graphEdges",
} as const;

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function toDate(val: unknown): Date | null {
  if (!val) return null;
  if (val instanceof Timestamp) return val.toDate();
  if (val instanceof Date) return val;
  // Duck-type Firestore Timestamp (instanceof can fail across bundle boundaries)
  if (typeof val === "object" && typeof (val as { toDate?: unknown }).toDate === "function") {
    return (val as { toDate(): Date }).toDate();
  }
  // Handle numeric timestamps or ISO strings
  if (typeof val === "number" || typeof val === "string") {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Workspaces
// ═══════════════════════════════════════════════════════════════

export async function createWorkspace(data: Omit<Workspace, "id" | "createdAt" | "updatedAt">): Promise<string> {
  const ref = await adminDb().collection(COLLECTIONS.workspaces).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const snap = await adminDb().collection(COLLECTIONS.workspaces).doc(id).get();
  if (!snap.exists) return null;
  const d = snap.data()!;
  return {
    id: snap.id,
    orgId: d.orgId,
    ownerUserId: d.ownerUserId,
    name: d.name,
    slug: d.slug,
    description: d.description || "",
    planTier: d.planTier || "free",
    defaultProvider: (d.defaultProvider as Workspace["defaultProvider"]) || "e2b",
    defaultAutoStopMinutes: d.defaultAutoStopMinutes ?? 30,
    allowedInstanceSizes: d.allowedInstanceSizes || ["small", "medium", "large", "xl"],
    staticIpEnabled: d.staticIpEnabled ?? false,
    createdAt: toDate(d.createdAt),
    updatedAt: toDate(d.updatedAt),
  };
}

export async function getWorkspaces(orgId: string): Promise<Workspace[]> {
  const snap = await adminDb().collection(COLLECTIONS.workspaces).where("orgId", "==", orgId).get();
  return snap.docs.map((s) => {
    const d = s.data();
    return {
      id: s.id,
      orgId: d.orgId,
      ownerUserId: d.ownerUserId,
      name: d.name,
      slug: d.slug,
      description: d.description || "",
      planTier: d.planTier || "free",
      defaultProvider: (d.defaultProvider as Workspace["defaultProvider"]) || "e2b",
      defaultAutoStopMinutes: d.defaultAutoStopMinutes ?? 30,
      allowedInstanceSizes: d.allowedInstanceSizes || ["small", "medium", "large", "xl"],
      staticIpEnabled: d.staticIpEnabled ?? false,
      createdAt: toDate(d.createdAt),
      updatedAt: toDate(d.updatedAt),
    };
  });
}

export async function updateWorkspace(id: string, data: Partial<Workspace>): Promise<void> {
  const { id: _id, ...rest } = data;
  await adminDb().collection(COLLECTIONS.workspaces).doc(id).update({
    ...rest,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  await adminDb().collection(COLLECTIONS.workspaces).doc(id).delete();
}

export function subscribeWorkspaces(orgId: string, cb: (workspaces: Workspace[]) => void): () => void {
  return adminDb().collection(COLLECTIONS.workspaces).where("orgId", "==", orgId).onSnapshot((snap) => {
    const items = snap.docs.map((s) => {
      const d = s.data();
      return {
        id: s.id,
        orgId: d.orgId,
        ownerUserId: d.ownerUserId,
        name: d.name,
        slug: d.slug,
        description: d.description || "",
        planTier: d.planTier || "free",
        defaultProvider: (d.defaultProvider as Workspace["defaultProvider"]) || "e2b",
        defaultAutoStopMinutes: d.defaultAutoStopMinutes ?? 30,
        allowedInstanceSizes: d.allowedInstanceSizes || ["small", "medium", "large", "xl"],
        staticIpEnabled: d.staticIpEnabled ?? false,
        createdAt: toDate(d.createdAt),
        updatedAt: toDate(d.updatedAt),
      };
    });
    cb(items);
  });
}

// ═══════════════════════════════════════════════════════════════
// Computers
// ═══════════════════════════════════════════════════════════════

function parseComputer(id: string, d: Record<string, unknown>): Computer {
  return {
    id,
    workspaceId: d.workspaceId as string,
    orgId: d.orgId as string,
    name: d.name as string,
    status: (d.status as ComputerStatus) || "stopped",
    provider: (d.provider as Computer["provider"]) || "e2b",
    providerInstanceId: (d.providerInstanceId as string) || null,
    providerInstanceType: (d.providerInstanceType as string) || null,
    providerRegion: (d.providerRegion as string) || null,
    providerImage: (d.providerImage as string) || null,
    providerMetadata: (d.providerMetadata as Record<string, unknown>) || {},
    templateId: (d.templateId as string) || null,
    sizeKey: (d.sizeKey as Computer["sizeKey"]) || "small",
    cpuCores: (d.cpuCores as number) || 2,
    ramMb: (d.ramMb as number) || 4096,
    diskGb: (d.diskGb as number) || 20,
    resolutionWidth: (d.resolutionWidth as number) || 1280,
    resolutionHeight: (d.resolutionHeight as number) || 720,
    region: (d.region as Computer["region"]) || "us-east",
    persistenceEnabled: (d.persistenceEnabled as boolean) ?? true,
    staticIpEnabled: (d.staticIpEnabled as boolean) ?? false,
    autoStopMinutes: (d.autoStopMinutes as number) ?? 30,
    controllerType: (d.controllerType as Computer["controllerType"]) || "human",
    modelKey: (d.modelKey as Computer["modelKey"]) || null,
    openclawVariant: (d.openclawVariant as OpenClawVariant) || null,
    ownerWallet: (d.ownerWallet as string) || (d.createdByUserId as string) || "",
    ownerOrgId: (d.ownerOrgId as string) || (d.orgId as string) || "",
    transferable: (d.transferable as boolean) ?? true,
    listedForSale: (d.listedForSale as boolean) ?? false,
    listingPriceCents: (d.listingPriceCents as number) ?? null,
    listingDescription: (d.listingDescription as string) || null,
    createdByUserId: (d.createdByUserId as string) || "",
    createdAt: toDate(d.createdAt),
    updatedAt: toDate(d.updatedAt),
    lastActiveAt: toDate(d.lastActiveAt),
  };
}

export async function createComputer(data: Omit<Computer, "id" | "createdAt" | "updatedAt" | "lastActiveAt">): Promise<string> {
  const ref = await adminDb().collection(COLLECTIONS.computers).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    lastActiveAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getComputer(id: string): Promise<Computer | null> {
  const snap = await adminDb().collection(COLLECTIONS.computers).doc(id).get();
  if (!snap.exists) return null;
  return parseComputer(snap.id, snap.data()!);
}

export async function getComputers(orgId: string, filters?: { status?: ComputerStatus; workspaceId?: string }): Promise<Computer[]> {
  let q: Query = adminDb().collection(COLLECTIONS.computers).where("orgId", "==", orgId);
  if (filters?.workspaceId) {
    q = q.where("workspaceId", "==", filters.workspaceId);
  }
  const snap = await q.get();
  let items = snap.docs.map((s) => parseComputer(s.id, s.data()));
  if (filters?.status) {
    items = items.filter((c) => c.status === filters.status);
  }
  return items;
}

export async function getComputersByWorkspace(workspaceId: string): Promise<Computer[]> {
  const snap = await adminDb().collection(COLLECTIONS.computers).where("workspaceId", "==", workspaceId).get();
  return snap.docs.map((s) => parseComputer(s.id, s.data()));
}

export async function updateComputer(id: string, data: Partial<Computer>): Promise<void> {
  const { id: _id, ...rest } = data;
  await adminDb().collection(COLLECTIONS.computers).doc(id).update({
    ...rest,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function deleteComputer(id: string): Promise<void> {
  await adminDb().collection(COLLECTIONS.computers).doc(id).delete();
}

export function subscribeComputers(orgId: string, cb: (computers: Computer[]) => void): () => void {
  return adminDb().collection(COLLECTIONS.computers).where("orgId", "==", orgId).onSnapshot((snap) => {
    cb(snap.docs.map((s) => parseComputer(s.id, s.data())));
  });
}

// ═══════════════════════════════════════════════════════════════
// Snapshots
// ═══════════════════════════════════════════════════════════════

export async function createSnapshot(data: Omit<ComputerSnapshot, "id" | "createdAt">): Promise<string> {
  const ref = await adminDb().collection(COLLECTIONS.snapshots).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getSnapshots(computerId: string): Promise<ComputerSnapshot[]> {
  const snap = await adminDb().collection(COLLECTIONS.snapshots).where("computerId", "==", computerId).get();
  return snap.docs.map((s) => {
    const d = s.data();
    return {
      id: s.id,
      computerId: d.computerId,
      providerSnapshotId: d.providerSnapshotId,
      label: d.label || "",
      createdAt: toDate(d.createdAt),
    };
  });
}

// ═══════════════════════════════════════════════════════════════
// Sessions
// ═══════════════════════════════════════════════════════════════

function parseSession(id: string, d: Record<string, unknown>): ComputerSession {
  return {
    id,
    computerId: d.computerId as string,
    workspaceId: d.workspaceId as string,
    controllerType: (d.controllerType as ComputerSession["controllerType"]) || "human",
    userId: (d.userId as string) || null,
    modelKey: (d.modelKey as ComputerSession["modelKey"]) || null,
    startedAt: toDate(d.startedAt),
    endedAt: toDate(d.endedAt),
    totalActions: (d.totalActions as number) || 0,
    totalScreenshots: (d.totalScreenshots as number) || 0,
    recordingUrl: (d.recordingUrl as string) || null,
    estimatedCostCents: (d.estimatedCostCents as number) || 0,
  };
}

export async function createSession(data: Omit<ComputerSession, "id" | "startedAt" | "endedAt" | "totalActions" | "totalScreenshots" | "estimatedCostCents">): Promise<string> {
  const ref = await adminDb().collection(COLLECTIONS.sessions).add({
    ...data,
    startedAt: FieldValue.serverTimestamp(),
    endedAt: null,
    totalActions: 0,
    totalScreenshots: 0,
    estimatedCostCents: 0,
  });
  return ref.id;
}

export async function getSession(id: string): Promise<ComputerSession | null> {
  const snap = await adminDb().collection(COLLECTIONS.sessions).doc(id).get();
  if (!snap.exists) return null;
  return parseSession(snap.id, snap.data()!);
}

export async function getSessions(opts: { computerId?: string; workspaceId?: string; limit?: number }): Promise<ComputerSession[]> {
  let q: Query = adminDb().collection(COLLECTIONS.sessions);
  if (opts.computerId) q = q.where("computerId", "==", opts.computerId);
  if (opts.workspaceId) q = q.where("workspaceId", "==", opts.workspaceId);
  const snap = await q.get();
  const items = snap.docs.map((s) => parseSession(s.id, s.data()));
  items.sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
  return items.slice(0, opts.limit || 50);
}

export async function endSession(id: string, stats: { totalActions: number; totalScreenshots: number; estimatedCostCents: number }): Promise<void> {
  await adminDb().collection(COLLECTIONS.sessions).doc(id).update({
    endedAt: FieldValue.serverTimestamp(),
    ...stats,
  });
}

// ═══════════════════════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════════════════════

export async function recordAction(data: Omit<ComputerAction, "id" | "createdAt">): Promise<string> {
  const ref = await adminDb().collection(COLLECTIONS.actions).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getActions(sessionId: string, max?: number): Promise<ComputerAction[]> {
  const snap = await adminDb().collection(COLLECTIONS.actions).where("sessionId", "==", sessionId).get();
  const items = snap.docs.map((s) => {
    const d = s.data();
    return {
      id: s.id,
      sessionId: d.sessionId,
      computerId: d.computerId,
      actionType: d.actionType,
      payload: d.payload || {},
      result: d.result || null,
      status: d.status || "pending",
      createdAt: toDate(d.createdAt),
    };
  });
  items.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return items.slice(0, max || 100);
}

export async function updateAction(id: string, data: Partial<ComputerAction>): Promise<void> {
  const { id: _id, ...rest } = data;
  await adminDb().collection(COLLECTIONS.actions).doc(id).update(rest);
}

// ═══════════════════════════════════════════════════════════════
// Files
// ═══════════════════════════════════════════════════════════════

export async function createFileRecord(data: Omit<ComputeFile, "id" | "createdAt">): Promise<string> {
  const ref = await adminDb().collection(COLLECTIONS.files).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getFiles(workspaceId: string, computerId?: string): Promise<ComputeFile[]> {
  let q: Query = adminDb().collection(COLLECTIONS.files).where("workspaceId", "==", workspaceId);
  if (computerId) q = q.where("computerId", "==", computerId);
  const snap = await q.get();
  const items = snap.docs.map((s) => {
    const d = s.data();
    return {
      id: s.id,
      workspaceId: d.workspaceId,
      computerId: d.computerId || null,
      uploaderUserId: d.uploaderUserId,
      storageKey: d.storageKey,
      filename: d.filename,
      mimeType: d.mimeType || "application/octet-stream",
      sizeBytes: d.sizeBytes || 0,
      visibility: d.visibility || "private",
      provenanceType: d.provenanceType || "upload",
      createdAt: toDate(d.createdAt),
    };
  });
  items.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return items;
}

export async function deleteFileRecord(id: string): Promise<void> {
  await adminDb().collection(COLLECTIONS.files).doc(id).delete();
}

// ═══════════════════════════════════════════════════════════════
// Templates
// ═══════════════════════════════════════════════════════════════

function parseTemplate(id: string, d: Record<string, unknown>): ComputeTemplate {
  return {
    id,
    workspaceId: (d.workspaceId as string) || null,
    creatorUserId: d.creatorUserId as string,
    name: d.name as string,
    slug: (d.slug as string) || "",
    description: (d.description as string) || "",
    category: (d.category as TemplateCategory) || "dev",
    baseImage: (d.baseImage as string) || "ubuntu:22.04",
    installManifest: (d.installManifest as Record<string, unknown>) || {},
    startupScript: (d.startupScript as string) || "",
    requiredSecrets: (d.requiredSecrets as string[]) || [],
    recommendedModels: (d.recommendedModels as ComputeTemplate["recommendedModels"]) || [],
    isPublic: (d.isPublic as boolean) ?? false,
    paidModReady: (d.paidModReady as boolean) ?? false,
    futurePriceCents: (d.futurePriceCents as number) ?? null,
    createdAt: toDate(d.createdAt),
    updatedAt: toDate(d.updatedAt),
  };
}

export async function createTemplate(data: Omit<ComputeTemplate, "id" | "createdAt" | "updatedAt">): Promise<string> {
  const ref = await adminDb().collection(COLLECTIONS.templates).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getTemplate(id: string): Promise<ComputeTemplate | null> {
  const snap = await adminDb().collection(COLLECTIONS.templates).doc(id).get();
  if (!snap.exists) return null;
  return parseTemplate(snap.id, snap.data()!);
}

export async function getTemplates(opts?: { workspaceId?: string; category?: TemplateCategory; isPublic?: boolean }): Promise<ComputeTemplate[]> {
  let q: Query = adminDb().collection(COLLECTIONS.templates);
  if (opts?.workspaceId) q = q.where("workspaceId", "==", opts.workspaceId);
  if (opts?.category) q = q.where("category", "==", opts.category);
  if (opts?.isPublic !== undefined) q = q.where("isPublic", "==", opts.isPublic);
  const snap = await q.get();
  return snap.docs.map((s) => parseTemplate(s.id, s.data()));
}

export async function updateTemplate(id: string, data: Partial<ComputeTemplate>): Promise<void> {
  const { id: _id, ...rest } = data;
  await adminDb().collection(COLLECTIONS.templates).doc(id).update({
    ...rest,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function deleteTemplate(id: string): Promise<void> {
  await adminDb().collection(COLLECTIONS.templates).doc(id).delete();
}

// ═══════════════════════════════════════════════════════════════
// Memory
// ═══════════════════════════════════════════════════════════════

function parseMemory(id: string, d: Record<string, unknown>): MemoryEntry {
  return {
    id,
    scopeType: (d.scopeType as MemoryScopeType) || "workspace",
    scopeId: d.scopeId as string,
    workspaceId: (d.workspaceId as string) || null,
    computerId: (d.computerId as string) || null,
    agentId: (d.agentId as string) || null,
    createdByUserId: (d.createdByUserId as string) || null,
    content: (d.content as string) || "",
    embeddingRef: (d.embeddingRef as string) || null,
    embedding: (Array.isArray(d.embedding) ? (d.embedding as number[]) : null),
    tags: (d.tags as string[]) || [],
    pinned: (d.pinned as boolean) ?? false,
    createdAt: toDate(d.createdAt),
    updatedAt: toDate(d.updatedAt),
  };
}

export async function createMemoryEntry(data: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<string> {
  const ref = await adminDb().collection(COLLECTIONS.memory).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getMemoryEntries(scopeType: MemoryScopeType, scopeId: string, opts?: { pinned?: boolean; limit?: number }): Promise<MemoryEntry[]> {
  let q: Query = adminDb()
    .collection(COLLECTIONS.memory)
    .where("scopeType", "==", scopeType)
    .where("scopeId", "==", scopeId);
  if (opts?.pinned !== undefined) q = q.where("pinned", "==", opts.pinned);
  const snap = await q.get();
  const items = snap.docs.map((s) => parseMemory(s.id, s.data()));
  items.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return items.slice(0, opts?.limit || 100);
}

export async function updateMemoryEntry(id: string, data: Partial<MemoryEntry>): Promise<void> {
  const { id: _id, ...rest } = data;
  await adminDb().collection(COLLECTIONS.memory).doc(id).update({
    ...rest,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function deleteMemoryEntry(id: string): Promise<void> {
  await adminDb().collection(COLLECTIONS.memory).doc(id).delete();
}

// ═══════════════════════════════════════════════════════════════
// Knowledge Graph — memory/agent/task/project edges (types.ts's
// GraphEdge doc comment; PRD §139 — no graph DB, plain Firestore docs)
// ═══════════════════════════════════════════════════════════════

function parseGraphEdge(id: string, d: FirebaseFirestore.DocumentData): GraphEdge {
  return {
    id,
    orgId: d.orgId as string,
    from: d.from as GraphEntityRef,
    to: d.to as GraphEntityRef,
    relation: (d.relation as string) || "",
    createdBy: (d.createdBy as GraphEntityRef) || null,
    createdAt: toDate(d.createdAt),
  };
}

export async function createGraphEdge(
  data: Omit<GraphEdge, "id" | "createdAt">,
): Promise<string> {
  const ref = await adminDb().collection(COLLECTIONS.graphEdges).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/** Edges where `entity` is either endpoint, newest first. Two queries
 *  (Firestore has no OR-across-fields) merged and deduped by id — fine at
 *  this collection's expected size; revisit only if it becomes a hot path. */
export async function getGraphEdgesForEntity(
  orgId: string,
  entity: GraphEntityRef,
  opts?: { relation?: string; limit?: number },
): Promise<GraphEdge[]> {
  const base = adminDb().collection(COLLECTIONS.graphEdges).where("orgId", "==", orgId);
  let fromQ: Query = base.where("from.type", "==", entity.type).where("from.id", "==", entity.id);
  let toQ: Query = base.where("to.type", "==", entity.type).where("to.id", "==", entity.id);
  if (opts?.relation) {
    fromQ = fromQ.where("relation", "==", opts.relation);
    toQ = toQ.where("relation", "==", opts.relation);
  }
  const [fromSnap, toSnap] = await Promise.all([fromQ.get(), toQ.get()]);
  const byId = new Map<string, GraphEdge>();
  for (const s of [...fromSnap.docs, ...toSnap.docs]) {
    byId.set(s.id, parseGraphEdge(s.id, s.data()));
  }
  const edges = [...byId.values()];
  edges.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return edges.slice(0, opts?.limit || 100);
}

export async function deleteGraphEdge(id: string): Promise<void> {
  await adminDb().collection(COLLECTIONS.graphEdges).doc(id).delete();
}

// ═══════════════════════════════════════════════════════════════
// Embed Tokens
// ═══════════════════════════════════════════════════════════════

export async function createEmbedToken(data: Omit<EmbedToken, "id" | "createdAt">): Promise<string> {
  const ref = await adminDb().collection(COLLECTIONS.embedTokens).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getEmbedTokens(workspaceId: string): Promise<EmbedToken[]> {
  const snap = await adminDb().collection(COLLECTIONS.embedTokens).where("workspaceId", "==", workspaceId).get();
  return snap.docs.map((s) => {
    const d = s.data();
    return {
      id: s.id,
      workspaceId: d.workspaceId,
      computerId: d.computerId,
      mode: d.mode || "read_only",
      allowedOrigins: d.allowedOrigins || [],
      expiresAt: toDate(d.expiresAt),
      createdByUserId: d.createdByUserId,
      createdAt: toDate(d.createdAt),
    };
  });
}

export async function deleteEmbedToken(id: string): Promise<void> {
  await adminDb().collection(COLLECTIONS.embedTokens).doc(id).delete();
}

export async function validateEmbedToken(id: string): Promise<EmbedToken | null> {
  const snap = await adminDb().collection(COLLECTIONS.embedTokens).doc(id).get();
  if (!snap.exists) return null;
  const d = snap.data()!;
  const token: EmbedToken = {
    id: snap.id,
    workspaceId: d.workspaceId,
    computerId: d.computerId,
    mode: d.mode || "read_only",
    allowedOrigins: d.allowedOrigins || [],
    expiresAt: toDate(d.expiresAt),
    createdByUserId: d.createdByUserId,
    createdAt: toDate(d.createdAt),
  };
  if (token.expiresAt && token.expiresAt.getTime() < Date.now()) return null;
  return token;
}

// ═══════════════════════════════════════════════════════════════
// Usage
// ═══════════════════════════════════════════════════════════════

export async function recordUsage(data: Omit<UsageRecord, "id" | "createdAt">): Promise<string> {
  const ref = await adminDb().collection(COLLECTIONS.usage).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getUsage(workspaceId: string, opts?: { limit?: number }): Promise<UsageRecord[]> {
  const snap = await adminDb().collection(COLLECTIONS.usage).where("workspaceId", "==", workspaceId).get();
  const items = snap.docs.map((s) => {
    const d = s.data();
    return {
      id: s.id,
      workspaceId: d.workspaceId,
      computerId: d.computerId || null,
      metricType: d.metricType,
      quantity: d.quantity || 0,
      periodStart: toDate(d.periodStart),
      periodEnd: toDate(d.periodEnd),
      estimatedCostCents: d.estimatedCostCents || 0,
      createdAt: toDate(d.createdAt),
    };
  });
  items.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return items.slice(0, opts?.limit || 100);
}

// ═══════════════════════════════════════════════════════════════
// Billing Ledger
// ═══════════════════════════════════════════════════════════════

function parseLedgerEntry(id: string, d: Record<string, unknown>): BillingLedgerEntry {
  return {
    id,
    orgId: d.orgId as string,
    workspaceId: d.workspaceId as string,
    computerId: d.computerId as string,
    sessionId: (d.sessionId as string) || null,
    provider: (d.provider as string) || "stub",
    sizeKey: (d.sizeKey as SizeKey) || "small",
    region: (d.region as Region) || "us-east",
    unitType: d.unitType as BillingLedgerEntry["unitType"],
    quantity: (d.quantity as number) || 0,
    providerCostCents: (d.providerCostCents as number) || 0,
    markupPercent: (d.markupPercent as number) || 0,
    customerPriceCents: (d.customerPriceCents as number) || 0,
    platformProfitCents: (d.platformProfitCents as number) || 0,
    createdAt: toDate(d.createdAt),
  };
}

export async function createLedgerEntry(data: Omit<BillingLedgerEntry, "id" | "createdAt">): Promise<string> {
  const ref = await adminDb().collection(COLLECTIONS.billingLedger).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getLedgerEntries(opts?: {
  workspaceId?: string;
  orgId?: string;
  limit?: number;
}): Promise<BillingLedgerEntry[]> {
  let q: Query = adminDb().collection(COLLECTIONS.billingLedger);
  if (opts?.workspaceId) q = q.where("workspaceId", "==", opts.workspaceId);
  if (opts?.orgId) q = q.where("orgId", "==", opts.orgId);
  const snap = await q.get();
  const items = snap.docs.map((s) => parseLedgerEntry(s.id, s.data()));
  items.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return items.slice(0, opts?.limit || 500);
}

export async function getAllLedgerEntries(limit?: number): Promise<BillingLedgerEntry[]> {
  const snap = await adminDb().collection(COLLECTIONS.billingLedger).get();
  const items = snap.docs.map((s) => parseLedgerEntry(s.id, s.data()));
  items.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return items.slice(0, limit || 1000);
}

// ═══════════════════════════════════════════════════════════════
// Pricing Settings (singleton document)
// ═══════════════════════════════════════════════════════════════

const PRICING_DOC_ID = "global";

const DEFAULT_PRICING: Omit<PricingSettings, "id"> = {
  defaultMarkupPercent: 30,
  sizeOverrides: {},
  regionOverrides: {},
  providerOverrides: {},
  minimumPriceFloorCents: 1,
  promoOverride: null,
  updatedAt: null,
  updatedByUserId: null,
};

function parsePricingSettings(id: string, d: Record<string, unknown>): PricingSettings {
  return {
    id,
    defaultMarkupPercent: (d.defaultMarkupPercent as number) ?? 30,
    sizeOverrides: (d.sizeOverrides as Partial<Record<SizeKey, number>>) || {},
    regionOverrides: (d.regionOverrides as Partial<Record<Region, number>>) || {},
    providerOverrides: (d.providerOverrides as Record<string, number>) || {},
    minimumPriceFloorCents: (d.minimumPriceFloorCents as number) ?? 1,
    promoOverride: d.promoOverride
      ? {
          percent: (d.promoOverride as { percent: number; expiresAt: unknown }).percent,
          expiresAt: toDate((d.promoOverride as { expiresAt: unknown }).expiresAt),
        }
      : null,
    updatedAt: toDate(d.updatedAt),
    updatedByUserId: (d.updatedByUserId as string) || null,
  };
}

export async function getPricingSettings(): Promise<PricingSettings> {
  const snap = await adminDb().collection(COLLECTIONS.pricingSettings).doc(PRICING_DOC_ID).get();
  if (!snap.exists) {
    return { id: PRICING_DOC_ID, ...DEFAULT_PRICING };
  }
  return parsePricingSettings(snap.id, snap.data()!);
}

export async function updatePricingSettings(
  data: Partial<Omit<PricingSettings, "id">>,
  userId: string,
): Promise<void> {
  const ref = adminDb().collection(COLLECTIONS.pricingSettings).doc(PRICING_DOC_ID);
  const snap = await ref.get();
  const update = {
    ...data,
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUserId: userId,
  };

  if (snap.exists) {
    await ref.update(update);
  } else {
    await ref.set({ ...DEFAULT_PRICING, ...update });
  }
}

// ═══════════════════════════════════════════════════════════════
// Entitlements
// ═══════════════════════════════════════════════════════════════

function parseEntitlement(id: string, d: Record<string, unknown>): ComputeEntitlement {
  return {
    id,
    orgId: (d.orgId as string) || "",
    creditBalanceCents: (d.creditBalanceCents as number) || 0,
    monthlyHourQuota: (d.monthlyHourQuota as number) || 0,
    hoursUsedThisPeriod: (d.hoursUsedThisPeriod as number) || 0,
    maxConcurrentComputers: (d.maxConcurrentComputers as number) || 1,
    allowedSizes: (d.allowedSizes as SizeKey[]) || ["small"],
    planTier: (d.planTier as ComputeEntitlement["planTier"]) || "free",
    periodStart: toDate(d.periodStart),
    updatedAt: toDate(d.updatedAt),
  };
}

export async function getEntitlement(orgId: string): Promise<ComputeEntitlement | null> {
  const ref = adminDb().collection(COLLECTIONS.entitlements).doc(orgId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  return parseEntitlement(snap.id, snap.data() as Record<string, unknown>);
}

export async function upsertEntitlement(
  orgId: string,
  data: Partial<Omit<ComputeEntitlement, "id" | "orgId">>,
): Promise<void> {
  const ref = adminDb().collection(COLLECTIONS.entitlements).doc(orgId);
  const snap = await ref.get();

  if (snap.exists) {
    await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
  } else {
    await ref.set({
      orgId,
      creditBalanceCents: 0,
      monthlyHourQuota: 5,
      hoursUsedThisPeriod: 0,
      maxConcurrentComputers: 1,
      allowedSizes: ["small"],
      planTier: "free",
      periodStart: FieldValue.serverTimestamp(),
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
}

export async function deductCredits(orgId: string, amountCents: number): Promise<boolean> {
  const entitlement = await getEntitlement(orgId);
  if (!entitlement) return false;
  if (entitlement.creditBalanceCents < amountCents) return false;
  await upsertEntitlement(orgId, {
    creditBalanceCents: entitlement.creditBalanceCents - amountCents,
  });
  return true;
}

export async function addHoursUsed(orgId: string, hours: number): Promise<void> {
  const entitlement = await getEntitlement(orgId);
  if (!entitlement) return;
  await upsertEntitlement(orgId, {
    hoursUsedThisPeriod: entitlement.hoursUsedThisPeriod + hours,
  });
}

// ═══════════════════════════════════════════════════════════════
// Transfers — Ownership Transfer Records
// ═══════════════════════════════════════════════════════════════

function parseTransfer(id: string, d: Record<string, unknown>): ComputerTransfer {
  return {
    id,
    computerId: d.computerId as string,
    computerName: (d.computerName as string) || "",
    openclawVariant: (d.openclawVariant as OpenClawVariant) || null,
    fromWallet: d.fromWallet as string,
    fromOrgId: d.fromOrgId as string,
    toWallet: d.toWallet as string,
    toOrgId: d.toOrgId as string,
    priceCents: (d.priceCents as number) || 0,
    platformFeeCents: (d.platformFeeCents as number) || 0,
    status: (d.status as TransferStatus) || "pending",
    snapshotId: (d.snapshotId as string) || null,
    createdAt: toDate(d.createdAt),
    completedAt: toDate(d.completedAt),
  };
}

export async function createTransfer(
  data: Omit<ComputerTransfer, "id" | "createdAt" | "completedAt" | "platformFeeCents">,
): Promise<string> {
  const platformFeeCents = Math.ceil(data.priceCents * (TRANSFER_FEE_PERCENT / 100));
  const ref = await adminDb().collection(COLLECTIONS.transfers).add({
    ...data,
    platformFeeCents,
    createdAt: FieldValue.serverTimestamp(),
    completedAt: null,
  });
  return ref.id;
}

export async function getTransfer(id: string): Promise<ComputerTransfer | null> {
  const snap = await adminDb().collection(COLLECTIONS.transfers).doc(id).get();
  if (!snap.exists) return null;
  return parseTransfer(snap.id, snap.data()!);
}

export async function getTransfers(opts?: {
  computerId?: string;
  fromWallet?: string;
  toWallet?: string;
  status?: TransferStatus;
  limit?: number;
}): Promise<ComputerTransfer[]> {
  let q: Query = adminDb().collection(COLLECTIONS.transfers);
  if (opts?.computerId) q = q.where("computerId", "==", opts.computerId);
  if (opts?.fromWallet) q = q.where("fromWallet", "==", opts.fromWallet);
  if (opts?.toWallet) q = q.where("toWallet", "==", opts.toWallet);
  if (opts?.status) q = q.where("status", "==", opts.status);
  const snap = await q.get();
  const items = snap.docs.map((s) => parseTransfer(s.id, s.data()));
  items.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return items.slice(0, opts?.limit || 50);
}

export async function completeTransfer(transferId: string): Promise<void> {
  await adminDb().collection(COLLECTIONS.transfers).doc(transferId).update({
    status: "completed",
    completedAt: FieldValue.serverTimestamp(),
  });
}

export async function cancelTransfer(transferId: string): Promise<void> {
  await adminDb().collection(COLLECTIONS.transfers).doc(transferId).update({
    status: "cancelled",
  });
}

/**
 * Atomic ownership transfer: stops the computer, snapshots it,
 * reassigns ownership, and logs the transfer.
 */
export async function transferComputer(opts: {
  computerId: string;
  fromWallet: string;
  fromOrgId: string;
  toWallet: string;
  toOrgId: string;
  toWorkspaceId: string;
  priceCents: number;
}): Promise<{ transferId: string; snapshotId: string | null }> {
  const computer = await getComputer(opts.computerId);
  if (!computer) throw new Error("Computer not found");
  if (computer.ownerWallet !== opts.fromWallet) throw new Error("Not the owner");
  if (!computer.transferable) throw new Error("Computer is not transferable");

  // 1. Stop the computer if running
  if (computer.status === "running" || computer.status === "starting") {
    await updateComputer(opts.computerId, { status: "stopping" });
  }

  // 2. Create a snapshot for the transfer record
  let snapshotId: string | null = null;
  try {
    snapshotId = await createSnapshot({
      computerId: opts.computerId,
      providerSnapshotId: `transfer-${Date.now()}`,
      label: `Pre-transfer snapshot → ${opts.toWallet.slice(0, 8)}...`,
    });
  } catch {
    // Snapshot is best-effort; transfer proceeds without it
  }

  // 3. Reassign ownership
  await updateComputer(opts.computerId, {
    ownerWallet: opts.toWallet,
    ownerOrgId: opts.toOrgId,
    orgId: opts.toOrgId,
    workspaceId: opts.toWorkspaceId,
    listedForSale: false,
    listingPriceCents: null,
    listingDescription: null,
    status: "stopped",
  });

  // 4. Log the transfer
  const transferId = await createTransfer({
    computerId: opts.computerId,
    computerName: computer.name,
    openclawVariant: computer.openclawVariant,
    fromWallet: opts.fromWallet,
    fromOrgId: opts.fromOrgId,
    toWallet: opts.toWallet,
    toOrgId: opts.toOrgId,
    priceCents: opts.priceCents,
    status: "completed",
    snapshotId,
  });

  await completeTransfer(transferId);

  return { transferId, snapshotId };
}

// ═══════════════════════════════════════════════════════════════
// Marketplace Helpers
// ═══════════════════════════════════════════════════════════════

/** List a computer for sale on the marketplace */
export async function listComputerForSale(
  computerId: string,
  ownerWallet: string,
  priceCents: number,
  description: string,
): Promise<void> {
  const computer = await getComputer(computerId);
  if (!computer) throw new Error("Computer not found");
  if (computer.ownerWallet !== ownerWallet) throw new Error("Not the owner");
  if (!computer.transferable) throw new Error("Computer is not transferable");

  await updateComputer(computerId, {
    listedForSale: true,
    listingPriceCents: priceCents,
    listingDescription: description,
  });
}

/** Remove a computer from the marketplace */
export async function unlistComputer(computerId: string, ownerWallet: string): Promise<void> {
  const computer = await getComputer(computerId);
  if (!computer) throw new Error("Computer not found");
  if (computer.ownerWallet !== ownerWallet) throw new Error("Not the owner");

  await updateComputer(computerId, {
    listedForSale: false,
    listingPriceCents: null,
    listingDescription: null,
  });
}

/** Get all computers currently listed for sale */
export async function getListedComputers(): Promise<Computer[]> {
  const snap = await adminDb().collection(COLLECTIONS.computers).where("listedForSale", "==", true).get();
  return snap.docs.map((s) => parseComputer(s.id, s.data()));
}
