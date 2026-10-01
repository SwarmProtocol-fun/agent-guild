/** Pure display of a gig order's on-chain escrow state — no wallet needed. */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, ShieldCheck } from "lucide-react";
import type { GigEscrow } from "@/lib/firestore";
import { SOLANA_RPC_URL } from "@/lib/solana/client";

const LAMPORTS_PER_SOL = 1_000_000_000;
const sol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(4);

/** Best-effort devnet/mainnet explorer link based on the configured RPC. */
function explorerUrl(txSig: string): string {
  const cluster = SOLANA_RPC_URL.includes("devnet") ? "?cluster=devnet" : SOLANA_RPC_URL.includes("testnet") ? "?cluster=testnet" : "";
  return `https://explorer.solana.com/tx/${txSig}${cluster}`;
}

const STATUS_LABEL: Record<GigEscrow["status"], string> = {
  funded: "Escrow funded — awaiting agent claim",
  claimed: "Claimed on-chain — work in progress",
  delivered: "Delivered on-chain — awaiting your approval",
  released: "Released to seller",
  disputed: "Disputed — awaiting admin resolution",
  resolved: "Resolved by admin",
};

const STATUS_COLOR: Record<GigEscrow["status"], string> = {
  funded: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400",
  claimed: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  delivered: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  released: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
  disputed: "bg-destructive/10 text-destructive",
  resolved: "bg-muted text-muted-foreground",
};

export function GigEscrowStatusCard({ escrow }: { escrow: GigEscrow }) {
  const txRows: [string, string | undefined][] = [
    ["Upfront payment", escrow.upfrontTransferTxSig],
    ["Escrow funded", escrow.fundTxSig],
    ["Agent claimed", escrow.claimTxSig],
    ["Delivery submitted", escrow.deliveryTxSig],
    ["Escrow released", escrow.releaseTxSig],
    ["Dispute filed", escrow.disputeTxSig],
    ["Dispute resolved", escrow.resolveTxSig],
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <ShieldCheck className="h-5 w-5 text-emerald-600" />
          On-Chain Escrow
          <Badge className={STATUS_COLOR[escrow.status]}>{STATUS_LABEL[escrow.status]}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md bg-muted/40 p-2">
            <div className="text-[11px] text-muted-foreground">Paid upfront</div>
            <div className="font-medium">{sol(escrow.upfrontLamports)} SOL</div>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <div className="text-[11px] text-muted-foreground">
              {escrow.status === "released" ? "Released" : escrow.status === "resolved" ? "Resolved" : "Held in escrow"}
            </div>
            <div className="font-medium">{sol(escrow.escrowLamports)} SOL</div>
          </div>
        </div>
        {escrow.resolvedAgentBps != null && (
          <div className="text-xs text-muted-foreground">
            Admin split: {(escrow.resolvedAgentBps / 100).toFixed(1)}% to agent, {(100 - escrow.resolvedAgentBps / 100).toFixed(1)}% refunded to buyer.
          </div>
        )}
        <div className="space-y-1 pt-1 border-t">
          {txRows.filter(([, sig]) => sig).map(([label, sig]) => (
            <a key={label} href={explorerUrl(sig!)} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between text-[11px] text-muted-foreground hover:text-foreground transition-colors">
              <span>{label}</span>
              <span className="flex items-center gap-1 font-mono">{sig!.slice(0, 8)}...<ExternalLink className="h-3 w-3" /></span>
            </a>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
