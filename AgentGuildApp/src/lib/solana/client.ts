/**
 * Solana client for the Agent Guild on-chain program — replaces the
 * ethers/ABI path (`agent-guild-contracts.ts`) for the "solana" chain.
 *
 * Program source: /solana-program (Anchor workspace, sibling to /contracts).
 */
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

import idl from "./idl/agent_guild.json";
import type { AgentGuild } from "./idl/agent_guild";

export const AGENT_GUILD_PROGRAM_ID = new PublicKey(
    process.env.NEXT_PUBLIC_SOLANA_PROGRAM_ID || "4T3UJ83HEwQH3Pb6eQuMnkEYSxyqXv7o6rNARXXKT3ci",
);

export const SOLANA_RPC_URL =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

/**
 * Extracts the raw 32-byte Ed25519 public key from a PEM SubjectPublicKeyInfo
 * block and returns it as a base58 Solana address. Solana pubkeys ARE raw
 * Ed25519 public keys, so an agent's existing CLI-generated Ed25519 identity
 * key doubles as its real, self-custodied Solana address — no separate
 * derivation/hashing needed (unlike the old EVM shim, which keccak256-hashed
 * the key into an address the agent never actually held the private key for).
 */
export function solanaAddressFromEd25519Pem(publicKeyPem: string): string {
    const pemContent = publicKeyPem
        .replace(/-----BEGIN PUBLIC KEY-----/, "")
        .replace(/-----END PUBLIC KEY-----/, "")
        .replace(/\s/g, "");
    const derBytes = Buffer.from(pemContent, "base64");
    const rawKey = derBytes.subarray(derBytes.length - 32);
    return new PublicKey(rawKey).toBase58();
}

export function getConnection(): Connection {
    return new Connection(SOLANA_RPC_URL, "confirmed");
}

/**
 * Minimal wallet shape Anchor's `AnchorProvider` needs — deliberately not
 * imported from `@coral-xyz/anchor` (its top-level `Wallet` export is a
 * Node-only class wrapping a raw `Keypair`, unsuitable for a browser wallet
 * adapter that never exposes a private key). Any wallet-adapter context
 * exposing `publicKey`/`signTransaction`/`signAllTransactions` satisfies this
 * structurally.
 */
export interface SolanaWallet {
    publicKey: PublicKey;
    signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
    signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

const READONLY_WALLET: SolanaWallet = {
    publicKey: PublicKey.default,
    async signTransaction() {
        throw new Error("Read-only Solana wallet cannot sign transactions");
    },
    async signAllTransactions() {
        throw new Error("Read-only Solana wallet cannot sign transactions");
    },
};

/** Read-only program instance — no wallet connection required. */
export function getReadonlyProgram(connection: Connection = getConnection()): Program<AgentGuild> {
    const provider = new AnchorProvider(connection, READONLY_WALLET, { commitment: "confirmed" });
    return new Program<AgentGuild>(idl as AgentGuild, provider);
}

/** Program instance for signing writes, given a connected wallet (e.g. from `@solana/wallet-adapter-react`). */
export function getProgram(wallet: SolanaWallet, connection: Connection = getConnection()): Program<AgentGuild> {
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    return new Program<AgentGuild>(idl as AgentGuild, provider);
}

// ── PDA helpers ─────────────────────────────────────────────────────────
// (Anchor's client auto-derives these same PDAs for instruction accounts
// whose IDL seeds are fully known — see the per-instruction calls below —
// these are exported for reads and for building explorer/query lookups.)

export function guildConfigPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("guild-config")], AGENT_GUILD_PROGRAM_ID);
}

export function treasuryPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("treasury")], AGENT_GUILD_PROGRAM_ID);
}

export function agentPda(agentWallet: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("agent"), agentWallet.toBuffer()], AGENT_GUILD_PROGRAM_ID);
}

export function asnPda(asn: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("asn"), Buffer.from(asn)], AGENT_GUILD_PROGRAM_ID);
}

export function taskPda(taskId: number | BN): [PublicKey, number] {
    const id = BN.isBN(taskId) ? taskId : new BN(taskId);
    return PublicKey.findProgramAddressSync(
        [Buffer.from("task"), id.toArrayLike(Buffer, "le", 8)],
        AGENT_GUILD_PROGRAM_ID,
    );
}

// ── Reads ───────────────────────────────────────────────────────────────

export async function getAllAgents(connection?: Connection) {
    const program = getReadonlyProgram(connection);
    return program.account.agentAccount.all();
}

export async function getAllTasks(connection?: Connection) {
    const program = getReadonlyProgram(connection);
    return program.account.taskAccount.all();
}

export async function getTreasury(connection?: Connection) {
    const program = getReadonlyProgram(connection);
    const [pda] = treasuryPda();
    return program.account.treasuryAccount.fetchNullable(pda);
}

export async function getAgentByWallet(agentWallet: PublicKey, connection?: Connection) {
    const program = getReadonlyProgram(connection);
    const [pda] = agentPda(agentWallet);
    return program.account.agentAccount.fetchNullable(pda);
}

// ── Writes (require a connected wallet) ──────────────────────────────
//
// Accounts whose PDA seeds are fully derivable from the IDL (guild-config,
// treasury, per-wallet agent_account, per-asn asn_record) are left out of
// `.accounts({...})` — Anchor's client resolves them automatically. Plain
// accounts with no seed metadata (task_account, claimant, poster, `to`) are
// passed explicitly.

export async function registerAgent(
    wallet: SolanaWallet,
    args: { name: string; skills: string; asn: string; feeRateBps: number },
) {
    const program = getProgram(wallet);
    return program.methods
        .registerAgent(args.name, args.skills, args.asn, args.feeRateBps)
        .accounts({ agentWallet: wallet.publicKey })
        .rpc();
}

/** Platform-sponsored registration — `wallet` pays fees/signs, `agentWallet` never signs. */
export async function registerAgentFor(
    wallet: SolanaWallet,
    args: { agentWallet: PublicKey; name: string; skills: string; asn: string; feeRateBps: number },
) {
    const program = getProgram(wallet);
    return program.methods
        .registerAgentFor(args.agentWallet, args.name, args.skills, args.asn, args.feeRateBps)
        .accounts({ payer: wallet.publicKey })
        .rpc();
}

/** Authority-only credit/trust update. */
export async function updateCredit(
    wallet: SolanaWallet,
    agentWallet: PublicKey,
    creditScore: number,
    trustScore: number,
) {
    const program = getProgram(wallet);
    const [agentAccount] = agentPda(agentWallet);
    return program.methods
        .updateCredit(creditScore, trustScore)
        .accounts({ authority: wallet.publicKey, agentAccount })
        .rpc();
}

export async function claimTask(wallet: SolanaWallet, task: PublicKey) {
    const program = getProgram(wallet);
    return program.methods.claimTask().accounts({ claimant: wallet.publicKey, taskAccount: task }).rpc();
}

export async function submitDelivery(wallet: SolanaWallet, task: PublicKey, deliveryHash: Uint8Array) {
    const program = getProgram(wallet);
    return program.methods
        .submitDelivery(Array.from(deliveryHash))
        .accounts({ claimant: wallet.publicKey, taskAccount: task })
        .rpc();
}

export async function postTask(
    wallet: SolanaWallet,
    args: {
        title: string;
        description: string;
        requiredSkills: string;
        deadline: number;
        budgetLamports: number | BN;
    },
) {
    const program = getProgram(wallet);
    const [config] = guildConfigPda();
    const configAccount = await program.account.guildConfig.fetch(config);
    const [task] = taskPda(configAccount.taskCounter);
    await program.methods
        .postTask(
            args.title,
            args.description,
            args.requiredSkills,
            new BN(args.deadline),
            BN.isBN(args.budgetLamports) ? args.budgetLamports : new BN(args.budgetLamports),
        )
        .accounts({ poster: wallet.publicKey })
        .rpc();
    return task;
}

export async function approveDelivery(wallet: SolanaWallet, task: PublicKey, claimant: PublicKey) {
    const program = getProgram(wallet);
    return program.methods
        .approveDelivery()
        .accounts({ poster: wallet.publicKey, taskAccount: task, claimant })
        .rpc();
}
