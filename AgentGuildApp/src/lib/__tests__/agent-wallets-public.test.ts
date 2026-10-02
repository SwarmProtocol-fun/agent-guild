import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal in-memory Firestore: agents + agentWallets, with where("agentId"), batch updates.
type Row = Record<string, unknown>;
const store: Record<string, Map<string, Row>> = {};
function col(name: string) {
    store[name] ??= new Map();
    return store[name];
}
const snapOf = (name: string, id: string) => {
    const data = col(name).get(id);
    return {
        id,
        exists: !!data,
        data: () => data,
        ref: { name, id },
    };
};
const db = {
    collection: (name: string) => ({
        doc: (id: string) => ({ get: async () => snapOf(name, id) }),
        where: (field: string, _op: string, value: unknown) => {
            const q = {
                limit: () => q,
                get: async () => {
                    const docs = [...col(name).entries()].filter(([, d]) => d[field] === value).map(([id]) => snapOf(name, id));
                    return { docs, empty: docs.length === 0, size: docs.length };
                },
            };
            return q;
        },
    }),
    batch: () => {
        const ops: [{ name: string; id: string }, Row][] = [];
        return {
            update: (ref: { name: string; id: string }, data: Row) => ops.push([ref, data]),
            commit: async () => {
                for (const [ref, data] of ops) col(ref.name).set(ref.id, { ...col(ref.name).get(ref.id), ...data });
            },
        };
    },
};

class FakeTimestamp {
    constructor(private ms: number) {}
    toDate() {
        return new Date(this.ms);
    }
}

vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => db }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => null }, Timestamp: FakeTimestamp }));
vi.mock("@/lib/secrets", () => ({ encryptValue: () => ({ encryptedValue: "x", iv: "y" }), decryptValue: () => "" }));
vi.mock("@/lib/chains", () => ({ getChain: () => ({ rpc: "http://rpc" }) }));
vi.mock("@/lib/settlement/registry", () => ({ getBalance: async () => ({ usdc: 0 }) }));
vi.mock("@/lib/mods/hyperliquid-store", () => ({ setAgentWallet: async () => undefined }));
const getBalance = vi.fn(async () => 0);
vi.mock("@solana/web3.js", () => ({
    Keypair: { generate: () => ({}) },
    PublicKey: class {
        constructor(public k: string) {}
    },
    Connection: class {
        getBalance = getBalance;
    },
}));

const { listPublicAgentWallets, setPayoutWallet, WalletInputError } = await import("../agent-wallets");

const AGENT = "chef";
const IDENTITY = "B6zYAuTbuJngzhfKATyFk8P465YeftU5Bsnb9WVxV7R";

beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    getBalance.mockReset().mockResolvedValue(0);
    col("agents").set(AGENT, { orgId: "gang", solanaAddress: IDENTITY });
    col("agentWallets").set("sol1", {
        agentId: AGENT, orgId: "gang", chain: "solana", publicKey: "GXu", encryptedSecretKey: "SECRET", iv: "IV",
        createdAt: new FakeTimestamp(1),
    });
    col("agentWallets").set("evm1", {
        agentId: AGENT, orgId: "gang", chain: "evm", publicKey: "0xB15", encryptedSecretKey: "SECRET", iv: "IV",
        createdAt: new FakeTimestamp(2),
    });
});

describe("listPublicAgentWallets", () => {
    it("lists identity first, then custodial oldest first, with no key material", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const list = await listPublicAgentWallets(AGENT);

        expect(list.generated).toBe(2);
        expect(list.max).toBe(10);
        expect(list.wallets.map((w) => [w.id, w.chain, w.address, w.custodial])).toEqual([
            ["identity", "solana", IDENTITY, false],
            ["sol1", "solana", "GXu", true],
            ["evm1", "evm", "0xB15", true],
        ]);
        // Legacy wallet with no flag: oldest custodial Solana is payout; identity never is.
        expect(list.wallets.map((w) => w.payout)).toEqual([false, true, false]);
        expect(JSON.stringify(list)).not.toMatch(/SECRET|encryptedSecretKey|"iv"/);
        // Unregistered EVM: no Hyperliquid lookup.
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(list.wallets[2].balance.hyperliquidEquity).toBeNull();
        fetchSpy.mockRestore();
    });

    it("nulls one wallet's balance on a failed lookup without failing the list", async () => {
        getBalance.mockRejectedValueOnce(new Error("rpc down"));
        const list = await listPublicAgentWallets(AGENT);
        expect(list.wallets).toHaveLength(3);
        expect(list.wallets.filter((w) => w.balance.sol === null && w.chain === "solana")).toHaveLength(1);
    });

    it("skips balance lookups when balances: false", async () => {
        const list = await listPublicAgentWallets(AGENT, undefined, { balances: false });
        expect(getBalance).not.toHaveBeenCalled();
        expect(list.wallets.every((w) => w.balance.sol === null)).toBe(true);
    });
});

describe("setPayoutWallet", () => {
    it("moves the flag between custodial Solana wallets", async () => {
        col("agentWallets").set("sol2", {
            agentId: AGENT, orgId: "gang", chain: "solana", publicKey: "S2", createdAt: new FakeTimestamp(3),
        });
        await setPayoutWallet(AGENT, "gang", "sol2");
        const list = await listPublicAgentWallets(AGENT, undefined, { balances: false });
        expect(list.wallets.filter((w) => w.payout).map((w) => w.id)).toEqual(["sol2"]);
    });

    it("rejects EVM, identity, and other agents' wallets", async () => {
        col("agentWallets").set("other", { agentId: "grok", orgId: "gang", chain: "solana", publicKey: "O" });
        await expect(setPayoutWallet(AGENT, "gang", "evm1")).rejects.toBeInstanceOf(WalletInputError);
        await expect(setPayoutWallet(AGENT, "gang", "identity")).rejects.toBeInstanceOf(WalletInputError);
        await expect(setPayoutWallet(AGENT, "gang", "other")).rejects.toBeInstanceOf(WalletInputError);
    });
});
