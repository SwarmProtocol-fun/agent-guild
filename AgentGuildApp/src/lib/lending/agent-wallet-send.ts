/**
 * Moving a loan's money straight from the borrowing agent's custodial wallet
 * — collateral, collateral top-ups and repayments — in one click instead of
 * sending from a personal wallet and pasting a signature.
 *
 * Every send follows the same rules, enforced here:
 *   - Claimed before broadcast: a transaction writes the send onto the loan
 *     document (one field per kind) before anything is signed, so a double
 *     click or a retry can't move money twice.
 *   - A broadcast send ("sent") is only ever re-verified, never re-sent.
 *   - Only a definitive answer ends a broadcast send: the ledger credited it
 *     ("posted"), the money was queued back ("returned"), or the chain says
 *     it failed ("failed"). Anything else — an RPC hiccup, finality not
 *     reached yet — leaves it "sent" for the next check (the UI's "Check
 *     now", or the lending sweep).
 *   - A Solana transaction the network has never seen 10 minutes after
 *     broadcast was dropped (its blockhash expired), so nothing moved: the
 *     send is released ("failed", txSig cleared) and can be retried.
 *
 * Verification needs finality — seconds on Solana, ~15 minutes on Ethereum.
 */

import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
    createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";
import { adminDb } from "@/lib/firebase-admin";
import { listAgentWallets, getAgentWalletKeypair, getAgentWalletEvmPrivateKey, type AgentWallet } from "@/lib/agent-wallets";
import { usdcMintAddress, rpcUrl as solanaRpcUrl } from "@/lib/solana/lending-verify";
import { ethLendingNetwork, rpcUrl as ethRpcUrl } from "@/lib/ethereum/lending-verify";
import { auditQuietly, type AuditEntry } from "@/lib/vault/store";
import { assetInfo, toBaseUnits, type LendingAsset } from "./assets";
import type { AgentWalletSend, Loan } from "./types";

const LOANS = "loans";
/** A claim older than this with no broadcast is treated as abandoned (the request died mid-send). */
const STALE_SENDING_MS = 5 * 60_000;
/** A Solana send still unknown to the network after this was dropped. Blockhashes expire in ~90s. */
export const SOLANA_DROPPED_AFTER_MS = 10 * 60_000;
/** Solana: how long one request waits for finality before handing off to a later check. */
const SOLANA_FINALITY_WAIT_MS = 35_000;
/** Headroom for fees: SOL for a Solana transaction (incl. a possible token-account rent), ETH for one transfer's gas. */
const SOL_FEE_RESERVE = 0.003;
const ETH_GAS_RESERVE = 0.0005;

/** The loan-document field each kind of send is claimed on. */
export type AgentSendField = "agentCollateralSend" | "agentTopUpSend" | "agentRepaySend";

export class AgentSendError extends Error {
    constructor(message: string, readonly status = 400) {
        super(message);
    }
}

export interface AgentWalletOption {
    walletId: string;
    address: string;
    /** Balance of the asset being sent; null when the RPC couldn't be read. */
    balance: number | null;
    /** SOL available for fees (Solana wallets). For SOL/ETH sends the fee comes out of `balance`. */
    feeBalance: number | null;
    enough: boolean;
    /** Plain-language reason it can't be used yet, if it can't. */
    shortfall: string | null;
}

export interface AgentSendResult {
    status: "posted" | "confirming" | "failed";
    txSig: string | null;
    loan: Loan | null;
    message: string;
}

function chainWallets(wallets: AgentWallet[], asset: LendingAsset): AgentWallet[] {
    const chain = assetInfo(asset).chain === "ethereum" ? "evm" : "solana";
    // Payout wallet first: it's the one paid jobs land in, so the likeliest to be funded.
    return wallets.filter((w) => w.chain === chain).sort((a, b) => Number(!!b.payout) - Number(!!a.payout));
}

function fmt(n: number, asset: LendingAsset): string {
    return `${Number(n.toFixed(asset === "usdc" ? 2 : 6))} ${assetInfo(asset).symbol}`;
}

/** The wallet's balance of `asset`, plus SOL for fees on Solana. */
async function readBalances(address: string, asset: LendingAsset): Promise<{ balance: number | null; feeBalance: number | null }> {
    try {
        if (asset === "eth") {
            const client = createPublicClient({ chain: ethLendingNetwork() === "mainnet" ? mainnet : sepolia, transport: http(ethRpcUrl()) });
            return { balance: Number(formatEther(await client.getBalance({ address: address as `0x${string}` }))), feeBalance: null };
        }
        const connection = new Connection(solanaRpcUrl(), "confirmed");
        const owner = new PublicKey(address);
        const lamports = (await connection.getBalance(owner)) / 1e9;
        if (asset === "sol") return { balance: lamports, feeBalance: lamports };
        const ata = getAssociatedTokenAddressSync(new PublicKey(usdcMintAddress()), owner);
        const usdc = await connection.getTokenAccountBalance(ata).then((r) => r.value.uiAmount ?? 0).catch(() => 0);
        return { balance: usdc, feeBalance: lamports };
    } catch {
        return { balance: null, feeBalance: null };
    }
}

export function shortfallFor(asset: LendingAsset, amount: number, balance: number | null, feeBalance: number | null): string | null {
    if (balance == null) return "Balance unavailable right now";
    if (asset === "eth") {
        return balance + 1e-12 >= amount + ETH_GAS_RESERVE ? null : `Needs ${fmt(amount, "eth")} plus ~${ETH_GAS_RESERVE} ETH gas; holds ${fmt(balance, "eth")}`;
    }
    if (asset === "sol") {
        return balance + 1e-12 >= amount + SOL_FEE_RESERVE ? null : `Needs ${fmt(amount, "sol")} plus ~${SOL_FEE_RESERVE} SOL for fees; holds ${fmt(balance, "sol")}`;
    }
    if (balance + 1e-9 < amount) return `Needs ${fmt(amount, "usdc")}; holds ${fmt(balance, "usdc")}`;
    if ((feeBalance ?? 0) < SOL_FEE_RESERVE) return `Holds enough USDC but needs ~${SOL_FEE_RESERVE} SOL for the network fee`;
    return null;
}

/**
 * The agent's wallets on `asset`'s chain with their balances. With
 * `onlyAddress`, just that wallet (top-ups must come from the wallet that
 * posted the collateral, so it all returns to one place).
 */
export async function agentWalletOptions(agentId: string, asset: LendingAsset, amount: number, onlyAddress?: string): Promise<AgentWalletOption[]> {
    let wallets = chainWallets(await listAgentWallets(agentId), asset);
    if (onlyAddress) wallets = wallets.filter((w) => w.publicKey.toLowerCase() === onlyAddress.toLowerCase());
    return Promise.all(wallets.map(async (w) => {
        const { balance, feeBalance } = await readBalances(w.publicKey, asset);
        const shortfall = amount > 0 ? shortfallFor(asset, amount, balance, feeBalance) : null;
        return { walletId: w.id, address: w.publicKey, balance, feeBalance, enough: amount > 0 && !shortfall, shortfall };
    }));
}

// ── Broadcast ───────────────────────────────────────────────────────────────

interface Broadcast { sig: string; wait: () => Promise<boolean> }

async function broadcastSolana(wallet: AgentWallet, orgId: string, agentId: string, asset: "usdc" | "sol", amount: number, recipient: string): Promise<Broadcast> {
    const connection = new Connection(solanaRpcUrl(), "confirmed");
    const keypair = await getAgentWalletKeypair(wallet.id, orgId, agentId);
    const to = new PublicKey(recipient);
    const units = toBaseUnits(asset, amount);
    const tx = new Transaction();
    if (asset === "sol") {
        tx.add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: to, lamports: units }));
    } else {
        const mint = new PublicKey(usdcMintAddress());
        const fromAta = getAssociatedTokenAddressSync(mint, keypair.publicKey);
        const toAta = getAssociatedTokenAddressSync(mint, to, true);
        tx.add(
            createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, toAta, to, mint),
            createTransferCheckedInstruction(fromAta, mint, toAta, keypair.publicKey, units, assetInfo("usdc").chainDecimals),
        );
    }
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = keypair.publicKey;
    tx.sign(keypair);
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
    const sig = await connection.sendRawTransaction(tx.serialize());
    return {
        sig,
        // Finalized, because that's what verification reads.
        wait: () => Promise.race([
            connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "finalized").then((r) => !r.value.err).catch(() => false),
            new Promise<boolean>((r) => setTimeout(() => r(false), SOLANA_FINALITY_WAIT_MS)),
        ]),
    };
}

async function broadcastEth(wallet: AgentWallet, orgId: string, agentId: string, amount: number, recipient: string): Promise<Broadcast> {
    const chain = ethLendingNetwork() === "mainnet" ? mainnet : sepolia;
    const account = privateKeyToAccount(await getAgentWalletEvmPrivateKey(wallet.id, orgId, agentId));
    const publicClient = createPublicClient({ chain, transport: http(ethRpcUrl()) });
    const walletClient = createWalletClient({ chain, account, transport: http(ethRpcUrl()) });
    const value = toBaseUnits("eth", amount);
    const to = recipient as `0x${string}`;
    try {
        await publicClient.call({ account, to, value });
    } catch (err) {
        throw new Error(`Simulation failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
    const sig = await walletClient.sendTransaction({ to, value });
    // Ethereum finality takes ~15 minutes; never wait for it inside a request.
    return { sig, wait: async () => false };
}

// ── Claim, send, settle ─────────────────────────────────────────────────────

export async function setSend(loanId: string, field: AgentSendField, patch: Partial<AgentWalletSend>): Promise<void> {
    const update: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) update[`${field}.${k}`] = v;
    await adminDb().collection(LOANS).doc(loanId).update(update);
}

export interface SendRequest {
    loan: Loan;
    field: AgentSendField;
    asset: LendingAsset;
    amount: number;
    recipient: string;
    requestedBy: string;
    walletId?: string;
    /** Top-ups: only this wallet may send. */
    onlyAddress?: string;
    /** Re-checked inside the claim transaction; return an error message if the loan can no longer take this send. */
    guard: (current: Loan) => string | null;
    /** Audit action name. */
    action: AuditEntry["action"];
}

/**
 * Claim, pick a funded wallet and broadcast. Returns the wallet and signature,
 * or `resume` when a broadcast send of this kind is already in flight (the
 * caller should only settle it).
 */
export async function claimAndBroadcast(req: SendRequest): Promise<{ resume: true } | { resume: false; wallet: AgentWallet; broadcast: Broadcast }> {
    const { loan, field, asset, amount, recipient } = req;
    if (!(amount > 0)) throw new AgentSendError("Amount must be positive");
    let wallets = chainWallets(await listAgentWallets(loan.borrowerAgentId), asset);
    const chainName = assetInfo(asset).chain === "ethereum" ? "Ethereum" : "Solana";
    if (!wallets.length) {
        throw new AgentSendError(`This agent has no ${chainName} wallet yet. Generate one on the agent's Wallets tab, fund it, then send from it.`);
    }
    if (req.onlyAddress) {
        wallets = wallets.filter((w) => w.publicKey.toLowerCase() === req.onlyAddress!.toLowerCase());
        if (!wallets.length) throw new AgentSendError("The collateral was posted from a wallet that isn't one of this agent's — add to it from that wallet instead");
    }

    // The requested wallet, or the first one that can cover it.
    let chosen = req.walletId ? wallets.find((w) => w.id === req.walletId) : undefined;
    if (req.walletId && !chosen) throw new AgentSendError("That wallet doesn't belong to this agent or is on the wrong chain");
    if (!chosen) {
        const checks = await Promise.all(wallets.map(async (w) => ({ w, ...(await readBalances(w.publicKey, asset)) })));
        const ok = checks.find((c) => !shortfallFor(asset, amount, c.balance, c.feeBalance));
        if (!ok) {
            const first = checks[0];
            throw new AgentSendError(`No agent wallet can cover it. ${first.w.publicKey}: ${shortfallFor(asset, amount, first.balance, first.feeBalance)}`);
        }
        chosen = ok.w;
    } else {
        const { balance, feeBalance } = await readBalances(chosen.publicKey, asset);
        const short = shortfallFor(asset, amount, balance, feeBalance);
        if (short) throw new AgentSendError(`${chosen.publicKey}: ${short}`);
    }

    // Claim before broadcasting, so a double click or a retry can't move the money twice.
    const loanRef = adminDb().collection(LOANS).doc(loan.id);
    const claim = await adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(loanRef);
        if (!snap.exists) throw new AgentSendError("Loan not found", 404);
        const current = { id: snap.id, ...snap.data() } as Loan;
        const existing = current[field];
        if (existing?.txSig && existing.status === "sent") return { resume: true as const };
        if (existing?.status === "sending" && Date.now() - existing.startedAt < STALE_SENDING_MS) {
            throw new AgentSendError("A transfer from the agent's wallet is already in progress", 409);
        }
        const blocked = req.guard(current);
        if (blocked) throw new AgentSendError(blocked);
        const send: AgentWalletSend = {
            walletId: chosen!.id, wallet: chosen!.publicKey, asset, amount, recipient, txSig: null, status: "sending",
            startedAt: Date.now(), requestedBy: req.requestedBy, error: null,
        };
        txn.update(loanRef, { [field]: send });
        return { resume: false as const };
    });
    if (claim.resume) return claim;

    let broadcast: Broadcast;
    try {
        broadcast = asset === "eth"
            ? await broadcastEth(chosen, loan.borrowerOrgId, loan.borrowerAgentId, amount, recipient)
            : await broadcastSolana(chosen, loan.borrowerOrgId, loan.borrowerAgentId, asset, amount, recipient);
    } catch (err) {
        // Nothing was broadcast, so nothing moved; the claim is released for a retry.
        const message = err instanceof Error ? err.message : String(err);
        await setSend(loan.id, field, { status: "failed", error: message.slice(0, 500) });
        throw new AgentSendError(`Couldn't send from the agent's wallet: ${message}`);
    }
    await setSend(loan.id, field, { status: "sent", txSig: broadcast.sig, sentAt: Date.now() });
    auditQuietly({
        orgId: loan.borrowerOrgId, action: req.action, actorType: "user", actorId: req.requestedBy, target: loan.id,
        detail: { agentId: loan.borrowerAgentId, wallet: chosen.publicKey, asset, amount, recipient, txSig: broadcast.sig },
    });
    return { resume: false, wallet: chosen, broadcast };
}

/**
 * Errors after which a broadcast send is settled for good: the chain says it
 * failed, or what landed doesn't match. Everything else (not final yet, RPC
 * trouble) is retried later.
 */
const DEFINITIVE = /failed on-chain|reverted on-chain|^Expected |isn't an ETH transfer|no balance metadata/i;

export function isDefinitiveFailure(message: string): boolean {
    return DEFINITIVE.test(message);
}

/** True when the network has never seen this Solana signature (searching history). False if seen or unknown. */
async function solanaSignatureMissing(sig: string): Promise<boolean> {
    try {
        const connection = new Connection(solanaRpcUrl(), "confirmed");
        const { value } = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
        return value[0] == null;
    } catch {
        return false; // can't tell — never release on an RPC error
    }
}

export interface Credit {
    /** Apply the verified transfer to the ledger. Throws on failure. */
    run: (send: AgentWalletSend) => Promise<Loan>;
    /** Whether a thrown message means the transfer was recorded and queued back (loan no longer takes it). */
    returned?: (message: string) => boolean;
    /** Whether the ledger already credited this exact send (e.g. a crash between credit and status write). */
    alreadyCredited?: (loan: Loan, send: AgentWalletSend) => boolean | Promise<boolean>;
    postedMessage: string;
}

/**
 * Verify an already-broadcast send and credit it. Safe to call any number of
 * times; never sends anything.
 */
export async function settleAgentSend(loanId: string, field: AgentSendField, credit: Credit, getLoan: (id: string) => Promise<Loan | null>): Promise<AgentSendResult> {
    const loan = await getLoan(loanId);
    const send = loan?.[field];
    if (!loan || !send?.txSig) return { status: "failed", txSig: null, loan, message: "No agent-wallet transfer to check" };
    if (send.status === "posted") return { status: "posted", txSig: send.txSig, loan, message: credit.postedMessage };
    if (send.status === "returned") return { status: "failed", txSig: send.txSig, loan, message: send.error ?? "Transfer was returned" };
    if (send.status === "failed") return { status: "failed", txSig: send.txSig, loan, message: send.error ?? "Transfer failed" };
    if (await credit.alreadyCredited?.(loan, send)) {
        await setSend(loanId, field, { status: "posted", error: null });
        return { status: "posted", txSig: send.txSig, loan, message: credit.postedMessage };
    }
    try {
        const updated = await credit.run(send);
        await setSend(loanId, field, { status: "posted", error: null });
        return { status: "posted", txSig: send.txSig, loan: updated, message: credit.postedMessage };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The ledger claims a signature only together with a credit or a queued
        // refund, so a claimed one was handled — by this send or a crashed retry of it.
        if (/already been used/i.test(message)) {
            const credited = !!(await credit.alreadyCredited?.((await getLoan(loanId)) ?? loan, send));
            await setSend(loanId, field, credited ? { status: "posted", error: null } : { status: "returned", error: message.slice(0, 500) });
            return credited
                ? { status: "posted", txSig: send.txSig, loan, message: credit.postedMessage }
                : { status: "failed", txSig: send.txSig, loan, message: "This transfer was already recorded; any refund owed is in the payout queue." };
        }
        if (credit.returned?.(message)) {
            await setSend(loanId, field, { status: "returned", error: message.slice(0, 500) });
            return { status: "failed", txSig: send.txSig, loan, message };
        }
        if (isDefinitiveFailure(message)) {
            await setSend(loanId, field, { status: "failed", error: message.slice(0, 500) });
            return { status: "failed", txSig: send.txSig, loan, message };
        }
        const age = Date.now() - (send.sentAt ?? send.startedAt);
        if (send.asset !== "eth" && age > SOLANA_DROPPED_AFTER_MS && await solanaSignatureMissing(send.txSig)) {
            const dropped = `The network dropped transaction ${send.txSig} before it landed; nothing was sent. Try again.`;
            await setSend(loanId, field, { status: "failed", txSig: null, error: dropped });
            return { status: "failed", txSig: null, loan, message: dropped };
        }
        return {
            status: "confirming", txSig: send.txSig, loan,
            message: send.asset === "eth"
                ? "Sent. Ethereum takes about 15 minutes to finalize; this finishes automatically, or check again then."
                : "Sent. Waiting for Solana to finalize; check again in a few seconds.",
        };
    }
}

/** Wait (briefly, Solana only) for the broadcast to finalize, then settle. */
export async function waitThenSettle(broadcast: Broadcast, settle: () => Promise<AgentSendResult>): Promise<AgentSendResult> {
    await broadcast.wait();
    return settle();
}
