/**
 * Tests for the credit-override no-op fix.
 *
 * Before the fix, getAgentScores/updateAgentScores queried Firestore with
 * `.where("id", "==", agentId)` — but agent documents are created via
 * `.add()` and never get an `id` field written into the body, so that query
 * always came back empty. getAgentScores silently fell back to a hardcoded
 * default (680/50) and updateAgentScores just returned without writing
 * anything, while requestOverride/applyOverride went on to log the override
 * as "approved" as if the mutation had succeeded. The fix uses `.doc(agentId)`
 * directly, matching every other read site in the codebase.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Minimal in-memory Firestore fake ────────────────────────────────────────
// Only implements what override.ts actually calls: collection(name).doc(id)
// .get()/.update(), and collection(name).add(). No transactions needed here.
function createFakeFirestore() {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  let autoId = 0;

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
      async update(patch: Record<string, unknown>) {
        const c = coll(name);
        if (!c.has(id)) throw new Error(`NOT_FOUND: ${name}/${id}`);
        c.set(id, { ...c.get(id), ...patch });
      },
      async set(obj: Record<string, unknown>) {
        coll(name).set(id, obj);
      },
    };
  }

  return {
    collection(name: string) {
      return {
        doc(id: string) {
          return docRef(name, id);
        },
        async add(obj: Record<string, unknown>) {
          const id = `auto_${autoId++}`;
          coll(name).set(id, obj);
          return docRef(name, id);
        },
      };
    },
    // Test-only helpers for setup/assertions.
    _seed(name: string, id: string, data: Record<string, unknown>) {
      coll(name).set(id, data);
    },
    _get(name: string, id: string) {
      return coll(name).get(id);
    },
  };
}

const fakeDb = createFakeFirestore();

vi.mock("@/lib/firebase-admin", () => ({
  adminDb: () => fakeDb,
}));

const { requestOverride, getOverride } = await import("./override");

describe("credit-ops/override.ts — agent score doc lookup", () => {
  beforeEach(() => {
    // Fresh fake DB per test by re-seeding (Map.clear via re-import isn't
    // needed since each test seeds its own distinct agentId).
  });

  it("reads and writes the agent's real score via .doc(agentId), not a doomed .where(\"id\",...) query", async () => {
    const agentId = "agent-real-doc-id"; // deliberately has NO "id" field in its body
    fakeDb._seed("agents", agentId, {
      creditScore: 750,
      trustScore: 60,
      asn: "asn-1",
    });

    const { overrideId, requiresApproval } = await requestOverride({
      agentId,
      asn: "asn-1",
      newCreditScore: 720, // delta = -30, within auto-approve threshold (50)
      newTrustScore: 55,
      reason: "test override",
      overrideType: "permanent",
      requestedBy: "tester",
    });

    expect(requiresApproval).toBe(false);

    // The override record itself must reflect the agent's REAL prior score
    // (750), not the old bug's hardcoded default (680) — that default only
    // appears when the doc lookup fails, which is exactly the bug.
    const override = await getOverride(overrideId);
    expect(override?.previousCreditScore).toBe(750);
    expect(override?.previousTrustScore).toBe(60);

    // And the agent doc must actually have been updated in Firestore — the
    // core of the original bug was that this write silently never happened.
    const agentDoc = fakeDb._get("agents", agentId);
    expect(agentDoc?.creditScore).toBe(720);
    expect(agentDoc?.trustScore).toBe(55);
  });

  it("falls back to the 680/50 default only when the agent doc genuinely doesn't exist", async () => {
    const missingAgentId = "agent-does-not-exist";

    const { overrideId } = await requestOverride({
      agentId: missingAgentId,
      asn: "asn-missing",
      newCreditScore: 600,
      newTrustScore: 40,
      reason: "test override on missing agent",
      overrideType: "permanent",
      requestedBy: "tester",
    });

    const override = await getOverride(overrideId);
    expect(override?.previousCreditScore).toBe(680);
    expect(override?.previousTrustScore).toBe(50);

    // No agent doc exists to update — updateAgentScores must no-op safely,
    // not throw.
    expect(fakeDb._get("agents", missingAgentId)).toBeUndefined();
  });
});
