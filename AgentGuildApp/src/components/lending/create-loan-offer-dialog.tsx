/**
 * Create Loan Offer Dialog — a lender posts standing terms (amount, rate,
 * term) to the marketplace for a borrower to accept later, the inverse of a
 * borrower's solo loan request.
 */
"use client";

import { useState } from "react";
import { Loader2, AlertCircle, CheckCircle2, ShieldCheck, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import type { LoanKind } from "@/lib/lending/types";

interface CreateLoanOfferDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    walletAddress: string | null;
    onCreated: () => void;
}

const TERM_OPTIONS = [7, 14, 30, 60, 90];

export function CreateLoanOfferDialog({ open, onOpenChange, walletAddress, onCreated }: CreateLoanOfferDialogProps) {
    const [kind, setKind] = useState<LoanKind>("unsecured");
    const [amount, setAmount] = useState("500");
    const [ratePercent, setRatePercent] = useState("12");
    const [termDays, setTermDays] = useState("30");
    const [note, setNote] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);

    const handleClose = () => {
        if (loading) return;
        setDone(false);
        setError(null);
        onOpenChange(false);
    };

    const handleSubmit = async () => {
        if (!walletAddress) {
            setError("Connect a wallet first");
            return;
        }
        const amountValue = parseFloat(amount);
        if (!Number.isFinite(amountValue) || amountValue <= 0) {
            setError("Enter a valid amount");
            return;
        }
        const rateBps = Math.round(parseFloat(ratePercent) * 100);
        if (!Number.isFinite(rateBps) || rateBps <= 0) {
            setError("Enter a valid rate");
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/v1/lending/offers", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-wallet-address": walletAddress },
                body: JSON.stringify({
                    kind, amount: amountValue, rateBps, termDays: parseInt(termDays, 10),
                    note: note || undefined,
                }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || "Failed to create offer");
            }
            setDone(true);
            onCreated();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create offer");
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Create Loan Offer</DialogTitle>
                </DialogHeader>

                {done ? (
                    <div className="p-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 space-y-3">
                        <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
                            <CheckCircle2 className="h-4 w-4" /> Offer Posted
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Visible to borrowers now. You&apos;ll be asked to send the USDC directly once one accepts it.
                        </p>
                        <Button size="sm" onClick={handleClose} className="w-full h-8 text-xs">Done</Button>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div>
                            <Label className="text-xs">Loan Kind</Label>
                            <div className="grid grid-cols-2 gap-2 mt-1.5">
                                <button
                                    onClick={() => setKind("trust")}
                                    className={`flex items-center gap-2 p-2.5 rounded-lg border text-left transition-all ${kind === "trust" ? "border-amber-500/40 bg-amber-500/5" : "border-border hover:border-amber-500/20"}`}
                                >
                                    <ShieldCheck className="h-4 w-4 text-amber-500 shrink-0" />
                                    <div>
                                        <div className="text-xs font-medium">Trust</div>
                                        <div className="text-[10px] text-muted-foreground">Borrower posts escrow</div>
                                    </div>
                                </button>
                                <button
                                    onClick={() => setKind("unsecured")}
                                    className={`flex items-center gap-2 p-2.5 rounded-lg border text-left transition-all ${kind === "unsecured" ? "border-emerald-500/40 bg-emerald-500/5" : "border-border hover:border-emerald-500/20"}`}
                                >
                                    <Landmark className="h-4 w-4 text-emerald-500 shrink-0" />
                                    <div>
                                        <div className="text-xs font-medium">Unsecured</div>
                                        <div className="text-[10px] text-muted-foreground">No collateral</div>
                                    </div>
                                </button>
                            </div>
                        </div>

                        <div>
                            <Label className="text-xs">Max Amount (USD)</Label>
                            <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1" />
                        </div>

                        <div>
                            <Label className="text-xs">Rate (% APR)</Label>
                            <Input type="number" step="0.1" value={ratePercent} onChange={(e) => setRatePercent(e.target.value)} className="mt-1" />
                        </div>

                        <div>
                            <Label className="text-xs">Term</Label>
                            <Select value={termDays} onValueChange={setTermDays}>
                                <SelectTrigger className="mt-1">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {TERM_OPTIONS.map((d) => (
                                        <SelectItem key={d} value={String(d)}>{d} days</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div>
                            <Label className="text-xs">Note (optional)</Label>
                            <Textarea
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                placeholder="Any conditions for a borrower to know about"
                                className="mt-1"
                                rows={2}
                            />
                        </div>

                        <p className="text-[11px] text-muted-foreground">
                            A borrower whose eligibility covers this amount and rate can accept it. Only you can fund the resulting loan — send the principal straight to their wallet once that happens.
                        </p>

                        {error && (
                            <div className="p-2 rounded-lg border border-red-500/20 bg-red-500/5 flex items-center gap-2 text-xs text-red-400">
                                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                                {error}
                            </div>
                        )}

                        <Button size="sm" onClick={handleSubmit} disabled={loading} className="w-full h-8 text-xs gap-1">
                            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                            Post Offer
                        </Button>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
