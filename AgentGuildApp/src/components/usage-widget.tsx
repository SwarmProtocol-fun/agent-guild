"use client";

import { useQuery } from "@tanstack/react-query";
import SpotlightCard from "@/components/reactbits/SpotlightCard";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import DecryptedText from "@/components/reactbits/DecryptedText";
import { Activity } from "lucide-react";

interface UsageData {
    fiveHour: {
        perModel: Record<string, any>;
        perModelCost: Record<string, any>;
        recentCalls: any[];
    };
    weekly: {
        perModel: Record<string, any>;
    };
    burnRate: {
        tokensPerMinute: number;
        costPerMinute: number;
    };
    estimatedLimits: {
        opus: number;
        sonnet: number;
    };
    current: {
        opusOutput: number;
        sonnetOutput: number;
        totalCost: number;
        totalCalls: number;
    };
}

export function UsageWidget() {
    const { data, isLoading: loading, error } = useQuery<UsageData, Error>({
        queryKey: ["usage"],
        queryFn: async () => {
            const res = await fetch("/api/usage");
            if (!res.ok) throw new Error("Failed to fetch usage data");
            return res.json();
        },
        refetchInterval: 10000,
        refetchIntervalInBackground: false,
    });

    if (loading && !data) {
        return (
            <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden" spotlightColor="rgba(255, 191, 0, 0.06)">
                <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                        <Activity className="w-5 h-5 text-amber-500" />
                        <span className="text-lg font-semibold text-muted-foreground">Provider Usage</span>
                    </CardTitle>
                </CardHeader>
                <CardContent className="h-40 flex items-center justify-center text-muted-foreground">
                    Loading usage data...
                </CardContent>
            </SpotlightCard>
        );
    }

    if (error || !data) {
        return (
            <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden" spotlightColor="rgba(255, 191, 0, 0.06)">
                <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                        <Activity className="w-5 h-5 text-amber-500" />
                        <span className="text-lg font-semibold text-muted-foreground">Provider Usage</span>
                    </CardTitle>
                </CardHeader>
                <CardContent className="h-40 flex items-center justify-center text-red-400 text-sm">
                    {error?.message || "Failed to load"}
                </CardContent>
            </SpotlightCard>
        );
    }

    const opusPct = Math.min(100, (data.current.opusOutput / data.estimatedLimits.opus) * 100);
    const sonnetPct = Math.min(100, (data.current.sonnetOutput / data.estimatedLimits.sonnet) * 100);

    return (
        <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden" spotlightColor="rgba(255, 191, 0, 0.06)">
            <CardHeader className="pb-2">
                <CardTitle className="text-lg flex justify-between items-center">
                    <div className="flex items-center gap-2">
                        <Activity className="w-5 h-5 text-amber-500" />
                        <DecryptedText text="API Usage & Costs" speed={30} maxIterations={6} animateOn="view" sequential className="text-lg font-semibold" encryptedClassName="text-lg font-semibold text-amber-500/40" />
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                        5h Window
                    </div>
                </CardTitle>
            </CardHeader>

            <CardContent className="space-y-4 pt-2">
                <div className="grid grid-cols-2 gap-4">
                    <div className="bg-black/20 p-3 rounded-lg border border-white/5">
                        <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wider font-semibold">Total Cost</div>
                        <div className="text-2xl font-bold font-mono text-emerald-400">
                            ${data.current.totalCost.toFixed(2)}
                        </div>
                    </div>
                    <div className="bg-black/20 p-3 rounded-lg border border-white/5">
                        <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wider font-semibold">Burn Rate</div>
                        <div className="text-lg font-bold font-mono text-amber-400">
                            ${data.burnRate.costPerMinute.toFixed(4)}<span className="text-xs text-muted-foreground">/min</span>
                        </div>
                    </div>
                </div>

                <div className="space-y-3 pt-2">
                    {/* Sonnet Progress */}
                    <div className="space-y-1">
                        <div className="flex justify-between text-xs">
                            <span className="font-semibold text-blue-400">Claude Sonnet Output Limit</span>
                            <span className="font-mono text-muted-foreground">
                                {data.current.sonnetOutput.toLocaleString()} / {data.estimatedLimits.sonnet.toLocaleString()}
                            </span>
                        </div>
                        <div className="h-2 w-full bg-blue-950/40 rounded-full overflow-hidden">
                            <div
                                className={`h-full rounded-full transition-all duration-1000 ${sonnetPct > 80 ? 'bg-red-500' : sonnetPct > 50 ? 'bg-amber-500' : 'bg-blue-500'}`}
                                style={{ width: `${Math.max(2, sonnetPct)}%` }}
                            />
                        </div>
                    </div>

                    {/* Opus Progress */}
                    <div className="space-y-1">
                        <div className="flex justify-between text-xs">
                            <span className="font-semibold text-purple-400">Claude Opus Output Limit</span>
                            <span className="font-mono text-muted-foreground">
                                {data.current.opusOutput.toLocaleString()} / {data.estimatedLimits.opus.toLocaleString()}
                            </span>
                        </div>
                        <div className="h-2 w-full bg-purple-950/40 rounded-full overflow-hidden">
                            <div
                                className={`h-full rounded-full transition-all duration-1000 ${opusPct > 80 ? 'bg-red-500' : opusPct > 50 ? 'bg-amber-500' : 'bg-purple-500'}`}
                                style={{ width: `${Math.max(2, opusPct)}%` }}
                            />
                        </div>
                    </div>
                </div>

                {Object.keys(data.fiveHour.perModel).length > 0 && (
                    <div className="pt-2">
                        <div className="text-xs text-muted-foreground mb-2 font-semibold">MODEL BREAKDOWN</div>
                        <div className="space-y-2 max-h-24 overflow-y-auto pr-2 custom-scrollbar">
                            {Object.entries(data.fiveHour.perModel)
                                .sort((a, b) => b[1].cost - a[1].cost)
                                .map(([model, stats]: [string, any]) => (
                                    <div key={model} className="flex justify-between text-xs items-center bg-black/10 p-1.5 rounded">
                                        <span className="truncate max-w-[140px] opacity-80" title={model}>
                                            {model.split('/').pop()}
                                        </span>
                                        <div className="flex items-center gap-3 font-mono">
                                            <span className="text-muted-foreground">{stats.calls} calls</span>
                                            <span className="text-emerald-400/80 w-12 text-right">${stats.cost.toFixed(2)}</span>
                                        </div>
                                    </div>
                                ))}
                        </div>
                    </div>
                )}
            </CardContent>
        </SpotlightCard>
    );
}
