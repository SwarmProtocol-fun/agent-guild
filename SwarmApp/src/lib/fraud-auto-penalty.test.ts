/**
 * Tests for the fraud auto-penalty compounding fix.
 *
 * Before the fix, applyCreditPenalty read the agent's score from the
 * caller's pre-loop snapshot and wrote an absolute `.update({creditScore})`
 * — so when a single scan produced two or more direct (<=50 credit)
 * penalties for the same agent, each call independently computed
 * "originalScore - penalty" and overwrote the previous call's write. Only
 * the last-applied rule's delta survived instead of both compounding.
 * The fix re-reads inside a Firestore transaction, so each penalty in the
 * loop compounds on the previous one's committed result.
 */
import { describe, it, expect, vi } from "vitest";
import type { RiskSignal, FraudDetectionConfig } from "./fraud-detection";

// ── Minimal in-memory Firestore fake with runTransaction support ───────────
function createFakeFirestore() {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();

  function coll(name: string) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  }

  function docRef(name: string, id: string) {
    return {
      id,
      __collection: name,
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
      async add() {
        // Used by fire-and-forget audit/webhook writers — accept and ignore
        // details, just needs to not throw.
        return { id: `auto_${Math.random().toString(36).slice(2)}` };
      },
    };
  }

  return {
    collection(name: string) {
      return {
        doc(id: string) { return docRef(name, id); },
        async add(obj: Record<string, unknown>) {
          const id = `auto_${Math.random().toString(36).slice(2)}`;
          coll(name).set(id, obj);
          return { id };
        },
        // fireWebhooks calls .where(...).get() while looking up webhooks —
        // not implemented here; real code wraps that call in try/catch and
        // treats failure as "no webhooks configured", which is fine for
        // this test.
        where() {
          throw new Error("where() not supported by this fake — caught upstream");
        },
      };
    },
    async runTransaction(fn: (tx: {
      get: (ref: ReturnType<typeof docRef>) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
      update: (ref: ReturnType<typeof docRef>, patch: Record<string, unknown>) => void;
    }) => Promise<unknown>) {
      const tx = {
        async get(ref: ReturnType<typeof docRef>) {
          return ref.get();
        },
        update(ref: ReturnType<typeof docRef>, patch: Record<string, unknown>) {
          const c = coll(ref.__collection);
          if (!c.has(ref.id)) throw new Error(`NOT_FOUND: ${ref.__collection}/${ref.id}`);
          c.set(ref.id, { ...c.get(ref.id), ...patch });
        },
      };
      return fn(tx);
    },
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

// logActivity (called, non-blocking, from applyAutoPenalties) goes through
// the *client* Firestore SDK (firebase/firestore + @/lib/firebase's `db`),
// not adminDb — left unmocked, it attempts real network I/O against a
// nonexistent test project and burns several seconds retrying before the
// surrounding try/catch in fraud-auto-penalty.ts swallows the failure.
// Stubbing addDoc avoids that without touching anything else in the module.
vi.mock("firebase/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();
  return { ...actual, addDoc: vi.fn().mockResolvedValue({ id: "fake-activity-doc" }) };
});

const { applyAutoPenalties } = await import("./fraud-auto-penalty");
const { DEFAULT_CONFIG } = await import("./fraud-detection");

function makeSignal(id: string, agentId: string, overrides: Partial<RiskSignal>): RiskSignal {
  return {
    id,
    agentId,
    asn: "asn-1",
    orgId: "org-1",
    signalType: "wash_settlement",
    severity: "critical",
    confidence: 0.95,
    evidence: { windowStart: 0, windowEnd: 0, description: "test" },
    scanRunId: "scan-1",
    status: "active",
    ...overrides,
  };
}

describe("fraud-auto-penalty.ts — direct-penalty compounding", () => {
  it("compounds two direct (<=50 credit) penalties in one scan instead of the second overwriting the first", async () => {
    const agentId = "agent-compound-1";
    fakeDb._seed("agents", agentId, {
      creditScore: 680,
      trustScore: 50,
      asn: "asn-1",
      walletAddress: "0xabc",
      orgId: "org-1",
    });

    const signals: RiskSignal[] = [
      makeSignal("sig-wash", agentId, {
        signalType: "wash_settlement", // creditPenalty: 50, trustPenalty: 10
        severity: "critical",
        confidence: 0.95,
      }),
      makeSignal("sig-ring", agentId, {
        signalType: "trust_ring", // creditPenalty: 40, trustPenalty: 8
        severity: "critical",
        confidence: 0.9,
      }),
    ];
    // updateSignalStatus needs these docs to exist to succeed.
    fakeDb._seed("riskSignals", "sig-wash", { status: "active" });
    fakeDb._seed("riskSignals", "sig-ring", { status: "active" });

    const config: FraudDetectionConfig = { ...DEFAULT_CONFIG, autoPenaltyEnabled: true };
    const result = await applyAutoPenalties(agentId, signals, config);

    expect(result.penaltiesApplied).toBe(2);

    const agentDoc = fakeDb._get("agents", agentId);
    // 680 - 50 (wash_settlement) - 40 (trust_ring) = 590.
    // The pre-fix bug would leave this at 640 (680 - 40, trust_ring's
    // overwrite of the stale 680 baseline, wash_settlement's write lost).
    expect(agentDoc?.creditScore).toBe(590);
    // 50 - 10 - 8 = 32
    expect(agentDoc?.trustScore).toBe(32);
  });

  it("clamps compounding at the minimum credit score floor (300) rather than going negative", async () => {
    const agentId = "agent-floor-1";
    fakeDb._seed("agents", agentId, {
      creditScore: 320,
      trustScore: 5,
      asn: "asn-2",
      walletAddress: "0xdef",
      orgId: "org-1",
    });

    const signals: RiskSignal[] = [
      makeSignal("sig-wash-2", agentId, { signalType: "wash_settlement", severity: "critical", confidence: 0.95 }),
      makeSignal("sig-ring-2", agentId, { signalType: "trust_ring", severity: "critical", confidence: 0.9 }),
    ];
    fakeDb._seed("riskSignals", "sig-wash-2", { status: "active" });
    fakeDb._seed("riskSignals", "sig-ring-2", { status: "active" });

    const config: FraudDetectionConfig = { ...DEFAULT_CONFIG, autoPenaltyEnabled: true };
    await applyAutoPenalties(agentId, signals, config);

    const agentDoc = fakeDb._get("agents", agentId);
    // 320 - 50 = 270 -> clamped to 300; then 300 - 40 = 260 -> clamped to 300.
    expect(agentDoc?.creditScore).toBe(300);
  });
});
