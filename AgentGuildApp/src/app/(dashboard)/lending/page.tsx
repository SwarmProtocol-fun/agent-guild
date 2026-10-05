/**
 * Lending Marketplace — browse and fund community pools or individual (solo)
 * loan requests from agents, and track your own positions/returns.
 *
 * Route: /lending
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Landmark, Users, User, Loader2, AlertCircle, CheckCircle2,
    ShieldCheck, ArrowDownToLine, ArrowUpFromLine, Wallet, Plus, X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSession } from "@/contexts/SessionContext";
import { getDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { OnChainSendStep } from "@/components/lending/onchain-send-step";
import { CreateLoanOfferDialog } from "@/components/lending/create-loan-offer-dialog";
import { BorrowPanel } from "@/components/lending/borrow-panel";
import type { Agent } from "@/lib/firestore";
import type { DepositAsset, LendingPayout, LendingPool, Loan, LoanOffer, PoolPosition, PoolWithdrawalRequest } from "@/lib/lending/types";
import { poolSharePrice as sharePrice, freeShares, solLamportsForUsd, LAMPORTS_PER_SOL } from "@/lib/lending/math";
import { useSolanaSender, useSolanaMessageSigner } from "@/lib/wallet";
import { walletLinkMessage } from "@/lib/solana/wallet-link";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import { getConnection } from "@/lib/solana/client";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
    createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";

type Tab = "borrow" | "pools" | "fund" | "offers" | "positions";

function fmt(n: number): string {
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function LendingMarketplacePage() {
    const { address: sessionAddress } = useSession();

    const [activeTab, setActiveTab] = useState<Tab>("pools");
    const [pools, setPools] = useState<LendingPool[]>([]);
    const [openLoans, setOpenLoans] = useState<Loan[]>([]);
    const [openOffers, setOpenOffers] = useState<LoanOffer[]>([]);
    const [myOffers, setMyOffers] = useState<LoanOffer[]>([]);
    const [positions, setPositions] = useState<Record<string, PoolPosition>>({});
    const [fundedLoans, setFundedLoans] = useState<Loan[]>([]);
    const [pendingWithdrawals, setPendingWithdrawals] = useState<PoolWithdrawalRequest[]>([]);
    const [payouts, setPayouts] = useState<{ owedToYou: LendingPayout[]; owedByYou: LendingPayout[] }>({ owedToYou: [], owedByYou: [] });
    const [settlingPayout, setSettlingPayout] = useState<LendingPayout | null>(null);
    const [positionsError, setPositionsError] = useState<string | null>(null);
    const [agentNames, setAgentNames] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);

    const [poolDialog, setPoolDialog] = useState<{ pool: LendingPool; mode: "deposit" | "withdraw" } | null>(null);
    const [fundingLoan, setFundingLoan] = useState<Loan | null>(null);
    const [creatingOffer, setCreatingOffer] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [poolsRes, loansRes, offersRes] = await Promise.all([
                fetch("/api/v1/lending/pools"),
                fetch("/api/v1/lending/loans?open=solo"),
                fetch("/api/v1/lending/offers?open=1"),
            ]);
            const poolsData = poolsRes.ok ? (await poolsRes.json()).pools as LendingPool[] : [];
            const loansData = loansRes.ok ? (await loansRes.json()).loans as Loan[] : [];
            const offersData = offersRes.ok ? (await offersRes.json()).offers as LoanOffer[] : [];
            setPools(poolsData);
            setOpenLoans(loansData);
            setOpenOffers(offersData);

            if (sessionAddress) {
                const posEntries = await Promise.all(
                    poolsData.map(async (p) => {
                        const res = await fetch(`/api/v1/lending/pools/${p.id}/position`, {
                            headers: { "x-wallet-address": sessionAddress },
                        });
                        if (!res.ok) return null;
                        const body = await res.json();
                        return body.position ? ([p.id, body.position as PoolPosition] as const) : null;
                    }),
                );
                setPositions(Object.fromEntries(posEntries.filter(Boolean) as [string, PoolPosition][]));

                const fundedRes = await fetch(`/api/v1/lending/loans?lenderWallet=${sessionAddress}`);
                setFundedLoans(fundedRes.ok ? (await fundedRes.json()).loans : []);

                const withdrawalsRes = await fetch("/api/v1/lending/pools/withdrawals?mine=1", {
                    headers: { "x-wallet-address": sessionAddress },
                });
                setPendingWithdrawals(withdrawalsRes.ok ? (await withdrawalsRes.json()).requests : []);

                const myOffersRes = await fetch(`/api/v1/lending/offers?lenderWallet=${sessionAddress}`);
                setMyOffers(myOffersRes.ok ? (await myOffersRes.json()).offers : []);

                const payoutsRes = await fetch("/api/v1/lending/payouts?mine=1");
                setPayouts(payoutsRes.ok ? await payoutsRes.json() : { owedToYou: [], owedByYou: [] });
            } else {
                setPositions({});
                setFundedLoans([]);
                setPendingWithdrawals([]);
                setMyOffers([]);
                setPayouts({ owedToYou: [], owedByYou: [] });
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load lending data");
        } finally {
            setLoading(false);
        }
    }, [sessionAddress]);

    useEffect(() => {
        load();
    }, [load, refreshKey]);

    // Resolve borrower names for open loan requests (best-effort, client-side).
    useEffect(() => {
        const missing = openLoans.filter((l) => !(l.borrowerAgentId in agentNames));
        if (missing.length === 0) return;
        (async () => {
            const entries = await Promise.all(
                missing.map(async (l) => {
                    try {
                        const snap = await getDoc(doc(db, "agents", l.borrowerAgentId));
                        const data = snap.data() as Agent | undefined;
                        return [l.borrowerAgentId, data?.name || l.borrowerAgentId] as const;
                    } catch {
                        return [l.borrowerAgentId, l.borrowerAgentId] as const;
                    }
                }),
            );
            setAgentNames((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openLoans]);

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-xl font-bold flex items-center gap-2">
                    <Landmark className="h-5 w-5 text-emerald-500" />
                    Lending Marketplace
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                    Apply for a loan for one of your agents, fund the community pool for diversified, lower-risk returns, or back a single agent&apos;s loan directly for a higher rate.
                </p>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1 border-b border-border">
                {([
                    { key: "borrow", label: "Borrow" },
                    { key: "pools", label: "Pools" },
                    { key: "fund", label: `Fund a Loan (${openLoans.length})` },
                    { key: "offers", label: `Loan Offers (${openOffers.length})` },
                    { key: "positions", label: "My Positions" },
                ] as { key: Tab; label: string }[]).map(({ key, label }) => (
                    <button
                        key={key}
                        onClick={() => setActiveTab(key)}
                        className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${activeTab === key
                            ? "border-emerald-500 text-emerald-500"
                            : "border-transparent text-muted-foreground hover:text-foreground"
                            }`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {error && (
                <div className="p-2 rounded-lg border border-red-500/20 bg-red-500/5 flex items-center gap-2 text-xs text-red-400">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
                </div>
            )}

            {loading ? (
                <div className="flex items-center justify-center py-16">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
            ) : (
                <>
                    {activeTab === "borrow" && <BorrowPanel />}

                    {activeTab === "pools" && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {pools.map((pool) => {
                                const price = sharePrice(pool);
                                const yieldPct = pool.totalDepositedUsd > 0 ? (pool.totalInterestEarnedUsd / pool.totalDepositedUsd) * 100 : 0;
                                const position = positions[pool.id];
                                const positionValue = position ? freeShares(position) * price : 0;
                                return (
                                    <Card key={pool.id}>
                                        <CardHeader>
                                            <div className="flex items-center gap-2">
                                                <Users className="h-4 w-4 text-emerald-500" />
                                                <CardTitle className="text-base">{pool.name}</CardTitle>
                                            </div>
                                            {pool.description && <CardDescription>{pool.description}</CardDescription>}
                                        </CardHeader>
                                        <CardContent className="space-y-3">
                                            <div className="grid grid-cols-3 gap-2 text-center">
                                                <div>
                                                    <p className="text-[10px] text-muted-foreground">Available</p>
                                                    <p className="text-sm font-mono">${fmt(pool.availableLiquidityUsd)}</p>
                                                </div>
                                                <div>
                                                    <p className="text-[10px] text-muted-foreground">Out on Loan</p>
                                                    <p className="text-sm font-mono">${fmt(pool.totalLentUsd)}</p>
                                                </div>
                                                <div>
                                                    <p className="text-[10px] text-muted-foreground">Lifetime Yield</p>
                                                    <p className="text-sm font-mono text-emerald-500">+{yieldPct.toFixed(2)}%</p>
                                                </div>
                                            </div>
                                            {position && (
                                                <div className="text-xs text-muted-foreground border-t border-border pt-2">
                                                    Your position: <span className="font-mono text-foreground">${fmt(positionValue)}</span>
                                                </div>
                                            )}
                                            <div className="flex gap-2">
                                                <Button size="sm" variant="outline" className="h-7 text-xs flex-1 gap-1" onClick={() => setPoolDialog({ pool, mode: "deposit" })}>
                                                    <ArrowDownToLine className="h-3 w-3" /> Deposit
                                                </Button>
                                                <Button size="sm" variant="outline" className="h-7 text-xs flex-1 gap-1" disabled={!position} onClick={() => setPoolDialog({ pool, mode: "withdraw" })}>
                                                    <ArrowUpFromLine className="h-3 w-3" /> Withdraw
                                                </Button>
                                            </div>
                                        </CardContent>
                                    </Card>
                                );
                            })}
                        </div>
                    )}

                    {activeTab === "fund" && (
                        <div className="space-y-2">
                            {(() => {
                                const fundable = openLoans.filter((l) => !l.reservedLenderWallet || l.reservedLenderWallet === sessionAddress);
                                if (fundable.length === 0) {
                                    return <p className="text-sm text-muted-foreground py-8 text-center">No open solo loan requests right now.</p>;
                                }
                                return fundable.map((loan) => (
                                    <div key={loan.id} className="flex items-center justify-between p-3 rounded-lg border border-border">
                                        <div className="flex items-center gap-3">
                                            {loan.kind === "trust" ? (
                                                <ShieldCheck className="h-4 w-4 text-amber-500 shrink-0" />
                                            ) : (
                                                <Landmark className="h-4 w-4 text-emerald-500 shrink-0" />
                                            )}
                                            <div>
                                                <div className="text-sm font-medium">
                                                    {agentNames[loan.borrowerAgentId] || loan.borrowerAgentId}
                                                    <span className="text-muted-foreground font-normal"> &middot; ${loan.principalUsd.toLocaleString()}</span>
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                    {(loan.interestRateBps / 100).toFixed(1)}% APR &middot; {loan.termDays}d term
                                                    {loan.kind === "trust" && ` · $${loan.collateralUsd.toFixed(0)} escrow`}
                                                    {loan.purpose && ` · ${loan.purpose}`}
                                                    {loan.reservedLenderWallet && " · from your offer"}
                                                </div>
                                            </div>
                                        </div>
                                        <Button size="sm" className="h-7 text-xs" onClick={() => setFundingLoan(loan)}>
                                            Fund
                                        </Button>
                                    </div>
                                ));
                            })()}
                        </div>
                    )}

                    {activeTab === "offers" && (
                        <div className="space-y-3">
                            <div className="flex justify-end">
                                <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setCreatingOffer(true)}>
                                    <Plus className="h-3 w-3" /> Create Offer
                                </Button>
                            </div>
                            {openOffers.length === 0 ? (
                                <p className="text-sm text-muted-foreground py-8 text-center">No open loan offers right now.</p>
                            ) : (
                                <div className="space-y-2">
                                    {openOffers.map((offer) => (
                                        <div key={offer.id} className="flex items-center justify-between p-3 rounded-lg border border-border">
                                            <div className="flex items-center gap-3">
                                                {offer.kind === "trust" ? (
                                                    <ShieldCheck className="h-4 w-4 text-amber-500 shrink-0" />
                                                ) : (
                                                    <Landmark className="h-4 w-4 text-emerald-500 shrink-0" />
                                                )}
                                                <div>
                                                    <div className="text-sm font-medium">
                                                        Up to ${offer.amountUsd.toLocaleString()}
                                                        <span className="text-muted-foreground font-normal"> &middot; {(offer.rateBps / 100).toFixed(1)}% APR &middot; {offer.termDays}d</span>
                                                    </div>
                                                    <div className="text-xs text-muted-foreground">
                                                        {offer.kind === "trust" ? "Trust (escrowed)" : "Unsecured"}
                                                        {offer.note && ` · ${offer.note}`}
                                                    </div>
                                                </div>
                                            </div>
                                            <Badge variant="outline" className="text-[10px]">open</Badge>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <p className="text-[11px] text-muted-foreground pt-1">
                                Accept an offer from an agent&apos;s credit page — eligibility (amount, rate band) is checked against that agent&apos;s own tier.
                            </p>
                        </div>
                    )}

                    {activeTab === "positions" && (
                        !sessionAddress ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
                                <Wallet className="h-4 w-4" /> Connect a wallet to view your positions.
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div>
                                    <h3 className="text-sm font-semibold mb-2">Pool Positions</h3>
                                    {Object.keys(positions).length === 0 ? (
                                        <p className="text-xs text-muted-foreground">No pool deposits yet.</p>
                                    ) : (
                                        <div className="space-y-2">
                                            {pools.filter((p) => positions[p.id]).map((p) => (
                                                <div key={p.id} className="flex items-center justify-between p-2.5 rounded-md border border-border text-xs">
                                                    <span>{p.name}</span>
                                                    <span className="font-mono">${fmt(freeShares(positions[p.id]) * sharePrice(p))}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                {pendingWithdrawals.filter((w) => w.status === "pending_payout").length > 0 && (
                                    <div>
                                        <h3 className="text-sm font-semibold mb-2">Withdrawals Awaiting Payout</h3>
                                        <div className="space-y-2">
                                            {pendingWithdrawals.filter((w) => w.status === "pending_payout").map((w) => (
                                                <div key={w.id} className="flex items-center justify-between p-2.5 rounded-md border border-border text-xs">
                                                    <span>${fmt(w.amountUsd)} requested</span>
                                                    <div className="flex items-center gap-2">
                                                        <Badge variant="outline" className="text-[10px]">awaiting admin payout</Badge>
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            className="h-6 text-[10px] px-2"
                                                            onClick={async () => {
                                                                setPositionsError(null);
                                                                const res = await fetch(`/api/v1/lending/pools/withdrawals/${w.id}/cancel`, { method: "POST" });
                                                                if (!res.ok) setPositionsError((await res.json().catch(() => ({}))).error || "Failed to cancel withdrawal");
                                                                setRefreshKey((k) => k + 1);
                                                            }}
                                                        >
                                                            Cancel
                                                        </Button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {positionsError && (
                                    <div className="flex items-center gap-2 text-xs text-red-500">
                                        <AlertCircle className="h-3.5 w-3.5" /> {positionsError}
                                    </div>
                                )}
                                {payouts.owedByYou.some((p) => p.status === "pending") && (
                                    <div>
                                        <h3 className="text-sm font-semibold mb-2">Refunds You Owe</h3>
                                        <div className="space-y-2">
                                            {payouts.owedByYou.filter((p) => p.status === "pending").map((p) => (
                                                <div key={p.id} className="flex items-center justify-between p-2.5 rounded-md border border-amber-500/30 text-xs">
                                                    <div>
                                                        <div>${fmt(p.amountUsd)} to <span className="font-mono">{p.toWallet.slice(0, 6)}…{p.toWallet.slice(-4)}</span></div>
                                                        <div className="text-[10px] text-muted-foreground">{p.reason}</div>
                                                    </div>
                                                    <Button size="sm" className="h-6 text-[10px] px-2" onClick={() => setSettlingPayout(p)}>Send Refund</Button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {payouts.owedToYou.length > 0 && (
                                    <div>
                                        <h3 className="text-sm font-semibold mb-2">Payouts Owed to You</h3>
                                        <div className="space-y-2">
                                            {payouts.owedToYou.map((p) => (
                                                <div key={p.id} className="flex items-center justify-between p-2.5 rounded-md border border-border text-xs">
                                                    <div>
                                                        <div>${fmt(p.amountUsd)} &middot; {p.kind.replace(/_/g, " ")}</div>
                                                        <div className="text-[10px] text-muted-foreground">{p.reason}</div>
                                                    </div>
                                                    <Badge variant="outline" className="text-[10px]">{p.status === "paid" ? "paid" : "queued"}</Badge>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                <div>
                                    <h3 className="text-sm font-semibold mb-2">My Loan Offers</h3>
                                    {myOffers.length === 0 ? (
                                        <p className="text-xs text-muted-foreground">No loan offers posted yet.</p>
                                    ) : (
                                        <div className="space-y-2">
                                            {myOffers.map((offer) => (
                                                <div key={offer.id} className="flex items-center justify-between p-2.5 rounded-md border border-border text-xs">
                                                    <span>
                                                        ${offer.amountUsd.toLocaleString()} at {(offer.rateBps / 100).toFixed(1)}% APR &middot; {offer.termDays}d
                                                    </span>
                                                    <div className="flex items-center gap-2">
                                                        <Badge variant="outline" className="text-[10px]">{offer.status}</Badge>
                                                        {offer.status === "open" && (
                                                            <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                className="h-6 w-6 p-0"
                                                                onClick={async () => {
                                                                    if (!sessionAddress) return;
                                                                    await fetch(`/api/v1/lending/offers/${offer.id}/withdraw`, {
                                                                        method: "POST",
                                                                        headers: { "x-wallet-address": sessionAddress },
                                                                    });
                                                                    setRefreshKey((k) => k + 1);
                                                                }}
                                                            >
                                                                <X className="h-3 w-3" />
                                                            </Button>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold mb-2">Solo Loans Funded</h3>
                                    {fundedLoans.length === 0 ? (
                                        <p className="text-xs text-muted-foreground">No solo loans funded yet.</p>
                                    ) : (
                                        <div className="space-y-2">
                                            {fundedLoans.map((l) => (
                                                <div key={l.id} className="flex items-center justify-between p-2.5 rounded-md border border-border text-xs">
                                                    <span>{agentNames[l.borrowerAgentId] || l.borrowerAgentId} &middot; ${l.principalUsd.toLocaleString()}</span>
                                                    <Badge variant="outline" className="text-[10px]">{l.status}</Badge>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )
                    )}
                </>
            )}

            {poolDialog && (
                <PoolActionDialog
                    pool={poolDialog.pool}
                    mode={poolDialog.mode}
                    walletAddress={sessionAddress}
                    maxWithdraw={poolDialog.mode === "withdraw" && positions[poolDialog.pool.id] ? freeShares(positions[poolDialog.pool.id]) * sharePrice(poolDialog.pool) : undefined}
                    onClose={() => setPoolDialog(null)}
                    onDone={() => {
                        setPoolDialog(null);
                        setRefreshKey((k) => k + 1);
                    }}
                />
            )}

            {fundingLoan && (
                <FundLoanDialog
                    loan={fundingLoan}
                    borrowerName={agentNames[fundingLoan.borrowerAgentId] || fundingLoan.borrowerAgentId}
                    walletAddress={sessionAddress}
                    onClose={() => setFundingLoan(null)}
                    onDone={() => {
                        setFundingLoan(null);
                        setRefreshKey((k) => k + 1);
                    }}
                />
            )}

            {settlingPayout && (
                <Dialog open onOpenChange={(open) => !open && setSettlingPayout(null)}>
                    <DialogContent className="max-w-sm">
                        <DialogHeader><DialogTitle>Send Refund</DialogTitle></DialogHeader>
                        <OnChainSendStep
                            recipientAddress={settlingPayout.toWallet}
                            amountUsd={settlingPayout.amountUsd}
                            helperText={`${settlingPayout.reason}. Send exactly this amount from your wallet, then paste the signature.`}
                            submitLabel="Confirm Refund"
                            onSubmit={async (txSig) => {
                                const res = await fetch(`/api/v1/lending/payouts/${settlingPayout.id}/confirm`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ txSig }),
                                });
                                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to confirm refund");
                                setSettlingPayout(null);
                                setRefreshKey((k) => k + 1);
                            }}
                        />
                    </DialogContent>
                </Dialog>
            )}

            <CreateLoanOfferDialog
                open={creatingOffer}
                onOpenChange={setCreatingOffer}
                walletAddress={sessionAddress}
                onCreated={() => {
                    setCreatingOffer(false);
                    setRefreshKey((k) => k + 1);
                }}
            />
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════
// Pool deposit / withdraw dialog
// ═══════════════════════════════════════════════════════════════

function PoolActionDialog({
    pool, mode, walletAddress, maxWithdraw, onClose, onDone,
}: {
    pool: LendingPool;
    mode: "deposit" | "withdraw";
    walletAddress: string | null;
    maxWithdraw?: number;
    onClose: () => void;
    onDone: () => void;
}) {
    const [step, setStep] = useState<"amount" | "send">("amount");
    const [amount, setAmount] = useState("100");
    const [treasury, setTreasury] = useState<string | null>(null);
    const [usdcMint, setUsdcMint] = useState<string | null>(null);
    // Non-null only on devnet, where native SOL deposits are accepted at this rate.
    const [solUsdRate, setSolUsdRate] = useState<number | null>(null);
    const [asset, setAsset] = useState<DepositAsset>("usdc");
    const solanaSender = useSolanaSender();
    const messageSigner = useSolanaMessageSigner();
    // Solana wallet that pays for deposits: the login itself, or (EVM login) the signature-linked one.
    const [linkedSolana, setLinkedSolana] = useState<string | null | undefined>(undefined);
    const [linking, setLinking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState(false);
    const [refundedUsd, setRefundedUsd] = useState(0);
    // undefined = still loading; null = uncapped
    const [capacityUsd, setCapacityUsd] = useState<number | null | undefined>(undefined);
    const [blockedReason, setBlockedReason] = useState<string | null>(null);

    useEffect(() => {
        if (mode === "deposit" && walletAddress) {
            fetch(`/api/v1/lending/pools/${pool.id}/deposit-limit`)
                .then((r) => r.json())
                .then((d) => {
                    setCapacityUsd(d.capacityUsd ?? null);
                    if (d.paused) setBlockedReason("Lending is paused — deposits are temporarily closed.");
                    else if (d.allowed === false) setBlockedReason("Lending is in a closed beta and this wallet isn't on the allowlist yet.");
                    else if (d.capacityUsd === 0) setBlockedReason("This pool (or your wallet) has reached its beta deposit cap.");
                })
                .catch(() => setCapacityUsd(null));
        }
    }, [mode, pool.id, walletAddress]);

    useEffect(() => {
        if (mode === "deposit") {
            fetch("/api/v1/lending/treasury")
                .then(async (r) => {
                    const body = await r.json().catch(() => ({}));
                    if (!r.ok) throw new Error(body.error || "Lending treasury not configured");
                    return body;
                })
                .then((d) => {
                    setTreasury(d.treasuryAddress);
                    setUsdcMint(typeof d.usdcMint === "string" ? d.usdcMint : null);
                    setSolUsdRate(typeof d.solUsdRate === "number" ? d.solUsdRate : null);
                })
                .catch((err) => setError(err instanceof Error ? err.message : "Failed to load treasury address"));
        }
    }, [mode]);

    useEffect(() => {
        if (mode !== "deposit" || !walletAddress) return;
        fetch("/api/v1/solana/link")
            .then((r) => (r.ok ? r.json() : { solanaAddress: null }))
            .then((d) => setLinkedSolana(d.solanaAddress ?? null))
            .catch(() => setLinkedSolana(null));
    }, [mode, walletAddress]);

    const linkSolanaWallet = async () => {
        if (!messageSigner || !walletAddress) return;
        setLinking(true);
        setError(null);
        try {
            const issuedAt = new Date().toISOString();
            const signature = await messageSigner.signMessage(
                walletLinkMessage({ account: canonicalizeWalletAddress(walletAddress), solanaAddress: messageSigner.address, issuedAt }),
            );
            const res = await fetch("/api/v1/solana/link", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ solanaAddress: messageSigner.address, issuedAt, signature }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || "Failed to link Solana wallet");
            setLinkedSolana(body.solanaAddress);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to link Solana wallet");
        } finally {
            setLinking(false);
        }
    };

    const amountUsd = parseFloat(amount) || 0;
    const lamports = asset === "sol" && solUsdRate ? solLamportsForUsd(amountUsd, solUsdRate) : 0;
    const solAmountLabel = `${(lamports / LAMPORTS_PER_SOL).toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL (devnet)`;
    // Deposits are verified as coming from the signed-in wallet, so it must be a Solana account.
    const signedInWithEvm = !!walletAddress && walletAddress.startsWith("0x");
    const needsLink = signedInWithEvm && !linkedSolana;
    const payerAddress = signedInWithEvm ? linkedSolana : walletAddress;
    const canWalletSend = !!solanaSender && !!payerAddress && solanaSender.address === payerAddress;

    const sendSolWithWallet = async (): Promise<string> => {
        if (!solanaSender || !treasury) throw new Error("Connect a Solana wallet first");
        const connection = getConnection();
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new Transaction({ feePayer: new PublicKey(solanaSender.address), blockhash, lastValidBlockHeight }).add(
            SystemProgram.transfer({
                fromPubkey: new PublicKey(solanaSender.address),
                toPubkey: new PublicKey(treasury),
                lamports,
            }),
        );
        const sig = await solanaSender.sendTransaction(tx, connection);
        // The server only credits finalized transfers.
        const result = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "finalized");
        if (result.value.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
        return sig;
    };

    const sendUsdcWithWallet = async (): Promise<string> => {
        if (!solanaSender || !treasury || !usdcMint) throw new Error("Connect a Solana wallet first");
        const connection = getConnection();
        const owner = new PublicKey(solanaSender.address);
        const mint = new PublicKey(usdcMint);
        const treasuryKey = new PublicKey(treasury);
        const from = getAssociatedTokenAddressSync(mint, owner);
        const to = getAssociatedTokenAddressSync(mint, treasuryKey, true);
        const raw = BigInt(Math.round(amountUsd * 1_000_000));
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight }).add(
            createAssociatedTokenAccountIdempotentInstruction(owner, to, treasuryKey, mint),
            createTransferCheckedInstruction(from, mint, to, owner, raw, 6),
        );
        const sig = await solanaSender.sendTransaction(tx, connection);
        const result = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "finalized");
        if (result.value.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
        return sig;
    };

    const requestWithdrawal = async () => {
        if (!walletAddress) {
            setError("Connect a wallet first");
            return;
        }
        if (!(amountUsd > 0)) {
            setError("Enter a valid amount");
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/v1/lending/pools/${pool.id}/withdraw`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-wallet-address": walletAddress },
                body: JSON.stringify({ amountUsd }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || "Withdrawal request failed");
            }
            setDone(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Withdrawal request failed");
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open onOpenChange={(open) => !open && (done ? onDone() : onClose())}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{mode === "deposit" ? "Deposit into" : "Withdraw from"} {pool.name}</DialogTitle>
                </DialogHeader>
                {done ? (
                    <div className="p-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 space-y-3">
                        <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
                            <CheckCircle2 className="h-4 w-4" /> {mode === "deposit" ? "Deposit Verified" : "Withdrawal Requested"}
                        </div>
                        {mode === "deposit" && refundedUsd > 0 && (
                            <p className="text-xs text-amber-500">
                                ${fmt(refundedUsd)} was over the beta deposit cap and wasn&apos;t credited — a refund from the treasury has been queued (see My Positions).
                            </p>
                        )}
                        {mode === "withdraw" && (
                            <p className="text-xs text-muted-foreground">
                                A platform admin will send the USDC from the treasury shortly — this pool has no signing key of its own.
                            </p>
                        )}
                        <Button size="sm" onClick={onDone} className="w-full h-8 text-xs">Close</Button>
                    </div>
                ) : step === "amount" ? (
                    <div className="space-y-4">
                        {mode === "deposit" && solUsdRate !== null && (
                            <div>
                                <Label className="text-xs">Pay with</Label>
                                <div className="mt-1 grid grid-cols-2 gap-1 rounded-lg border border-border p-1">
                                    {(["usdc", "sol"] as const).map((a) => (
                                        <button
                                            key={a}
                                            type="button"
                                            onClick={() => setAsset(a)}
                                            className={`h-7 rounded-md text-xs font-medium transition-colors ${asset === a ? "bg-emerald-500/15 text-emerald-500" : "text-muted-foreground hover:text-foreground"}`}
                                        >
                                            {a === "usdc" ? "USDC" : "SOL (devnet)"}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        <div>
                            <Label className="text-xs">Amount (USD)</Label>
                            <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1" />
                            {mode === "withdraw" && maxWithdraw !== undefined && (
                                <p className="text-[10px] text-muted-foreground mt-1">Max: ${fmt(maxWithdraw)}</p>
                            )}
                            {mode === "deposit" && typeof capacityUsd === "number" && capacityUsd > 0 && (
                                <p className="text-[10px] text-muted-foreground mt-1">Beta limit: up to ${fmt(capacityUsd)}</p>
                            )}
                            {mode === "deposit" && asset === "sol" && solUsdRate !== null && amountUsd > 0 && (
                                <p className="text-[10px] text-muted-foreground mt-1">
                                    = {solAmountLabel} at the devnet test rate of ${fmt(solUsdRate)}/SOL
                                </p>
                            )}
                            {mode === "deposit" && blockedReason && (
                                <p className="text-[10px] text-amber-500 mt-1">{blockedReason}</p>
                            )}
                            {mode === "deposit" && needsLink && (
                                <div className="mt-2 space-y-1">
                                    <p className="text-[10px] text-amber-500">
                                        You&apos;re signed in with an EVM wallet. Pool deposits are paid in Solana USDC, so link your Solana wallet to this account (one signature, no fee).
                                    </p>
                                    <Button size="sm" variant="outline" onClick={linkSolanaWallet} disabled={!messageSigner || linking || linkedSolana === undefined} className="w-full h-7 text-xs gap-1">
                                        {linking && <Loader2 className="h-3 w-3 animate-spin" />}
                                        {messageSigner ? "Link Solana wallet" : "Connect a Solana wallet (Phantom, Solflare) first"}
                                    </Button>
                                </div>
                            )}
                            {mode === "deposit" && signedInWithEvm && linkedSolana && (
                                <p className="text-[10px] text-muted-foreground mt-1">
                                    Paying from linked Solana wallet {linkedSolana.slice(0, 4)}…{linkedSolana.slice(-4)}.{!canWalletSend && " Connect that wallet to send in one click, or send manually and paste the signature."}
                                </p>
                            )}
                        </div>
                        {error && (
                            <div className="p-2 rounded-lg border border-red-500/20 bg-red-500/5 flex items-center gap-2 text-xs text-red-400">
                                <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
                            </div>
                        )}
                        {mode === "deposit" ? (
                            <Button
                                size="sm"
                                onClick={() => setStep("send")}
                                disabled={
                                    !(amountUsd > 0) || !treasury || !!blockedReason || capacityUsd === undefined || needsLink || (signedInWithEvm && linkedSolana === undefined)
                                    || (typeof capacityUsd === "number" && amountUsd > capacityUsd)
                                }
                                className="w-full h-8 text-xs gap-1"
                            >
                                {!treasury && <Loader2 className="h-3 w-3 animate-spin" />}
                                Continue
                            </Button>
                        ) : (
                            <Button size="sm" onClick={requestWithdrawal} disabled={loading} className="w-full h-8 text-xs gap-1">
                                {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                                Request Withdrawal
                            </Button>
                        )}
                    </div>
                ) : (
                    <OnChainSendStep
                        recipientAddress={treasury!}
                        amountUsd={amountUsd}
                        amountLabel={asset === "sol" ? solAmountLabel : undefined}
                        helperText={asset === "sol"
                            ? `Worth $${fmt(amountUsd)} in the pool. Make sure your wallet is on Devnet. Send with your connected wallet, or send the exact amount yourself and paste the signature.`
                            : undefined}
                        onSendWithWallet={canWalletSend ? (asset === "sol" ? sendSolWithWallet : usdcMint ? sendUsdcWithWallet : undefined) : undefined}
                        submitLabel="Verify Deposit"
                        onSubmit={async (txSig) => {
                            if (!walletAddress) throw new Error("Connect a wallet first");
                            const res = await fetch(`/api/v1/lending/pools/${pool.id}/deposit`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json", "x-wallet-address": walletAddress },
                                body: JSON.stringify({ amountUsd, txSig, asset }),
                            });
                            const body = await res.json().catch(() => ({}));
                            if (!res.ok) throw new Error(body.error || "Deposit verification failed");
                            setRefundedUsd(body.refundedUsd || 0);
                            setDone(true);
                        }}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

// ═══════════════════════════════════════════════════════════════
// Fund a solo loan dialog
// ═══════════════════════════════════════════════════════════════

function FundLoanDialog({
    loan, borrowerName, walletAddress, onClose, onDone,
}: {
    loan: Loan;
    borrowerName: string;
    walletAddress: string | null;
    onClose: () => void;
    onDone: () => void;
}) {
    const [step, setStep] = useState<"review" | "send">("review");
    const [done, setDone] = useState(false);

    return (
        <Dialog open onOpenChange={(open) => !open && (done ? onDone() : onClose())}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <User className="h-4 w-4 text-purple-400" /> Fund Loan
                    </DialogTitle>
                </DialogHeader>
                {done ? (
                    <div className="p-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 space-y-3">
                        <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
                            <CheckCircle2 className="h-4 w-4" /> Loan Funded
                        </div>
                        <Button size="sm" onClick={onDone} className="w-full h-8 text-xs">Close</Button>
                    </div>
                ) : step === "review" ? (
                    <div className="space-y-4">
                        <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-1.5 text-xs">
                            <div className="flex justify-between"><span className="text-muted-foreground">Borrower</span><span>{borrowerName}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">Principal</span><span className="font-mono">${loan.principalUsd.toLocaleString()}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">Rate</span><span>{(loan.interestRateBps / 100).toFixed(1)}% APR</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">Term</span><span>{loan.termDays} days</span></div>
                            {loan.kind === "trust" && (
                                <div className="flex justify-between"><span className="text-muted-foreground">Escrow</span><span className="font-mono">${loan.collateralUsd.toFixed(0)}</span></div>
                            )}
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                            Solo loans are peer-to-peer and not backstopped by the pool — you send the principal straight to the borrower's wallet and bear the full risk in exchange for the full return.
                        </p>
                        <Button
                            size="sm"
                            onClick={() => setStep("send")}
                            disabled={!loan.borrowerWalletAddress}
                            className="w-full h-8 text-xs"
                        >
                            {loan.borrowerWalletAddress ? "Continue" : "Borrower has no wallet on file"}
                        </Button>
                    </div>
                ) : (
                    <OnChainSendStep
                        recipientAddress={loan.borrowerWalletAddress!}
                        amountUsd={loan.principalUsd}
                        helperText="Send the principal directly to the borrower's wallet, then paste the signature."
                        submitLabel="Verify & Fund"
                        onSubmit={async (txSig) => {
                            if (!walletAddress) throw new Error("Connect a wallet first");
                            const res = await fetch(`/api/v1/lending/loans/${loan.id}/fund`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json", "x-wallet-address": walletAddress },
                                body: JSON.stringify({ txSig }),
                            });
                            if (!res.ok) {
                                const body = await res.json().catch(() => ({}));
                                throw new Error(body.error || "Failed to fund loan");
                            }
                            setDone(true);
                        }}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
