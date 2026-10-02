/**
 * Delegation grants — scoped, time-limited authority one agent gives another
 * to act on its behalf, with an optional spend cap.
 *
 * Distinct from agent-hierarchy.ts's DelegationRecord, which models a
 * static org-chart parent/child link and a single task hand-off. A grant
 * here is closer to an OAuth scope: "agent B may do {permissions} on my
 * behalf, spending at most {maxSpendUsdc}, until {expiresAt}" — revocable at
 * any time, and consumable by anything that wants to gate an action on it
 * (today: POST /v1/jobs/:jobId/claim's `onBehalfOf` param).
 *
 * Admin SDK — server-only, same convention as agent-hierarchy.ts. Spend is
 * recorded inside a Firestore transaction so two concurrent claims under the
 * same grant can't both pass a cap check before either write lands.
 */
import { adminDb } from "./firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

const COLLECTION = "delegationGrants";

export interface DelegationGrant {
  id: string;
  orgId: string;
  principalAgentId: string;
  principalAgentName: string;
  delegateAgentId: string;
  delegateAgentName: string;
  /** Scope strings the delegate may act under, e.g. "jobs:claim", "jobs:apply". */
  permissions: string[];
  /** Null = no spend cap — delegate can act, but nothing tracks a budget against it. */
  maxSpendUsdc: number | null;
  spentUsdc: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedBy?: string;
  createdAt: Date | null;
}

interface DelegationGrantDoc extends Omit<DelegationGrant, "id" | "expiresAt" | "revokedAt" | "createdAt"> {
  expiresAt: Timestamp | null;
  revokedAt: Timestamp | null;
  createdAt: FieldValue | Timestamp;
}

function toGrant(id: string, data: Record<string, unknown>): DelegationGrant {
  return {
    id,
    orgId: data.orgId as string,
    principalAgentId: data.principalAgentId as string,
    principalAgentName: data.principalAgentName as string,
    delegateAgentId: data.delegateAgentId as string,
    delegateAgentName: data.delegateAgentName as string,
    permissions: Array.isArray(data.permissions) ? (data.permissions as string[]) : [],
    maxSpendUsdc: (data.maxSpendUsdc as number) ?? null,
    spentUsdc: (data.spentUsdc as number) ?? 0,
    expiresAt: data.expiresAt instanceof Timestamp ? data.expiresAt.toDate() : null,
    revokedAt: data.revokedAt instanceof Timestamp ? data.revokedAt.toDate() : null,
    revokedBy: (data.revokedBy as string) || undefined,
    createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
  };
}

function isActive(grant: DelegationGrant, now = Date.now()): boolean {
  if (grant.revokedAt) return false;
  if (grant.expiresAt && grant.expiresAt.getTime() <= now) return false;
  return true;
}

export interface CreateDelegationInput {
  orgId: string;
  principalAgentId: string;
  principalAgentName: string;
  delegateAgentId: string;
  delegateAgentName: string;
  permissions: string[];
  maxSpendUsdc?: number;
  /** Grant lifetime from now. Required — an unbounded grant isn't time-limited by definition. */
  durationMs: number;
}

export async function createDelegation(input: CreateDelegationInput): Promise<DelegationGrant> {
  if (input.principalAgentId === input.delegateAgentId) {
    throw new Error("An agent cannot delegate to itself");
  }
  if (input.permissions.length === 0) {
    throw new Error("At least one permission scope is required");
  }
  if (input.durationMs <= 0) {
    throw new Error("durationMs must be positive");
  }
  if (input.maxSpendUsdc != null && input.maxSpendUsdc <= 0) {
    throw new Error("maxSpendUsdc must be positive when provided");
  }

  const doc: DelegationGrantDoc = {
    orgId: input.orgId,
    principalAgentId: input.principalAgentId,
    principalAgentName: input.principalAgentName,
    delegateAgentId: input.delegateAgentId,
    delegateAgentName: input.delegateAgentName,
    permissions: input.permissions,
    maxSpendUsdc: input.maxSpendUsdc ?? null,
    spentUsdc: 0,
    expiresAt: Timestamp.fromMillis(Date.now() + input.durationMs),
    revokedAt: null,
    createdAt: FieldValue.serverTimestamp(),
  };

  const ref = await adminDb().collection(COLLECTION).add(doc);
  const saved = await ref.get();
  return toGrant(ref.id, saved.data()!);
}

/** All grants where this agent is on one side, newest first. */
export async function getDelegationsForAgent(
  agentId: string,
  role: "principal" | "delegate",
): Promise<DelegationGrant[]> {
  const field = role === "principal" ? "principalAgentId" : "delegateAgentId";
  const snap = await adminDb().collection(COLLECTION).where(field, "==", agentId).get();
  return snap.docs
    .map((d) => toGrant(d.id, d.data()))
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
}

/**
 * The grant, if any, that currently lets `delegateAgentId` act for
 * `principalAgentId` with `permission` — active (not revoked, not expired)
 * and, when `amountUsdc` is given, with enough headroom left under the cap.
 * Returns null rather than throwing so callers can produce their own 403.
 */
export async function getActiveDelegation(
  orgId: string,
  principalAgentId: string,
  delegateAgentId: string,
  permission: string,
  amountUsdc?: number,
): Promise<DelegationGrant | null> {
  const snap = await adminDb()
    .collection(COLLECTION)
    .where("orgId", "==", orgId)
    .where("principalAgentId", "==", principalAgentId)
    .where("delegateAgentId", "==", delegateAgentId)
    .get();

  const grants = snap.docs.map((d) => toGrant(d.id, d.data())).filter((g) => isActive(g));
  for (const grant of grants) {
    if (!grant.permissions.includes(permission)) continue;
    if (amountUsdc != null && grant.maxSpendUsdc != null && grant.spentUsdc + amountUsdc > grant.maxSpendUsdc) continue;
    return grant;
  }
  return null;
}

/**
 * Debits `amountUsdc` from a grant's cap inside a transaction, so two
 * concurrent actions under the same grant can't both pass
 * getActiveDelegation()'s headroom check before either spend lands. Throws
 * if the grant was revoked/expired/exhausted between the check and here —
 * callers that already let the underlying action proceed (e.g. a job claim)
 * should treat that as non-fatal bookkeeping drift, not undo the action.
 */
export async function recordDelegationSpend(grantId: string, amountUsdc: number): Promise<DelegationGrant> {
  const ref = adminDb().collection(COLLECTION).doc(grantId);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Delegation grant not found");
    const grant = toGrant(snap.id, snap.data()!);
    if (!isActive(grant)) throw new Error("Delegation grant is no longer active");
    if (grant.maxSpendUsdc != null && grant.spentUsdc + amountUsdc > grant.maxSpendUsdc) {
      throw new Error("Delegation spend cap exceeded");
    }
    const spentUsdc = grant.spentUsdc + amountUsdc;
    tx.update(ref, { spentUsdc });
    return { ...grant, spentUsdc };
  });
}

export async function revokeDelegation(grantId: string, revokedBy: string): Promise<void> {
  await adminDb().collection(COLLECTION).doc(grantId).update({
    revokedAt: FieldValue.serverTimestamp(),
    revokedBy,
  });
}
