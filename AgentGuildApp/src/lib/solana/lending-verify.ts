/**
 * Real on-chain USDC verification for the lending marketplace — devnet USDC
 * via SPL token transfer, same mint settlement/solana-adapter.ts uses for job
 * payouts. This module is read-only: it never holds a private key and never
 * signs or sends a transaction. Every real money movement (deposit, solo loan
 * funding, repayment, and admin-executed payouts) is initiated by a human
 * from their own wallet; this only confirms, on-chain, that it happened
 * before anything gets credited in Firestore.
 *
 * Checks both sides of the transfer (recipient received, sender's balance
 * dropped by the same amount) so a caller can't claim credit for a
 * transaction someone else broadcast. Every verified signature is claimed in
 * `lendingOnChainTxs` so it can never be credited twice.
 */
import { Connection } from "@solana/web3.js";
import { adminDb } from "@/lib/firebase-admin";
import { getChain } from "@/lib/chains";

// Same devnet USDC-Dev mint as settlement/solana-adapter.ts.
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const USDC_DECIMALS = 6;
const ONCHAIN_TX_COLLECTION = "lendingOnChainTxs";

export function usdcMintAddress(): string {
    return process.env.SOLANA_USDC_MINT || DEVNET_USDC_MINT;
}

function connection(): Connection {
    const chain = getChain("solana");
    return new Connection(chain?.rpc || "https://api.devnet.solana.com", "confirmed");
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

function tokenBalanceDelta(
    tx: NonNullable<Awaited<ReturnType<Connection["getTransaction"]>>>,
    owner: string,
    mint: string,
): number {
    const pre = tx.meta?.preTokenBalances?.find((b) => b.owner === owner && b.mint === mint);
    const post = tx.meta?.postTokenBalances?.find((b) => b.owner === owner && b.mint === mint);
    const preAmount = pre ? Number(pre.uiTokenAmount.amount) : 0;
    const postAmount = post ? Number(post.uiTokenAmount.amount) : 0;
    return (postAmount - preAmount) / 10 ** USDC_DECIMALS;
}

export interface VerifyTransferInput {
    txSig: string;
    /** Wallet that must have sent the USDC (its balance must drop by >= the amount). */
    expectedFromWallet: string;
    /** Wallet that must have received the USDC. */
    expectedToWallet: string;
    expectedAmountUsd: number;
    /** Replay-guard bookkeeping, stored alongside the claim. */
    purpose: string;
    refId: string;
}

/**
 * Verify a submitted signature transferred >= expectedAmountUsd of devnet
 * USDC from expectedFromWallet to expectedToWallet, then claims the
 * signature so it can't be reused for a different credit. Throws with a
 * user-facing reason on any failure.
 */
export async function verifyAndClaimUsdcTransfer(input: VerifyTransferInput): Promise<void> {
    const { txSig, expectedFromWallet, expectedToWallet, expectedAmountUsd, purpose, refId } = input;

    const tx = await connection().getTransaction(txSig, { maxSupportedTransactionVersion: 0 });
    if (!tx) throw new Error("Transaction not found — it may not be confirmed yet");
    if (tx.meta?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`);

    const mint = usdcMintAddress();
    const receivedUsd = tokenBalanceDelta(tx, expectedToWallet, mint);
    if (receivedUsd < expectedAmountUsd * 0.995) {
        throw new Error(`Expected at least ${expectedAmountUsd} USDC to arrive at ${expectedToWallet}, found ${receivedUsd}`);
    }

    const sentUsd = -tokenBalanceDelta(tx, expectedFromWallet, mint);
    if (sentUsd < expectedAmountUsd * 0.995) {
        throw new Error(`Expected ${expectedFromWallet} to be the sender of at least ${expectedAmountUsd} USDC`);
    }

    // Claim the signature atomically — Firestore's create() rejects if the doc already exists.
    try {
        await adminDb().collection(ONCHAIN_TX_COLLECTION).doc(txSig).create({
            purpose,
            refId,
            fromWallet: expectedFromWallet,
            toWallet: expectedToWallet,
            amountUsd: expectedAmountUsd,
            claimedAt: Date.now(),
        });
    } catch {
        throw new Error("This transaction signature has already been used for a different credit");
    }
}

function explorerTxUrl(txSig: string): string {
    const chain = getChain("solana");
    return chain?.explorer.txUrl(txSig) || `https://solscan.io/tx/${txSig}?cluster=devnet`;
}

export { explorerTxUrl };
