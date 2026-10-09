import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@solana/web3.js";

// ── Fake Firestore: the loans collection, dotted-path updates, transactions, equality queries ──
type Doc = Record<string, unknown>;
const loans = new Map<string, Doc>();
function applyUpdate(doc: Doc, patch: Doc): Doc {
    const out: Doc = structuredClone(doc);
    for (const [path, v] of Object.entries(patch)) {
        const keys = path.split(".");
        let cur = out as Record<string, unknown>;
        for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
        cur[keys[keys.length - 1]] = v;
    }
    return out;
}
const read = (doc: Doc, path: string) => path.split(".").reduce<unknown>((o, k) => (o as Doc | undefined)?.[k], doc);
const ref = (id: string) => ({
    id,
    get: async () => ({ id, exists: loans.has(id), data: () => loans.get(id) }),
    update: async (p: Doc) => { loans.set(id, applyUpdate(loans.get(id)!, p)); },
});
const where = (filters: [string, unknown][]) => ({
    where: (f: string, _op: string, v: unknown) => where([...filters, [f, v]]),
    get: async () => ({ docs: [...loans.entries()].filter(([, d]) => filters.every(([f, v]) => read(d, f) === v)).map(([id, d]) => ({ id, data: () => d })) }),
});
const fakeDb = {
    collection: () => ({ doc: ref, where: (f: string, op: string, v: unknown) => where([]).where(f, op, v) }),
    runTransaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn({
        get: (r: ReturnType<typeof ref>) => r.get(),
        update: (r: ReturnType<typeof ref>, p: Doc) => r.update(p),
    }),
};
vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => fakeDb }));

// ── Chain fakes ──
const AGENT_KEY = Keypair.generate();
const TREASURY = Keypair.generate().publicKey.toBase58();
const chain = {
    lamports: 2_000_000_000,
    usdc: 0,
    sendRawTransaction: vi.fn(async () => chain.sigs[chain.sendRawTransaction.mock.calls.length - 1]),
    simulateErr: null as unknown,
    finalized: true,
    /** What getSignatureStatuses reports: true = the network knows the signature. */
    seen: true,
    sigs: ["sig1", "sig2", "sig3"],
};
vi.mock("@solana/web3.js", async (orig) => {
    const real = await orig<typeof import("@solana/web3.js")>();
    class Connection {
        async getBalance() { return chain.lamports; }
        async getTokenAccountBalance() { return { value: { uiAmount: chain.usdc } }; }
        async getLatestBlockhash() { return { blockhash: real.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }; }
        async simulateTransaction() { return { value: { err: chain.simulateErr } }; }
        sendRawTransaction = chain.sendRawTransaction;
        async confirmTransaction() { return { value: { err: chain.finalized ? null : "x" } }; }
        async getSignatureStatuses() { return { value: [chain.seen ? { confirmationStatus: "confirmed" } : null] }; }
    }
    return { ...real, Connection };
});
vi.mock("@/lib/solana/lending-verify", () => ({ usdcMintAddress: () => Keypair.generate().publicKey.toBase58(), rpcUrl: () => "http://solana" }));
vi.mock("@/lib/ethereum/lending-verify", () => ({ ethLendingNetwork: () => "sepolia", rpcUrl: () => "http://eth" }));
vi.mock("../verify", () => ({ treasuryFor: () => TREASURY }));
vi.mock("@/lib/vault/store", () => ({ auditQuietly: vi.fn() }));
const wallets = {
    listAgentWallets: vi.fn(async () => [{ id: "w1", chain: "solana", publicKey: AGENT_KEY.publicKey.toBase58(), agentId: "ag1", orgId: "org1" }]),
    getAgentWalletKeypair: vi.fn(async () => AGENT_KEY),
    getAgentWalletEvmPrivateKey: vi.fn(),
};
vi.mock("@/lib/agent-wallets", () => wallets);
const service = {
    getLoan: vi.fn(async (id: string) => (loans.has(id) ? { id, ...loans.get(id) } : null)),
    postLoanCollateral: vi.fn(async (id: string) => ({ id, status: "pending_disbursement" })),
    addLoanCollateral: vi.fn(async (id: string) => ({ id, status: "active" })),
    repayLoan: vi.fn(async (id: string) => ({ loan: { id, status: "active" }, repayment: {} })),
    listRepaymentsForLoan: vi.fn(async () => [] as Array<{ txSig?: string }>),
};
vi.mock("../lending-service", () => service);

const ac = await import("../agent-collateral");
const ar = await import("../agent-repay");
const { auditQuietly } = await import("@/lib/vault/store");

const solLoan = (extra: Doc = {}) => ({
    borrowerAgentId: "ag1", borrowerOrgId: "org1", status: "pending_collateral", collateralStatus: "awaiting",
    asset: "usdc", collateralAsset: "sol", collateral: 0.5, ...extra,
});

describe("posting collateral from the agent's wallet", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        loans.clear();
        Object.assign(chain, { lamports: 2_000_000_000, usdc: 0, simulateErr: null, finalized: true, seen: true });
    });

    it("sends exactly once, from the agent's wallet to the treasury, then posts it", async () => {
        loans.set("L1", solLoan());
        const r = await ac.postCollateralFromAgentWallet("L1", "0xmember");
        expect(r.status).toBe("posted");
        expect(chain.sendRawTransaction).toHaveBeenCalledTimes(1);
        expect(service.postLoanCollateral).toHaveBeenCalledWith("L1", AGENT_KEY.publicKey.toBase58(), "sig1");
        expect(loans.get("L1")!.agentCollateralSend).toMatchObject({ status: "posted", txSig: "sig1", walletId: "w1", amount: 0.5, requestedBy: "0xmember" });
        expect(auditQuietly).toHaveBeenCalledWith(expect.objectContaining({ action: "lending.collateral_from_agent_wallet", target: "L1" }));
    });

    it("never re-sends once a transfer is on-chain: a retry only re-verifies", async () => {
        loans.set("L1", solLoan({ agentCollateralSend: { walletId: "w1", wallet: "W", asset: "sol", amount: 0.5, txSig: "sigOld", status: "sent", startedAt: Date.now(), requestedBy: "x", error: null } }));
        await ac.postCollateralFromAgentWallet("L1", "0xmember");
        expect(chain.sendRawTransaction).not.toHaveBeenCalled();
        expect(service.postLoanCollateral).toHaveBeenCalledWith("L1", "W", "sigOld");
    });

    it("refuses a second send while one is mid-flight", async () => {
        loans.set("L1", solLoan({ agentCollateralSend: { walletId: "w1", wallet: "W", asset: "sol", amount: 0.5, txSig: null, status: "sending", startedAt: Date.now(), requestedBy: "x", error: null } }));
        await expect(ac.postCollateralFromAgentWallet("L1", "0xmember")).rejects.toMatchObject({ status: 409 });
        expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    });

    it("explains a shortfall with the address to fund, and sends nothing", async () => {
        loans.set("L1", solLoan());
        chain.lamports = 100_000_000; // 0.1 SOL
        await expect(ac.postCollateralFromAgentWallet("L1", "0xmember")).rejects.toThrow(new RegExp(`${AGENT_KEY.publicKey.toBase58()}.*Needs 0.5 SOL`));
        expect(chain.sendRawTransaction).not.toHaveBeenCalled();
        const q = await ac.quoteAgentCollateral("L1");
        expect(q.wallets[0]).toMatchObject({ enough: false, balance: 0.1 });
    });

    it("a failed simulation moves nothing and frees the loan for a retry", async () => {
        loans.set("L1", solLoan());
        chain.simulateErr = { InstructionError: [0, "Custom"] };
        await expect(ac.postCollateralFromAgentWallet("L1", "0xmember")).rejects.toThrow(/Simulation failed/);
        expect(chain.sendRawTransaction).not.toHaveBeenCalled();
        expect(loans.get("L1")!.agentCollateralSend).toMatchObject({ status: "failed", txSig: null });
        chain.simulateErr = null;
        expect((await ac.postCollateralFromAgentWallet("L1", "0xmember")).status).toBe("posted");
    });

    it("a transfer that isn't final yet stays 'sent', and the sweep step finishes it later", async () => {
        loans.set("L1", solLoan());
        chain.finalized = false;
        service.postLoanCollateral.mockRejectedValueOnce(new Error("Transaction not found or not finalized yet — wait a few seconds and retry"));
        const r = await ac.postCollateralFromAgentWallet("L1", "0xmember");
        expect(r.status).toBe("confirming");
        expect(loans.get("L1")!.agentCollateralSend).toMatchObject({ status: "sent", txSig: "sig1" });

        const swept = await ac.finishPendingAgentCollateral();
        expect(swept.posted).toEqual(["L1"]);
        expect(chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    });

    it("a real verification failure is recorded, not retried as 'confirming'", async () => {
        loans.set("L1", solLoan());
        service.postLoanCollateral.mockRejectedValueOnce(new Error("Expected at least 0.5 SOL to arrive"));
        const r = await ac.postCollateralFromAgentWallet("L1", "0xmember");
        expect(r.status).toBe("failed");
        expect(loans.get("L1")!.agentCollateralSend).toMatchObject({ status: "failed", error: expect.stringMatching(/Expected at least/) });
    });

    it("an RPC error while verifying is not a failure: the send stays 'sent' and the loan keeps waiting", async () => {
        loans.set("L1", solLoan());
        service.postLoanCollateral.mockRejectedValueOnce(new Error("fetch failed"));
        expect((await ac.postCollateralFromAgentWallet("L1", "0xmember")).status).toBe("confirming");
        expect(loans.get("L1")!.agentCollateralSend).toMatchObject({ status: "sent", txSig: "sig1" });
        expect((await ac.finishPendingAgentCollateral()).posted).toEqual(["L1"]);
    });

    it("after a definitive failure, a retry sends a fresh transfer instead of re-checking the dead one", async () => {
        loans.set("L1", solLoan());
        service.postLoanCollateral.mockRejectedValueOnce(new Error("Transaction failed on-chain: {}"));
        expect((await ac.postCollateralFromAgentWallet("L1", "0xmember")).status).toBe("failed");
        expect((await ac.postCollateralFromAgentWallet("L1", "0xmember")).status).toBe("posted");
        expect(chain.sendRawTransaction).toHaveBeenCalledTimes(2);
        expect(service.postLoanCollateral).toHaveBeenLastCalledWith("L1", expect.any(String), "sig2");
    });

    it("a Solana transfer the network never saw is released after 10 minutes so it can be retried", async () => {
        const old = Date.now() - 11 * 60_000;
        loans.set("L1", solLoan({ agentCollateralSend: { walletId: "w1", wallet: "W", asset: "sol", amount: 0.5, txSig: "sigLost", status: "sent", startedAt: old, sentAt: old, requestedBy: "x", error: null } }));
        service.postLoanCollateral.mockRejectedValueOnce(new Error("Transaction not found or not finalized yet — wait a few seconds and retry"));
        chain.seen = false;
        const r = await ac.finishAgentCollateral("L1");
        expect(r.status).toBe("failed");
        expect(loans.get("L1")!.agentCollateralSend).toMatchObject({ status: "failed", txSig: null, error: expect.stringMatching(/dropped/) });
        chain.seen = true;
        expect((await ac.postCollateralFromAgentWallet("L1", "0xmember")).status).toBe("posted");
        expect(chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    });

    it("a slow transfer the network has seen is never released, however old", async () => {
        const old = Date.now() - 60 * 60_000;
        loans.set("L1", solLoan({ agentCollateralSend: { walletId: "w1", wallet: "W", asset: "sol", amount: 0.5, txSig: "sigSlow", status: "sent", startedAt: old, sentAt: old, requestedBy: "x", error: null } }));
        service.postLoanCollateral.mockRejectedValueOnce(new Error("Transaction not found or not finalized yet — wait a few seconds and retry"));
        expect((await ac.finishAgentCollateral("L1")).status).toBe("confirming");
        expect(loans.get("L1")!.agentCollateralSend).toMatchObject({ status: "sent", txSig: "sigSlow" });
    });

    it("collateral that lands after the loan was cancelled is marked returned (its return is queued by the ledger)", async () => {
        loans.set("L1", solLoan({ status: "cancelled", agentCollateralSend: { walletId: "w1", wallet: "W", asset: "sol", amount: 0.5, txSig: "sigLate", status: "sent", startedAt: Date.now(), requestedBy: "x", error: null } }));
        service.postLoanCollateral.mockRejectedValueOnce(new Error("This loan is no longer awaiting collateral (status: cancelled). Your transfer was recorded and its return has been queued."));
        expect((await ac.finishPendingAgentCollateral()).errors).toHaveLength(1);
        expect(loans.get("L1")!.agentCollateralSend).toMatchObject({ status: "returned" });
    });

    it("a send the ledger already credited (crash before the status write) settles as posted", async () => {
        loans.set("L1", solLoan({ status: "pending_disbursement", collateralStatus: "held", collateralTxSig: "sigDone", agentCollateralSend: { walletId: "w1", wallet: "W", asset: "sol", amount: 0.5, txSig: "sigDone", status: "sent", startedAt: Date.now(), requestedBy: "x", error: null } }));
        expect((await ac.finishAgentCollateral("L1")).status).toBe("posted");
        expect(service.postLoanCollateral).not.toHaveBeenCalled();
    });

    it("tells you to create a wallet when the agent has none on that chain", async () => {
        loans.set("L1", solLoan({ collateralAsset: "eth" }));
        await expect(ac.postCollateralFromAgentWallet("L1", "0xmember")).rejects.toThrow(/no Ethereum wallet yet/);
    });

    it("refuses loans that aren't awaiting collateral", async () => {
        loans.set("L1", solLoan({ status: "active", collateralStatus: "held" }));
        await expect(ac.postCollateralFromAgentWallet("L1", "0xmember")).rejects.toThrow(/isn't awaiting collateral/);
        expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    });
});

describe("adding collateral from the agent's wallet", () => {
    const marketLoan = (extra: Doc = {}) => solLoan({ status: "active", collateralStatus: "held", collateralPostedByWallet: AGENT_KEY.publicKey.toBase58(), ...extra });
    beforeEach(() => {
        vi.clearAllMocks();
        loans.clear();
        Object.assign(chain, { lamports: 2_000_000_000, usdc: 0, simulateErr: null, finalized: true, seen: true });
    });

    it("sends from the wallet that posted the collateral and adds it to the loan", async () => {
        loans.set("L1", marketLoan());
        const r = await ac.topUpFromAgentWallet("L1", 0.25, "0xmember");
        expect(r.status).toBe("posted");
        expect(service.addLoanCollateral).toHaveBeenCalledWith("L1", AGENT_KEY.publicKey.toBase58(), 0.25, "sig1");
        expect(loans.get("L1")!.agentTopUpSend).toMatchObject({ status: "posted", amount: 0.25 });
    });

    it("refuses when the collateral came from a wallet that isn't the agent's", async () => {
        loans.set("L1", marketLoan({ collateralPostedByWallet: "SomeoneElse111" }));
        await expect(ac.topUpFromAgentWallet("L1", 0.25, "0xmember")).rejects.toThrow(/isn't one of this agent's/);
        expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    });

    it("refuses a loan that isn't active", async () => {
        loans.set("L1", marketLoan({ status: "liquidating" }));
        await expect(ac.topUpFromAgentWallet("L1", 0.25, "0xmember")).rejects.toThrow(/Only an active loan/);
        expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    });

    it("refuses non-market loans", async () => {
        loans.set("L1", marketLoan({ collateralAsset: undefined }));
        await expect(ac.topUpFromAgentWallet("L1", 0.25, "0xmember")).rejects.toThrow(/collateral-market/);
    });
});

describe("repaying from the agent's wallet", () => {
    const LENDER = Keypair.generate().publicKey.toBase58();
    const activeLoan = (extra: Doc = {}) => ({
        borrowerAgentId: "ag1", borrowerOrgId: "org1", status: "active", source: "solo", asset: "sol",
        lenderWalletAddress: LENDER, principal: 1, ...extra,
    });
    beforeEach(() => {
        vi.clearAllMocks();
        loans.clear();
        Object.assign(chain, { lamports: 2_000_000_000, usdc: 0, simulateErr: null, finalized: true, seen: true });
    });

    it("pays a solo loan's lender directly and applies it", async () => {
        loans.set("L1", activeLoan());
        const r = await ar.repayFromAgentWallet("L1", 0.4, "0xmember");
        expect(r.status).toBe("posted");
        expect(service.repayLoan).toHaveBeenCalledWith("L1", 0.4, AGENT_KEY.publicKey.toBase58(), "sig1");
        expect(loans.get("L1")!.agentRepaySend).toMatchObject({ recipient: LENDER, status: "posted" });
    });

    it("pays a pool loan to the treasury", async () => {
        loans.set("L1", activeLoan({ source: "pool", lenderWalletAddress: undefined }));
        await ar.repayFromAgentWallet("L1", 0.4, "0xmember");
        expect(loans.get("L1")!.agentRepaySend).toMatchObject({ recipient: TREASURY });
    });

    it("allows another repayment once the previous one settled, but not while one is in flight", async () => {
        loans.set("L1", activeLoan());
        await ar.repayFromAgentWallet("L1", 0.1, "0xmember");
        await ar.repayFromAgentWallet("L1", 0.1, "0xmember");
        expect(chain.sendRawTransaction).toHaveBeenCalledTimes(2);

        service.repayLoan.mockRejectedValueOnce(new Error("Transaction not found or not finalized yet"));
        expect((await ar.repayFromAgentWallet("L1", 0.1, "0xmember")).status).toBe("confirming");
        // A second click only re-checks the in-flight one.
        await ar.repayFromAgentWallet("L1", 0.1, "0xmember");
        expect(chain.sendRawTransaction).toHaveBeenCalledTimes(3);
    });

    it("a repayment the ledger already recorded settles as posted instead of hanging", async () => {
        loans.set("L1", activeLoan({ agentRepaySend: { walletId: "w1", wallet: "W", asset: "sol", amount: 0.1, txSig: "sigR", status: "sent", startedAt: Date.now(), requestedBy: "x", error: null } }));
        service.repayLoan.mockRejectedValueOnce(new Error("This transaction signature has already been used for a different credit"));
        service.listRepaymentsForLoan.mockResolvedValueOnce([]).mockResolvedValueOnce([{ txSig: "sigR" }]);
        expect((await ar.finishAgentRepay("L1")).status).toBe("posted");
    });

    it("refuses a loan that isn't active", async () => {
        loans.set("L1", activeLoan({ status: "repaid" }));
        await expect(ar.repayFromAgentWallet("L1", 0.1, "0xmember")).rejects.toThrow(/Only an active loan/);
    });
});

describe("collateral shortfalls", () => {
    it("reserves fees on top of the amount", () => {
        expect(ac.shortfallFor("sol", 1, 1.0005, 1.0005)).toMatch(/for fees/);
        expect(ac.shortfallFor("sol", 1, 1.01, 1.01)).toBeNull();
        expect(ac.shortfallFor("usdc", 50, 60, 0)).toMatch(/SOL for the network fee/);
        expect(ac.shortfallFor("usdc", 50, 40, 1)).toMatch(/Needs 50 USDC/);
        expect(ac.shortfallFor("eth", 0.2, 0.2, null)).toMatch(/gas/);
        expect(ac.shortfallFor("eth", 0.2, 0.21, null)).toBeNull();
        expect(ac.shortfallFor("eth", 0.2, null, null)).toMatch(/unavailable/);
    });
});
