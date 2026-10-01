/**
 * Solana client for the Agent Guild on-chain program — replaces the
 * ethers/ABI path (`agent-guild-contracts.ts`) for the "solana" chain.
 *
 * Program source: /solana-program (Anchor workspace, sibling to /contracts).
 */
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { MEMO_PROGRAM_ID } from "@solana/spl-memo";
import bs58 from "bs58";

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

export function proposalPda(proposalId: number | BN): [PublicKey, number] {
    const id = BN.isBN(proposalId) ? proposalId : new BN(proposalId);
    return PublicKey.findProgramAddressSync(
        [Buffer.from("proposal"), id.toArrayLike(Buffer, "le", 8)],
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

export async function getAllPenaltyProposals(connection?: Connection) {
    const program = getReadonlyProgram(connection);
    return program.account.penaltyProposal.all();
}

/** Approved penalty proposals for an agent — this IS its on-chain slashing history. */
export async function getSlashingHistory(agentWallet: PublicKey, connection?: Connection) {
    const proposals = await getAllPenaltyProposals(connection);
    return proposals.filter(
        (p) => p.account.agent.equals(agentWallet) && "approved" in p.account.status,
    );
}

/** Same as `getSlashingHistory`, keyed by ASN instead of wallet — the `PenaltyProposal` account stores both. */
export async function getSlashingHistoryByAsn(asn: string, connection?: Connection) {
    const proposals = await getAllPenaltyProposals(connection);
    return proposals.filter((p) => p.account.asn === asn && "approved" in p.account.status);
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
): Promise<{ task: PublicKey; taskId: BN; txSig: string }> {
    const program = getProgram(wallet);
    const [config] = guildConfigPda();
    const configAccount = await program.account.guildConfig.fetch(config);
    const taskId: BN = configAccount.taskCounter;
    const [task] = taskPda(taskId);
    const txSig = await program.methods
        .postTask(
            args.title,
            args.description,
            args.requiredSkills,
            new BN(args.deadline),
            BN.isBN(args.budgetLamports) ? args.budgetLamports : new BN(args.budgetLamports),
        )
        .accounts({ poster: wallet.publicKey })
        .rpc();
    return { task, taskId, txSig };
}

export async function approveDelivery(wallet: SolanaWallet, task: PublicKey, claimant: PublicKey) {
    const program = getProgram(wallet);
    return program.methods
        .approveDelivery()
        .accounts({ poster: wallet.publicKey, taskAccount: task, claimant })
        .rpc();
}

/** Poster-only: flags a submitted delivery as disputed, freezing the escrow until resolveDispute(). */
export async function disputeDelivery(wallet: SolanaWallet, task: PublicKey) {
    const program = getProgram(wallet);
    return program.methods
        .disputeDelivery()
        .accounts({ poster: wallet.publicKey, taskAccount: task })
        .rpc();
}

/**
 * Authority-only (the program's configured admin wallet): splits the escrowed
 * budget between agent and poster. `agentBps` is the agent's share in basis
 * points (10000 = 100% to agent, 0 = 100% refunded to poster, 5000 = even split).
 */
export async function resolveDispute(
    wallet: SolanaWallet,
    task: PublicKey,
    poster: PublicKey,
    claimant: PublicKey,
    agentBps: number,
) {
    const program = getProgram(wallet);
    return program.methods
        .resolveDispute(agentBps)
        .accounts({ authority: wallet.publicKey, taskAccount: task, poster, claimant })
        .rpc();
}

// ── Governance / slashing ─────────────────────────────────────────────

export async function createPenaltyProposal(
    wallet: SolanaWallet,
    args: { agentWallet: PublicKey; asn: string; amount: number; reason: string },
) {
    const program = getProgram(wallet);
    const [config] = guildConfigPda();
    const configAccount = await program.account.guildConfig.fetch(config);
    const [proposal] = proposalPda(configAccount.proposalCounter);
    const [agentAccount] = agentPda(args.agentWallet);
    await program.methods
        .createPenaltyProposal(args.asn, args.amount, args.reason)
        .accounts({ proposer: wallet.publicKey, agentAccount })
        .rpc();
    return proposal;
}

/** Authority-only. Approving slashes the agent's credit score by `amount`. */
export async function resolvePenaltyProposal(wallet: SolanaWallet, proposal: PublicKey, approve: boolean) {
    const program = getProgram(wallet);
    return program.methods
        .resolvePenaltyProposal(approve)
        .accounts({ authority: wallet.publicKey, proposal })
        .rpc();
}

// ── On-chain event memos (replaces HCS score-event topics) ───────────
//
// A transaction carrying a standard Memo-program instruction, with the
// agent's AgentAccount PDA included as a read-only (non-signing) account so
// `getSignaturesForAddress(agentPda)` surfaces it later — no bespoke program
// instruction needed. Anyone can read these events back; there is nothing
// private about them (matches the "public" HCS topic case only — see
// mod-stubs.ts for why private events aren't posted this way).

const MAX_MEMO_BYTES = 560; // well under the ~1232-byte transaction size limit

export async function postEventMemo(
    wallet: SolanaWallet,
    agentWallet: PublicKey,
    payload: unknown,
    connection: Connection = getConnection(),
): Promise<string> {
    const memoText = JSON.stringify(payload);
    if (Buffer.byteLength(memoText, "utf8") > MAX_MEMO_BYTES) {
        throw new Error(`Score event payload exceeds ${MAX_MEMO_BYTES} bytes for a single memo transaction`);
    }
    const [agentAccount] = agentPda(agentWallet);

    const ix = new TransactionInstruction({
        keys: [
            { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
            { pubkey: agentAccount, isSigner: false, isWritable: false },
        ],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(memoText, "utf8"),
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = wallet.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    const signed = await wallet.signTransaction(tx);
    const signature = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    return signature;
}

export interface OnChainEventMemo {
    signature: string;
    blockTime: number | null;
    payload: unknown;
}

/** Reads back memo events tagged to an agent, newest first (paginated like the old Mirror Node). */
export async function getEventMemosForAgent(
    agentWallet: PublicKey,
    limit = 50,
    connection: Connection = getConnection(),
): Promise<OnChainEventMemo[]> {
    const [agentAccount] = agentPda(agentWallet);
    const signatures = await connection.getSignaturesForAddress(agentAccount, { limit });

    const events: OnChainEventMemo[] = [];
    for (const sigInfo of signatures) {
        if (sigInfo.err) continue;
        const tx = await connection.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx) continue;

        for (const ix of tx.transaction.message.instructions) {
            if (!("programId" in ix) || !ix.programId.equals(MEMO_PROGRAM_ID)) continue;

            let memoText: string | undefined;
            if ("parsed" in ix && typeof ix.parsed === "string") {
                memoText = ix.parsed;
            } else if ("data" in ix) {
                try {
                    memoText = Buffer.from(bs58.decode(ix.data)).toString("utf8");
                } catch {
                    continue;
                }
            }
            if (!memoText) continue;

            try {
                events.push({ signature: sigInfo.signature, blockTime: tx.blockTime ?? null, payload: JSON.parse(memoText) });
            } catch {
                // Not one of our JSON memos — skip.
            }
        }
    }
    return events;
}

/** Resolves an ASN to its owning agent wallet via the on-chain `AsnRecord` PDA. */
export async function getAgentWalletByAsn(asn: string, connection?: Connection): Promise<PublicKey | null> {
    const program = getReadonlyProgram(connection);
    const [pda] = asnPda(asn);
    const record = await program.account.asnRecord.fetchNullable(pda);
    return record ? record.agent : null;
}

/**
 * Score-event history for an ASN — replaces the Hedera Mirror Node
 * paginated-topic-messages read path. Returns oldest-first (matching the
 * old `order=asc` Mirror Node call, since callers accumulate deltas
 * forward from a starting score).
 */
export async function getScoreEventHistoryForAsn(
    asn: string,
    limit = 50,
    connection?: Connection,
): Promise<OnChainEventMemo[]> {
    const wallet = await getAgentWalletByAsn(asn, connection);
    if (!wallet) return [];
    const memos = await getEventMemosForAgent(wallet, limit, connection);
    return memos.reverse(); // getSignaturesForAddress is newest-first
}
