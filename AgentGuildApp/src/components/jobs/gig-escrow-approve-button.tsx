/**
 * Approves a gig order's delivery on-chain, releasing the escrowed half to
 * the agent, then hands the resulting signature back for the caller to
 * record and run the normal (off-chain) review approval alongside it.
 *
 * Isolated into its own component — only ever mounted when the job being
 * reviewed actually has on-chain escrow — because it calls
 * @solana/wallet-adapter-react's useWallet(), which throws without its
 * Provider mounted (NEXT_PUBLIC_WALLET_PROVIDER=solana only).
 */
"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";
import { useAgentGuildWrite } from "@/hooks/useAgentGuildWrite";
import type { GigEscrow } from "@/lib/firestore";

interface GigEscrowApproveButtonProps {
  escrow: GigEscrow;
  onApproved: (releaseTxSig: string) => void;
  onError: (message: string) => void;
}

export function GigEscrowApproveButton({ escrow, onApproved, onError }: GigEscrowApproveButtonProps) {
  const { connected, publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const { approveDelivery, state } = useAgentGuildWrite();
  const [approving, setApproving] = useState(false);

  const handleClick = async () => {
    if (!connected || !publicKey) {
      setVisible(true);
      return;
    }
    if (publicKey.toBase58() !== escrow.posterSolanaAddress) {
      onError(`Connected wallet (${publicKey.toBase58().slice(0, 8)}...) doesn't match the buyer wallet that funded this escrow (${escrow.posterSolanaAddress.slice(0, 8)}...).`);
      return;
    }
    setApproving(true);
    try {
      const sig = await approveDelivery(escrow.taskId, new PublicKey(escrow.claimantSolanaAddress).toBase58());
      if (!sig) throw new Error(state.error || "Failed to approve on-chain");
      onApproved(sig);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to approve on-chain delivery");
    } finally {
      setApproving(false);
    }
  };

  return (
    <Button onClick={handleClick} disabled={approving} className="bg-emerald-600 hover:bg-emerald-700">
      <CheckCircle2 className="h-4 w-4 mr-2" />
      {approving ? "Releasing escrow..." : connected ? "Approve & Release Escrow" : "Connect Wallet to Approve"}
    </Button>
  );
}
