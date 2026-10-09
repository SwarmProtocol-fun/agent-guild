import { describe, it, expect, vi, beforeEach } from "vitest";

// A tiny in-memory Firestore: just the calls polymarket-store makes, plus a
// switch that makes any ordered query fail the way a missing index does.
type Doc = Record<string, unknown>;
const data = new Map<string, Map<string, Doc>>();
let missingIndexes = true;
let nextId = 0;

const INC = Symbol("inc");
function merge(target: Doc, patch: Doc): Doc {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && INC in (v as object)) out[k] = Number(out[k] ?? 0) + (v as { [INC]: number })[INC];
    else if (v && typeof v === "object" && !(v instanceof Date)) out[k] = merge((out[k] as Doc) ?? {}, v as Doc);
    else out[k] = v;
  }
  return out;
}
const coll = (name: string) => { if (!data.has(name)) data.set(name, new Map()); return data.get(name)!; };
function docRef(name: string, id: string) {
  return {
    id,
    get: async () => ({ id, exists: coll(name).has(id), data: () => coll(name).get(id) }),
    set: async (v: Doc, opts?: { merge?: boolean }) => { coll(name).set(id, opts?.merge ? merge(coll(name).get(id) ?? {}, v) : merge({}, v)); },
    update: async (v: Doc) => { coll(name).set(id, merge(coll(name).get(id) ?? {}, v)); },
  };
}
function query(name: string, filters: [string, unknown][] = [], ordered = false, lim = Infinity) {
  return {
    where: (f: string, _op: string, v: unknown) => query(name, [...filters, [f, v]], ordered, lim),
    orderBy: () => query(name, filters, true, lim),
    limit: (n: number) => query(name, filters, ordered, n),
    get: async () => {
      if (ordered && missingIndexes) throw Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index."), { code: 9 });
      const docs = [...coll(name).entries()].filter(([, d]) => filters.every(([f, v]) => d[f] === v)).slice(0, lim)
        .map(([id, d]) => ({ id, ref: docRef(name, id), data: () => d }));
      return { docs };
    },
  };
}
const fakeDb = {
  collection: (name: string) => ({
    ...query(name),
    doc: (id: string) => docRef(name, id),
    add: async (v: Doc) => { const id = `t${nextId++}`; await docRef(name, id).set(v); return { id }; },
  }),
  runTransaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn({
    get: (ref: { get: () => unknown }) => ref.get(),
    update: (ref: { update: (v: Doc) => unknown }, v: Doc) => ref.update(v),
    set: (ref: { set: (v: Doc) => unknown }, v: Doc) => ref.set(v),
  }),
};
vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => fakeDb }));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => ({ toDate: () => new Date() }), increment: (n: number) => ({ [INC]: n }) },
}));

const store = await import("../polymarket-store");

const trade = (realizedPnl: number, mode: "paper" | "live" = "paper") => ({
  agentId: "a1", orgId: "o1", mode, conditionId: "c", question: "q", tokenId: "t", outcome: "Yes",
  side: "sell" as const, shares: 1, price: 0.5, notional: 0.5, fee: 0, realizedPnl, strategyId: null, orderId: null, status: "filled",
});

describe("polymarket store without composite indexes", () => {
  beforeEach(() => { data.clear(); missingIndexes = true; });

  it("new accounts start with $1,000 of paper money", async () => {
    expect(await store.ensureAccount("a1", "o1")).toMatchObject({ mode: "paper", paperCash: 1000, paperStartCash: 1000 });
  });

  it("adding paper funds raises cash and the starting balance together", async () => {
    await store.ensureAccount("a1", "o1");
    expect(await store.addPaperFunds("a1", 500)).toBe(1500);
    expect(await store.getAccount("a1")).toMatchObject({ paperCash: 1500, paperStartCash: 1500 });
  });

  it("tracks today's realized PnL per mode from a counter, no index needed", async () => {
    await store.ensureAccount("a1", "o1");
    await store.recordTrade(trade(-3));
    await store.recordTrade(trade(1.25));
    await store.recordTrade(trade(-10, "live"));
    expect(await store.getDailyRealizedPnl("a1", "paper")).toBeCloseTo(-1.75);
    expect(await store.getDailyRealizedPnl("a1", "live")).toBeCloseTo(-10);
    expect(await store.getDailyRealizedPnl("nobody", "paper")).toBe(0);
  });

  it("lists trades even before the trades index exists", async () => {
    await store.recordTrade(trade(1));
    await store.recordTrade(trade(2));
    expect((await store.listTrades("a1")).length).toBe(2);
    missingIndexes = false;
    expect((await store.listTrades("a1")).length).toBe(2);
  });

  it("keys the counter by UTC day", () => {
    expect(store.dayKey(new Date("2026-10-09T23:59:00Z"))).toBe("d20261009");
  });
});
