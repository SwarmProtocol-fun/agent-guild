/**
 * Gig Escrow Order Form — signs the real on-chain payment for an
 * escrow-enabled gig: half paid directly to the seller's wallet immediately,
 * half funded into the agent_guild program's on-chain Task escrow (released
 * on approval, split by admin if disputed).
 *
 * Isolated into its own component — and only ever mounted when a gig with
 * escrowEnabled is actually being ordered — because it calls
 * @solana/wallet-adapter-react's useWallet(), which throws if this
 * deployment's wallet provider isn't configured for Solana
 * (NEXT_PUBLIC_WALLET_PROVIDER=solana). The caller must check that before
 * mounting this component; see gigs/page.tsx.
 */
"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Connection, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Button } from "@/components/ui/button";
import { useAgentGuildWrite } from "@/hooks/useAgentGuildWrite";
import { getConnection } from "@/lib/solana/client";
import { orderGig, type Gig } from "@/lib/firestore";

interface GigEscrowOrderFormProps {
  gig: Gig; // caller guarantees escrowEnabled, priceLamports, sellerSolanaAddress are set
  buyerOrgId: string;
  requirements: string;
  onOrdered: (jobId: string) => void;
  onError: (message: string) => void;
}

export function GigEscrowOrderForm({ gig, buyerOrgId, requirements, onOrdered, onError }: GigEscrowOrderFormProps) {
  const { publicKey, signTransaction, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { postTask, state } = useAgentGuildWrite();
  const [placing, setPlacing] = useState(false);
  const [stepLabel, setStepLabel] = useState<string | null>(null);

  const totalLamports = gig.priceLamports ?? 0;
  const upfrontLamports = Math.floor(totalLamports / 2);
  const escrowLamports = totalLamports - upfrontLamports;

  const handlePlaceOrder = async () => {
    if (!connected || !publicKey || !signTransaction) {
      setVisible(true);
      return;
    }
    setPlacing(true);
    try {
      const connection: Connection = getConnection();
      const sellerPubkey = new PublicKey(gig.sellerSolanaAddress!);

      // 1. Direct upfront transfer — not escrowed, not refundable.
      setStepLabel("Sending upfront payment...");
      const transferTx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: sellerPubkey, lamports: upfrontLamports })
      );
      transferTx.feePayer = publicKey;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      transferTx.recentBlockhash = blockhash;
      const signedTransfer = await signTransaction(transferTx);
      const upfrontTransferTxSig = await connection.sendRawTransaction(signedTransfer.serialize());
      await connection.confirmTransaction({ signature: upfrontTransferTxSig, blockhash, lastValidBlockHeight }, "confirmed");

      // 2. Fund the remaining half into on-chain escrow via the agent_guild program.
      setStepLabel("Funding on-chain escrow...");
      const deadlineUnix = Math.floor(Date.now() / 1000) + Math.max(1, gig.deliveryDays) * 86400 + 86400;
      const result = await postTask(
        gig.title,
        gig.description,
        gig.tags.join(", "),
        deadlineUnix,
        (escrowLamports / LAMPORTS_PER_SOL).toString(),
      );
      if (!result) throw new Error(state.error || "Failed to fund on-chain escrow");

      // 3. Record the order.
      setStepLabel("Recording order...");
      const jobId = await orderGig(
        gig.id,
        { orgId: buyerOrgId, address: publicKey.toBase58() },
        requirements,
        {
          taskId: result.taskId,
          taskPda: result.taskPda,
          posterSolanaAddress: publicKey.toBase58(),
          claimantSolanaAddress: gig.sellerSolanaAddress!,
          totalLamports,
          upfrontLamports,
          escrowLamports,
          upfrontTransferTxSig,
          fundTxSig: result.txSig,
        }
      );
      onOrdered(jobId);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to place escrow order");
    } finally {
      setPlacing(false);
      setStepLabel(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground space-y-1 bg-muted/40 rounded-md p-3">
        <div className="flex justify-between"><span>Paid immediately to seller</span><span className="font-medium">{(upfrontLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL</span></div>
        <div className="flex justify-between"><span>Held in on-chain escrow</span><span className="font-medium">{(escrowLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL</span></div>
      </div>
      <Button
        onClick={handlePlaceOrder}
        disabled={placing}
        className="w-full bg-amber-600 hover:bg-amber-700 text-white"
      >
        {placing ? (stepLabel ?? "Processing...") : connected ? "Pay & Place Order" : "Connect Wallet to Order"}
      </Button>
    </div>
  );
}
