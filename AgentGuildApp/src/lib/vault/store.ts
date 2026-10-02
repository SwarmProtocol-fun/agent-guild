/**
 * Vault persistence (Admin SDK only — these collections are deny-all in
 * firestore.rules, so browsers can never read them).
 *
 *   vaultSecrets/{id}        sealed values (see crypto.ts), never returned decrypted by any API
 *   vaultBindings/{id}       what an agent may do with a secret (see policy.ts)
 *   vaultUsage/{bindingId_h} per-binding hourly call counters
 *   vaultAudit/{id}          append-only, hash-chained per org
 *   vaultAuditHeads/{orgId}  { seq, hash } of the latest audit entry
 */

import crypto from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { seal, open, maskSecret, type SealedValue } from "./crypto";
import type { Binding, BindingInput } from "./policy";

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_SECRET_BYTES = 16 * 1024;

const db = () => adminDb();
const toMillis = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : null);

export class VaultError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

// ─── secrets ───────────────────────────────────────────────────

export interface SecretSummary {
  id: string;
  name: string;
  description: string;
  maskedPreview: string;
  kekProvider: SealedValue["kekProvider"];
  createdBy: string;
  createdAt: number | null;
  rotatedAt: number | null;
  lastUsedAt: number | null;
  useCount: number;
  rotation: RotationSummary | null;
}

/** Public view of a secret's rotation policy (the webhook signing secret is never included). */
export interface RotationSummary {
  intervalDays: number;
  mode: "remind" | "webhook";
  webhookUrl: string | null;
  nextAt: number | null;
  overdue: boolean;
  lastError: string | null;
}

function rotationSummary(r: FirebaseFirestore.DocumentData | undefined): RotationSummary | null {
  if (!r || !r.intervalDays) return null;
  return {
    intervalDays: r.intervalDays,
    mode: r.mode === "webhook" ? "webhook" : "remind",
    webhookUrl: r.webhookUrl || null,
    nextAt: toMillis(r.nextAt),
    overdue: Boolean(r.overdue),
    lastError: r.lastError || null,
  };
}

function secretAad(orgId: string, secretId: string) {
  return `vault:${orgId}:${secretId}`;
}

function checkValue(value: string) {
  if (!value) throw new VaultError("value is required");
  if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new VaultError("value is larger than 16 KB");
}

export async function createSecret(orgId: string, name: string, value: string, createdBy: string, description = ""): Promise<string> {
  if (!SECRET_NAME_RE.test(name)) throw new VaultError("name must look like STRIPE_API_KEY (uppercase letters, digits, underscores)");
  checkValue(value);
  const dupe = await db().collection("vaultSecrets").where("orgId", "==", orgId).where("name", "==", name).limit(1).get();
  if (!dupe.empty) throw new VaultError(`A secret named ${name} already exists — rotate it instead`, 409);

  const ref = db().collection("vaultSecrets").doc();
  const sealed = await seal(value, secretAad(orgId, ref.id));
  await ref.set({
    orgId,
    name,
    description: description.slice(0, 500),
    ...sealed,
    maskedPreview: maskSecret(value),
    createdBy,
    createdAt: FieldValue.serverTimestamp(),
    rotatedAt: null,
    lastUsedAt: null,
    useCount: 0,
  });
  return ref.id;
}

export async function rotateSecret(orgId: string, secretId: string, value: string): Promise<void> {
  checkValue(value);
  const ref = db().collection("vaultSecrets").doc(secretId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.orgId !== orgId) throw new VaultError("Secret not found", 404);
  const sealed = await seal(value, secretAad(orgId, secretId));
  const policy = snap.data()!.rotation;
  await ref.update({
    ...sealed,
    maskedPreview: maskSecret(value),
    rotatedAt: FieldValue.serverTimestamp(),
    // A rotation by any route (manual, webhook) restarts the schedule.
    ...(policy?.intervalDays
      ? {
          "rotation.nextAt": Timestamp.fromMillis(Date.now() + policy.intervalDays * 86_400_000),
          "rotation.overdue": false,
          "rotation.lastError": null,
        }
      : {}),
  });
}

export async function listSecrets(orgId: string): Promise<SecretSummary[]> {
  const snap = await db().collection("vaultSecrets").where("orgId", "==", orgId).get();
  return snap.docs
    .map((d) => {
      const x = d.data();
      return {
        id: d.id,
        name: x.name,
        description: x.description || "",
        maskedPreview: x.maskedPreview,
        kekProvider: x.kekProvider,
        createdBy: x.createdBy,
        createdAt: toMillis(x.createdAt),
        rotatedAt: toMillis(x.rotatedAt),
        lastUsedAt: toMillis(x.lastUsedAt),
        useCount: x.useCount || 0,
        rotation: rotationSummary(x.rotation),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteSecret(orgId: string, secretId: string): Promise<void> {
  const ref = db().collection("vaultSecrets").doc(secretId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.orgId !== orgId) throw new VaultError("Secret not found", 404);
  const users = await db().collection("vaultBindings").where("orgId", "==", orgId).where("secretId", "==", secretId).get();
  if (!users.empty) {
    throw new VaultError(`Secret is used by binding(s): ${users.docs.map((d) => d.data().name).join(", ")} — delete those first`, 409);
  }
  await ref.delete();
}

/** Server-internal: decrypt for injection. Never expose through an API response. */
export async function useSecretValue(orgId: string, secretId: string): Promise<string> {
  const ref = db().collection("vaultSecrets").doc(secretId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.orgId !== orgId) throw new VaultError("The binding's secret no longer exists", 409);
  const value = await open(snap.data() as SealedValue, secretAad(orgId, secretId));
  ref.update({ lastUsedAt: FieldValue.serverTimestamp(), useCount: FieldValue.increment(1) }).catch(() => {});
  return value;
}

// ─── bindings ──────────────────────────────────────────────────

function toBinding(id: string, x: FirebaseFirestore.DocumentData): Binding & { createdAt: number | null; secretName?: string } {
  return {
    id,
    orgId: x.orgId,
    name: x.name,
    description: x.description || "",
    secretId: x.secretId,
    baseUrl: x.baseUrl,
    auth: x.auth,
    allowedMethods: x.allowedMethods || ["GET"],
    allowedPaths: x.allowedPaths || ["/"],
    agentIds: x.agentIds || [],
    maxCallsPerHour: x.maxCallsPerHour || 0,
    revoked: Boolean(x.revoked),
    createdBy: x.createdBy,
    createdAt: toMillis(x.createdAt),
  };
}

export async function createBinding(orgId: string, input: BindingInput, createdBy: string): Promise<string> {
  const secret = await db().collection("vaultSecrets").doc(input.secretId).get();
  if (!secret.exists || secret.data()!.orgId !== orgId) throw new VaultError("secretId does not match a secret in this org");
  if (await getBindingByName(orgId, input.name)) throw new VaultError(`A binding named ${input.name} already exists`, 409);
  const ref = await db().collection("vaultBindings").add({
    ...input,
    orgId,
    revoked: false,
    createdBy,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function listBindings(orgId: string) {
  const snap = await db().collection("vaultBindings").where("orgId", "==", orgId).get();
  return snap.docs.map((d) => toBinding(d.id, d.data())).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getBindingByName(orgId: string, name: string) {
  const snap = await db().collection("vaultBindings").where("orgId", "==", orgId).where("name", "==", name).limit(1).get();
  return snap.empty ? null : toBinding(snap.docs[0].id, snap.docs[0].data());
}

export async function updateBinding(orgId: string, id: string, patch: Partial<BindingInput> & { revoked?: boolean }) {
  const ref = db().collection("vaultBindings").doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.orgId !== orgId) throw new VaultError("Binding not found", 404);
  if (patch.secretId) {
    const secret = await db().collection("vaultSecrets").doc(patch.secretId).get();
    if (!secret.exists || secret.data()!.orgId !== orgId) throw new VaultError("secretId does not match a secret in this org");
  }
  if (patch.name && patch.name !== snap.data()!.name && (await getBindingByName(orgId, patch.name))) {
    throw new VaultError(`A binding named ${patch.name} already exists`, 409);
  }
  await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
}

export async function deleteBinding(orgId: string, id: string) {
  const ref = db().collection("vaultBindings").doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.orgId !== orgId) throw new VaultError("Binding not found", 404);
  await ref.delete();
}

/** Count one call against the binding's hourly cap. Returns false when the cap is reached. */
export async function reserveCall(binding: Pick<Binding, "id" | "maxCallsPerHour">): Promise<boolean> {
  if (!binding.maxCallsPerHour) return true;
  const hour = Math.floor(Date.now() / 3_600_000);
  const ref = db().collection("vaultUsage").doc(`${binding.id}_${hour}`);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? snap.data()!.count || 0 : 0;
    if (count >= binding.maxCallsPerHour) return false;
    tx.set(ref, { count: count + 1, bindingId: binding.id, hour, expiresAt: Timestamp.fromMillis((hour + 2) * 3_600_000) }, { merge: true });
    return true;
  });
}

// ─── audit (hash chain) ────────────────────────────────────────

export interface AuditEntry {
  orgId: string;
  action:
    | "secret.created" | "secret.rotated" | "secret.deleted"
    | "binding.created" | "binding.updated" | "binding.revoked" | "binding.deleted"
    | "binding.executed" | "binding.denied"
    | "tokens.revoked"
    | "secret.rotation_configured" | "secret.rotation_due" | "secret.rotation_failed";
  actorType: "user" | "agent";
  actorId: string;
  target: string;
  detail?: Record<string, string | number | boolean | null>;
}

const GENESIS = "0".repeat(64);

export function auditHash(prevHash: string, seq: number, at: number, entry: AuditEntry): string {
  const canonical = JSON.stringify([prevHash, seq, at, entry.orgId, entry.action, entry.actorType, entry.actorId, entry.target, entry.detail ?? null]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  const headRef = db().collection("vaultAuditHeads").doc(entry.orgId);
  const entryRef = db().collection("vaultAudit").doc();
  await db().runTransaction(async (tx) => {
    const head = await tx.get(headRef);
    const prevHash: string = head.exists ? head.data()!.hash : GENESIS;
    const seq: number = head.exists ? head.data()!.seq + 1 : 1;
    const at = Date.now();
    const hash = auditHash(prevHash, seq, at, entry);
    tx.set(entryRef, { ...entry, detail: entry.detail ?? null, seq, at, prevHash, hash });
    tx.set(headRef, { seq, hash, updatedAt: at });
  });
}

/** Best-effort wrapper for paths where an audit failure shouldn't fail the request it records. */
export function auditQuietly(entry: AuditEntry) {
  appendAudit(entry).catch((err) => console.error("[vault] audit append failed:", err));
}

export async function listAudit(orgId: string, limit = 100) {
  const snap = await db().collection("vaultAudit").where("orgId", "==", orgId).orderBy("seq", "desc").limit(Math.min(limit, 500)).get();
  return snap.docs.map((d) => d.data() as AuditEntry & { seq: number; at: number; prevHash: string; hash: string });
}

/** Re-derive each hash in the returned window; `intact` is false if any entry was altered or removed. */
export function verifyAuditWindow(entries: (AuditEntry & { seq: number; at: number; prevHash: string; hash: string })[]) {
  const asc = [...entries].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < asc.length; i++) {
    const e = asc[i];
    if (auditHash(e.prevHash, e.seq, e.at, e) !== e.hash) return { intact: false, brokenAt: e.seq };
    if (i > 0 && (asc[i - 1].hash !== e.prevHash || asc[i - 1].seq + 1 !== e.seq)) return { intact: false, brokenAt: e.seq };
  }
  return { intact: true as const, brokenAt: null };
}
