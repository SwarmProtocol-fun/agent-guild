/**
 * Admin — Lending Payouts
 *
 * The lending treasury has no signing key anywhere in this app — every real
 * payout (pool-funded loan disbursement, pool withdrawal) is sent by a
 * platform admin from their own wallet, then confirmed here with the
 * resulting signature, which the backend verifies on-chain before touching
 * the ledger.
 *
 * Route: /admin/lending
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import { ShieldAlert, Loader2, RefreshCw, Landmark, ArrowUpFromLine } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";
import { OnChainSendStep } from "@/components/lending/onchain-send-step";
import type { Loan, PoolWithdrawalRequest } from "@/lib/lending/types";

export default function AdminLendingPage() {
    const { address: sessionAddress, authenticated } = useSession();
    const isAdmin = isPlatformAdmin(sessionAddress);

    const [treasury, setTreasury] = useState<string | null>(null);
    const [disbursements, setDisbursements] = useState<Loan[]>([]);
    const [withdrawals, setWithdrawals] = useState<PoolWithdrawalRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [payoutLoan, setPayoutLoan] = useState<Loan | null>(null);
    const [payoutWithdrawal, setPayoutWithdrawal] = useState<PoolWithdrawalRequest | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [treasuryRes, loansRes, withdrawalsRes] = await Promise.all([
                fetch("/api/v1/lending/treasury"),
                fetch("/api/v1/lending/loans?open=pending_disbursement"),
                fetch("/api/v1/lending/pools/withdrawals"),
            ]);
            if (treasuryRes.ok) setTreasury((await treasuryRes.json()).treasuryAddress);
            if (loansRes.ok) setDisbursements((await loansRes.json()).loans || []);
            if (withdrawalsRes.ok) setWithdrawals((await withdrawalsRes.json()).requests || []);
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
                    {treasury && (
                        <p className="text-xs text-muted-foreground mt-1 font-mono">Treasury: {treasury}</p>
                    )}
                </div>
                <Button size="sm" variant="outline" onClick={load} className="gap-1">
                    <RefreshCw className="h-3.5 w-3.5" /> Refresh
                </Button>
            </div>

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
                                            <div className="text-muted-foreground">${loan.principalUsd.toLocaleString()} &middot; {loan.kind} &middot; agent {loan.borrowerAgentId}</div>
                                        </div>
                                        <Button size="sm" className="h-7 text-xs" onClick={() => setPayoutLoan(loan)}>Mark Paid</Button>
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
                                            <div className="font-mono">{req.walletAddress}</div>
                                            <div className="text-muted-foreground">${req.amountUsd.toLocaleString()} from pool {req.poolId}</div>
                                        </div>
                                        <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setPayoutWithdrawal(req)}>
                                            <ArrowUpFromLine className="h-3 w-3" /> Mark Paid
                                        </Button>
                                    </div>
                                ))
                            )}
                        </CardContent>
                    </Card>
                </>
            )}

            {payoutLoan && (
                <Dialog open onOpenChange={(open) => !open && setPayoutLoan(null)}>
                    <DialogContent className="max-w-sm">
                        <DialogHeader><DialogTitle>Confirm Loan Disbursement</DialogTitle></DialogHeader>
                        <OnChainSendStep
                            recipientAddress={payoutLoan.borrowerWalletAddress!}
                            amountUsd={payoutLoan.principalUsd}
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
                            recipientAddress={payoutWithdrawal.walletAddress}
                            amountUsd={payoutWithdrawal.amountUsd}
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
