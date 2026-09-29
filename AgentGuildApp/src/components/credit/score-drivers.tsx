/**
 * Score Drivers — Two-column display of top positive and negative factors.
 */
"use client";

import type { ScoreFactor } from "@/lib/credit-explainer";
import { formatDelta } from "@/lib/credit-tiers";

interface ScoreDriversProps {
    positiveFactors: ScoreFactor[];
    negativeFactors: ScoreFactor[];
}

export function ScoreDrivers({ positiveFactors, negativeFactors }: ScoreDriversProps) {
    const hasPositive = positiveFactors.length > 0;
    const hasNegative = negativeFactors.length > 0;

    if (!hasPositive && !hasNegative) {
        return (
            <div className="text-center py-6 text-muted-foreground text-sm">
                No score factors recorded yet
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Positive factors */}
            <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
                    Positive Factors
                </h4>
                {hasPositive ? (
                    <div className="space-y-2">
                        {positiveFactors.map((f) => (
                            <div key={f.label} className="flex items-center justify-between p-2 rounded-md bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900">
                                <div className="flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                    <span className="text-sm">{f.label}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-muted-foreground">{f.count}x</span>
                                    <span className="text-sm font-mono font-medium text-emerald-600 dark:text-emerald-400">
                                        {formatDelta(f.delta)}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-xs text-muted-foreground">No positive factors yet</p>
                )}
            </div>

            {/* Negative factors */}
            <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
                    Negative Factors
                </h4>
                {hasNegative ? (
                    <div className="space-y-2">
                        {negativeFactors.map((f) => (
                            <div key={f.label} className="flex items-center justify-between p-2 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900">
                                <div className="flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
                                    <span className="text-sm">{f.label}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-muted-foreground">{f.count}x</span>
                                    <span className="text-sm font-mono font-medium text-red-600 dark:text-red-400">
                                        {formatDelta(f.delta)}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-xs text-muted-foreground">No negative factors</p>
                )}
            </div>
        </div>
    );
}
