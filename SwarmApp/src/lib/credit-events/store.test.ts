/**
 * Tests for the credit-event dedup TOCTOU fix.
 *
 * Before the fix, dedup was a plain query (isDuplicate) followed by a
 * separate .add() — not atomic. Two concurrent ingests of the same source
 * event could both pass the isDuplicate check before either commits,
 * producing two credit-delta events for one real occurrence. The fix uses
 * the idempotency key (hashed) as the doc ID and `.create()`, which fails
 * atomically if the doc already exists.
 */
import { describe, it, expect, vi } from "vitest";
import type { CreditEventInput } from "./types";

// ── Minimal in-memory Firestore fake with atomic .create() semantics ───────
function createFakeFirestore() {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();

  function coll(name: string) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  }

  function docRef(name: string, id: string) {
    return {
      id,
      async get() {
        const c = coll(name);
        const exists = c.has(id);
        return { exists, id, data: () => (exists ? c.get(id) : undefined) };
      },
      async create(obj: Record<string, unknown>) {
        const c = coll(name);
        if (c.has(id)) {
          const err = new Error("ALREADY_EXISTS: Document already exists") as Error & { code: number };
          err.code = 6; // matches the gRPC ALREADY_EXISTS code checked in ingest.ts
          throw err;
        }
        c.set(id, obj);
      },
    };
  }

  return {
    collection(name: string) {
      return { doc(id: string) { return docRef(name, id); } };
    },
    _size(name: string) {
      return coll(name).size;
    },
  };
}

const fakeDb = createFakeFirestore();

vi.mock("@/lib/firebase-admin", () => ({
  adminDb: () => fakeDb,
}));

const { storeCreditEvent, isDuplicate } = await import("./store");
const { ingestCreditEvent } = await import("./ingest");

function makeEvent(sourceEventId: string): CreditEventInput {
  return {
    eventType: "task.completed",
    agentId: "agent-1",
    orgId: "org-1",
    creditDelta: 5,
    trustDelta: 1,
    provenance: "task_lifecycle",
    severity: "info",
    source: { system: "assignments", sourceEventId, sourceEventType: "assignment.completed" },
    timestamp: Math.floor(Date.now() / 1000),
    description: "test event",
  };
}

describe("credit-events dedup", () => {
  it("storeCreditEvent's second call for the same idempotency key throws ALREADY_EXISTS rather than double-storing", async () => {
    const event = makeEvent("assign-dup-1-completed");

    await storeCreditEvent(event);
    expect(await isDuplicate(`${event.source.system}:${event.source.sourceEventId}`)).toBe(true);

    await expect(storeCreditEvent(event)).rejects.toThrow(/ALREADY_EXISTS/);
  });

  it("ingestCreditEvent treats a racing duplicate .create() as deduplicated, not an error", async () => {
    const event = makeEvent("assign-race-2-completed");

    // Simulate the race: both calls pass isDuplicate (neither has committed
    // yet) by calling ingestCreditEvent twice back-to-back without awaiting
    // between them.
    const [first, second] = await Promise.all([
      ingestCreditEvent(event),
      ingestCreditEvent(event),
    ]);

    const results = [first, second];
    const succeeded = results.filter((r) => r.success && !r.deduplicated);
    const deduped = results.filter((r) => r.success && r.deduplicated);

    // Exactly one of the two concurrent calls actually stored the event;
    // the other must come back as a clean dedup, not a thrown error or a
    // silently duplicated store.
    expect(succeeded.length).toBe(1);
    expect(deduped.length).toBe(1);
  });

  it("ingestCreditEvent is a clean no-op dedup on a genuine, non-racing duplicate", async () => {
    const event = makeEvent("assign-clean-3-completed");

    const first = await ingestCreditEvent(event);
    expect(first.success).toBe(true);
    expect(first.deduplicated).toBeFalsy();

    const second = await ingestCreditEvent(event);
    expect(second.success).toBe(true);
    expect(second.deduplicated).toBe(true);
  });
});
