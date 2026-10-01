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
import { getPlatformKeypair, updateCreditOnChain } from "@/lib/solana/platform";
import type { SettleJobParams, SettlementAdapter, SettlementReceipt, VerifyResult } from "./types";

// Circle's public devnet USDC-Dev mint — same one the devnet faucet issues.
// Override with SOLANA_USDC_MINT for a different cluster/mint.
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const USDC_DECIMALS = 6;
const MEMO_PREFIX = "agent-guild:receipt:";
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// Same SOLANA_PLATFORM_KEYPAIR (base58) that lib/solana/platform.ts, the
// gas-sponsor route, and metaplex/mint already use — this used to read its
// own SOLANA_SETTLEMENT_SECRET_KEY (JSON-array format), a var that was never
// set anywhere in .env.example/.env.local/CI, so settlement always threw.
function loadPlatformKeypair(): Keypair {
  const keypair = getPlatformKeypair();
  if (!keypair) throw new Error("SOLANA_PLATFORM_KEYPAIR not configured");
  return keypair;
}

/**
 * Payment + receipt is a plain transaction — a standard SPL token transfer
 * plus a standard Memo-program instruction, verifiable by anyone reading the
 * transaction, nothing bespoke to audit. Reputation is a separate, best-effort
 * call into the Agent Guild Anchor program's `updateCredit` instruction (see
 * lib/solana/platform.ts), signed by the platform authority keypair — a
 * different key than the settlement wallet that pays the transfer above.
 * It never throws: if the agent isn't registered on-chain yet, or the
 * authority key isn't configured, settlement still succeeds and
 * `reputationUpdated` comes back false.
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

    const creditResult = await updateCreditOnChain(p.agentWallet, p.creditScore, p.trustScore);

    return {
      chain: "solana",
      txSig,
      receiptHash: p.resultHash,
      explorerUrl: chain.explorer.txUrl(txSig),
      reputationUpdated: Boolean(creditResult.txSignature),
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
