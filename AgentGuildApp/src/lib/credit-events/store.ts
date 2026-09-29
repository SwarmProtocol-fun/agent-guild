/**
 * Credit Event Store
 *
 * Firestore CRUD for the canonical `creditEvents` collection.
 * Deduplication, flexible querying, and replay support.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, Timestamp, type Query } from "firebase-admin/firestore";
import type {
  CreditEvent,
  CreditEventInput,
  CreditEventQuery,
} from "./types";
import { computeIdempotencyKey } from "./validation";

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const CREDIT_EVENTS_COLLECTION = "creditEvents";

// ═══════════════════════════════════════════════════════════════
// Deduplication
// ═══════════════════════════════════════════════════════════════

/**
 * Check if an event with the same idempotency key already exists.
 * Pattern from hedera-slashing.ts checkIfAlreadySlashed().
 */
export async function isDuplicate(idempotencyKey: string): Promise<boolean> {
  const snapshot = await adminDb()
    .collection(CREDIT_EVENTS_COLLECTION)
    .where("idempotencyKey", "==", idempotencyKey)
    .get();
  return !snapshot.empty;
}

// ═══════════════════════════════════════════════════════════════
// Store
// ═══════════════════════════════════════════════════════════════

/**
 * Store a validated credit event in Firestore.
 * Returns the Firestore document ID.
 */
export async function storeCreditEvent(event: CreditEventInput): Promise<string> {
  const idempotencyKey = computeIdempotencyKey(
    event.source.system,
    event.source.sourceEventId,
  );

  const ref = await adminDb().collection(CREDIT_EVENTS_COLLECTION).add({
    ...event,
    idempotencyKey,
    createdAt: FieldValue.serverTimestamp(),
  });

  return ref.id;
}

// ═══════════════════════════════════════════════════════════════
// Query
// ═══════════════════════════════════════════════════════════════

/**
 * Query credit events with flexible filtering.
 * Follows the constraint accumulation pattern from activity.ts.
 */
export async function queryCreditEvents(
  params: CreditEventQuery,
): Promise<CreditEvent[]> {
  let q: Query = adminDb().collection(CREDIT_EVENTS_COLLECTION);

  if (params.agentId) {
    q = q.where("agentId", "==", params.agentId);
  }
  if (params.asn) {
    q = q.where("asn", "==", params.asn);
  }
  if (params.orgId) {
    q = q.where("orgId", "==", params.orgId);
  }
  if (params.eventType) {
    q = q.where("eventType", "==", params.eventType);
  }
  if (params.provenance) {
    q = q.where("provenance", "==", params.provenance);
  }
  if (params.fromTimestamp) {
    q = q.where("timestamp", ">=", params.fromTimestamp);
  }
  if (params.toTimestamp) {
    q = q.where("timestamp", "<=", params.toTimestamp);
  }

  const direction = params.orderDirection || "desc";
  q = q.orderBy("timestamp", direction).limit(params.limit || 100);

  const snap = await q.get();

  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      createdAt: data.createdAt instanceof Timestamp
        ? data.createdAt.toDate()
        : data.createdAt,
    } as CreditEvent;
  });
}

/**
 * Get events for replay within a time range.
 * Returns events in ascending order for sequential replay.
 */
export async function getEventsForReplay(
  fromTimestamp: number,
  toTimestamp: number,
  agentId?: string,
  eventType?: string,
): Promise<CreditEvent[]> {
  return queryCreditEvents({
    fromTimestamp,
    toTimestamp,
    agentId,
    eventType: eventType as CreditEvent["eventType"],
    orderDirection: "asc",
    limit: 10000,
  });
}
