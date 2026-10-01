/**
 * Active Loans Panel — an agent's loan history with a live-estimated payoff
 * balance for active loans (interest accrues daily server-side; we project
 * forward from lastAccrualAt for display without waiting on a write).
 */
"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, AlertCircle, ShieldCheck, Landmark } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RepayLoanDialog } from "./repay-loan-dialog";
import type { Loan } from "@/lib/lending/types";

interface ActiveLoansPanelProps {
    agentId: string;
    refreshKey: number;
}

const STATUS_STYLES: Record<Loan["status"], string> = {
    pending: "bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-800/50 dark:text-slate-300 dark:border-slate-600",
    pending_disbursement: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-700",
    active: "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-700",
    repaid: "bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-700",
    defaulted: "bg-red-100 text-red-700 border-red-300 dark:bg-red-950/50 dark:text-red-300 dark:border-red-700",
};

function estimatePayoff(loan: Loan): number {
    const asOfSec = loan.lastAccrualAt ?? loan.originatedAt ?? Math.floor(Date.now() / 1000);
    const daysElapsed = Math.max(0, Date.now() / 1000 - asOfSec) / 86400;
    const dailyRate = loan.interestRateBps / 10_000 / 365;
    const projectedInterest = loan.interestAccruedUsd + loan.principalRemainingUsd * dailyRate * daysElapsed;
    return loan.principalRemainingUsd + projectedInterest;
}

export function ActiveLoansPanel({ agentId, refreshKey }: ActiveLoansPanelProps) {
    const [loans, setLoans] = useState<Loan[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [repayLoan, setRepayLoan] = useState<Loan | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/v1/lending/loans?agentId=${agentId}`);
            if (!res.ok) throw new Error("Failed to load loans");
            const data = await res.json();
            setLoans(data.loans || []);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load loans");
        } finally {
            setLoading(false);
        }
    }, [agentId]);

    useEffect(() => {
        load();
    }, [load, refreshKey]);

    if (loading) {
        return (
            <Card>
                <CardContent className="pt-6 flex items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </CardContent>
            </Card>
        );
    }

    if (error) {
        return (
            <Card>
                <CardContent className="pt-6 flex items-center gap-2 text-xs text-red-500">
                    <AlertCircle className="h-3.5 w-3.5" /> {error}
                </CardContent>
            </Card>
        );
    }

    if (loans.length === 0) return null;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base">Loans</CardTitle>
                <CardDescription>Loan history for this agent</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
                {loans.map((loan) => {
                    const payoff = loan.status === "active" ? estimatePayoff(loan) : loan.principalRemainingUsd + loan.interestAccruedUsd;
                    return (
                        <div key={loan.id} className="flex items-center justify-between p-2.5 rounded-md border border-border">
                            <div className="flex items-center gap-2">
                                {loan.kind === "trust" ? (
                                    <ShieldCheck className="h-3.5 w-3.5 text-amber-500" />
                                ) : (
                                    <Landmark className="h-3.5 w-3.5 text-emerald-500" />
                                )}
                                <div>
                                    <div className="text-xs font-medium">
                                        ${loan.principalUsd.toLocaleString()} &middot; {(loan.interestRateBps / 100).toFixed(1)}% &middot; {loan.source === "pool" ? "Pool" : "Solo"}
                                    </div>
                                    <div className="text-[10px] text-muted-foreground">
                                        {loan.status === "active" && `Payoff: $${payoff.toFixed(2)}`}
                                        {loan.status === "pending" && "Awaiting a solo lender"}
                                        {loan.status === "pending_disbursement" && "Approved — awaiting real USDC disbursement"}
                                        {loan.status === "repaid" && "Repaid in full"}
                                        {loan.status === "defaulted" && `Defaulted — $${loan.principalRemainingUsd.toFixed(2)} outstanding`}
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <Badge variant="outline" className={`text-[10px] ${STATUS_STYLES[loan.status]}`}>
                                    {loan.status}
                                </Badge>
                                {loan.status === "active" && (
                                    <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => setRepayLoan(loan)}>
                                        Repay
                                    </Button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </CardContent>

            {repayLoan && (
                <RepayLoanDialog
                    open={!!repayLoan}
                    onOpenChange={(open) => !open && setRepayLoan(null)}
                    loan={repayLoan}
                    payoffUsd={estimatePayoff(repayLoan)}
                    onRepaid={() => {
                        setRepayLoan(null);
                        load();
                    }}
                />
            )}
        </Card>
    );
}
