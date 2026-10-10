/**
 * Request Loan Dialog — pick a source (pool vs solo), the pool (USDC, SOL or
 * ETH — repaid in the same asset — or, for collateralized loans, a USDC/ETH or
 * USDC/SOL market that lends USDC against locked ETH/SOL; solo loans are
 * USDC), amount, and term, then submit the request. Tier limits are in USD and
 * converted at the live price.
 */
"use client";

import { useEffect, useState } from "react";
import { Loader2, AlertCircle, CheckCircle2, Users, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { soloRateBand } from "@/lib/lending/eligibility";
import type { KindEligibility, LendingPool, LoanKind, LoanSource } from "@/lib/lending/types";
import { assetInfo, assetOf, formatAssetAmount, poolLabel, type LendingAsset } from "@/lib/lending/assets";
import { fetchLendingTreasury, type LendingTreasuryInfo } from "@/lib/lending/client";

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
    const [pools, setPools] = useState<LendingPool[]>([]);
    const [poolId, setPoolId] = useState<string | null>(null);
    const [treasuryInfo, setTreasuryInfo] = useState<LendingTreasuryInfo | null>(null);
    // Collateral markets only make loans of the collateralized ("trust") kind.
    const choices = pools.filter((p) => kind === "trust" || !p.collateralAsset);
    const pool = choices.find((p) => p.id === poolId) ?? choices.find((p) => assetOf(p) === "usdc" && !p.collateralAsset) ?? null;
    const asset: LendingAsset = source === "pool" && pool ? assetOf(pool) : "usdc";
    const priceUsd = asset === "usdc" ? 1 : treasuryInfo?.pricesUsd[asset] ?? null;
    const market = source === "pool" && pool?.collateralAsset ? pool : null;
    const collateralPrice = market ? treasuryInfo?.pricesUsd[market.collateralAsset!] ?? null : null;

    useEffect(() => {
        if (!open) return;
        fetchLendingTreasury().then(setTreasuryInfo).catch(() => setTreasuryInfo(null));
        fetch("/api/v1/lending/pools")
            .then((r) => (r.ok ? r.json() : { pools: [] }))
            .then((d) => setPools(d.pools ?? []))
            .catch(() => setPools([]));
    }, [open]);
    const band = soloRateBand(gate.rateBps);
    const [ratePercent, setRatePercent] = useState(String(gate.rateBps / 100));
    const [termDays, setTermDays] = useState("30");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    /** Pool loans small enough to pay out automatically: "active" = already paid, "sent" = on its way. */
    const [payout, setPayout] = useState<"active" | "sent" | null>(null);

    const handleClose = () => {
        if (loading) return;
        setDone(false);
        setPayout(null);
        setError(null);
        onOpenChange(false);
    };

    const handleSubmit = async () => {
        // In the loan's asset.
        const amountValue = parseFloat(amount);
        if (!Number.isFinite(amountValue) || amountValue <= 0) {
            setError("Enter a valid amount");
            return;
        }
        if (priceUsd !== null && amountValue * priceUsd > gate.maxAmountUsd) {
            setError(`Your current limit for this loan is $${gate.maxAmountUsd.toLocaleString()}${asset !== "usdc" ? ` (≈ ${formatAssetAmount(asset, gate.maxAmountUsd / priceUsd)})` : ""} — it grows with each loan you repay`);
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
                    poolId: source === "pool" ? pool?.id : undefined,
                    amount: amountValue, termDays: parseInt(termDays, 10),
                    requestedRateBps,
                }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || "Failed to request loan");
            }
            const body = await res.json().catch(() => ({}));
            setPayout(body.loan?.status === "active" ? "active" : body.loan?.autoDisburseSend?.status === "sent" ? "sent" : null);
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
                            {kind === "trust"
                                ? `Next: post the collateral from the Loans panel (a ${assetInfo(asset).symbol} transfer to the lending treasury). `
                                    + (source === "pool"
                                        ? "Once it's verified, the loan is paid out to the agent's wallet and activates."
                                        : "Once it's verified, the request goes live on the marketplace for a solo lender to fund.")
                                : source === "pool"
                                    ? payout === "active"
                                        ? `Paid out — the ${assetInfo(asset).symbol} is in the agent's wallet and the loan is active.`
                                        : payout === "sent"
                                            ? `The ${assetInfo(asset).symbol} is on its way to the agent's wallet — the loan activates once it's confirmed on-chain.`
                                            : `The pool reserved the liquidity. The ${assetInfo(asset).symbol} is sent to the agent's wallet shortly — the loan activates once that's confirmed on-chain.`
                                    : "This request is now visible on the lending marketplace for a solo lender to fund."}
                        </p>
                        <Button size="sm" onClick={handleClose} className="w-full h-8 text-xs">Done</Button>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {source === "pool" && choices.length > 0 && (
                            <div>
                                <Label className="text-xs">Pool</Label>
                                <div className="mt-1 grid grid-cols-3 gap-1 rounded-lg border border-border p-1">
                                    {choices.map((p) => (
                                        <button
                                            key={p.id}
                                            type="button"
                                            onClick={() => {
                                                if (p.id !== pool?.id && assetOf(p) !== asset) setAmount(assetOf(p) === "usdc" ? String(Math.min(gate.maxAmountUsd, 500)) : "");
                                                setPoolId(p.id);
                                            }}
                                            className={`h-7 rounded-md text-xs font-medium transition-colors ${pool?.id === p.id ? "bg-emerald-500/15 text-emerald-500" : "text-muted-foreground hover:text-foreground"}`}
                                        >
                                            {poolLabel(p)}
                                        </button>
                                    ))}
                                </div>
                                {market ? (
                                    <p className="text-[10px] text-muted-foreground mt-1">
                                        Borrow USDC against {assetInfo(market.collateralAsset!).symbol}{market.collateralAsset === "eth" ? " (posted on Ethereum)" : ""}: lock {((10_000 / market.maxLtvBps!)).toFixed(2)}× the loan&apos;s value. If the loan reaches {(market.liquidationLtvBps! / 100).toFixed(0)}% of the collateral&apos;s value it&apos;s liquidated.
                                    </p>
                                ) : asset !== "usdc" && (
                                    <p className="text-[10px] text-muted-foreground mt-1">
                                        Paid out in {assetInfo(asset).symbol}{asset === "eth" ? " on Ethereum" : ""}, repaid in {assetInfo(asset).symbol}{kind === "trust" ? ", collateral posted in " + assetInfo(asset).symbol : ""}.
                                    </p>
                                )}
                            </div>
                        )}

                        <div>
                            <Label className="text-xs">Amount ({assetInfo(asset).symbol})</Label>
                            <div className="mt-1 flex gap-2">
                                <Input
                                    type="number"
                                    value={amount}
                                    onChange={(e) => setAmount(e.target.value)}
                                />
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-9 text-xs"
                                    disabled={priceUsd === null}
                                    onClick={() => {
                                        if (priceUsd === null) return;
                                        const max = gate.maxAmountUsd / priceUsd;
                                        // Round down so the max never exceeds the limit after conversion.
                                        const decimals = asset === "usdc" ? 2 : 6;
                                        setAmount(String(Math.floor(max * 10 ** decimals) / 10 ** decimals));
                                        setError(null);
                                    }}
                                >
                                    Max
                                </Button>
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-1">
                                Max ${gate.maxAmountUsd.toLocaleString()}{asset !== "usdc" && priceUsd !== null && ` (≈ ${formatAssetAmount(asset, gate.maxAmountUsd / priceUsd)})`} at {(gate.rateBps / 100).toFixed(1)}% APR
                                {market && collateralPrice !== null && parseFloat(amount) > 0 && (
                                    <> · collateral ≈ {formatAssetAmount(market.collateralAsset!, parseFloat(amount) / (market.maxLtvBps! / 10_000) / collateralPrice)}</>
                                )}
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

                        {kind === "trust" && (
                            <p className="text-[11px] text-muted-foreground">
                                Trust loans are collateralized: after requesting, you&apos;ll post collateral ({market ? "sized by the market's loan-to-value" : "sized by your credit tier"}) to the lending treasury. It&apos;s returned to your wallet when the loan is repaid, or applied to the balance on default.
                            </p>
                        )}

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
