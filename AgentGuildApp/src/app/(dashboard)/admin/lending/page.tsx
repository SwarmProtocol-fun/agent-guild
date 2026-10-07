/**
 * Admin — Lending Payouts
 *
 * The lending treasury has no signing key anywhere in this app — every real
 * payout (pool-funded loan disbursement, pool withdrawal, collateral return,
 * refund) is sent by a platform admin from the treasury wallet for that
 * asset (Solana for USDC and SOL, Ethereum for ETH — a Safe is fine), then
 * confirmed here with the resulting signature, which the backend verifies
 * on-chain before touching the ledger. Also hosts a manual trigger for the
 * lending sweep (normally hourly), and the liquidation queue: seized
 * collateral-market collateral to sell, then record the proceeds.
 *
 * Route: /admin/lending
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import { ShieldAlert, Loader2, RefreshCw, Landmark, ArrowUpFromLine, Undo2, Timer } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";
import { OnChainSendStep } from "@/components/lending/onchain-send-step";
import type { LendingPayout, Loan, PoolWithdrawalRequest } from "@/lib/lending/types";
import { assetOf, assetInfo, collateralAssetOf, formatAssetAmount, poolLabel, type LendingAsset } from "@/lib/lending/assets";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchLendingTreasury, treasuryAddressFor, sendAssetLabel, type LendingTreasuryInfo } from "@/lib/lending/client";

export default function AdminLendingPage() {
    const { address: sessionAddress, authenticated } = useSession();
    const isAdmin = isPlatformAdmin(sessionAddress);

    const [treasuryInfo, setTreasuryInfo] = useState<LendingTreasuryInfo | null>(null);
    const treasuryOf = (asset: LendingAsset) => (treasuryInfo ? treasuryAddressFor(treasuryInfo, asset) : null);
    const sendProps = (asset: LendingAsset) => ({ assetLabel: sendAssetLabel(treasuryInfo, asset), chain: assetInfo(asset).chain });
    const [disbursements, setDisbursements] = useState<Loan[]>([]);
    const [withdrawals, setWithdrawals] = useState<PoolWithdrawalRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [payoutLoan, setPayoutLoan] = useState<Loan | null>(null);
    const [payoutWithdrawal, setPayoutWithdrawal] = useState<PoolWithdrawalRequest | null>(null);
    const [payouts, setPayouts] = useState<LendingPayout[]>([]);
    const [liquidations, setLiquidations] = useState<Loan[]>([]);
    const [settlingLoan, setSettlingLoan] = useState<Loan | null>(null);
    const [proceeds, setProceeds] = useState("");
    const [activePayout, setActivePayout] = useState<LendingPayout | null>(null);
    const [sweeping, setSweeping] = useState(false);
    const [sweepSummary, setSweepSummary] = useState<string | null>(null);

    const runSweep = async () => {
        setSweeping(true);
        setSweepSummary(null);
        try {
            const res = await fetch("/api/cron/lending-sweep", { method: "POST" });
            const data = await res.json().catch(() => ({}));
            if (!res.ok && res.status !== 207) throw new Error(data.error || "Sweep failed");
            setSweepSummary(
                `Defaulted ${data.defaulted?.length ?? 0} · liquidating ${data.liquidating?.length ?? 0} · expired ${data.expired?.length ?? 0} · reconciled ${data.poolsReconciled?.length ?? 0} pool(s)`
                + (data.errors?.length ? ` · ${data.errors.length} error(s): ${data.errors.join("; ")}` : ""),
            );
            load();
        } catch (err) {
            setSweepSummary(err instanceof Error ? err.message : "Sweep failed");
        } finally {
            setSweeping(false);
        }
    };

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [treasury, loansRes, withdrawalsRes, payoutsRes, liquidationsRes] = await Promise.all([
                fetchLendingTreasury().catch(() => null),
                fetch("/api/v1/lending/loans?open=pending_disbursement"),
                fetch("/api/v1/lending/pools/withdrawals"),
                fetch("/api/v1/lending/payouts"),
                fetch("/api/v1/lending/loans?open=liquidating"),
            ]);
            setTreasuryInfo(treasury);
            if (loansRes.ok) setDisbursements((await loansRes.json()).loans || []);
            if (withdrawalsRes.ok) setWithdrawals((await withdrawalsRes.json()).requests || []);
            if (payoutsRes.ok) setPayouts((await payoutsRes.json()).payouts || []);
            if (liquidationsRes.ok) setLiquidations((await liquidationsRes.json()).loans || []);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAdmin) load();
    }, [isAdmin, load]);

    if (!authenticated || !isAdmin) {
        return (
            <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
                <ShieldAlert className="h-12 w-12 text-red-400" />
                <h2 className="text-lg font-semibold">Access Denied</h2>
                <p className="text-sm text-muted-foreground">Platform admin wallet required.</p>
            </div>
        );
    }

    return (
        <div className="space-y-6 p-6 max-w-5xl mx-auto">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold flex items-center gap-2">
                        <Landmark className="h-5 w-5 text-emerald-500" /> Lending Payouts
                    </h1>
                    {treasuryInfo && (
                        <div className="text-xs text-muted-foreground mt-1 font-mono space-y-0.5">
                            <p>Solana treasury (USDC, SOL): {treasuryInfo.assets.usdc.treasuryAddress}</p>
                            <p>Ethereum treasury (ETH): {treasuryInfo.assets.eth ? `${treasuryInfo.assets.eth.treasuryAddress} · ${treasuryInfo.assets.eth.network}` : "not configured"}</p>
                        </div>
                    )}
                </div>
                <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={runSweep} disabled={sweeping} className="gap-1">
                        {sweeping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Timer className="h-3.5 w-3.5" />} Run Sweep
                    </Button>
                    <Button size="sm" variant="outline" onClick={load} className="gap-1">
                        <RefreshCw className="h-3.5 w-3.5" /> Refresh
                    </Button>
                </div>
            </div>
            {sweepSummary && <p className="text-xs text-muted-foreground">{sweepSummary}</p>}

            {loading ? (
                <div className="flex items-center justify-center py-16">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
            ) : (
                <>
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Loans Awaiting Disbursement ({disbursements.length})</CardTitle>
                            <CardDescription>Send the principal from the treasury to each borrower, then confirm with the signature.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {disbursements.length === 0 ? (
                                <p className="text-xs text-muted-foreground">Nothing pending.</p>
                            ) : (
                                disbursements.map((loan) => (
                                    <div key={loan.id} className="flex items-center justify-between p-2.5 rounded-md border border-border text-xs">
                                        <div>
                                            <div className="font-mono">{loan.borrowerWalletAddress}</div>
                                            <div className="text-muted-foreground">{formatAssetAmount(assetOf(loan), loan.principal)} &middot; {loan.kind} &middot; agent {loan.borrowerAgentId}</div>
                                        </div>
                                        <div className="flex gap-1.5">
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-7 text-xs"
                                                onClick={async () => {
                                                    if (!confirm("Cancel this loan? Its pool reservation is released and any collateral is queued for return. Only do this if you have NOT sent the disbursement.")) return;
                                                    const res = await fetch(`/api/v1/lending/loans/${loan.id}/cancel`, { method: "POST" });
                                                    if (!res.ok) alert((await res.json().catch(() => ({}))).error || "Failed to cancel");
                                                    load();
                                                }}
                                            >
                                                Cancel
                                            </Button>
                                            <Button size="sm" className="h-7 text-xs" onClick={() => setPayoutLoan(loan)}>Mark Paid</Button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Pool Withdrawals Awaiting Payout ({withdrawals.length})</CardTitle>
                            <CardDescription>Send the locked-in amount from the treasury to each lender, then confirm with the signature.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {withdrawals.length === 0 ? (
                                <p className="text-xs text-muted-foreground">Nothing pending.</p>
                            ) : (
                                withdrawals.map((req) => (
                                    <div key={req.id} className="flex items-center justify-between p-2.5 rounded-md border border-border text-xs">
                                        <div>
                                            <div className="font-mono">{req.payoutWalletAddress ?? req.walletAddress}</div>
                                            <div className="text-muted-foreground">{formatAssetAmount(assetOf(req), req.amount)} from pool {req.poolId}</div>
                                        </div>
                                        <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setPayoutWithdrawal(req)}>
                                            <ArrowUpFromLine className="h-3 w-3" /> Mark Paid
                                        </Button>
                                    </div>
                                ))
                            )}
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Liquidations ({liquidations.length})</CardTitle>
                            <CardDescription>
                                Collateral-market loans whose collateral was seized (loan-to-value past the market&apos;s threshold, or overdue).
                                Sell the collateral from its treasury, send the USDC proceeds to the Solana treasury, then record them here.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {liquidations.length === 0 ? (
                                <p className="text-xs text-muted-foreground">Nothing pending.</p>
                            ) : (
                                liquidations.map((loan) => (
                                    <div key={loan.id} className="flex items-center justify-between p-2.5 rounded-md border border-border text-xs">
                                        <div>
                                            <div>
                                                {poolLabel(loan)} &middot; sell {formatAssetAmount(collateralAssetOf(loan), loan.collateral)} &middot; owed {formatAssetAmount(assetOf(loan), loan.principalRemaining + loan.interestAccrued)}
                                            </div>
                                            <div className="text-muted-foreground">
                                                {loan.liquidationReason === "overdue" ? "Overdue" : loan.liquidationReason === "admin" ? "Started by an admin" : `LTV ${((loan.liquidationLtvAtStart ?? 0) * 100).toFixed(0)}%`}
                                                {loan.liquidationPriceUsd !== undefined && ` at $${loan.liquidationPriceUsd.toLocaleString()}/${assetInfo(collateralAssetOf(loan)).symbol}`} &middot; agent {loan.borrowerAgentId}
                                            </div>
                                        </div>
                                        <Button size="sm" className="h-7 text-xs" onClick={() => { setProceeds(""); setSettlingLoan(loan); }}>Record Proceeds</Button>
                                    </div>
                                ))
                            )}
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Payout Queue ({payouts.length})</CardTitle>
                            <CardDescription>
                                Collateral returns, seized collateral owed to solo lenders, and refunds. Treasury payouts are yours to send;
                                payouts owed by a user&apos;s own wallet are listed for visibility and settled by that user.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {payouts.length === 0 ? (
                                <p className="text-xs text-muted-foreground">Nothing pending.</p>
                            ) : (
                                payouts.map((p) => {
                                    const fromTreasury = p.fromWallet === treasuryOf(assetOf(p));
                                    return (
                                        <div key={p.id} className="flex items-center justify-between p-2.5 rounded-md border border-border text-xs">
                                            <div>
                                                <div className="font-mono">{p.toWallet}</div>
                                                <div className="text-muted-foreground">
                                                    {formatAssetAmount(assetOf(p), p.amount)} &middot; {p.kind.replace(/_/g, " ")} &middot; {p.reason}
                                                    {!fromTreasury && <> &middot; owed by <span className="font-mono">{p.fromWallet.slice(0, 6)}…</span></>}
                                                </div>
                                            </div>
                                            <Button size="sm" className="h-7 text-xs gap-1" variant={fromTreasury ? "default" : "outline"} onClick={() => setActivePayout(p)}>
                                                <Undo2 className="h-3 w-3" /> Mark Paid
                                            </Button>
                                        </div>
                                    );
                                })
                            )}
                        </CardContent>
                    </Card>
                </>
            )}

            {activePayout && (
                <Dialog open onOpenChange={(open) => !open && setActivePayout(null)}>
                    <DialogContent className="max-w-sm">
                        <DialogHeader><DialogTitle>Confirm Payout</DialogTitle></DialogHeader>
                        <OnChainSendStep
                            recipientAddress={activePayout.toWallet}
                            amount={activePayout.amount}
                            {...sendProps(assetOf(activePayout))}
                            helperText={`${activePayout.reason}. Send exactly this amount from ${activePayout.fromWallet === treasuryOf(assetOf(activePayout)) ? "the treasury" : activePayout.fromWallet}, then paste the signature.`}
                            submitLabel="Confirm Payout"
                            onSubmit={async (txSig) => {
                                const res = await fetch(`/api/v1/lending/payouts/${activePayout.id}/confirm`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ txSig }),
                                });
                                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to confirm");
                                setActivePayout(null);
                                load();
                            }}
                        />
                    </DialogContent>
                </Dialog>
            )}

            {settlingLoan && (
                <Dialog open onOpenChange={(open) => !open && setSettlingLoan(null)}>
                    <DialogContent className="max-w-sm">
                        <DialogHeader><DialogTitle>Record Liquidation Proceeds</DialogTitle></DialogHeader>
                        <div className="space-y-3">
                            <div>
                                <Label className="text-xs">Proceeds ({assetInfo(assetOf(settlingLoan)).symbol})</Label>
                                <Input type="number" value={proceeds} onChange={(e) => setProceeds(e.target.value)} className="mt-1" placeholder="What the collateral sold for" />
                                <p className="text-[10px] text-muted-foreground mt-1">
                                    Owed: {formatAssetAmount(assetOf(settlingLoan), settlingLoan.principalRemaining + settlingLoan.interestAccrued)}. Any surplus is queued back to the borrower; a shortfall is written off as a default.
                                </p>
                            </div>
                            {parseFloat(proceeds) > 0 && treasuryOf(assetOf(settlingLoan)) && (
                                <OnChainSendStep
                                    recipientAddress={treasuryOf(assetOf(settlingLoan))!}
                                    amount={parseFloat(proceeds)}
                                    {...sendProps(assetOf(settlingLoan))}
                                    helperText="Send the sale proceeds to the treasury from anywhere (an exchange withdrawal, or a swap inside the treasury), then paste that transaction."
                                    submitLabel="Verify & Settle"
                                    onSubmit={async (txSig) => {
                                        const res = await fetch(`/api/v1/lending/loans/${settlingLoan.id}/liquidation-proceeds`, {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ amount: parseFloat(proceeds), txSig }),
                                        });
                                        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to settle");
                                        setSettlingLoan(null);
                                        load();
                                    }}
                                />
                            )}
                        </div>
                    </DialogContent>
                </Dialog>
            )}

            {payoutLoan && (
                <Dialog open onOpenChange={(open) => !open && setPayoutLoan(null)}>
                    <DialogContent className="max-w-sm">
                        <DialogHeader><DialogTitle>Confirm Loan Disbursement</DialogTitle></DialogHeader>
                        <OnChainSendStep
                            recipientAddress={payoutLoan.borrowerWalletAddress!}
                            amount={payoutLoan.principal}
                            {...sendProps(assetOf(payoutLoan))}
                            helperText="Send the principal from the treasury to this borrower, then paste the signature."
                            submitLabel="Confirm Disbursement"
                            onSubmit={async (txSig) => {
                                const res = await fetch(`/api/v1/lending/loans/${payoutLoan.id}/disburse`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ txSig }),
                                });
                                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to confirm");
                                setPayoutLoan(null);
                                load();
                            }}
                        />
                    </DialogContent>
                </Dialog>
            )}

            {payoutWithdrawal && (
                <Dialog open onOpenChange={(open) => !open && setPayoutWithdrawal(null)}>
                    <DialogContent className="max-w-sm">
                        <DialogHeader><DialogTitle>Confirm Pool Withdrawal</DialogTitle></DialogHeader>
                        <OnChainSendStep
                            recipientAddress={payoutWithdrawal.payoutWalletAddress ?? payoutWithdrawal.walletAddress}
                            amount={payoutWithdrawal.amount}
                            {...sendProps(assetOf(payoutWithdrawal))}
                            helperText="Send the locked-in amount from the treasury to this lender, then paste the signature."
                            submitLabel="Confirm Payout"
                            onSubmit={async (txSig) => {
                                const res = await fetch(`/api/v1/lending/pools/withdrawals/${payoutWithdrawal.id}/confirm`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ txSig }),
                                });
                                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to confirm");
                                setPayoutWithdrawal(null);
                                load();
                            }}
                        />
                    </DialogContent>
                </Dialog>
            )}
        </div>
    );
}
