// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// ─── in-memory Firestore: vaultRuntimes + agents ──────────────
const store = new Map<string, Map<string, Record<string, unknown>>>();
const coll = (name: string) => (store.get(name) ?? store.set(name, new Map()).get(name)!);
function ref(name: string, id: string) {
  return {
    id,
    get: async () => ({ id, exists: coll(name).has(id), data: () => coll(name).get(id), ref: ref(name, id) }),
    set: async (d: Record<string, unknown>) => { coll(name).set(id, { ...d }); },
    update: async (p: Record<string, unknown>) => { Object.assign(coll(name).get(id)!, p); },
  };
}
vi.mock("@/lib/firebase-admin", () => ({
  adminDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ref(name, id),
      where: (field: string, _op: string, value: unknown) => ({
        limit: () => ({
          get: async () => {
            const docs = [...coll(name).entries()].filter(([, d]) => d[field] === value).map(([id]) => ({ id, ref: ref(name, id) }));
            return { empty: docs.length === 0, docs };
          },
        }),
        get: async () => ({ docs: [...coll(name).entries()].filter(([, d]) => d[field] === value).map(([id, d]) => ({ id, data: () => d })) }),
      }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ get: (r: ReturnType<typeof ref>) => r.get(), update: (r: ReturnType<typeof ref>, p: Record<string, unknown>) => r.update(p) }),
  }),
}));
vi.mock("@/lib/compute/firestore", () => ({
  getComputer: async (id: string) => (id === "comp1" ? { id, orgId: "org1" } : null),
}));

import { connectRuntime, enrollRuntime, runtimeToken, revokeRuntime } from "../runtimes";
import { decodeAgentToken } from "@/lib/agent-tokens";

beforeAll(() => { process.env.SESSION_SECRET = "s".repeat(64); });
beforeEach(() => {
  store.clear();
  coll("agents").set("agentA", { orgId: "org1", name: "A" });
});

const connect = () => connectRuntime({ orgId: "org1", computerId: "comp1", agentId: "agentA", scopes: ["bindings:execute"], bindings: ["gh"], createdBy: "0xowner" });

describe("runtime connection", () => {
  it("refuses computers and agents from other orgs", async () => {
    await expect(connectRuntime({ orgId: "org1", computerId: "nope", agentId: "agentA", scopes: ["bindings:list"], createdBy: "x" })).rejects.toThrow(/Computer not found/);
    coll("agents").set("agentB", { orgId: "org2" });
    await expect(connectRuntime({ orgId: "org1", computerId: "comp1", agentId: "agentB", scopes: ["bindings:list"], createdBy: "x" })).rejects.toThrow(/Agent not found/);
  });

  it("enrolls once, then mints scoped 1-hour tokens", async () => {
    const { enrollCode } = await connect();
    expect(JSON.stringify(coll("vaultRuntimes").get("comp1"))).not.toContain(enrollCode); // only the hash is stored

    const { runtimeId, credential } = await enrollRuntime(enrollCode);
    expect(runtimeId).toBe("comp1");
    await expect(enrollRuntime(enrollCode)).rejects.toThrow(/already used/);

    const { token } = await runtimeToken(runtimeId, credential);
    const claims = await decodeAgentToken(token);
    expect(claims).toMatchObject({ agentId: "agentA", orgId: "org1", scopes: ["bindings:execute"], bindings: ["gh"] });
    expect(claims!.expiresAt - claims!.issuedAt).toBe(3600);
  });

  it("rejects expired codes", async () => {
    const { enrollCode } = await connect();
    coll("vaultRuntimes").get("comp1")!.enrollExpiresAt = { toMillis: () => Date.now() - 1 };
    await expect(enrollRuntime(enrollCode)).rejects.toThrow(/expired/);
  });

  it("rejects wrong credentials, revoked runtimes and agents that left the org", async () => {
    const { enrollCode } = await connect();
    const { runtimeId, credential } = await enrollRuntime(enrollCode);
    await expect(runtimeToken(runtimeId, "agrt_wrong")).rejects.toThrow(/Invalid/);
    await expect(runtimeToken(runtimeId, "not-a-credential")).rejects.toThrow(/Invalid/);

    coll("agents").set("agentA", { orgId: "org2" });
    await expect(runtimeToken(runtimeId, credential)).rejects.toThrow(/no longer belongs/);
    coll("agents").set("agentA", { orgId: "org1" });

    await revokeRuntime("org1", "comp1");
    await expect(runtimeToken(runtimeId, credential)).rejects.toThrow(/revoked/);
    await expect(revokeRuntime("org2", "comp1")).rejects.toThrow(/not found/);
  });

  it("reconnecting invalidates the previous credential", async () => {
    const first = await enrollRuntime((await connect()).enrollCode);
    await enrollRuntime((await connect()).enrollCode);
    await expect(runtimeToken(first.runtimeId, first.credential)).rejects.toThrow(/Invalid/);
  });
});
