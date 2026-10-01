/**
 * Request Loan Dialog — pick a source (pool vs solo), amount, and term for a
 * trust (collateralized) or unsecured loan, then submit the request.
 */
"use client";

import { useState } from "react";
import { Loader2, AlertCircle, CheckCircle2, Users, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { soloRateBand } from "@/lib/lending/eligibility";
import type { KindEligibility, LoanKind, LoanSource } from "@/lib/lending/types";

interface RequestLoanDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    agentId: string;
    orgId: string;
    kind: LoanKind;
    gate: KindEligibility;
    walletAddress: string | null;
    onRequested: () => void;
}

const TERM_OPTIONS = [7, 14, 30, 60, 90];

export function RequestLoanDialog({
    open, onOpenChange, agentId, orgId, kind, gate, walletAddress, onRequested,
}: RequestLoanDialogProps) {
    const [amount, setAmount] = useState(String(Math.min(gate.maxAmountUsd, 500)));
    const [source, setSource] = useState<LoanSource>("pool");
    const band = soloRateBand(gate.rateBps);
    const [ratePercent, setRatePercent] = useState(String(gate.rateBps / 100));
    const [termDays, setTermDays] = useState("30");
    const [purpose, setPurpose] = useState("");
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
        const amountUsd = parseFloat(amount);
        if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
            setError("Enter a valid amount");
            return;
        }
        if (amountUsd > gate.maxAmountUsd) {
            setError(`Amount exceeds the maximum of $${gate.maxAmountUsd.toLocaleString()}`);
            return;
        }
        let requestedRateBps: number | undefined;
        if (source === "solo") {
            requestedRateBps = Math.round(parseFloat(ratePercent) * 100);
            if (!Number.isFinite(requestedRateBps) || requestedRateBps < band.minBps || requestedRateBps > band.maxBps) {
                setError(`Rate must be between ${(band.minBps / 100).toFixed(1)}% and ${(band.maxBps / 100).toFixed(1)}% APR`);
                return;
            }
        }
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/v1/lending/loans", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-wallet-address": walletAddress || "" },
                body: JSON.stringify({
                    agentId, orgId, kind, source,
                    amountUsd, termDays: parseInt(termDays, 10),
                    purpose: purpose || undefined,
                    requestedRateBps,
                }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || "Failed to request loan");
            }
            setDone(true);
            onRequested();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to request loan");
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        Request {kind === "trust" ? "Trust (Escrowed)" : "Unsecured"} Loan
                    </DialogTitle>
                </DialogHeader>

                {done ? (
                    <div className="p-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 space-y-3">
                        <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
                            <CheckCircle2 className="h-4 w-4" />
                            {source === "pool" ? "Loan Approved" : "Request Posted"}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {source === "pool"
                                ? "The pool reserved the liquidity. A platform admin will send the real USDC disbursement shortly — the loan activates once that's confirmed on-chain."
                                : "This request is now visible on the lending marketplace for a solo lender to fund."}
                        </p>
                        <Button size="sm" onClick={handleClose} className="w-full h-8 text-xs">Done</Button>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div>
                            <Label className="text-xs">Amount (USD)</Label>
                            <Input
                                type="number"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                className="mt-1"
                            />
                            <p className="text-[10px] text-muted-foreground mt-1">
                                Max ${gate.maxAmountUsd.toLocaleString()} at {(gate.rateBps / 100).toFixed(1)}% APR
                            </p>
                        </div>

                        <div>
                            <Label className="text-xs">Funding Source</Label>
                            <div className="grid grid-cols-2 gap-2 mt-1.5">
                                <button
                                    onClick={() => setSource("pool")}
                                    className={`flex items-center gap-2 p-2.5 rounded-lg border text-left transition-all ${source === "pool" ? "border-emerald-500/40 bg-emerald-500/5" : "border-border hover:border-emerald-500/20"}`}
                                >
                                    <Users className="h-4 w-4 text-emerald-500 shrink-0" />
                                    <div>
                                        <div className="text-xs font-medium">Community Pool</div>
                                        <div className="text-[10px] text-muted-foreground">Diversified risk, admin-disbursed</div>
                                    </div>
                                </button>
                                <button
                                    onClick={() => setSource("solo")}
                                    className={`flex items-center gap-2 p-2.5 rounded-lg border text-left transition-all ${source === "solo" ? "border-purple-500/40 bg-purple-500/5" : "border-border hover:border-purple-500/20"}`}
                                >
                                    <User className="h-4 w-4 text-purple-400 shrink-0" />
                                    <div>
                                        <div className="text-xs font-medium">Solo Lender</div>
                                        <div className="text-[10px] text-muted-foreground">Posts to marketplace, awaits funding</div>
                                    </div>
                                </button>
                            </div>
                        </div>

                        {source === "solo" && (
                            <div>
                                <Label className="text-xs">Rate You're Offering (% APR)</Label>
                                <Input
                                    type="number"
                                    step="0.1"
                                    value={ratePercent}
                                    onChange={(e) => setRatePercent(e.target.value)}
                                    className="mt-1"
                                />
                                <p className="text-[10px] text-muted-foreground mt-1">
                                    Negotiated directly with a lender — must be between {(band.minBps / 100).toFixed(1)}% and {(band.maxBps / 100).toFixed(1)}% APR. Pool loans are always fixed at {(gate.rateBps / 100).toFixed(1)}%.
                                </p>
                            </div>
                        )}

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
                            <Label className="text-xs">Purpose (optional)</Label>
                            <Textarea
                                value={purpose}
                                onChange={(e) => setPurpose(e.target.value)}
                                placeholder="What is this loan for?"
                                className="mt-1"
                                rows={2}
                            />
                        </div>

                        {error && (
                            <div className="p-2 rounded-lg border border-red-500/20 bg-red-500/5 flex items-center gap-2 text-xs text-red-400">
                                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                                {error}
                            </div>
                        )}

                        <Button
                            size="sm"
                            onClick={handleSubmit}
                            disabled={loading}
                            className="w-full h-8 text-xs gap-1"
                        >
                            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                            {source === "pool" ? "Request Loan" : "Post to Marketplace"}
                        </Button>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
