/**
 * Shared "send the real transfer yourself, then paste the signature" step —
 * same shape as marketplace/crypto-checkout-dialog's Solana flow, reused for
 * every lending action that needs a verified on-chain USDC transfer (deposit,
 * solo loan funding, repayment, admin payouts). This component never signs
 * anything; it just collects the signature after the user sends it
 * themselves, and hands it to the caller's onSubmit to verify server-side.
 */
"use client";

import { useState } from "react";
import { Loader2, AlertCircle, CheckCircle2, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface OnChainSendStepProps {
    recipientAddress: string;
    amountUsd: number;
    assetLabel?: string;
    helperText?: string;
    submitLabel?: string;
    onSubmit: (txSig: string) => Promise<void>;
}

export function OnChainSendStep({
    recipientAddress,
    amountUsd,
    assetLabel = "USDC (Solana devnet)",
    helperText,
    submitLabel = "Verify & Continue",
    onSubmit,
}: OnChainSendStepProps) {
    const [txSig, setTxSig] = useState("");
    const [copied, setCopied] = useState(false);
    const [loading, setLoading] = useState(false);
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

    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-border p-3 space-y-2">
                <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Send</span>
                    <span className="font-bold">{amountUsd} {assetLabel}</span>
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

            <Button size="sm" onClick={handleSubmit} disabled={loading || !txSig.trim()} className="w-full h-8 text-xs gap-1">
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                {submitLabel}
            </Button>
        </div>
    );
}
