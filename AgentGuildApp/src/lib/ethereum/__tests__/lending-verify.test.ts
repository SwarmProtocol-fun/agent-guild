/**
 * ETH transfer verification against a stubbed viem client — the two accepted
 * shapes (plain transfer, contract-wallet send), finality, and replay guard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const claims = new Set<string>();
vi.mock("@/lib/firebase-admin", () => ({
    adminDb: () => ({
        collection: () => ({ doc: (id: string) => ({ id, get: async () => ({ exists: claims.has(id) }) }) }),
    }),
}));

const rpc = {
    getTransaction: vi.fn(),
    getTransactionReceipt: vi.fn(),
    getBlock: vi.fn(),
    getBalance: vi.fn(),
};
vi.mock("viem", async (importOriginal) => ({ ...(await importOriginal<typeof import("viem")>()), createPublicClient: () => rpc }));

import { verifyEthTransfer, normalizeEthTxHash, ethLendingNetwork, ethTreasuryAddress } from "../lending-verify";

const HASH = "0x" + "ab".repeat(32);
const ALICE = "0x1111111111111111111111111111111111111111";
const TREASURY = "0x2222222222222222222222222222222222222222";
const ETH = BigInt(10) ** BigInt(18);

const input = (over: Partial<Parameters<typeof verifyEthTransfer>[0]> = {}) => ({
    txSig: HASH,
    expectedFromWallet: ALICE,
    expectedToWallet: TREASURY,
    expectedAmountUsd: 1.5,
    purpose: "pool_deposit",
    refId: "pool",
    ...over,
});

beforeEach(() => {
    claims.clear();
    for (const fn of Object.values(rpc)) fn.mockReset();
    rpc.getTransaction.mockResolvedValue({ from: ALICE, to: TREASURY, value: (ETH * BigInt(3)) / BigInt(2) });
    rpc.getTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: BigInt(100) });
    rpc.getBlock.mockResolvedValue({ number: BigInt(150) });
    delete process.env.ETH_LENDING_NETWORK;
    delete process.env.ETH_LENDING_RPC_URL;
});

describe("verifyEthTransfer", () => {
    it("accepts a finalized plain transfer of at least the amount (address case doesn't matter)", async () => {
        const res = await verifyEthTransfer(input({ expectedFromWallet: ALICE.toUpperCase().replace("0X", "0x"), txSig: HASH.toUpperCase().replace("0X", "0x") }));
        expect(res).toEqual({ txSig: HASH, receivedUsd: 1.5 });
    });

    it("rejects too little ETH, the wrong sender, reverts and unfinalized blocks", async () => {
        await expect(verifyEthTransfer(input({ expectedAmountUsd: 2 }))).rejects.toThrow(/at least 2 ETH/);
        await expect(verifyEthTransfer(input({ expectedFromWallet: "0x4444444444444444444444444444444444444444" }))).rejects.toThrow(/isn't an ETH transfer/);
        rpc.getTransactionReceipt.mockResolvedValueOnce({ status: "reverted", blockNumber: BigInt(100) });
        await expect(verifyEthTransfer(input())).rejects.toThrow(/reverted/);
        rpc.getBlock.mockResolvedValueOnce({ number: BigInt(99) });
        await expect(verifyEthTransfer(input())).rejects.toThrow(/isn't finalized/);
    });

    it("accepts a contract-wallet (Safe) send by balance movement across the block", async () => {
        // Treasury Safe pays Alice: an owner EOA calls the Safe, which sends the ETH internally.
        rpc.getTransaction.mockResolvedValue({ from: "0x3333333333333333333333333333333333333333", to: TREASURY, value: BigInt(0) });
        rpc.getBalance.mockImplementation(async ({ address, blockNumber }: { address: string; blockNumber: bigint }) => {
            const after = blockNumber === BigInt(100);
            if (address === ALICE) return after ? ETH * BigInt(2) : ETH / BigInt(2);
            return after ? ETH : ETH * BigInt(3);
        });
        const res = await verifyEthTransfer(input({ expectedFromWallet: TREASURY, expectedToWallet: ALICE }));
        expect(res.receivedUsd).toBe(1.5);
        await expect(verifyEthTransfer(input({ expectedFromWallet: TREASURY, expectedToWallet: ALICE, expectedAmountUsd: 1.6 }))).rejects.toThrow(/to arrive/);
    });

    it("refuses a hash already claimed, under any casing", async () => {
        claims.add(HASH);
        await expect(verifyEthTransfer(input({ txSig: HASH.toUpperCase().replace("0X", "0x") }))).rejects.toThrow(/already been used/);
    });

    it("reports a missing transaction clearly", async () => {
        rpc.getTransaction.mockRejectedValue(new Error("TransactionNotFound"));
        await expect(verifyEthTransfer(input())).rejects.toThrow(/not found or not mined/);
    });
});

describe("configuration", () => {
    it("normalizes and validates hashes", () => {
        expect(normalizeEthTxHash(` ${HASH.toUpperCase().replace("0X", "0x")} `)).toBe(HASH);
        expect(() => normalizeEthTxHash("5xyz")).toThrow(/doesn't look like/);
    });

    it("defaults to Sepolia and refuses a testnet RPC on mainnet", async () => {
        expect(ethLendingNetwork()).toBe("sepolia");
        process.env.ETH_LENDING_NETWORK = "mainnet";
        await expect(verifyEthTransfer(input())).rejects.toThrow(/ETH_LENDING_RPC_URL must be set/);
        process.env.ETH_LENDING_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
        await expect(verifyEthTransfer(input())).rejects.toThrow(/points at a testnet/);
        process.env.ETH_LENDING_NETWORK = "goerli";
        expect(() => ethLendingNetwork()).toThrow(/must be "mainnet" or "sepolia"/);
    });

    it("requires a valid treasury address", () => {
        delete process.env.ETH_LENDING_TREASURY_ADDRESS;
        expect(() => ethTreasuryAddress()).toThrow(/not configured/);
        process.env.ETH_LENDING_TREASURY_ADDRESS = "nope";
        expect(() => ethTreasuryAddress()).toThrow(/not a valid address/);
        process.env.ETH_LENDING_TREASURY_ADDRESS = TREASURY.toUpperCase().replace("0X", "0x");
        expect(ethTreasuryAddress()).toBe(TREASURY);
    });
});
