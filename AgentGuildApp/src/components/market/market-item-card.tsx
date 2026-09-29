"use client";

import React from "react";
import Link from "next/link";
import {
    Download, Trash2, Check, Loader2, Star,
    ShieldCheck, Users, CreditCard, Crown,
    Shield, ChevronRight, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Skill, OwnedItem, MarketSubscription } from "@/lib/market/types";
import { MOD_REGISTRY } from "@/lib/skills";

function formatPrice(price: number, currency: string = "USD"): string {
    const symbol = currency === "HBAR" ? "\u210F" : "$";
    return price % 1 === 0 ? `${symbol}${price}` : `${symbol}${price.toFixed(2)}`;
}

function getCheapestLabel(item: Skill): string | null {
    if (item.pricing.model === "free") return null;
    const tiers = item.pricing.tiers;
    if (!tiers || tiers.length === 0) return null;
    const monthly = tiers.find((t) => t.plan === "monthly");
    if (monthly) return `${formatPrice(monthly.price, monthly.currency)}/mo`;
    const yearly = tiers.find((t) => t.plan === "yearly");
    if (yearly) return `${formatPrice(yearly.price, yearly.currency)}/yr`;
    const lifetime = tiers.find((t) => t.plan === "lifetime");
    if (lifetime) return `${formatPrice(lifetime.price, lifetime.currency)} once`;
    return null;
}

interface MarketItemCardProps {
    item: Skill;
    owned?: OwnedItem;
    subscription?: MarketSubscription;
    avgRating?: number;
    ratingCount?: number;
    installCount?: number;
    onGet: () => void;
    onRemove: () => void;
    onSubscribe: () => void;
    onCancelSub: () => void;
    onRate?: () => void;
    busy: boolean;
}

export const MarketItemCard = React.memo(function MarketItemCard({
    item, owned, subscription, avgRating, ratingCount, installCount,
    onGet, onRemove, onSubscribe, onCancelSub, onRate, busy,
}: MarketItemCardProps) {
    const isPaid = item.pricing.model === "subscription";
    const priceLabel = getCheapestLabel(item);
    const isVerified = item.source === "verified";

    return (
        <Card className={`p-0 bg-card border-border transition-all hover:border-amber-500/20 group overflow-hidden min-h-[140px] ${isVerified ? "ring-1 ring-amber-500/10" : ""}`}>
            <div className="flex items-start gap-3 p-4">
                <Link href={`/market/${item.id}`} className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="text-2xl shrink-0 w-10 h-10 flex items-center justify-center rounded-lg bg-muted/50">
                        {item.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5 min-w-0 flex-wrap">
                            <h3 className="font-semibold text-base text-foreground">{item.name}</h3>
                            <span className="text-[10px] text-muted-foreground shrink-0 whitespace-nowrap">v{item.version}</span>
                            {isPaid && priceLabel ? (
                                <Badge className="text-[10px] bg-amber-500/10 text-amber-400 border-amber-500/20 shrink-0 whitespace-nowrap">
                                    <CreditCard className="h-2.5 w-2.5 mr-0.5" />{priceLabel}
                                </Badge>
                            ) : (
                                <Badge variant="outline" className="text-[10px] border-emerald-500/20 text-emerald-400 shrink-0 whitespace-nowrap">Free</Badge>
                            )}
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity ml-auto shrink-0" />
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2 mb-2 break-words">{item.description}</p>
                        <div className="flex items-center gap-1.5 flex-wrap">
                            <Badge variant="outline" className="text-[10px]">{item.category}</Badge>
                            {(() => {
                                const modEntry = MOD_REGISTRY.find((m) => m.legacySkillId === item.id);
                                const capCount = modEntry?.capabilities.length ?? 0;
                                return capCount > 1 ? (
                                    <Badge variant="outline" className="text-[10px] border-cyan-500/20 text-cyan-400">
                                        {capCount} capabilities
                                    </Badge>
                                ) : null;
                            })()}
                            {isVerified ? (
                                <Badge variant="outline" className="text-[10px] border-amber-500/20 text-amber-500">
                                    <ShieldCheck className="h-2.5 w-2.5 mr-0.5" />Verified
                                </Badge>
                            ) : (
                                <Badge variant="outline" className="text-[10px] border-blue-500/20 text-blue-400">
                                    <Users className="h-2.5 w-2.5 mr-0.5" />Community
                                </Badge>
                            )}
                            {subscription && (
                                <Badge className="text-[10px] bg-purple-500/10 text-purple-400 border-purple-500/20">
                                    <Crown className="h-2.5 w-2.5 mr-0.5" />
                                    {subscription.plan === "lifetime" ? "Lifetime" : subscription.plan === "yearly" ? "Yearly" : "Monthly"}
                                </Badge>
                            )}
                            {item.requiredKeys?.map((k) => (
                                <Badge key={k} variant="outline" className="text-[10px] border-amber-500/20 text-amber-500">
                                    <Shield className="h-2.5 w-2.5 mr-0.5" />{k}
                                </Badge>
                            ))}
                            {/* Install count + rating row */}
                            <div className="flex items-center gap-2 ml-auto text-[10px] text-muted-foreground">
                                {(installCount ?? 0) > 0 && (
                                    <span className="flex items-center gap-0.5">
                                        <Download className="h-2.5 w-2.5" />
                                        {installCount}
                                    </span>
                                )}
                                {avgRating != null && avgRating > 0 && (
                                    <span className="flex items-center gap-0.5">
                                        <Star className="h-2.5 w-2.5 text-amber-400 fill-amber-400" />
                                        {avgRating.toFixed(1)}
                                        <span className="text-muted-foreground/50">({ratingCount ?? 0})</span>
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                </Link>
                <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                    {owned ? (
                        <div className="flex items-center gap-1">
                            <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px]">
                                <Check className="h-2.5 w-2.5 mr-0.5" />Owned
                            </Badge>
                            {onRate && (
                                <button
                                    onClick={onRate}
                                    className="p-1 rounded text-amber-400 hover:bg-amber-500/10 transition-colors"
                                    title="Rate this item"
                                >
                                    <Star className="h-3.5 w-3.5" />
                                </button>
                            )}
                            <button
                                onClick={onRemove}
                                disabled={busy}
                                className="p-1 rounded text-red-400 hover:bg-red-500/10 transition-colors"
                                title="Remove from inventory"
                            >
                                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            </button>
                        </div>
                    ) : isPaid && !subscription ? (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={onSubscribe}
                            disabled={busy}
                            className="h-7 text-xs gap-1 border-purple-500/30 text-purple-400 hover:bg-purple-500/10"
                        >
                            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Crown className="h-3 w-3" />}
                            Subscribe
                        </Button>
                    ) : (
                        <div className="flex items-center gap-1">
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={onGet}
                                disabled={busy}
                                className="h-7 text-xs gap-1 border-amber-500/30 text-amber-500 hover:bg-amber-500/10"
                            >
                                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                                Get
                            </Button>
                            {isPaid && subscription && (
                                <button
                                    onClick={onCancelSub}
                                    disabled={busy}
                                    className="p-1 rounded text-red-400 hover:bg-red-500/10 transition-colors"
                                    title="Cancel subscription"
                                >
                                    <XCircle className="h-3.5 w-3.5" />
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </Card>
    );
});
