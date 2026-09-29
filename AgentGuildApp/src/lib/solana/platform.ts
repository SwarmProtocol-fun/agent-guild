/**
 * Server-only platform keypair — signs sponsored registration and admin
 * credit updates on Solana, the same trust boundary the old
 * `HEDERA_PLATFORM_KEY` ethers.Wallet occupied. Never import this from
 * client-facing code.
 */
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createMint, freezeAccount, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import bs58 from "bs58";

import { agentPda, getConnection, getProgram, registerAgentFor, updateCredit, type SolanaWallet } from "./client";

let cachedKeypair: Keypair | null | undefined;

/** Loads the platform keypair from SOLANA_PLATFORM_KEYPAIR (base58-encoded secret key). */
export function getPlatformKeypair(): Keypair | null {
    if (cachedKeypair !== undefined) return cachedKeypair;
    const secret = process.env.SOLANA_PLATFORM_KEYPAIR;
    cachedKeypair = secret ? Keypair.fromSecretKey(bs58.decode(secret)) : null;
    return cachedKeypair;
}

/** Wraps a raw `Keypair` as a `SolanaWallet` for server-side signing. */
export function platformWallet(keypair: Keypair): SolanaWallet {
    return {
        publicKey: keypair.publicKey,
        async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
            if (tx instanceof VersionedTransaction) tx.sign([keypair]);
            else tx.partialSign(keypair);
            return tx;
        },
        async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
            for (const tx of txs) {
                if (tx instanceof VersionedTransaction) tx.sign([keypair]);
                else tx.partialSign(keypair);
            }
            return txs;
        },
    };
}

/** Platform-sponsored registration — mirrors the old `registerOnChain()` (Hedera `registerAgentFor`). */
export async function registerAgentForOnChain(args: {
    agentAddress: string;
    name: string;
    skills: string;
    asn: string;
    feeRateBps?: number;
}): Promise<{ txSignature?: string }> {
    const keypair = getPlatformKeypair();
    if (!keypair || !args.agentAddress) return {};

    try {
        const wallet = platformWallet(keypair);
        const agentWallet = new PublicKey(args.agentAddress);
        const txSignature = await registerAgentFor(wallet, {
            agentWallet,
            name: args.name,
            skills: args.skills,
            asn: args.asn,
            feeRateBps: args.feeRateBps ?? 0,
        });
        return { txSignature };
    } catch (err) {
        console.error("registerAgentFor on Solana AgentGuild program failed:", err);
        return {};
    }
}

/** Authority-only credit/trust update — mirrors the old Hedera `updateCreditOnChain()`. */
export async function updateCreditOnChain(
    agentAddr: string,
    creditScore: number,
    trustScore: number,
): Promise<{ txSignature?: string }> {
    const keypair = getPlatformKeypair();
    if (!keypair || !agentAddr) return {};

    try {
        const wallet = platformWallet(keypair);
        const agentWallet = new PublicKey(agentAddr);
        const txSignature = await updateCredit(wallet, agentWallet, creditScore, trustScore);
        return { txSignature };
    } catch (err) {
        console.error("updateCredit on Solana AgentGuild program failed:", err);
        return {};
    }
}

/**
 * Mints a soulbound reputation token for an agent: a fresh supply-1/decimals-0
 * SPL mint, minted into the agent's associated token account, which is then
 * frozen — the standard non-transferable "frozen SPL token" pattern. Replaces
 * the Solidity `AgentGuildAgentIdentityNFT.mintAgentNFT` soulbound ERC-721.
 */
export async function mintIdentityToken(agentAddr: string): Promise<{ mint?: string }> {
    const keypair = getPlatformKeypair();
    if (!keypair || !agentAddr) return {};

    try {
        const connection = getConnection();
        const agentWallet = new PublicKey(agentAddr);
        const mint = await createMint(connection, keypair, keypair.publicKey, keypair.publicKey, 0);
        const ata = await getOrCreateAssociatedTokenAccount(connection, keypair, mint, agentWallet);
        await mintTo(connection, keypair, mint, ata.address, keypair, 1);
        await freezeAccount(connection, keypair, ata.address, mint, keypair);
        return { mint: mint.toBase58() };
    } catch (err) {
        console.error("mintIdentityToken (soulbound SPL token) failed:", err);
        return {};
    }
}

/** Whether the agent's on-chain registry account already exists (checked before registering/minting). */
export async function agentAlreadyRegistered(agentAddr: string): Promise<boolean> {
    try {
        const keypair = getPlatformKeypair();
        if (!keypair) return false;
        const program = getProgram(platformWallet(keypair));
        const [pda] = agentPda(new PublicKey(agentAddr));
        const account = await program.account.agentAccount.fetchNullable(pda);
        return account !== null;
    } catch {
        return false;
    }
}
