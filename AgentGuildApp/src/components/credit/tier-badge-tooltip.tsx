/**
 * Tier Badge Tooltip — Enhanced Badge with Radix Tooltip showing tier details.
 * Reusable in agent profile, marketplace leaderboard, review queue, etc.
 */
"use client";

import { Badge } from "@/components/ui/badge";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { getTierForScore, pointsToNextTier, type TierDefinition } from "@/lib/credit-tiers";

interface TierBadgeTooltipProps {
    /** Credit score to derive tier from */
    creditScore: number;
    /** Optional: pass a pre-computed tier to avoid re-computation */
    tier?: TierDefinition;
    /** Optional: show small variant */
    size?: "sm" | "md";
}

export function TierBadgeTooltip({ creditScore, tier: tierProp, size = "md" }: TierBadgeTooltipProps) {
    const tier = tierProp || getTierForScore(creditScore);
    const toNext = pointsToNextTier(creditScore);

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Badge
                        className={`${tier.badgeClass} cursor-help ${size === "sm" ? "text-[10px] px-1.5 py-0" : ""}`}
                    >
                        {tier.name}
                    </Badge>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                    <div className="space-y-2">
                        <div>
                            <p className="font-semibold text-sm">{tier.name} Tier</p>
                            <p className="text-xs text-muted-foreground">{tier.description}</p>
                        </div>

                        <div className="text-xs">
                            <p className="text-muted-foreground">
                                Credit range: {tier.minCredit}+
                                {" "}(current: {creditScore})
                            </p>
                            {toNext > 0 && (
                                <p className="text-muted-foreground">
                                    {toNext} points to next tier
                                </p>
                            )}
                        </div>

                        {tier.benefits.length > 0 && (
                            <div>
                                <p className="text-xs font-medium mb-0.5">Benefits:</p>
                                <ul className="text-xs text-muted-foreground space-y-0.5">
                                    {tier.benefits.map((b) => (
                                        <li key={b} className="flex items-start gap-1">
                                            <span className="text-emerald-500 shrink-0">+</span>
                                            {b}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {tier.restrictions.length > 0 && (
                            <div>
                                <p className="text-xs font-medium mb-0.5">Restrictions:</p>
                                <ul className="text-xs text-muted-foreground space-y-0.5">
                                    {tier.restrictions.map((r) => (
                                        <li key={r} className="flex items-start gap-1">
                                            <span className="text-red-500 shrink-0">-</span>
                                            {r}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
