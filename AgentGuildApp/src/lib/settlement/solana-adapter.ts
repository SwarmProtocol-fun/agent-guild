import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getAccount,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import { createMemoInstruction } from "@solana/spl-memo";
import { getChain } from "@/lib/chains";
import type { SettleJobParams, SettlementAdapter, SettlementReceipt, VerifyResult } from "./types";

// Circle's public devnet USDC-Dev mint — same one the devnet faucet issues.
// Override with SOLANA_USDC_MINT for a different cluster/mint.
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const USDC_DECIMALS = 6;
const MEMO_PREFIX = "agent-guild:receipt:";
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

function loadPlatformKeypair(): Keypair {
  const raw = process.env.SOLANA_SETTLEMENT_SECRET_KEY;
  if (!raw) throw new Error("SOLANA_SETTLEMENT_SECRET_KEY not configured");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/**
 * No custom Anchor program — a single transaction carrying a standard SPL
 * token transfer (payment) plus a standard Memo-program instruction
 * (the job's receipt hash) is the whole settlement. Anyone can verify the
 * receipt by reading the transaction; nothing bespoke to write or audit.
 */
export class SolanaSettlementAdapter implements SettlementAdapter {
  async settleJob(p: SettleJobParams): Promise<SettlementReceipt> {
    const chain = getChain("solana");
    if (!chain) throw new Error("Solana chain config missing");

    const connection = new Connection(chain.rpc, "confirmed");
    const platform = loadPlatformKeypair();
    const usdcMint = new PublicKey(process.env.SOLANA_USDC_MINT || DEVNET_USDC_MINT);
    const agentPubkey = new PublicKey(p.agentWallet);

    const platformAta = await getOrCreateAssociatedTokenAccount(connection, platform, usdcMint, platform.publicKey);
    const agentAta = await getOrCreateAssociatedTokenAccount(connection, platform, usdcMint, agentPubkey);

    const amountRaw = BigInt(Math.round(p.amountUsdc * 10 ** USDC_DECIMALS));

    const tx = new Transaction()
      .add(
        createTransferCheckedInstruction(
          platformAta.address,
          usdcMint,
          agentAta.address,
          platform.publicKey,
          amountRaw,
          USDC_DECIMALS,
        ),
      )
      .add(createMemoInstruction(`${MEMO_PREFIX}${p.resultHash}`, [platform.publicKey]));

    const txSig = await sendAndConfirmTransaction(connection, tx, [platform]);

    return {
      chain: "solana",
      txSig,
      receiptHash: p.resultHash,
      explorerUrl: chain.explorer.txUrl(txSig),
      // Solana has no deployed AgentRegistry-equivalent yet — this settles
      // payment + receipt only, same "not yet" state as a fresh EVM chain.
      reputationUpdated: false,
    };
  }

  async getBalance(wallet: string): Promise<{ usdc: number }> {
    const chain = getChain("solana");
    if (!chain) throw new Error("Solana chain config missing");
    const connection = new Connection(chain.rpc, "confirmed");
    const usdcMint = new PublicKey(process.env.SOLANA_USDC_MINT || DEVNET_USDC_MINT);
    const ata = await getAssociatedTokenAddress(usdcMint, new PublicKey(wallet));

    try {
      const account = await getAccount(connection, ata);
      return { usdc: Number(account.amount) / 10 ** USDC_DECIMALS };
    } catch (err) {
      if (err instanceof TokenAccountNotFoundError) return { usdc: 0 };
      throw err;
    }
  }

  async verifyReceipt(txSig: string, resultHash: string): Promise<VerifyResult> {
    const chain = getChain("solana");
    if (!chain) throw new Error("Solana chain config missing");
    const connection = new Connection(chain.rpc, "confirmed");

    const tx = await connection.getTransaction(txSig, { maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err) return { found: false, hashVerified: false };

    const memoIx = tx.transaction.message.compiledInstructions?.find((ix) => {
      const programId = tx.transaction.message.staticAccountKeys[ix.programIdIndex]?.toBase58();
      return programId === MEMO_PROGRAM_ID;
    });
    const memoText = memoIx ? Buffer.from(memoIx.data).toString("utf8") : "";
    const hashVerified = memoText === `${MEMO_PREFIX}${resultHash}`;

    return {
      found: true,
      hashVerified,
      confirmedAt: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : undefined,
    };
  }
}
