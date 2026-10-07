/**
 * Repay Loan Dialog — pay down or fully pay off an active loan with a real,
 * verified on-chain transfer in the loan's asset: pick an amount, send it yourself to the
 * right recipient (the treasury for pool loans, the lender directly for solo
 * loans), then paste the signature for the backend to verify before it
 * applies the payment.
 */
"use client";

import { useState, useEffect } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSession } from "@/contexts/SessionContext";
import { OnChainSendStep } from "./onchain-send-step";
import type { Loan } from "@/lib/lending/types";
import { assetOf, assetInfo, ceilAmount, formatAssetAmount, roundAmount } from "@/lib/lending/assets";
import { fetchLendingTreasury, treasuryAddressFor, sendAssetLabel, type LendingTreasuryInfo } from "@/lib/lending/client";

interface RepayLoanDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    loan: Loan;
    payoffUsd: number;
    onRepaid: () => void;
}

export function RepayLoanDialog({ open, onOpenChange, loan, payoffUsd, onRepaid }: RepayLoanDialogProps) {
    const { address: sessionAddress } = useSession();
    const [step, setStep] = useState<"amount" | "send">("amount");
    const asset = assetOf(loan);
    // Quoted rounded up to ledger precision so paying the quote always clears the balance.
    const payoff = ceilAmount(asset, payoffUsd);
    const [amount, setAmount] = useState(String(payoff));
    const [treasuryInfo, setTreasuryInfo] = useState<LendingTreasuryInfo | null>(null);
    const recipient = loan.source === "solo" ? loan.lenderWalletAddress || null : treasuryInfo ? treasuryAddressFor(treasuryInfo, asset) : null;
    const [done, setDone] = useState(false);

    useEffect(() => {
        fetchLendingTreasury().then(setTreasuryInfo).catch(() => setTreasuryInfo(null));
    }, []);

    const handleClose = () => {
        setStep("amount");
        setDone(false);
        onOpenChange(false);
    };

    const amountUsd = roundAmount(asset, parseFloat(amount) || 0);

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Repay Loan</DialogTitle>
                </DialogHeader>

                {done ? (
                    <div className="p-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 space-y-3">
                        <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
                            <CheckCircle2 className="h-4 w-4" /> Payment Verified
                        </div>
                        <Button size="sm" onClick={handleClose} className="w-full h-8 text-xs">Done</Button>
                    </div>
                ) : step === "amount" ? (
                    <div className="space-y-4">
                        <p className="text-xs text-muted-foreground">
                            Current payoff (principal + accrued interest): <span className="font-mono text-foreground">{formatAssetAmount(asset, payoff)}</span>
                        </p>
                        <div>
                            <Label className="text-xs">Amount ({assetInfo(asset).symbol})</Label>
                            <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1" />
                            <button
                                type="button"
                                className="text-[10px] text-emerald-500 hover:underline mt-1"
                                onClick={() => setAmount(String(payoff))}
                            >
                                Pay full balance
                            </button>
                        </div>
                        <Button
                            size="sm"
                            onClick={() => setStep("send")}
                            disabled={!(amountUsd > 0) || !recipient}
                            className="w-full h-8 text-xs gap-1"
                        >
                            {!recipient && <Loader2 className="h-3 w-3 animate-spin" />}
                            Continue
                        </Button>
                    </div>
                ) : (
                    <OnChainSendStep
                        recipientAddress={recipient!}
                        amountUsd={amountUsd}
                        assetLabel={sendAssetLabel(treasuryInfo, asset)}
                        chain={assetInfo(asset).chain}
                        helperText={`Send from the ${loan.borrowerOrgId} org's wallet, then paste the signature.`}
                        submitLabel="Verify Payment"
                        onSubmit={async (txSig) => {
                            const res = await fetch(`/api/v1/lending/loans/${loan.id}/repay`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json", "x-wallet-address": sessionAddress || "" },
                                body: JSON.stringify({ amountUsd, txSig }),
                            });
                            if (!res.ok) {
                                const body = await res.json().catch(() => ({}));
                                throw new Error(body.error || "Repayment failed");
                            }
                            setDone(true);
                            onRepaid();
                        }}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
