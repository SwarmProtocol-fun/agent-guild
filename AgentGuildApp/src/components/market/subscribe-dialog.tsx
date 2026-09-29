"use client";

import { Calendar, Crown, Infinity, CreditCard, Zap, Loader2 } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import type { Skill, SubscriptionPlan } from "@/lib/market/types";

function formatPrice(price: number, currency: string = "USD"): string {
    const symbol = currency === "HBAR" ? "\u210F" : "$";
    return price % 1 === 0 ? `${symbol}${price}` : `${symbol}${price.toFixed(2)}`;
}

interface SubscribeDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    item: Skill | null;
    busyId: string | null;
    onSubscribe: (itemId: string, plan: SubscriptionPlan, method: "stripe" | "crypto") => void;
}

export function SubscribeDialog({ open, onOpenChange, item, busyId, onSubscribe }: SubscribeDialogProps) {
    if (!item) return null;

    const subKey = item.id.startsWith("community-") ? item.id.slice(10) : item.id;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <span className="text-xl">{item.icon}</span>
                        Subscribe to {item.name}
                    </DialogTitle>
                </DialogHeader>
                {item.pricing.tiers && item.pricing.tiers.length > 0 ? (
                    <div className="space-y-3">
                        <p className="text-sm text-muted-foreground">
                            Choose a plan to access this {item.type}. The creator controls pricing and access.
                        </p>
                        <div className="grid gap-2">
                            {item.pricing.tiers.map((tier) => (
                                <div key={tier.plan} className="rounded-lg border border-border p-4 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            {tier.plan === "monthly" && <Calendar className="h-5 w-5 text-purple-400" />}
                                            {tier.plan === "yearly" && <Crown className="h-5 w-5 text-amber-400" />}
                                            {tier.plan === "lifetime" && <Infinity className="h-5 w-5 text-emerald-400" />}
                                            <div>
                                                <div className="font-semibold text-sm capitalize">{tier.plan}</div>
                                                <div className="text-xs text-muted-foreground">
                                                    {tier.plan === "monthly" && "Billed monthly, cancel anytime"}
                                                    {tier.plan === "yearly" && "Billed annually, best value"}
                                                    {tier.plan === "lifetime" && "One-time payment, forever access"}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <div className="font-bold text-sm">{formatPrice(tier.price, tier.currency)}</div>
                                            <div className="text-[10px] text-muted-foreground">
                                                {tier.plan === "monthly" ? "/month" : tier.plan === "yearly" ? "/year" : "once"}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex gap-2">
                                        {tier.currency === "HBAR" ? (
                                            <button
                                                onClick={() => onSubscribe(subKey, tier.plan, "crypto")}
                                                disabled={!!busyId}
                                                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium transition-colors disabled:opacity-50"
                                            >
                                                <Zap className="h-3.5 w-3.5" /> Pay with HBAR
                                            </button>
                                        ) : (
                                            <>
                                                <button
                                                    onClick={() => onSubscribe(subKey, tier.plan, "stripe")}
                                                    disabled={!!busyId}
                                                    className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium transition-colors disabled:opacity-50"
                                                >
                                                    <CreditCard className="h-3.5 w-3.5" /> Pay with Card
                                                </button>
                                                <button
                                                    onClick={() => onSubscribe(subKey, tier.plan, "crypto")}
                                                    disabled={!!busyId}
                                                    className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md border border-border hover:bg-muted/50 text-xs font-medium transition-colors disabled:opacity-50"
                                                >
                                                    <Zap className="h-3.5 w-3.5" /> Pay with Crypto
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                        {busyId && (
                            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-2">
                                <Loader2 className="h-4 w-4 animate-spin" /> Processing...
                            </div>
                        )}
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">No pricing tiers available for this item.</p>
                )}
            </DialogContent>
        </Dialog>
    );
}
