import { describe, it, expect, vi, beforeEach } from "vitest";

/** Tiny in-memory Firestore: collections of docs, where(==) filters, add/update. */
const data: Record<string, Record<string, Record<string, unknown>>> = {};
let nextId = 0;
function coll(name: string) {
  data[name] ??= {};
  const docs = data[name];
  const q = (filters: [string, unknown][]) => ({
    where: (f: string, _op: string, v: unknown) => q([...filters, [f, v]]),
    limit: () => q(filters),
    get: async () => {
      const hits = Object.entries(docs).filter(([, d]) => filters.every(([f, v]) => d[f] === v));
      return { empty: !hits.length, docs: hits.map(([id, d]) => ({ id, data: () => d })) };
    },
  });
  return {
    ...q([]),
    add: async (d: Record<string, unknown>) => { const id = `d${nextId++}`; docs[id] = d; return { id }; },
    doc: (id: string) => ({ update: async (patch: Record<string, unknown>) => { docs[id] = { ...docs[id], ...patch }; } }),
  };
}
vi.mock("../firebase-admin", () => ({ adminDb: () => ({ collection: coll }) }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "ts" } }));

const { getModInstallStatus, enableModCapabilities } = await import("../firestore-admin");
const MOD = "mod-polymarket-trading";
const CAPS = ["polymarket-trade", "polymarket-run-bots"];

describe("mod install status", () => {
  beforeEach(() => { for (const k of Object.keys(data)) delete data[k]; });

  it("is missing when the org has neither an install doc nor the Market item", async () => {
    expect((await getModInstallStatus("org1", MOD)).installed).toBe(false);
    expect(await enableModCapabilities("org1", MOD, CAPS)).toEqual({ installed: false, enabled: [] });
    expect(Object.keys(data.modInstallations ?? {})).toHaveLength(0);
  });

  it("counts a Market install (inventory only) as installed, and the grant creates the install doc", async () => {
    await coll("installedSkills").add({ orgId: "org1", skillId: "polymarket-trading", enabled: true });
    await coll("installedSkills").add({ orgId: "org2", skillId: "polymarket-trading", enabled: true });
    expect(await getModInstallStatus("org1", MOD)).toEqual({ installed: true, enabled: true, installationId: null, enabledCapabilities: [] });

    expect(await enableModCapabilities("org1", MOD, CAPS)).toEqual({ installed: true, enabled: CAPS });
    const installs = Object.values(data.modInstallations);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ modId: MOD, orgId: "org1", enabled: true, enabledCapabilities: CAPS });

    // Second grant finds the doc and adds nothing.
    expect(await enableModCapabilities("org1", MOD, CAPS)).toEqual({ installed: true, enabled: [] });
    expect(Object.values(data.modInstallations)).toHaveLength(1);
  });

  it("doesn't treat another org's Market item as installed", async () => {
    await coll("installedSkills").add({ orgId: "org2", skillId: "polymarket-trading", enabled: true });
    expect((await getModInstallStatus("org1", MOD)).installed).toBe(false);
  });
});
