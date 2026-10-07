/**
 * On-chain ETH verification for the ETH lending pool — the Ethereum
 * counterpart of solana/lending-verify.ts, with the same contract: read-only
 * (no key is held here), money is only credited against finalized blocks,
 * and the replay claim is written inside the caller's Firestore transaction
 * (claimEthTransferInTxn) so it commits or rolls back with the credit.
 *
 * Two transfer shapes are accepted:
 *   - a plain transfer: tx.from = sender, tx.to = recipient, tx.value >= amount
 *   - a send executed by a contract wallet such as a Safe multisig treasury:
 *     tx.to = the sending contract, and the sender's and recipient's balances
 *     moved by at least the amount across the transaction's block. This needs
 *     state at that block, so confirm treasury payouts within ~20 minutes of
 *     finality or point ETH_LENDING_RPC_URL at an archive node.
 *
 *   ETH_LENDING_NETWORK            — "sepolia" (default) or "mainnet"
 *   ETH_LENDING_RPC_URL            — required on mainnet
 *   ETH_LENDING_TREASURY_ADDRESS   — the ETH treasury (a Safe is fine)
 */
import { createPublicClient, http, isAddress, isHash, type Hash, type PublicClient } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { adminDb } from "@/lib/firebase-admin";
import { getChain } from "@/lib/chains";
import { toBaseUnits, fromBaseUnits } from "@/lib/lending/assets";
import type { VerifyTransferInput, VerifiedTransfer } from "@/lib/solana/lending-verify";

const ONCHAIN_TX_COLLECTION = "lendingOnChainTxs";

export type EthNetwork = "mainnet" | "sepolia";

export function ethLendingNetwork(): EthNetwork {
    const raw = (process.env.ETH_LENDING_NETWORK || "sepolia").trim();
    if (raw !== "mainnet" && raw !== "sepolia") throw new Error(`ETH_LENDING_NETWORK must be "mainnet" or "sepolia" (got "${raw}")`);
    return raw;
}

function rpcUrl(): string {
    const rpc = process.env.ETH_LENDING_RPC_URL;
    if (ethLendingNetwork() === "mainnet") {
        if (!rpc) throw new Error("ETH_LENDING_RPC_URL must be set when ETH_LENDING_NETWORK=mainnet");
        if (/sepolia|goerli|holesky|testnet/i.test(rpc)) throw new Error("ETH_LENDING_RPC_URL points at a testnet but ETH_LENDING_NETWORK=mainnet");
        return rpc;
    }
    return rpc || getChain("sepolia")?.rpc || "https://ethereum-sepolia-rpc.publicnode.com";
}

let client: PublicClient | null = null;
let clientKey = "";
function publicClient(): PublicClient {
    const key = `${ethLendingNetwork()}|${rpcUrl()}`;
    if (!client || clientKey !== key) {
        client = createPublicClient({ chain: ethLendingNetwork() === "mainnet" ? mainnet : sepolia, transport: http(rpcUrl()) }) as PublicClient;
        clientKey = key;
    }
    return client;
}

/** Public address of the ETH lending treasury, lowercased. No key for it is configured here. */
export function ethTreasuryAddress(): string {
    const addr = process.env.ETH_LENDING_TREASURY_ADDRESS;
    if (!addr) throw new Error("ETH_LENDING_TREASURY_ADDRESS is not configured");
    if (!isAddress(addr, { strict: false })) throw new Error("ETH_LENDING_TREASURY_ADDRESS is not a valid address");
    return addr.toLowerCase();
}

/** Tx hashes are case-insensitive hex; claims are keyed by the lowercase form so a re-cased hash can't be replayed. */
export function normalizeEthTxHash(txSig: string): string {
    const hash = txSig.trim().toLowerCase();
    if (!isHash(hash)) throw new Error("That doesn't look like an Ethereum transaction hash (0x followed by 64 hex characters)");
    return hash;
}

export function ethExplorerTxUrl(hash: string): string {
    return ethLendingNetwork() === "mainnet" ? `https://etherscan.io/tx/${hash}` : `https://sepolia.etherscan.io/tx/${hash}`;
}

export async function verifyEthTransfer(input: VerifyTransferInput): Promise<VerifiedTransfer> {
    const hash = normalizeEthTxHash(input.txSig) as Hash;
    if (input.expectedFromWallet === null) throw new Error("ETH transfers need a known sender");
    const from = input.expectedFromWallet.toLowerCase();
    const to = input.expectedToWallet.toLowerCase();
    if (!isAddress(from, { strict: false }) || !isAddress(to, { strict: false })) {
        throw new Error("ETH transfers need Ethereum addresses on both sides");
    }

    const claimed = await adminDb().collection(ONCHAIN_TX_COLLECTION).doc(hash).get();
    if (claimed.exists) throw new Error("This transaction hash has already been used for a different credit");

    const rpc = publicClient();
    let tx, receipt;
    try {
        [tx, receipt] = await Promise.all([rpc.getTransaction({ hash }), rpc.getTransactionReceipt({ hash })]);
    } catch {
        throw new Error("Transaction not found or not mined yet — wait a minute and retry");
    }
    if (receipt.status !== "success") throw new Error("Transaction reverted on-chain");
    const finalized = await rpc.getBlock({ blockTag: "finalized" });
    if (receipt.blockNumber > finalized.number) {
        throw new Error("Transaction isn't finalized yet — Ethereum takes about 15 minutes; retry then");
    }

    const required = toBaseUnits("eth", input.expectedAmount);
    const txTo = tx.to?.toLowerCase();
    let received: bigint;

    if (txTo === to && tx.from.toLowerCase() === from) {
        received = tx.value;
        if (received < required) throw new Error(`Expected at least ${input.expectedAmount} ETH, transaction sent ${fromBaseUnits("eth", received)}`);
    } else if (txTo === from) {
        // Contract wallet (e.g. Safe) executed the send — check balance movement across the block.
        const before = receipt.blockNumber - BigInt(1);
        const after = receipt.blockNumber;
        let toBefore, toAfter, fromBefore, fromAfter;
        try {
            [toBefore, toAfter, fromBefore, fromAfter] = await Promise.all([
                rpc.getBalance({ address: to as `0x${string}`, blockNumber: before }),
                rpc.getBalance({ address: to as `0x${string}`, blockNumber: after }),
                rpc.getBalance({ address: from as `0x${string}`, blockNumber: before }),
                rpc.getBalance({ address: from as `0x${string}`, blockNumber: after }),
            ]);
        } catch {
            throw new Error("Couldn't read balances at that block — the RPC may have pruned it; set ETH_LENDING_RPC_URL to an archive node");
        }
        received = toAfter - toBefore;
        const sent = fromBefore - fromAfter;
        if (received < required) throw new Error(`Expected at least ${input.expectedAmount} ETH to arrive at ${to}, found ${fromBaseUnits("eth", received)}`);
        if (sent < required) throw new Error(`Expected ${from} to send at least ${input.expectedAmount} ETH`);
    } else {
        throw new Error(`Transaction isn't an ETH transfer from ${from} to ${to}`);
    }

    return { txSig: hash, received: fromBaseUnits("eth", received) };
}

export function claimEthTransferInTxn(txn: FirebaseFirestore.Transaction, input: VerifyTransferInput): void {
    const hash = normalizeEthTxHash(input.txSig);
    txn.create(adminDb().collection(ONCHAIN_TX_COLLECTION).doc(hash), {
        purpose: input.purpose,
        refId: input.refId,
        fromWallet: input.expectedFromWallet?.toLowerCase() ?? null,
        toWallet: input.expectedToWallet.toLowerCase(),
        amount: input.expectedAmount,
        asset: "eth",
        claimedAt: Date.now(),
    });
}
