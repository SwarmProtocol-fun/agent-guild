/**
 * Confidence Indicator — Inline display of score confidence level.
 * Shows colored dot + label with event count on hover via tooltip.
 */
"use client";

import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ConfidenceInfo } from "@/lib/credit-tiers";

interface ConfidenceIndicatorProps {
    confidence: ConfidenceInfo;
}

const LEVEL_STYLES = {
    low: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", label: "Limited data" },
    medium: { dot: "bg-blue-500", text: "text-blue-600 dark:text-blue-400", label: "Moderate" },
    high: { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", label: "High confidence" },
};

export function ConfidenceIndicator({ confidence }: ConfidenceIndicatorProps) {
    const style = LEVEL_STYLES[confidence.level];

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <div className="flex items-center gap-1.5 cursor-help">
                        <div className={`w-2 h-2 rounded-full ${style.dot}`} />
                        <span className={`text-xs font-medium ${style.text}`}>
                            {style.label}
                        </span>
                    </div>
                </TooltipTrigger>
                <TooltipContent>
                    <p className="text-xs">{confidence.description}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                        {confidence.eventCount} event{confidence.eventCount !== 1 ? "s" : ""} recorded
                    </p>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
