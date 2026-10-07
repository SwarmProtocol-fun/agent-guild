/**
 * Real on-chain USDC verification for the lending marketplace — SPL token
 * transfers in the configured USDC mint (devnet USDC-Dev by default, same
 * mint settlement/solana-adapter.ts uses for job payouts). This module is
 * read-only: it never holds a private key and never signs or sends a
 * transaction. Every real money movement (deposit, solo loan funding,
 * repayment, and admin-executed payouts) is initiated by a human from their
 * own wallet; this only confirms, on-chain, that it happened before anything
 * gets credited in Firestore.
 *
 * Checks both sides of the transfer (recipient received, sender's balance
 * dropped by the same amount) so a caller can't claim credit for a
 * transaction someone else broadcast. No shortfall tolerance: plain USDC has
 * no transfer fee, so anything less than the full amount is rejected.
 *
 * Verification and the replay-guard claim are deliberately split:
 * verifyUsdcTransfer() is a pure read, and claimUsdcTransferInTxn() writes the
 * `lendingOnChainTxs` claim inside the caller's Firestore transaction, so the
 * claim and the ledger credit commit (or fail) together — a failed credit can
 * never burn a signature the user really paid with.
 */
import { Connection } from "@solana/web3.js";
import { adminDb } from "@/lib/firebase-admin";
import { getChain } from "@/lib/chains";
import { LAMPORTS_PER_SOL } from "@/lib/lending/math";

// Same devnet USDC-Dev mint as settlement/solana-adapter.ts.
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const USDC_DECIMALS = 6;
const ONCHAIN_TX_COLLECTION = "lendingOnChainTxs";

type SolanaCluster = "devnet" | "mainnet-beta";

/**
 * Which cluster lending runs against. Defaults to devnet; mainnet must be
 * opted into explicitly with SOLANA_CLUSTER=mainnet-beta, and then every
 * devnet fallback below is refused rather than silently used.
 */
export function lendingCluster(): SolanaCluster {
    const raw = (process.env.SOLANA_CLUSTER || "devnet").trim();
    if (raw !== "devnet" && raw !== "mainnet-beta") {
        throw new Error(`SOLANA_CLUSTER must be "devnet" or "mainnet-beta" (got "${raw}")`);
    }
    return raw;
}

export function usdcMintAddress(): string {
    const mint = process.env.SOLANA_USDC_MINT;
    if (lendingCluster() === "mainnet-beta") {
        if (!mint) throw new Error("SOLANA_USDC_MINT must be set when SOLANA_CLUSTER=mainnet-beta");
        if (mint === DEVNET_USDC_MINT) throw new Error("SOLANA_USDC_MINT is the devnet mint but SOLANA_CLUSTER=mainnet-beta");
        return mint;
    }
    return mint || DEVNET_USDC_MINT;
}

function rpcUrl(): string {
    const rpc = process.env.SOLANA_RPC_URL;
    if (lendingCluster() === "mainnet-beta") {
        if (!rpc) throw new Error("SOLANA_RPC_URL must be set when SOLANA_CLUSTER=mainnet-beta");
        if (/devnet|testnet/i.test(rpc)) throw new Error("SOLANA_RPC_URL points at a test cluster but SOLANA_CLUSTER=mainnet-beta");
        return rpc;
    }
    return getChain("solana")?.rpc || "https://api.devnet.solana.com";
}

function connection(): Connection {
    // "finalized", not "confirmed" — money is only credited against blocks
    // that can no longer be rolled back.
    return new Connection(rpcUrl(), "finalized");
}

/**
 * Public address of the lending treasury — a wallet a platform admin
 * personally controls outside this app. No secret key for it is ever
 * configured here.
 */
export function treasuryAddress(): string {
    const addr = process.env.SOLANA_LENDING_TREASURY_ADDRESS;
    if (!addr) throw new Error("SOLANA_LENDING_TREASURY_ADDRESS is not configured");
    return addr;
}

interface TokenBalanceLike {
    owner?: string;
    mint: string;
    uiTokenAmount: { amount: string };
}

/**
 * Net change in `owner`'s holdings of `mint` across every token account they
 * own in the transaction (an owner can hold more than one account for the
 * same mint). Uses BigInt on the raw integer amounts to avoid float drift.
 */
export function tokenBalanceDelta(
    pre: TokenBalanceLike[] | null | undefined,
    post: TokenBalanceLike[] | null | undefined,
    owner: string,
    mint: string,
): number {
    const sum = (balances: TokenBalanceLike[] | null | undefined) =>
        (balances || [])
            .filter((b) => b.owner === owner && b.mint === mint)
            .reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount), BigInt(0));
    const delta = sum(post) - sum(pre);
    return Number(delta) / 10 ** USDC_DECIMALS;
}

export interface VerifyTransferInput {
    txSig: string;
    /** Wallet that must have sent the funds (its balance must drop by >= the amount). */
    expectedFromWallet: string;
    /** Wallet that must have received the funds. */
    expectedToWallet: string;
    /** In the transfer's asset units (USDC, SOL or ETH — see lending/assets.ts on the `Usd` naming). */
    expectedAmountUsd: number;
    /** Replay-guard bookkeeping, stored alongside the claim. */
    purpose: string;
    refId: string;
}

export interface VerifiedTransfer {
    txSig: string;
    /** Amount that actually arrived at expectedToWallet, in asset units (may exceed the expected amount). */
    receivedUsd: number;
}

/**
 * Verify a submitted signature transferred >= expectedAmountUsd of USDC from
 * expectedFromWallet to expectedToWallet at finalized commitment. Read-only —
 * does NOT claim the signature; the caller must call claimUsdcTransferInTxn()
 * inside the transaction that credits it. Throws with a user-facing reason on
 * any failure. Also rejects early if the signature is already claimed.
 */
export async function verifyUsdcTransfer(input: VerifyTransferInput): Promise<VerifiedTransfer> {
    const { txSig, expectedFromWallet, expectedToWallet, expectedAmountUsd } = input;

    const claimed = await adminDb().collection(ONCHAIN_TX_COLLECTION).doc(txSig).get();
    if (claimed.exists) throw new Error("This transaction signature has already been used for a different credit");

    const tx = await connection().getTransaction(txSig, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
    if (!tx) throw new Error("Transaction not found or not finalized yet — wait a few seconds and retry");
    if (tx.meta?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`);

    const mint = usdcMintAddress();
    const pre = tx.meta?.preTokenBalances;
    const post = tx.meta?.postTokenBalances;

    const receivedUsd = tokenBalanceDelta(pre, post, expectedToWallet, mint);
    if (receivedUsd + 1e-9 < expectedAmountUsd) {
        throw new Error(`Expected at least ${expectedAmountUsd} USDC to arrive at ${expectedToWallet}, found ${receivedUsd}`);
    }

    const sentUsd = -tokenBalanceDelta(pre, post, expectedFromWallet, mint);
    if (sentUsd + 1e-9 < expectedAmountUsd) {
        throw new Error(`Expected ${expectedFromWallet} to be the sender of at least ${expectedAmountUsd} USDC`);
    }

    return { txSig, receivedUsd };
}

/**
 * Net lamport change for `owner` across a transaction. `accountKeys` must be
 * the full key list (static + lookup-table) so it lines up index-for-index
 * with pre/postBalances.
 */
export function lamportBalanceDelta(accountKeys: string[], pre: number[], post: number[], owner: string): number {
    return accountKeys.reduce((acc, key, i) => (key === owner ? acc + ((post[i] ?? 0) - (pre[i] ?? 0)) : acc), 0);
}

export interface VerifiedSolTransfer extends VerifiedTransfer {
    lamports: number;
}

/**
 * Native-SOL counterpart of verifyUsdcTransfer(), for the SOL pool — the
 * amount (expectedAmountUsd) is in SOL. Checks the recipient's lamports rose
 * by at least that much and the sender's fell by at least as much (the
 * sender's drop also includes the network fee when they paid it, so it's >=,
 * never ==). Same contract: read-only, the caller claims the signature with
 * claimUsdcTransferInTxn() inside the crediting transaction.
 */
export async function verifySolTransfer(input: VerifyTransferInput): Promise<VerifiedSolTransfer> {
    const { txSig, expectedFromWallet, expectedToWallet, expectedAmountUsd: expectedSol } = input;

    const claimed = await adminDb().collection(ONCHAIN_TX_COLLECTION).doc(txSig).get();
    if (claimed.exists) throw new Error("This transaction signature has already been used for a different credit");

    const tx = await connection().getTransaction(txSig, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
    if (!tx) throw new Error("Transaction not found or not finalized yet — wait a few seconds and retry");
    if (tx.meta?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`);
    if (!tx.meta) throw new Error("Transaction has no balance metadata");

    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    const accountKeys = Array.from({ length: keys.length }, (_, i) => keys.get(i)!.toBase58());
    const { preBalances, postBalances } = tx.meta;

    const requiredLamports = Math.round(expectedSol * LAMPORTS_PER_SOL);
    const received = lamportBalanceDelta(accountKeys, preBalances, postBalances, expectedToWallet);
    if (received < requiredLamports) {
        throw new Error(`Expected at least ${expectedSol} SOL to arrive at ${expectedToWallet}, found ${received / LAMPORTS_PER_SOL}`);
    }
    const sent = -lamportBalanceDelta(accountKeys, preBalances, postBalances, expectedFromWallet);
    if (sent < requiredLamports) {
        throw new Error(`Expected ${expectedFromWallet} to be the sender of at least ${expectedSol} SOL`);
    }

    return { txSig, receivedUsd: received / LAMPORTS_PER_SOL, lamports: received };
}

/**
 * Claim a verified signature inside a Firestore transaction. txn.create()
 * fails the whole transaction if the claim already exists, so a concurrent
 * double-submit can only ever credit once — and if the rest of the
 * transaction fails, the claim is rolled back with it.
 */
export function claimUsdcTransferInTxn(txn: FirebaseFirestore.Transaction, input: VerifyTransferInput): void {
    const ref = adminDb().collection(ONCHAIN_TX_COLLECTION).doc(input.txSig);
    txn.create(ref, {
        purpose: input.purpose,
        refId: input.refId,
        fromWallet: input.expectedFromWallet,
        toWallet: input.expectedToWallet,
        amountUsd: input.expectedAmountUsd,
        claimedAt: Date.now(),
    });
}

function explorerTxUrl(txSig: string): string {
    const cluster = lendingCluster() === "mainnet-beta" ? "" : "?cluster=devnet";
    return `https://solscan.io/tx/${txSig}${cluster}`;
}

export { explorerTxUrl };
