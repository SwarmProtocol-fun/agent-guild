/**
 * Active Loans Panel — an agent's loan history with a live-estimated payoff
 * balance for active loans (interest accrues daily server-side; we project
 * forward from lastAccrualAt for display without waiting on a write). Trust
 * loans awaiting collateral get a "Post collateral" step — one click from the
 * agent's own wallet by default, or a verified transfer from the member's own
 * wallet — and can be cancelled until it's posted. Active collateral-market
 * loans show how close they are to liquidation and can take more collateral.
 */
"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, AlertCircle, ShieldCheck, Landmark, TriangleAlert } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OnChainSendStep } from "./onchain-send-step";
import { AgentWalletSendStep } from "./agent-wallet-send-step";
import { AddCollateralDialog } from "./add-collateral-dialog";
import { SendSourceTabs, type SendSource } from "./send-source-tabs";
import { useWalletTransfer } from "./use-wallet-transfer";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RepayLoanDialog } from "./repay-loan-dialog";
import type { Loan } from "@/lib/lending/types";
import { assetOf, assetInfo, collateralAssetOf, formatAssetAmount, poolLabel } from "@/lib/lending/assets";
import { loanToValue, loanHealth, type LoanHealth } from "@/lib/lending/math";
import { fetchLendingTreasury, treasuryAddressFor, sendAssetLabel, type LendingTreasuryInfo } from "@/lib/lending/client";

interface ActiveLoansPanelProps {
    agentId: string;
    refreshKey: number;
}

const STATUS_STYLES: Record<Loan["status"], string> = {
    pending_collateral: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-700",
    cancelled: "bg-slate-100 text-slate-500 border-slate-300 dark:bg-slate-800/50 dark:text-slate-400 dark:border-slate-600",
    pending: "bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-800/50 dark:text-slate-300 dark:border-slate-600",
    pending_disbursement: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-700",
    active: "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-700",
    repaid: "bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-700",
    defaulted: "bg-red-100 text-red-700 border-red-300 dark:bg-red-950/50 dark:text-red-300 dark:border-red-700",
    liquidating: "bg-orange-100 text-orange-700 border-orange-300 dark:bg-orange-950/50 dark:text-orange-300 dark:border-orange-700",
    liquidated: "bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-800/50 dark:text-slate-300 dark:border-slate-600",
};

function estimatePayoff(loan: Loan): number {
    const asOfSec = loan.lastAccrualAt ?? loan.originatedAt ?? Math.floor(Date.now() / 1000);
    const daysElapsed = Math.max(0, Date.now() / 1000 - asOfSec) / 86400;
    const dailyRate = loan.interestRateBps / 10_000 / 365;
    const projectedInterest = loan.interestAccrued + loan.principalRemaining * dailyRate * daysElapsed;
    return loan.principalRemaining + projectedInterest;
}

export function ActiveLoansPanel({ agentId, refreshKey }: ActiveLoansPanelProps) {
    const [loans, setLoans] = useState<Loan[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [repayLoan, setRepayLoan] = useState<Loan | null>(null);
    const [collateralLoan, setCollateralLoan] = useState<Loan | null>(null);
    const [collateralSource, setCollateralSource] = useState<SendSource>("agent");
    const [topUpLoan, setTopUpLoan] = useState<Loan | null>(null);
    const [treasuryInfo, setTreasuryInfo] = useState<LendingTreasuryInfo | null>(null);
    const [cancellingId, setCancellingId] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const { canSend, send } = useWalletTransfer(treasuryInfo);

    const openCollateral = async (loan: Loan) => {
        setActionError(null);
        let info = treasuryInfo;
        if (!info) {
            try {
                info = await fetchLendingTreasury();
                setTreasuryInfo(info);
            } catch (err) {
                setActionError(err instanceof Error ? err.message : "Lending treasury is not configured");
                return;
            }
        }
        if (!treasuryAddressFor(info, collateralAssetOf(loan))) {
            setActionError(`The ${assetInfo(collateralAssetOf(loan)).symbol} treasury is not configured`);
            return;
        }
        setCollateralSource("agent");
        setCollateralLoan(loan);
    };

    const cancel = async (loan: Loan) => {
        setCancellingId(loan.id);
        setActionError(null);
        try {
            const res = await fetch(`/api/v1/lending/loans/${loan.id}/cancel`, { method: "POST" });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to cancel");
            await load();
        } catch (err) {
            setActionError(err instanceof Error ? err.message : "Failed to cancel");
        } finally {
            setCancellingId(null);
        }
    };

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

    // Prices for market loans' live loan-to-value (best-effort; the panel works without them).
    useEffect(() => {
        fetchLendingTreasury().then(setTreasuryInfo).catch(() => undefined);
    }, [refreshKey]);

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
                {actionError && (
                    <div className="flex items-center gap-2 text-xs text-red-500">
                        <AlertCircle className="h-3.5 w-3.5" /> {actionError}
                    </div>
                )}
                {loans.map((loan) => {
                    const payoff = loan.status === "active" ? estimatePayoff(loan) : loan.principalRemaining + loan.interestAccrued;
                    const asset = assetOf(loan);
                    const amt = (n: number) => formatAssetAmount(asset, n);
                    const coll = (n: number) => formatAssetAmount(collateralAssetOf(loan), n);
                    const collPrice = loan.collateralAsset ? treasuryInfo?.pricesUsd[loan.collateralAsset] ?? null : null;
                    const debtPrice = treasuryInfo?.pricesUsd[asset] ?? null;
                    const ltv = loan.status === "active" && collPrice !== null && debtPrice !== null
                        ? loanToValue(payoff, debtPrice, loan.collateral, collPrice)
                        : null;
                    return (
                        <div key={loan.id} className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-md border border-border">
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                {loan.kind === "trust" ? (
                                    <ShieldCheck className="h-3.5 w-3.5 text-amber-500" />
                                ) : (
                                    <Landmark className="h-3.5 w-3.5 text-emerald-500" />
                                )}
                                <div className="min-w-0 flex-1">
                                    <div className="text-xs font-medium">
                                        {amt(loan.principal)} &middot; {(loan.interestRateBps / 100).toFixed(1)}% &middot; {loan.source === "pool" ? (loan.collateralAsset ? `${poolLabel(loan)} market` : "Pool") : "Solo"}
                                    </div>
                                    <div className="text-[10px] text-muted-foreground">
                                        {loan.status === "active" && `Payoff: ${amt(payoff)}`}
                                        {loan.status === "pending_collateral" && (loan.agentCollateralSend?.status === "sent"
                                            ? `${coll(loan.collateral)} collateral sent from the agent's wallet; confirming`
                                            : `Post ${coll(loan.collateral)} collateral to continue`)}
                                        {loan.status === "liquidating" && `Collateral (${coll(loan.collateral)}) seized for sale — ${amt(loan.principalRemaining + loan.interestAccrued)} owed`}
                                        {loan.status === "liquidated" && `Collateral sold for ${amt(loan.liquidationProceeds ?? 0)}; loan closed`}
                                        {loan.status === "cancelled" && (loan.cancelReason || "Cancelled before funding")}
                                        {loan.status === "pending" && "Awaiting a solo lender"}
                                        {loan.status === "pending_disbursement" && `Approved — awaiting real ${assetInfo(asset).symbol} disbursement`}
                                        {loan.status === "repaid" && "Repaid in full"}
                                        {loan.status === "defaulted" && `Defaulted — ${amt(loan.principalRemaining)} outstanding`}
                                        {loan.collateralStatus === "held" && ` · ${coll(loan.collateral)} collateral held`}
                                        {loan.collateralStatus === "return_pending" && ` · collateral return queued`}
                                        {loan.collateralStatus === "returned" && ` · collateral returned`}
                                        {loan.collateralStatus === "seized" && ` · collateral seized`}
                                        {!!loan.overpaymentOwed && loan.overpaymentOwed >= assetInfo(asset).dust && ` · ${amt(loan.overpaymentOwed)} overpayment refund queued`}
                                    </div>
                                    {ltv !== null && loan.liquidationLtvBps && <LtvMeter ltv={ltv} liquidationLtvBps={loan.liquidationLtvBps} />}
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <Badge variant="outline" className={`text-[10px] ${STATUS_STYLES[loan.status]}`}>
                                    {loan.status}
                                </Badge>
                                {loan.status === "active" && loan.collateralAsset && loan.collateralStatus === "held" && (
                                    <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" disabled={!treasuryInfo} onClick={() => setTopUpLoan(loan)}>
                                        Add collateral
                                    </Button>
                                )}
                                {loan.status === "active" && (
                                    <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => setRepayLoan(loan)}>
                                        Repay
                                    </Button>
                                )}
                                {loan.status === "pending_collateral" && (
                                    <>
                                        <Button size="sm" className="h-6 text-[10px] px-2" onClick={() => openCollateral(loan)}>
                                            Post collateral
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-6 text-[10px] px-2"
                                            disabled={cancellingId === loan.id}
                                            onClick={() => cancel(loan)}
                                        >
                                            {cancellingId === loan.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Cancel"}
                                        </Button>
                                    </>
                                )}
                            </div>
                        </div>
                    );
                })}
            </CardContent>

            {collateralLoan && treasuryInfo && treasuryAddressFor(treasuryInfo, collateralAssetOf(collateralLoan)) && (
                <Dialog open onOpenChange={(open) => !open && setCollateralLoan(null)}>
                    <DialogContent className="max-w-sm">
                        <DialogHeader><DialogTitle>Post Collateral</DialogTitle></DialogHeader>
                        <SendSourceTabs value={collateralSource} onChange={setCollateralSource} label="Pay collateral from" />
                        {collateralSource === "agent" ? (
                            <AgentWalletSendStep
                                endpoint={`/api/v1/lending/loans/${collateralLoan.id}/collateral/agent-wallet`}
                                verb="Post"
                                description={(a) => <>Sends exactly <span className="font-medium text-foreground">{a}</span> from the agent&apos;s wallet to the lending treasury and verifies it. It&apos;s returned to the same wallet when the loan is repaid.</>}
                                doneMessage="Collateral posted from the agent's wallet. The loan moves on to funding."
                                onPosted={() => { load(); setTimeout(() => setCollateralLoan(null), 1500); }}
                            />
                        ) : (
                        <OnChainSendStep
                            recipientAddress={treasuryAddressFor(treasuryInfo, collateralAssetOf(collateralLoan))!}
                            amount={collateralLoan.collateral}
                            assetLabel={sendAssetLabel(treasuryInfo, collateralAssetOf(collateralLoan))}
                            chain={assetInfo(collateralAssetOf(collateralLoan)).chain}
                            helperText="Send exactly this amount from your own wallet to the lending treasury. It's held for the life of the loan and returned to the same wallet when you repay — or applied to the balance if the loan defaults."
                            submitLabel="Verify Collateral"
                            onSendWithWallet={canSend(collateralAssetOf(collateralLoan))
                                ? () => send(collateralAssetOf(collateralLoan), treasuryAddressFor(treasuryInfo, collateralAssetOf(collateralLoan))!, collateralLoan.collateral)
                                : undefined}
                            onSubmit={async (txSig) => {
                                const res = await fetch(`/api/v1/lending/loans/${collateralLoan.id}/collateral`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ txSig }),
                                });
                                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Collateral verification failed");
                                setCollateralLoan(null);
                                load();
                            }}
                        />
                        )}
                    </DialogContent>
                </Dialog>
            )}

            {topUpLoan && treasuryInfo && (
                <AddCollateralDialog
                    loan={topUpLoan}
                    debt={estimatePayoff(topUpLoan)}
                    treasuryInfo={treasuryInfo}
                    onClose={() => setTopUpLoan(null)}
                    onAdded={load}
                />
            )}

            {repayLoan && (
                <RepayLoanDialog
                    open={!!repayLoan}
                    onOpenChange={(open) => !open && setRepayLoan(null)}
                    loan={repayLoan}
                    payoffEstimate={estimatePayoff(repayLoan)}
                    onRepaid={() => {
                        setRepayLoan(null);
                        load();
                    }}
                />
            )}
        </Card>
    );
}

const HEALTH_STYLES: Record<LoanHealth, { bar: string; text: string; label: string }> = {
    healthy: { bar: "bg-emerald-500", text: "text-muted-foreground", label: "Healthy" },
    watch: { bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", label: "Watch" },
    at_risk: { bar: "bg-red-500", text: "text-red-600 dark:text-red-400", label: "Close to liquidation" },
};

/** Loan-to-value against the liquidation threshold, with a plain warning as it gets close. */
function LtvMeter({ ltv, liquidationLtvBps }: { ltv: number; liquidationLtvBps: number }) {
    const threshold = liquidationLtvBps / 10_000;
    const health = loanHealth(ltv, liquidationLtvBps);
    const style = HEALTH_STYLES[health];
    // The bar spans 0 → the threshold; full means liquidation.
    const fill = Math.min(1, ltv / threshold);
    return (
        <div className="mt-1.5 max-w-xs">
            <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-[hsl(var(--muted))]"
                role="meter" aria-label="Loan-to-value" aria-valuemin={0} aria-valuemax={Math.round(threshold * 100)} aria-valuenow={Math.round(ltv * 100)}
            >
                <div className={`h-full rounded-full transition-[width] ${style.bar}`} style={{ width: `${fill * 100}%` }} />
            </div>
            <div className={`mt-0.5 flex items-center gap-1 text-[10px] tabular-nums ${style.text}`}>
                {health === "at_risk" && <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />}
                <span>
                    LTV {(ltv * 100).toFixed(1)}% · liquidates at {(threshold * 100).toFixed(0)}% · {style.label}
                    {health === "at_risk" && " — add collateral or repay"}
                </span>
            </div>
        </div>
    );
}
