/**
 * Platform-admin action: executes resolveDispute() on-chain for a disputed
 * gig order's escrow, splitting it between the agent and the buyer by basis
 * points. The transaction only succeeds if the connected wallet is the
 * agent_guild program's configured authority — anyone else's signature is
 * rejected on-chain, so no extra client-side role check is needed here.
 *
 * Isolated into its own component for the same reason as the other escrow
 * components — only mounted for a job_delivery dispute whose order actually
 * has on-chain escrow.
 */
"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Gavel } from "lucide-react";
import { useAgentGuildWrite } from "@/hooks/useAgentGuildWrite";
import { recordEscrowResolved, type GigEscrow } from "@/lib/firestore";

interface AdminResolveEscrowDisputeProps {
  jobId: string;
  escrow: GigEscrow;
  onResolved: (resolveTxSig: string, agentBps: number) => void;
}

export function AdminResolveEscrowDispute({ jobId, escrow, onResolved }: AdminResolveEscrowDisputeProps) {
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { resolveDispute, state } = useAgentGuildWrite();
  const [agentBps, setAgentBps] = useState("5000");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleResolve = async () => {
    if (!connected) {
      setVisible(true);
      return;
    }
    const bps = Math.max(0, Math.min(10000, parseInt(agentBps, 10) || 0));
    setResolving(true);
    setError(null);
    try {
      const sig = await resolveDispute(escrow.taskId, escrow.posterSolanaAddress, escrow.claimantSolanaAddress, bps);
      if (!sig) throw new Error(state.error || "Failed to resolve on-chain (are you connected as the program authority?)");
      await recordEscrowResolved(jobId, sig, bps);
      onResolved(sig, bps);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve on-chain");
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <h4 className="text-xs font-medium flex items-center gap-1.5"><Gavel className="h-3.5 w-3.5" /> Execute On-Chain Resolution</h4>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div>
        <label className="text-[11px] text-muted-foreground block mb-1">Agent's share (basis points, 0–10000 — 10000 = 100% to agent)</label>
        <Input type="number" min="0" max="10000" value={agentBps} onChange={(e) => setAgentBps(e.target.value)} className="h-8 text-sm" />
      </div>
      <Button size="sm" className="w-full" onClick={handleResolve} disabled={resolving}>
        {resolving ? "Resolving on-chain..." : connected ? "Resolve & Split Escrow" : "Connect Authority Wallet"}
      </Button>
    </div>
  );
}
