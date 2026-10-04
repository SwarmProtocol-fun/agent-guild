import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMod, RouteContext } from "../sdk";

type Data = Record<string, unknown>;

const db = vi.hoisted(() => {
  const cols = new Map<string, Map<string, Data>>();
  function bucket(name: string) {
    let rows = cols.get(name);
    if (!rows) {
      rows = new Map();
      cols.set(name, rows);
    }
    return rows;
  }
  function docRef(name: string, id: string) {
    return {
      id,
      parent: { id: name },
      async get() {
        const data = bucket(name).get(id);
        return { exists: data != null, data: () => data };
      },
      async set(data: Data) {
        bucket(name).set(id, { ...data });
      },
      async create(data: Data) {
        if (bucket(name).has(id)) {
          const err = new Error("already exists") as Error & { code: number };
          err.code = 6;
          throw err;
        }
        bucket(name).set(id, { ...data });
      },
      async delete() {
        bucket(name).delete(id);
      },
    };
  }
  let failCommit = false;
  return {
    clear() {
      cols.clear();
      failCommit = false;
    },
    failNextCommit() {
      failCommit = true;
    },
    admin() {
      return {
        collection(name: string) {
          return {
            doc: (id: string) => docRef(name, id),
            where(field: string, _op: string, value: unknown) {
              return {
                get: async () => ({
                  docs: [...bucket(name).entries()]
                    .filter(([, data]) => data[field] === value)
                    .map(([id, data]) => ({ id, data: () => data })),
                }),
              };
            },
          };
        },
        batch() {
          const ops: Array<{ name: string; id: string; data: Data }> = [];
          return {
            set(ref: { id: string; parent: { id: string } }, data: Data) {
              ops.push({ name: ref.parent.id, id: ref.id, data });
            },
            async commit() {
              if (failCommit) {
                failCommit = false;
                throw new Error("firestore unavailable");
              }
              for (const op of ops) bucket(op.name).set(op.id, { ...op.data });
            },
          };
        },
      };
    },
  };
});

const settleOnChains = vi.hoisted(() => vi.fn());
const hashJobResult = vi.hoisted(() => vi.fn(() => "hash-1"));
const verifyReceipt = vi.hoisted(() => vi.fn());
const getAgentCapabilities = vi.hoisted(() => vi.fn(async () => [{ key: "solana-settlement" }]));
const getOrganizationsByWalletAdmin = vi.hoisted(() => vi.fn(async () => [{ id: "o1" }]));

vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => db.admin() }));
vi.mock("@/lib/firestore-admin", () => ({
  getAgentCapabilities,
  getOrganizationsByWalletAdmin,
  getAgent: vi.fn(),
  getAgentsByOrg: vi.fn(async () => []),
  getModInstallations: vi.fn(async () => []),
}));
vi.mock("@/lib/settlement/registry", () => ({
  settleOnChains,
  hashJobResult,
  verifyReceipt,
  getBalance: vi.fn(),
}));
vi.mock("@/lib/solana/platform", () => ({
  agentAlreadyRegistered: vi.fn(),
  getAgentSlashingHistoryOnChain: vi.fn(),
  mintIdentityToken: vi.fn(),
}));
vi.mock("@/lib/solana/client", () => ({ getScoreEventHistoryForAsn: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ requireOrgMembershipByAddress: vi.fn() }));
vi.mock("@/lib/agent-wallets", () => ({
  listAgentWallets: vi.fn(async () => []),
  generateAgentWallet: vi.fn(),
  getAgentWalletKeypair: vi.fn(),
}));
vi.mock("@/lib/gateway/store", () => ({
  enqueueTask: vi.fn(),
  getTask: vi.fn(),
  getAvailableWorkers: vi.fn(async () => []),
}));

const AGENT = { agent: { agentId: "a1", orgId: "o1" }, session: null };
const SESSION = { agent: null, session: { address: "OWNER", role: "operator" as const } };

function paid(txSig: string) {
  return {
    receipts: [{
      chain: "solana",
      txSig,
      receiptHash: "hash-1",
      explorerUrl: `https://explorer.solana.com/tx/${txSig}?cluster=devnet`,
      reputationUpdated: false,
    }],
    errors: [],
  };
}

async function call(method: string, path: string, ctxBase: object, body?: unknown) {
  const { default: mod } = (await import("../../../../mods/solana-settlement/server")) as { default: ServerMod };
  const { matchRoute } = await import("../router");
  const url = new URL(`http://x/api/mods/solana-settlement${path}`);
  const matched = matchRoute(mod.routes!, method, url.pathname.split("/").slice(4));
  if (!matched) throw new Error(`no route ${method} ${path}`);
  const handler = typeof matched.def === "function" ? matched.def : matched.def.handler;
  const req = new Request(url, { method, body: body ? JSON.stringify(body) : undefined });
  const out = await handler(req, { params: matched.params, ...ctxBase } as unknown as RouteContext);
  return out instanceof Response ? out : Response.json(out);
}

const job = { agentWallet: "Wallet111", taskId: "job-1", amountUsdc: 1.5 };

beforeEach(() => {
  db.clear();
  settleOnChains.mockReset();
  verifyReceipt.mockReset();
  hashJobResult.mockClear();
  getAgentCapabilities.mockResolvedValue([{ key: "solana-settlement" }]);
  getOrganizationsByWalletAdmin.mockResolvedValue([{ id: "o1" }]);
});

describe("solana settlement ledger", () => {
  it("keeps the receipt after the handler returns, scoped to the caller's org", async () => {
    settleOnChains.mockResolvedValue(paid("sig-1"));
    const settled = await call("POST", "/settle", AGENT, job);
    expect(settled.status).toBe(200);
    expect((await settled.json()).persisted).toBe(true);
    expect(settleOnChains).toHaveBeenCalledTimes(1);

    const history = await (await call("GET", "/history", SESSION)).json();
    expect(history.history).toHaveLength(1);
    expect(history.history[0].txSig).toBe("sig-1");
    expect(history.history[0].amountUsdc).toBe(1.5);

    getOrganizationsByWalletAdmin.mockResolvedValue([{ id: "other-org" }]);
    const hidden = await (await call("GET", "/history", SESSION)).json();
    expect(hidden.history).toEqual([]);
  });

  it("does not pay a second time when the same job is settled again", async () => {
    settleOnChains.mockResolvedValue(paid("sig-1"));
    await call("POST", "/settle", AGENT, job);
    const again = await call("POST", "/settle", AGENT, job);
    const body = await again.json();
    expect(again.status).toBe(200);
    expect(body.replayed).toBe(true);
    expect(body.receipt.txSig).toBe("sig-1");
    expect(settleOnChains).toHaveBeenCalledTimes(1);

    const total = await (await call("GET", "/agent/a1/total", AGENT)).json();
    expect(total).toMatchObject({ agentId: "a1", totalUsdc: 1.5, settlementCount: 1 });
  });

  it("verifies the stored hash from chain, and hides another org's signature", async () => {
    settleOnChains.mockResolvedValue(paid("sig-1"));
    verifyReceipt.mockResolvedValue({ found: true, hashVerified: true });
    await call("POST", "/settle", AGENT, job);

    const verified = await call("GET", "/verify/sig-1", SESSION);
    expect(verified.status).toBe(200);
    expect(verifyReceipt).toHaveBeenCalledWith("solana", "sig-1", "hash-1");

    getOrganizationsByWalletAdmin.mockResolvedValue([{ id: "other-org" }]);
    expect((await call("GET", "/verify/sig-1", SESSION)).status).toBe(404);
    expect((await call("GET", "/verify/missing", SESSION)).status).toBe(404);
  });

  it("releases the claim when the chain pays nothing, so a later try can pay", async () => {
    settleOnChains.mockResolvedValueOnce({ receipts: [], errors: [{ chain: "solana", error: "dry" }] });
    const failed = await call("POST", "/settle", AGENT, job);
    expect(failed.status).toBe(502);

    settleOnChains.mockResolvedValueOnce(paid("sig-2"));
    const retried = await call("POST", "/settle", AGENT, job);
    expect(retried.status).toBe(200);
    expect((await retried.json()).receipt.txSig).toBe("sig-2");
    expect(settleOnChains).toHaveBeenCalledTimes(2);
  });

  it("pins the signature when the receipt write fails, so the retry does not pay again", async () => {
    settleOnChains.mockResolvedValue(paid("sig-1"));
    db.failNextCommit();
    const first = await call("POST", "/settle", AGENT, job);
    expect(first.status).toBe(200);
    expect((await first.json()).persisted).toBe(false);

    const again = await call("POST", "/settle", AGENT, job);
    const body = await again.json();
    expect(body.replayed).toBe(true);
    expect(body.receipt.txSig).toBe("sig-1");
    expect(settleOnChains).toHaveBeenCalledTimes(1);
  });

  it("rejects a settle from an agent without the capability", async () => {
    getAgentCapabilities.mockResolvedValue([]);
    const res = await call("POST", "/settle", AGENT, job);
    expect(res.status).toBe(403);
    expect(settleOnChains).not.toHaveBeenCalled();
  });
});
