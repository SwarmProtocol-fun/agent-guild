/**
 * openGym mod — Firestore persistence. Admin SDK only.
 *
 *   gymWorkouts/{id}           one session (logbook.ts Workout)
 *   gymBodyweight/{sha256}     one weigh-in per org per date (later writes win)
 *   gymLinks/{orgId}           linked openGym instance: base URL + sealed token
 *
 * Lookups are single-field equality on `orgId`; sorting happens in memory so
 * no composite index is needed. A personal logbook stays in the low thousands
 * of rows, so reading an org's whole log per stats call is fine.
 */

import { createHash, randomUUID } from "crypto";
import { adminDb } from "@/lib/firebase-admin";
import { seal, open, type SealedValue } from "@/lib/vault/crypto";
import type { BodyweightEntry, Source, Workout, WorkoutDraft } from "./logbook";

const WORKOUTS = "gymWorkouts";
const BODYWEIGHT = "gymBodyweight";
const LINKS = "gymLinks";

function hashId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

/** Firestore rejects `undefined` field values; drop them. */
function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function listWorkouts(orgId: string): Promise<Workout[]> {
  const snap = await adminDb().collection(WORKOUTS).where("orgId", "==", orgId).get();
  return snap.docs
    .map((d) => d.data() as Workout)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

export async function getWorkout(id: string): Promise<Workout | null> {
  const snap = await adminDb().collection(WORKOUTS).doc(id).get();
  return snap.exists ? (snap.data() as Workout) : null;
}

export async function saveWorkout(orgId: string, draft: WorkoutDraft, source: Source, loggedBy: string): Promise<Workout> {
  const id = draft.externalId ? `og-${hashId(orgId, draft.externalId)}` : randomUUID();
  const workout: Workout = clean({ ...draft, id, orgId, source, loggedBy, createdAt: new Date().toISOString() });
  await adminDb().collection(WORKOUTS).doc(id).set(workout);
  return workout;
}

/** Upsert many (openGym import). Ids derive from externalId, so a re-sync overwrites rather than duplicates. */
export async function saveWorkouts(orgId: string, drafts: WorkoutDraft[], source: Source, loggedBy: string): Promise<number> {
  const db = adminDb();
  const at = new Date().toISOString();
  for (let i = 0; i < drafts.length; i += 400) {
    const batch = db.batch();
    for (const draft of drafts.slice(i, i + 400)) {
      const id = draft.externalId ? `og-${hashId(orgId, draft.externalId)}` : randomUUID();
      batch.set(db.collection(WORKOUTS).doc(id), clean({ ...draft, id, orgId, source, loggedBy, createdAt: at }));
    }
    await batch.commit();
  }
  return drafts.length;
}

export async function deleteWorkout(id: string): Promise<void> {
  await adminDb().collection(WORKOUTS).doc(id).delete();
}

export async function listBodyweight(orgId: string): Promise<BodyweightEntry[]> {
  const snap = await adminDb().collection(BODYWEIGHT).where("orgId", "==", orgId).get();
  return snap.docs.map((d) => d.data() as BodyweightEntry).sort((a, b) => a.date.localeCompare(b.date));
}

export async function saveBodyweight(orgId: string, entries: { date: string; weightKg: number }[], source: Source): Promise<void> {
  const db = adminDb();
  const at = new Date().toISOString();
  for (let i = 0; i < entries.length; i += 400) {
    const batch = db.batch();
    for (const e of entries.slice(i, i + 400)) {
      const row: BodyweightEntry = { orgId, date: e.date, weightKg: e.weightKg, source, at };
      batch.set(db.collection(BODYWEIGHT).doc(hashId(orgId, e.date)), row);
    }
    await batch.commit();
  }
}

// ── Linked openGym instance ─────────────────────────────────────────────

export interface GymLink {
  orgId: string;
  baseUrl: string;
  profileName: string | null;
  linkedBy: string;
  linkedAt: string;
  lastSyncAt: string | null;
  lastSyncCount: number | null;
}

interface StoredLink extends GymLink {
  token: SealedValue;
}

const aad = (orgId: string) => `opengym-link:${orgId}`;

export async function getLink(orgId: string): Promise<GymLink | null> {
  const snap = await adminDb().collection(LINKS).doc(orgId).get();
  if (!snap.exists) return null;
  const link: Partial<StoredLink> = { ...(snap.data() as StoredLink) };
  delete link.token;
  return link as GymLink;
}

export async function getLinkToken(orgId: string): Promise<{ link: GymLink; token: string } | null> {
  const snap = await adminDb().collection(LINKS).doc(orgId).get();
  if (!snap.exists) return null;
  const { token, ...link } = snap.data() as StoredLink;
  return { link, token: await open(token, aad(orgId)) };
}

export async function saveLink(link: Omit<GymLink, "lastSyncAt" | "lastSyncCount">, token: string): Promise<void> {
  const sealed = await seal(token, aad(link.orgId));
  const row: StoredLink = { ...link, lastSyncAt: null, lastSyncCount: null, token: sealed };
  await adminDb().collection(LINKS).doc(link.orgId).set(clean(row));
}

export async function markSynced(orgId: string, count: number): Promise<void> {
  await adminDb().collection(LINKS).doc(orgId).set({ lastSyncAt: new Date().toISOString(), lastSyncCount: count }, { merge: true });
}

export async function deleteLink(orgId: string): Promise<void> {
  await adminDb().collection(LINKS).doc(orgId).delete();
}
