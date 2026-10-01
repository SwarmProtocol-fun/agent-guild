/**
 * Loan Offers Panel — browse open lender-posted offers this agent is
 * eligible to accept (amount within tier cap, rate within the solo band),
 * and accept one to create a reserved pending loan for that lender to fund.
 */
"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Loader2, AlertCircle, CheckCircle2, ShieldCheck, Landmark } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { soloRateBand } from "@/lib/lending/eligibility";
import type { EligibilitySummary, LoanOffer } from "@/lib/lending/types";

interface LoanOffersPanelProps {
    agentId: string;
    orgId: string;
    walletAddress: string | null;
    onAccepted: () => void;
}

export function LoanOffersPanel({ agentId, orgId, walletAddress, onAccepted }: LoanOffersPanelProps) {
    const [offers, setOffers] = useState<LoanOffer[]>([]);
    const [eligibility, setEligibility] = useState<EligibilitySummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [acceptingId, setAcceptingId] = useState<string | null>(null);
    const [acceptedId, setAcceptedId] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [offersRes, eligibilityRes] = await Promise.all([
                fetch("/api/v1/lending/offers?open=1"),
                fetch(`/api/v1/lending/eligibility?agentId=${agentId}`),
            ]);
            if (offersRes.ok) setOffers((await offersRes.json()).offers || []);
            if (eligibilityRes.ok) setEligibility(await eligibilityRes.json());
        } catch {
            // best-effort
        } finally {
            setLoading(false);
        }
    }, [agentId]);

    useEffect(() => {
        load();
    }, [load]);

    const eligibleOffers = useMemo(() => {
        if (!eligibility) return [];
        return offers.filter((offer) => {
            const gate = offer.kind === "trust" ? eligibility.trust : eligibility.unsecured;
            if (!gate.eligible || offer.amountUsd > gate.maxAmountUsd) return false;
            const band = soloRateBand(gate.rateBps);
            return offer.rateBps >= band.minBps && offer.rateBps <= band.maxBps;
        });
    }, [offers, eligibility]);

    const accept = async (offer: LoanOffer) => {
        if (!walletAddress) {
            setError("Connect a wallet first");
            return;
        }
        setAcceptingId(offer.id);
        setError(null);
        try {
            const res = await fetch(`/api/v1/lending/offers/${offer.id}/accept`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-wallet-address": walletAddress },
                body: JSON.stringify({ agentId, orgId }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || "Failed to accept offer");
            }
            setAcceptedId(offer.id);
            onAccepted();
            load();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to accept offer");
        } finally {
            setAcceptingId(null);
        }
    };

    if (!loading && eligibleOffers.length === 0) return null;

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center gap-2">
                    <Landmark className="h-4 w-4 text-emerald-500" />
                    <CardTitle className="text-base">Open Loan Offers</CardTitle>
                </div>
                <CardDescription>Lender-posted terms this agent currently qualifies to accept</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
                {loading ? (
                    <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    eligibleOffers.map((offer) => (
                        <div key={offer.id} className="flex items-center justify-between p-2.5 rounded-lg border border-border">
                            <div className="flex items-center gap-2">
                                {offer.kind === "trust" ? (
                                    <ShieldCheck className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                                ) : (
                                    <Landmark className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                                )}
                                <div>
                                    <div className="text-xs font-medium">
                                        ${offer.amountUsd.toLocaleString()} &middot; {(offer.rateBps / 100).toFixed(1)}% APR &middot; {offer.termDays}d
                                    </div>
                                    {offer.note && <div className="text-[10px] text-muted-foreground">{offer.note}</div>}
                                </div>
                            </div>
                            {acceptedId === offer.id ? (
                                <Badge variant="outline" className="text-[10px] gap-1"><CheckCircle2 className="h-3 w-3" /> Accepted</Badge>
                            ) : (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    disabled={acceptingId === offer.id}
                                    onClick={() => accept(offer)}
                                >
                                    {acceptingId === offer.id && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                                    Accept
                                </Button>
                            )}
                        </div>
                    ))
                )}
                {error && (
                    <div className="p-2 rounded-lg border border-red-500/20 bg-red-500/5 flex items-center gap-2 text-xs text-red-400">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
