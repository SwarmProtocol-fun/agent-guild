"use client";

import { useState, useEffect } from "react";
import {
    Plus, Shield, Crown, Clock, CheckCircle2, XCircle,
    StopCircle, CreditCard, Loader2, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SubmitMarketItemDialog } from "@/components/market/submit-dialog";
import type { CommunityMarketItem } from "@/lib/market/types";
const trackMarketplaceEvent = (..._args: unknown[]) => {}; // posthog removed

// ── Publisher Tier Badge ──

const TIER_BADGE_STYLES: Record<number, { label: string; color: string }> = {
    0: { label: "New Publisher", color: "border-zinc-500/30 text-zinc-400 bg-zinc-500/5" },
    1: { label: "Approved", color: "border-emerald-500/30 text-emerald-400 bg-emerald-500/5" },
    2: { label: "Trusted", color: "border-blue-500/30 text-blue-400 bg-blue-500/5" },
    3: { label: "Strategic Partner", color: "border-amber-500/30 text-amber-400 bg-amber-500/5" },
};

function PublisherTierBadge({ walletAddress }: { walletAddress?: string }) {
    const [tier, setTier] = useState<number | null>(null);
    const [quota, setQuota] = useState<{ used: number; max: number } | null>(null);

    useEffect(() => {
        if (!walletAddress) return;
        fetch(`/api/v1/marketplace/publisher/${walletAddress}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                if (data) {
                    setTier(data.tier ?? 0);
                    setQuota({
                        used: data.stats?.totalSubmissions ?? 0,
                        max: data.quota?.maxPerWeek ?? 2,
                    });
                }
            })
            .catch(() => {});
    }, [walletAddress]);

    if (tier === null) return null;
    const style = TIER_BADGE_STYLES[tier] || TIER_BADGE_STYLES[0];

    return (
        <div className="flex items-center gap-2">
            <Badge variant="outline" className={`text-[10px] px-2 py-0.5 ${style.color}`}>
                {tier === 3 ? <Crown className="h-2.5 w-2.5 mr-0.5" /> : <Shield className="h-2.5 w-2.5 mr-0.5" />}
                {style.label}
            </Badge>
            {quota && (
                <span className="text-[10px] text-muted-foreground">
                    {quota.max - Math.min(quota.used, quota.max)}/{quota.max} this week
                </span>
            )}
        </div>
    );
}

// ── Submissions Panel ──

interface MarketSubmissionsProps {
    submissions: CommunityMarketItem[];
    walletAddress: string;
    orgId?: string;
    deletingId: string | null;
    onDelete: (docId: string) => void;
    onSubmitted: () => void;
}

export function MarketSubmissions({
    submissions, walletAddress, orgId, deletingId, onDelete, onSubmitted,
}: MarketSubmissionsProps) {
    const [submitOpen, setSubmitOpen] = useState(false);

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold">Your Submissions</h2>
                    <p className="text-sm text-muted-foreground">
                        Submit mods, plugins, and skills for the community marketplace
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <PublisherTierBadge walletAddress={walletAddress} />
                    <Button
                        onClick={() => { setSubmitOpen(true); trackMarketplaceEvent("submission_started"); }}
                        className="bg-amber-600 hover:bg-amber-700 text-black gap-1.5"
                    >
                        <Plus className="h-4 w-4" />
                        Submit to Market
                    </Button>
                </div>
            </div>

            {submissions.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
                    {submissions.map((sub) => (
                        <Card key={sub.id} className="p-4 bg-card border-border">
                            <div className="flex items-start gap-3">
                                <div className="text-2xl shrink-0 w-10 h-10 flex items-center justify-center rounded-lg bg-muted/50">
                                    {sub.icon}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-0.5">
                                        <h3 className="font-semibold text-sm truncate">{sub.name}</h3>
                                        <span className="text-[10px] text-muted-foreground">v{sub.version}</span>
                                    </div>
                                    <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{sub.description}</p>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <Badge variant="outline" className="text-[10px]">{sub.category}</Badge>
                                        <Badge variant="outline" className="text-[10px] capitalize">{sub.type}</Badge>
                                        {sub.pricing?.model === "subscription" ? (
                                            <Badge variant="outline" className="text-[10px] border-purple-500/20 text-purple-400">
                                                <CreditCard className="h-2.5 w-2.5 mr-0.5" />Paid
                                            </Badge>
                                        ) : (
                                            <Badge variant="outline" className="text-[10px] border-emerald-500/20 text-emerald-400">Free</Badge>
                                        )}
                                        <SubmissionStatusBadge status={sub.status} />
                                    </div>
                                </div>
                                <button
                                    onClick={() => onDelete(sub.id)}
                                    disabled={deletingId === sub.id}
                                    className="p-1 rounded text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
                                    title="Delete submission"
                                >
                                    {deletingId === sub.id ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <Trash2 className="h-3.5 w-3.5" />
                                    )}
                                </button>
                            </div>
                        </Card>
                    ))}
                </div>
            ) : (
                <Card className="p-12 text-center bg-card border-border border-dashed">
                    <Plus className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                    <h3 className="text-lg font-semibold mb-2">No submissions yet</h3>
                    <p className="text-sm text-muted-foreground mb-6">
                        Share your custom mods, plugins, and skills with the community.
                    </p>
                    <Button
                        onClick={() => { setSubmitOpen(true); trackMarketplaceEvent("submission_started"); }}
                        className="bg-amber-600 hover:bg-amber-700 text-black gap-2"
                    >
                        <Plus className="h-4 w-4" /> Submit Your First Item
                    </Button>
                </Card>
            )}

            <SubmitMarketItemDialog
                open={submitOpen}
                onOpenChange={setSubmitOpen}
                submitterAddress={walletAddress}
                orgId={orgId}
                onSubmitted={() => { onSubmitted(); }}
            />
        </div>
    );
}

function SubmissionStatusBadge({ status }: { status: string }) {
    switch (status) {
        case "pending":
            return (
                <Badge variant="outline" className="text-[10px] border-yellow-500/20 text-yellow-500">
                    <Clock className="h-2.5 w-2.5 mr-0.5" />Pending
                </Badge>
            );
        case "approved":
            return (
                <Badge variant="outline" className="text-[10px] border-emerald-500/20 text-emerald-400">
                    <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />Approved
                </Badge>
            );
        case "rejected":
            return (
                <Badge variant="outline" className="text-[10px] border-red-500/20 text-red-400">
                    <XCircle className="h-2.5 w-2.5 mr-0.5" />Rejected
                </Badge>
            );
        case "changes_requested":
            return (
                <Badge variant="outline" className="text-[10px] border-orange-500/20 text-orange-400">
                    <Clock className="h-2.5 w-2.5 mr-0.5" />Changes Requested
                </Badge>
            );
        case "suspended":
            return (
                <Badge variant="outline" className="text-[10px] border-red-500/20 text-red-500">
                    <StopCircle className="h-2.5 w-2.5 mr-0.5" />Suspended
                </Badge>
            );
        default:
            return null;
    }
}
