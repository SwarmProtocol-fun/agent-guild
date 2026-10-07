import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory Firestore fake (just what verifyGigUpfrontPayment touches) ──
const store = new Map<string, Record<string, unknown>>();
const docRef = (col: string, id: string) => ({
    path: `${col}/${id}`,
    get: async () => ({ exists: store.has(`${col}/${id}`), data: () => store.get(`${col}/${id}`) }),
});
const fakeDb = {
    collection: (col: string) => ({ doc: (id: string) => docRef(col, id) }),
    runTransaction: async (fn: (txn: unknown) => Promise<void>) => {
        const writes: (() => void)[] = [];
        await fn({
            create: (ref: { path: string }, data: Record<string, unknown>) => {
                if (store.has(ref.path)) throw Object.assign(new Error("exists"), { code: 6 });
                writes.push(() => store.set(ref.path, data));
            },
            update: (ref: { path: string }, data: Record<string, unknown>) => {
                writes.push(() => store.set(ref.path, { ...store.get(ref.path), ...data }));
            },
        });
        writes.forEach((w) => w());
    },
};
vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => fakeDb }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "ts" } }));
vi.mock("@/lib/solana/client", () => ({ SOLANA_RPC_URL: "http://rpc.test" }));

let parsedTx: unknown = null;
vi.mock("@solana/web3.js", () => ({
    Connection: vi.fn(function () { return { getParsedTransaction: async () => parsedTx }; }),
}));

import { systemTransferLamports, verifyGigUpfrontPayment } from "../gig-payment-verify";

const BUYER = "Buyer111", SELLER = "Seller222", ATTACKER = "Attacker333";
const transfer = (source: string, destination: string, lamports: number) =>
    ({ program: "system", parsed: { type: "transfer", info: { source, destination, lamports } } });
const txWith = (...ixs: unknown[]) => ({ meta: { err: null }, transaction: { message: { instructions: ixs } } });

function seedOrder(jobId: string, sig: string, claimant = SELLER) {
    store.set("gigs/g1", { sellerSolanaAddress: SELLER, priceLamports: 1_000_000 });
    store.set(`jobs/${jobId}`, {
        gigId: "g1",
        escrow: { upfrontTransferTxSig: sig, posterSolanaAddress: BUYER, claimantSolanaAddress: claimant },
    });
}

describe("systemTransferLamports", () => {
    it("sums only system transfers from source to destination", () => {
        const ixs = [
            transfer(BUYER, SELLER, 300),
            transfer(BUYER, SELLER, 200),
            transfer(BUYER, ATTACKER, 999),
            { program: "spl-token", parsed: { type: "transfer", info: { source: BUYER, destination: SELLER, lamports: 999 } } },
            { programId: "x", accounts: [], data: "" },
        ];
        expect(systemTransferLamports(ixs as never, BUYER, SELLER)).toBe(500);
    });
});

describe("verifyGigUpfrontPayment", () => {
    beforeEach(() => { store.clear(); parsedTx = null; });

    it("verifies a real half-price payment to the gig's seller and stamps the job", async () => {
        seedOrder("j1", "sigA");
        parsedTx = txWith(transfer(BUYER, SELLER, 500_000));
        expect(await verifyGigUpfrontPayment("j1")).toEqual({ verified: true, lamports: 500_000 });
        expect(store.get("jobs/j1")?.upfrontVerifiedAt).toBe("ts");
        expect(store.get("gigPaymentTxs/sigA")?.jobId).toBe("j1");
    });

    it("rejects an order whose payee isn't the gig's seller (buyer paid themselves)", async () => {
        seedOrder("j1", "sigA", ATTACKER);
        parsedTx = txWith(transfer(BUYER, ATTACKER, 500_000));
        const r = await verifyGigUpfrontPayment("j1");
        expect(r.verified).toBe(false);
        expect(store.get("jobs/j1")?.upfrontVerifiedAt).toBeUndefined();
    });

    it("rejects an underpayment", async () => {
        seedOrder("j1", "sigA");
        parsedTx = txWith(transfer(BUYER, SELLER, 499_999));
        expect((await verifyGigUpfrontPayment("j1")).verified).toBe(false);
    });

    it("rejects a failed transaction", async () => {
        seedOrder("j1", "sigA");
        parsedTx = { ...txWith(transfer(BUYER, SELLER, 500_000)), meta: { err: { InstructionError: [0, "x"] } } };
        expect((await verifyGigUpfrontPayment("j1")).verified).toBe(false);
    });

    it("reports a not-yet-finalized payment as retryable", async () => {
        seedOrder("j1", "sigA");
        expect(await verifyGigUpfrontPayment("j1")).toMatchObject({ verified: false, retryable: true });
    });

    it("rejects reusing one payment signature for a second order", async () => {
        seedOrder("j1", "sigA");
        parsedTx = txWith(transfer(BUYER, SELLER, 500_000));
        expect((await verifyGigUpfrontPayment("j1")).verified).toBe(true);

        seedOrder("j2", "sigA");
        const r = await verifyGigUpfrontPayment("j2");
        expect(r).toMatchObject({ verified: false });
        expect(store.get("jobs/j2")?.upfrontVerifiedAt).toBeUndefined();
    });

    describe("package orders", () => {
        function seedPackageOrder(packageId: string) {
            store.set("gigs/g1", {
                sellerSolanaAddress: SELLER,
                priceLamports: 1_000_000, // mirrors the cheapest tier
                packages: [
                    { id: "basic", priceLamports: 1_000_000 },
                    { id: "premium", priceLamports: 4_000_000 },
                ],
            });
            store.set("jobs/j1", {
                gigId: "g1",
                gigPackageId: packageId,
                escrow: { upfrontTransferTxSig: "sigA", posterSolanaAddress: BUYER, claimantSolanaAddress: SELLER },
            });
        }

        it("requires half of the ordered tier's price, not the gig's starting price", async () => {
            seedPackageOrder("premium");
            parsedTx = txWith(transfer(BUYER, SELLER, 500_000)); // half of basic only
            expect((await verifyGigUpfrontPayment("j1")).verified).toBe(false);

            parsedTx = txWith(transfer(BUYER, SELLER, 2_000_000));
            expect(await verifyGigUpfrontPayment("j1")).toEqual({ verified: true, lamports: 2_000_000 });
        });

        it("rejects an order for a tier the gig doesn't offer", async () => {
            seedPackageOrder("deluxe");
            parsedTx = txWith(transfer(BUYER, SELLER, 2_000_000));
            expect((await verifyGigUpfrontPayment("j1")).verified).toBe(false);
        });
    });
});
