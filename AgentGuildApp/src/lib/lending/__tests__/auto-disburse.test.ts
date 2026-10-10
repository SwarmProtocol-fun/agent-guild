import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// ── Fake Firestore: loans + the daily allowance docs, dotted updates, merge sets, increments, transactions ──
type Doc = Record<string, unknown>;
const INC = "__inc";
const store = new Map<string, Map<string, Doc>>();
const col = (name: string) => store.get(name) ?? store.set(name, new Map()).get(name)!;
const loans = col("loans");
function resolve(cur: unknown, v: unknown) {
    return v && typeof v === "object" && INC in (v as Doc) ? ((cur as number) || 0) + (v as Record<string, number>)[INC] : v;
}
function applyUpdate(doc: Doc, patch: Doc): Doc {
    const out: Doc = structuredClone(doc);
    for (const [path, v] of Object.entries(patch)) {
        const keys = path.split(".");
        let cur = out as Record<string, unknown>;
        for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
        const last = keys[keys.length - 1];
        cur[last] = resolve(cur[last], v);
    }
    return out;
}
const read = (doc: Doc, path: string) => path.split(".").reduce<unknown>((o, k) => (o as Doc | undefined)?.[k], doc);
const ref = (name: string, id: string) => ({
    id,
    get: async () => ({ id, exists: col(name).has(id), data: () => col(name).get(id) }),
    update: async (p: Doc) => { col(name).set(id, applyUpdate(col(name).get(id)!, p)); },
    set: async (p: Doc) => { col(name).set(id, applyUpdate(col(name).get(id) ?? {}, p)); },
});
const where = (name: string, filters: [string, unknown][]) => ({
    where: (f: string, _op: string, v: unknown) => where(name, [...filters, [f, v]]),
    get: async () => ({ docs: [...col(name).entries()].filter(([, d]) => filters.every(([f, v]) => read(d, f) === v)).map(([id, d]) => ({ id, data: () => d })) }),
});
const fakeDb = {
    collection: (name: string) => ({ doc: (id: string) => ref(name, id), where: (f: string, op: string, v: unknown) => where(name, []).where(f, op, v) }),
    runTransaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
        // Buffer writes so a throw rolls everything back, like Firestore.
        const writes: Array<() => Promise<void>> = [];
        const result = await fn({
            get: (r: ReturnType<typeof ref>) => r.get(),
            update: (r: ReturnType<typeof ref>, p: Doc) => { writes.push(() => r.update(p)); },
            set: (r: ReturnType<typeof ref>, p: Doc) => { writes.push(() => r.set(p)); },
        });
        for (const w of writes) await w();
        return result;
    },
};
vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => fakeDb }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { increment: (n: number) => ({ [INC]: n }) } }));

// ── Chain fakes ──
const PAYOUT_KEY = Keypair.generate();
const PAYOUT = PAYOUT_KEY.publicKey.toBase58();
const BORROWER = Keypair.generate().publicKey.toBase58();
const chain = {
    lamports: 1_000_000_000,
    usdc: 1_000,
    sendRawTransaction: vi.fn(async () => `sig${chain.sendRawTransaction.mock.calls.length}`),
    simulateErr: null as unknown,
    finalized: true,
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
        async getSignatureStatuses() { return { value: [{ confirmationStatus: "confirmed" }] }; }
    }
    return { ...real, Connection };
});
vi.mock("@/lib/solana/lending-verify", () => ({ usdcMintAddress: () => Keypair.generate().publicKey.toBase58(), rpcUrl: () => "http://solana" }));
vi.mock("@/lib/ethereum/lending-verify", () => ({ ethLendingNetwork: () => "sepolia", rpcUrl: () => "http://eth" }));
vi.mock("../verify", () => ({ treasuryFor: () => "TREASURY" }));
vi.mock("@/lib/vault/store", () => ({ auditQuietly: vi.fn() }));
vi.mock("@/lib/agent-wallets", () => ({ listAgentWallets: vi.fn(async () => []), getAgentWalletKeypair: vi.fn(), getAgentWalletEvmPrivateKey: vi.fn() }));
const service = {
    getLoan: vi.fn(async (id: string) => (loans.has(id) ? { id, ...loans.get(id) } : null)),
    confirmLoanDisbursement: vi.fn(async (id: string, txSig: string) => {
        loans.set(id, { ...loans.get(id)!, status: "active", disbursementTxSig: txSig });
        return { id, ...loans.get(id) };
    }),
    postLoanCollateral: vi.fn(), addLoanCollateral: vi.fn(), repayLoan: vi.fn(), listRepaymentsForLoan: vi.fn(async () => []),
};
vi.mock("../lending-service", () => service);

const ad = await import("../auto-disburse");
const { auditQuietly } = await import("@/lib/vault/store");

const poolLoan = (extra: Doc = {}) => ({
    borrowerAgentId: "ag1", borrowerOrgId: "org1", borrowerWalletAddress: BORROWER, source: "pool", poolId: "community",
    status: "pending_disbursement", principal: 100, ...extra,
});
const today = () => col("lendingAutoDisburse").get(new Date().toISOString().slice(0, 10))?.usd;

describe("automatic disbursement of small pool loans", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        store.clear();
        store.set("loans", loans);
        loans.clear();
        Object.assign(chain, { lamports: 1_000_000_000, usdc: 1_000, simulateErr: null, finalized: true });
        process.env.LENDING_AUTO_DISBURSE_MAX_USD = "500";
        process.env.LENDING_AUTO_DISBURSE_DAILY_USD = "1000";
        process.env.LENDING_PAYOUT_SOLANA_SECRET_KEY = bs58.encode(PAYOUT_KEY.secretKey);
        delete process.env.LENDING_PAUSED;
    });

    it("pays a loan under the limit from the payout wallet, exactly once, and activates it", async () => {
        loans.set("L1", poolLoan());
        const r = await ad.autoDisburseLoan("L1", { wait: true });
        expect(r.status).toBe("posted");
        expect(chain.sendRawTransaction).toHaveBeenCalledTimes(1);
        expect(service.confirmLoanDisbursement).toHaveBeenCalledWith("L1", "sig1", { fromWallet: PAYOUT });
        expect(loans.get("L1")).toMatchObject({ status: "active", autoDisburseSend: { status: "posted", wallet: PAYOUT, recipient: BORROWER, amount: 100 } });
        expect(today()).toBe(100);
        expect(auditQuietly).toHaveBeenCalledWith(expect.objectContaining({ action: "lending.auto_disburse", target: "L1" }));

        expect((await ad.autoDisburseLoan("L1")).status).toBe("skipped");
        expect(chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    });

    it("leaves loans over the per-loan limit, or with payouts off, to an admin", async () => {
        loans.set("L1", poolLoan({ principal: 501 }));
        expect(await ad.autoDisburseLoan("L1")).toMatchObject({ status: "skipped", reason: expect.stringMatching(/\$500 automatic payout limit/) });
        delete process.env.LENDING_AUTO_DISBURSE_MAX_USD;
        loans.set("L2", poolLoan());
        expect(await ad.autoDisburseLoan("L2")).toMatchObject({ status: "skipped", reason: "Automatic payouts are off" });
        expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    });

    it("judges SOL/ETH loans by their USD value at request time", async () => {
        loans.set("L1", poolLoan({ asset: "sol", principal: 2, principalUsdValue: 600 }));
        expect((await ad.autoDisburseLoan("L1")).status).toBe("skipped");
        loans.set("L2", poolLoan({ asset: "sol", principal: 2 })); // no USD value recorded
        expect((await ad.autoDisburseLoan("L2")).status).toBe("skipped");
        loans.set("L3", poolLoan({ asset: "sol", principal: 0.5, principalUsdValue: 75 }));
        expect((await ad.autoDisburseLoan("L3", { wait: true })).status).toBe("posted");
    });

    it("stops at the daily limit", async () => {
        for (const id of ["L1", "L2", "L3"]) loans.set(id, poolLoan({ principal: 400 }));
        expect((await ad.autoDisburseLoan("L1", { wait: true })).status).toBe("posted");
        expect((await ad.autoDisburseLoan("L2", { wait: true })).status).toBe("posted");
        expect(await ad.autoDisburseLoan("L3")).toMatchObject({ status: "skipped", reason: expect.stringMatching(/limit .* is used up/) });
        expect(today()).toBe(800);
        expect(chain.sendRawTransaction).toHaveBeenCalledTimes(2);
    });

    it("waits in the queue when the payout wallet is short, and the sweep pays it once topped up", async () => {
        loans.set("L1", poolLoan());
        chain.usdc = 50;
        expect(await ad.autoDisburseLoan("L1")).toMatchObject({ status: "skipped", reason: expect.stringMatching(/Payout wallet: Needs 100 USDC/) });
        chain.usdc = 1_000;
        expect((await ad.autoDisbursePending()).posted).toEqual(["L1"]);
    });

    it("never pays while lending is paused", async () => {
        process.env.LENDING_PAUSED = "true";
        loans.set("L1", poolLoan());
        expect(await ad.autoDisburseLoan("L1")).toMatchObject({ status: "skipped", reason: "Lending is paused" });
    });

    it("a failed simulation moves nothing and returns the day's allowance", async () => {
        loans.set("L1", poolLoan());
        chain.simulateErr = { InstructionError: [0, "Custom"] };
        expect((await ad.autoDisburseLoan("L1")).status).toBe("failed");
        expect(loans.get("L1")!.autoDisburseSend).toMatchObject({ status: "failed", txSig: null });
        expect(today()).toBe(0);
        chain.simulateErr = null;
        expect((await ad.autoDisburseLoan("L1", { wait: true })).status).toBe("posted");
    });

    it("a payout not final yet stays 'sent' and the sweep only re-verifies it", async () => {
        loans.set("L1", poolLoan());
        service.confirmLoanDisbursement.mockRejectedValueOnce(new Error("Transaction not found or not finalized yet"));
        expect((await ad.autoDisburseLoan("L1")).status).toBe("confirming");
        expect(loans.get("L1")!.autoDisburseSend).toMatchObject({ status: "sent", txSig: "sig1" });
        expect((await ad.autoDisbursePending()).posted).toEqual(["L1"]);
        expect(chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    });

    it("never re-sends a claim that died without recording its transaction — it's reported for an admin", async () => {
        loans.set("L1", poolLoan({ autoDisburseSend: { walletId: "platform-payout", wallet: PAYOUT, asset: "usdc", amount: 100, txSig: null, status: "sending", startedAt: Date.now() - 10 * 60_000, requestedBy: "auto-disburse", error: null } }));
        const swept = await ad.autoDisbursePending();
        expect(swept.errors[0]).toMatch(/never recorded its transaction/);
        expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    });

    it("never retries a payout that landed but didn't verify", async () => {
        loans.set("L1", poolLoan({ autoDisburseSend: { walletId: "platform-payout", wallet: PAYOUT, asset: "usdc", amount: 100, txSig: "sigX", status: "failed", startedAt: Date.now(), requestedBy: "auto-disburse", error: "Expected 100 USDC, got 10" } }));
        expect(await ad.autoDisburseLoan("L1")).toMatchObject({ status: "skipped", reason: expect.stringMatching(/needs an admin/) });
        expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    });

    it("tryAutoDisburse never throws and passes non-pending loans through", async () => {
        const active = { id: "L9", ...poolLoan({ status: "active" }) } as never;
        expect(await ad.tryAutoDisburse(active)).toEqual({ loan: active, autoDisburse: null });
        service.getLoan.mockRejectedValueOnce(new Error("boom"));
        const pending = { id: "L1", ...poolLoan() } as never;
        expect((await ad.tryAutoDisburse(pending)).autoDisburse).toMatchObject({ status: "skipped", reason: "boom" });
    });
});
