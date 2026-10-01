/**
 * Signs disputeDelivery() on-chain (poster/buyer-only) before filing the
 * record-only platform dispute — freezes the escrow so it can't be released
 * normally until a platform admin calls resolveDispute(). Optional: the
 * buyer can file the record-only dispute without this and the escrow just
 * stays wherever it was.
 *
 * Isolated into its own component for the same reason as the other escrow
 * components — only mounted when the viewer is the buyer on an escrowed order.
 */
"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { useAgentGuildWrite } from "@/hooks/useAgentGuildWrite";
import type { GigEscrow } from "@/lib/firestore";

interface GigEscrowDisputeSignButtonProps {
  escrow: GigEscrow;
  onSigned: (disputeTxSig: string) => void;
  onError: (message: string) => void;
}

export function GigEscrowDisputeSignButton({ escrow, onSigned, onError }: GigEscrowDisputeSignButtonProps) {
  const { connected, publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const { disputeDelivery, state } = useAgentGuildWrite();
  const [signing, setSigning] = useState(false);
  const [signed, setSigned] = useState(false);

  const handleClick = async () => {
    if (!connected || !publicKey) {
      setVisible(true);
      return;
    }
    setSigning(true);
    try {
      const sig = await disputeDelivery(escrow.taskId);
      if (!sig) throw new Error(state.error || "Failed to flag dispute on-chain");
      setSigned(true);
      onSigned(sig);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to flag dispute on-chain");
    } finally {
      setSigning(false);
    }
  };

  if (signed) {
    return <p className="text-xs text-emerald-600">On-chain escrow frozen pending admin resolution.</p>;
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleClick} disabled={signing} className="text-xs">
      <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />
      {signing ? "Signing..." : "Also freeze on-chain escrow (optional)"}
    </Button>
  );
}
