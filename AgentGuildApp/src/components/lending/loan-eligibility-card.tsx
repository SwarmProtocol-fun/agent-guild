/**
 * Loan Eligibility Card — shows an agent's current lending eligibility
 * (trust/collateralized vs unsecured) derived from their resolved credit policy tier.
 */
"use client";

import { useEffect, useState, useCallback } from "react";
import { Landmark, Lock, ShieldCheck, Loader2, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { RequestLoanDialog } from "./request-loan-dialog";
import type { EligibilitySummary } from "@/lib/lending/types";

interface LoanEligibilityCardProps {
    agentId: string;
    orgId: string;
    onLoanRequested: () => void;
}

function rate(bps: number): string {
    return `${(bps / 100).toFixed(1)}%`;
}

export function LoanEligibilityCard({ agentId, orgId, onLoanRequested }: LoanEligibilityCardProps) {
    const { address: sessionAddress } = useSession();
    const [eligibility, setEligibility] = useState<EligibilitySummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dialogKind, setDialogKind] = useState<"trust" | "unsecured" | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/v1/lending/eligibility?agentId=${agentId}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || "Failed to load eligibility");
            }
            setEligibility(await res.json());
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load eligibility");
        } finally {
            setLoading(false);
        }
    }, [agentId]);

    useEffect(() => {
        load();
    }, [load]);

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center gap-2">
                    <Landmark className="h-4 w-4 text-emerald-500" />
                    <CardTitle className="text-base">Lending</CardTitle>
                </div>
                <CardDescription>Loan eligibility, scaled to this agent&apos;s credit policy tier</CardDescription>
            </CardHeader>
            <CardContent>
                {loading ? (
                    <div className="flex items-center justify-center py-6">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                ) : error ? (
                    <div className="flex items-center gap-2 text-xs text-red-500">
                        <AlertCircle className="h-3.5 w-3.5" /> {error}
                    </div>
                ) : eligibility ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {/* Trust / collateralized */}
                        <div className="p-3 rounded-lg border border-border space-y-2">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-1.5 text-sm font-medium">
                                    <ShieldCheck className="h-3.5 w-3.5 text-amber-500" />
                                    Trust Loan
                                </div>
                                <Badge variant="outline" className="text-[10px]">Escrowed</Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Up to <span className="font-mono text-foreground">${eligibility.trust.maxAmountUsd.toLocaleString()}</span> at {rate(eligibility.trust.rateBps)} APR
                            </p>
                            {!eligibility.trust.eligible && (
                                <p className="text-[11px] text-red-500">{eligibility.trust.reason}</p>
                            )}
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs w-full"
                                disabled={!eligibility.trust.eligible}
                                onClick={() => setDialogKind("trust")}
                            >
                                Request
                            </Button>
                        </div>

                        {/* Unsecured */}
                        <div className="p-3 rounded-lg border border-border space-y-2">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-1.5 text-sm font-medium">
                                    {eligibility.unsecured.eligible ? (
                                        <Landmark className="h-3.5 w-3.5 text-emerald-500" />
                                    ) : (
                                        <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                                    )}
                                    Unsecured Loan
                                </div>
                                <Badge variant="outline" className="text-[10px]">No collateral</Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Up to <span className="font-mono text-foreground">${eligibility.unsecured.maxAmountUsd.toLocaleString()}</span> at {rate(eligibility.unsecured.rateBps)} APR
                            </p>
                            {!eligibility.unsecured.eligible && (
                                <p className="text-[11px] text-amber-500">{eligibility.unsecured.reason}</p>
                            )}
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs w-full"
                                disabled={!eligibility.unsecured.eligible}
                                onClick={() => setDialogKind("unsecured")}
                            >
                                Request
                            </Button>
                        </div>

                        <p className="sm:col-span-2 text-[11px] text-muted-foreground">
                            {eligibility.completedTrustLoans}/{eligibility.trustLoansRequiredForUnsecured} escrowed trust loans repaid toward unsecured eligibility &middot; {eligibility.activeLoanCount} active loan{eligibility.activeLoanCount === 1 ? "" : "s"}
                        </p>
                    </div>
                ) : null}
            </CardContent>

            {eligibility && dialogKind && (
                <RequestLoanDialog
                    open={!!dialogKind}
                    onOpenChange={(open) => !open && setDialogKind(null)}
                    agentId={agentId}
                    orgId={orgId}
                    kind={dialogKind}
                    gate={dialogKind === "trust" ? eligibility.trust : eligibility.unsecured}
                    walletAddress={sessionAddress}
                    onRequested={() => {
                        setDialogKind(null);
                        load();
                        onLoanRequested();
                    }}
                />
            )}
        </Card>
    );
}
