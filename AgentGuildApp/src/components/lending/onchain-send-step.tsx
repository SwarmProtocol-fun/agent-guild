/**
 * Shared "send the real transfer yourself, then paste the signature" step —
 * same shape as marketplace/crypto-checkout-dialog's Solana flow, reused for
 * every lending action that needs a verified on-chain USDC transfer (deposit,
 * solo loan funding, repayment, admin payouts). This component never signs
 * anything; it just collects the signature after the user sends it
 * themselves, and hands it to the caller's onSubmit to verify server-side.
 * Callers may also pass onSendWithWallet, which has the connected wallet sign
 * and send the transfer and resolves once it's finalized — the paste path
 * stays available as a fallback.
 */
"use client";

import { useState } from "react";
import { Loader2, AlertCircle, CheckCircle2, Copy, Check, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface OnChainSendStepProps {
    recipientAddress: string;
    amountUsd: number;
    assetLabel?: string;
    helperText?: string;
    submitLabel?: string;
    /** Overrides the "Send" row's value (default: `${amountUsd} ${assetLabel}`). */
    amountLabel?: string;
    /** Signs and sends the transfer from the connected wallet; resolves to a finalized signature. */
    onSendWithWallet?: () => Promise<string>;
    onSubmit: (txSig: string) => Promise<void>;
}

// Mirrors the server's SOLANA_CLUSTER (lib/solana/lending-verify.ts) for display only.
const DEFAULT_ASSET_LABEL = process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "mainnet-beta" ? "USDC (Solana)" : "USDC (Solana devnet)";

export function OnChainSendStep({
    recipientAddress,
    amountUsd,
    assetLabel = DEFAULT_ASSET_LABEL,
    helperText,
    submitLabel = "Verify & Continue",
    amountLabel,
    onSendWithWallet,
    onSubmit,
}: OnChainSendStepProps) {
    const [txSig, setTxSig] = useState("");
    const [copied, setCopied] = useState(false);
    const [loading, setLoading] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleCopy = () => {
        navigator.clipboard.writeText(recipientAddress);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleSubmit = async () => {
        if (!txSig.trim()) return;
        setLoading(true);
        setError(null);
        try {
            await onSubmit(txSig.trim());
        } catch (err) {
            setError(err instanceof Error ? err.message : "Verification failed");
        } finally {
            setLoading(false);
        }
    };

    const handleSendWithWallet = async () => {
        if (!onSendWithWallet) return;
        setSending(true);
        setError(null);
        let sig: string;
        try {
            sig = await onSendWithWallet();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Wallet transaction failed");
            setSending(false);
            return;
        }
        // Keep the signature visible so a failed verification can be retried with the button below.
        setTxSig(sig);
        setSending(false);
        setLoading(true);
        try {
            await onSubmit(sig);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Verification failed");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-border p-3 space-y-2">
                <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Send</span>
                    <span className="font-bold">{amountLabel ?? `${amountUsd} ${assetLabel}`}</span>
                </div>
                <div className="flex justify-between text-sm items-center">
                    <span className="text-muted-foreground">To</span>
                    <button
                        onClick={handleCopy}
                        className="flex items-center gap-1.5 font-mono text-xs hover:text-emerald-500 transition-colors"
                    >
                        {recipientAddress.slice(0, 10)}...{recipientAddress.slice(-6)}
                        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                    </button>
                </div>
            </div>

            {onSendWithWallet && (
                <Button size="sm" onClick={handleSendWithWallet} disabled={sending || loading} className="w-full h-8 text-xs gap-1">
                    {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wallet className="h-3 w-3" />}
                    {sending ? "Waiting for wallet & finalization…" : "Send with wallet"}
                </Button>
            )}

            <p className="text-xs text-muted-foreground">
                {helperText || "Send the exact amount above from your own wallet, then paste the transaction signature below."}
            </p>

            <div>
                <Label className="text-xs">Transaction Signature</Label>
                <Input
                    value={txSig}
                    onChange={(e) => setTxSig(e.target.value)}
                    placeholder="Paste the transaction signature..."
                    className="mt-1 font-mono text-xs"
                />
            </div>

            {error && (
                <div className="p-2 rounded-lg border border-red-500/20 bg-red-500/5 flex items-center gap-2 text-xs text-red-400">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
                </div>
            )}

            <Button
                size="sm"
                variant={onSendWithWallet ? "outline" : "default"}
                onClick={handleSubmit}
                disabled={loading || sending || !txSig.trim()}
                className="w-full h-8 text-xs gap-1"
            >
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                {submitLabel}
            </Button>
        </div>
    );
}
