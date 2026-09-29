/** Token Usage — Inline token consumption display widget for headers and cards. */
"use client";

/**
 * Token Usage Widget
 *
 * Shows AI token consumption and estimated cost per agent.
 * Designed to be embedded in the analytics page or dashboard.
 */

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Coins, TrendingUp, Zap, Brain, ArrowUpRight, ArrowDownRight } from "lucide-react";

export interface TokenUsageEntry {
    agentId: string;
    agentName: string;
    inputTokens: number;
    outputTokens: number;
    /** Estimated cost in USD */
    costUsd: number;
    /** Trend percentage vs previous period */
    trend?: number;
}

interface TokenUsageProps {
    entries: TokenUsageEntry[];
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    /** Overall trend vs previous period */
    overallTrend?: number;
    period?: string;
}

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
}

export function TokenUsageWidget({
    entries, totalInputTokens, totalOutputTokens, totalCostUsd, overallTrend, period = "This month",
}: TokenUsageProps) {
    const totalTokens = totalInputTokens + totalOutputTokens;

    return (
        <div className="space-y-4">
            {/* Summary Stats */}
            <div className="grid grid-cols-3 gap-3">
                <Card className="p-4 bg-card border-border">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-blue-500/10">
                            <Zap className="h-4 w-4 text-blue-400" />
                        </div>
                        <div>
                            <p className="text-xl font-bold">{formatTokens(totalTokens)}</p>
                            <p className="text-[10px] text-muted-foreground">Total Tokens</p>
                        </div>
                    </div>
                </Card>
                <Card className="p-4 bg-card border-border">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-emerald-500/10">
                            <Coins className="h-4 w-4 text-emerald-400" />
                        </div>
                        <div className="flex items-center gap-2">
                            <div>
                                <p className="text-xl font-bold">${totalCostUsd.toFixed(2)}</p>
                                <p className="text-[10px] text-muted-foreground">Est. Cost</p>
                            </div>
                            {overallTrend !== undefined && (
                                <Badge className={`text-[10px] ${overallTrend > 0
                                        ? "bg-red-500/10 text-red-400 border-red-500/20"
                                        : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                    }`}>
                                    {overallTrend > 0 ? <ArrowUpRight className="h-2.5 w-2.5 mr-0.5" /> : <ArrowDownRight className="h-2.5 w-2.5 mr-0.5" />}
                                    {Math.abs(overallTrend)}%
                                </Badge>
                            )}
                        </div>
                    </div>
                </Card>
                <Card className="p-4 bg-card border-border">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-amber-500/10">
                            <TrendingUp className="h-4 w-4 text-amber-400" />
                        </div>
                        <div>
                            <div className="flex items-baseline gap-2">
                                <p className="text-sm font-bold text-blue-400">{formatTokens(totalInputTokens)} in</p>
                                <p className="text-sm font-bold text-emerald-400">{formatTokens(totalOutputTokens)} out</p>
                            </div>
                            <p className="text-[10px] text-muted-foreground">I/O Breakdown</p>
                        </div>
                    </div>
                </Card>
            </div>

            {/* Per-Agent Breakdown */}
            {entries.length > 0 && (
                <Card className="bg-card border-border overflow-hidden">
                    <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Brain className="h-4 w-4 text-amber-500" />
                            <span className="text-sm font-semibold">Per-Agent Usage</span>
                        </div>
                        <span className="text-xs text-muted-foreground">{period}</span>
                    </div>
                    <div className="divide-y divide-border">
                        {entries
                            .sort((a, b) => b.costUsd - a.costUsd)
                            .map((entry) => {
                                const pct = totalTokens > 0 ? ((entry.inputTokens + entry.outputTokens) / totalTokens) * 100 : 0;
                                return (
                                    <div key={entry.agentId} className="px-4 py-3 flex items-center gap-3">
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="text-sm font-medium truncate">{entry.agentName}</span>
                                                {entry.trend !== undefined && (
                                                    <span className={`text-[10px] ${entry.trend > 0 ? "text-red-400" : "text-emerald-400"}`}>
                                                        {entry.trend > 0 ? "↑" : "↓"}{Math.abs(entry.trend)}%
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                                <span>{formatTokens(entry.inputTokens)} in / {formatTokens(entry.outputTokens)} out</span>
                                            </div>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <p className="text-sm font-semibold">${entry.costUsd.toFixed(2)}</p>
                                            <p className="text-[10px] text-muted-foreground">{pct.toFixed(1)}%</p>
                                        </div>
                                        {/* Bar */}
                                        <div className="w-20 h-2 bg-muted rounded-full overflow-hidden shrink-0">
                                            <div
                                                className="h-full bg-gradient-to-r from-amber-500 to-amber-400 rounded-full transition-all"
                                                style={{ width: `${Math.min(pct, 100)}%` }}
                                            />
                                        </div>
                                    </div>
                                );
                            })}
                    </div>
                </Card>
            )}
        </div>
    );
}
