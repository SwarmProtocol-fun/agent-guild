/** Usage — Token consumption and cost tracking across models and agents. */
"use client";

import { useState, useEffect, useCallback } from "react";
import { Coins, TrendingUp, Cpu, Users, Loader2, BarChart3 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useOrg } from "@/contexts/OrgContext";
import { useAuthAddress } from "@/hooks/useAuthAddress";
import {
    type UsageRecord,
    getUsageRecords,
    aggregateByModel,
    aggregateByAgent,
    aggregateDaily,
    fmtTokens,
    fmtCost,
    shortModel,
} from "@/lib/usage";

// ═══════════════════════════════════════════════════════════════
// Summary Cards
// ═══════════════════════════════════════════════════════════════

function StatCard({ icon: Icon, label, value, sub, color }: {
    icon: typeof Coins; label: string; value: string; sub?: string; color: string;
}) {
    return (
        <Card className="p-4 bg-card/80 border-border">
            <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg ${color}`}>
                    <Icon className="h-4 w-4" />
                </div>
                <div>
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
                    <p className="text-xl font-bold mt-0.5">{value}</p>
                    {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
                </div>
            </div>
        </Card>
    );
}

// ═══════════════════════════════════════════════════════════════
// Daily Cost Bar Chart (pure CSS)
// ═══════════════════════════════════════════════════════════════

function DailyCostChart({ data }: { data: { date: string; costUsd: number }[] }) {
    const maxCost = Math.max(...data.map(d => d.costUsd), 0.001);
    const last14 = data.slice(-14);

    return (
        <Card className="p-4 bg-card/80 border-border">
            <h3 className="text-sm font-semibold mb-3">Daily Cost (last 14 days)</h3>
            <div className="flex items-end gap-1 h-32">
                {last14.map((d) => {
                    const pct = (d.costUsd / maxCost) * 100;
                    return (
                        <div key={d.date} className="flex-1 flex flex-col items-center gap-1 group">
                            <span className="text-[8px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                                {fmtCost(d.costUsd)}
                            </span>
                            <div
                                className="w-full bg-amber-500/80 rounded-t-sm hover:bg-amber-400 transition-colors min-h-[2px]"
                                style={{ height: `${Math.max(pct, 2)}%` }}
                            />
                            <span className="text-[7px] text-muted-foreground -rotate-45 origin-top-left mt-1">
                                {d.date.slice(5)}
                            </span>
                        </div>
                    );
                })}
            </div>
            {last14.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-8">No usage data yet</p>
            )}
        </Card>
    );
}

// ═══════════════════════════════════════════════════════════════
// Main Page
// ═══════════════════════════════════════════════════════════════

export default function UsagePage() {
    const { currentOrg } = useOrg();
    const authAddress = useAuthAddress();
    const [records, setRecords] = useState<UsageRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [range, setRange] = useState<"7d" | "30d">("30d");

    const loadUsage = useCallback(async () => {
        if (!currentOrg) return;
        try {
            setLoading(true);
            const days = range === "7d" ? 7 : 30;
            const data = await getUsageRecords(currentOrg.id, days);
            setRecords(data);
        } catch (err) {
            console.error("Failed to load usage:", err);
        } finally {
            setLoading(false);
        }
    }, [currentOrg, range]);

    useEffect(() => { loadUsage(); }, [loadUsage]);

    const byModel = aggregateByModel(records);
    const byAgent = aggregateByAgent(records);
    const daily = aggregateDaily(records);

    const totalTokens = records.reduce((sum, r) => sum + r.tokensIn + r.tokensOut, 0);
    const totalCost = records.reduce((sum, r) => sum + r.costUsd, 0);
    const topModel = byModel[0]?.model || "—";
    const topAgent = byAgent[0]?.agentName || "—";

    if (!authAddress) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-muted-foreground">
                <Coins className="h-12 w-12 opacity-30" />
                <p>Connect your wallet to view usage</p>
            </div>
        );
    }

    return (
        <div className="max-w-[1200px] mx-auto px-4 py-8">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                            <Coins className="h-6 w-6 text-emerald-500" />
                        </div>
                        Usage
                    </h1>
                    <p className="text-sm text-muted-foreground mt-2">
                        Token consumption &amp; cost tracking across agents and models
                    </p>
                </div>
                <div className="flex gap-1 bg-muted/30 rounded-lg p-0.5">
                    {(["7d", "30d"] as const).map((r) => (
                        <button
                            key={r}
                            onClick={() => setRange(r)}
                            className={`px-3 py-1 text-xs rounded-md transition-colors ${range === r ? "bg-emerald-500/20 text-emerald-400" : "text-muted-foreground hover:text-foreground"
                                }`}
                        >
                            {r}
                        </button>
                    ))}
                </div>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="h-6 w-6 animate-spin text-emerald-500" />
                </div>
            ) : (
                <>
                    {/* Summary cards */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                        <StatCard icon={BarChart3} label="Total Tokens" value={fmtTokens(totalTokens)} sub={`${records.length} requests`} color="bg-blue-500/10 text-blue-400" />
                        <StatCard icon={Coins} label="Total Cost" value={fmtCost(totalCost)} sub={`Last ${range}`} color="bg-emerald-500/10 text-emerald-400" />
                        <StatCard icon={Cpu} label="Top Model" value={shortModel(topModel)} sub="By cost" color="bg-purple-500/10 text-purple-400" />
                        <StatCard icon={Users} label="Top Agent" value={topAgent} sub="By cost" color="bg-amber-500/10 text-amber-400" />
                    </div>

                    {/* Daily chart */}
                    <div className="mb-6">
                        <DailyCostChart data={daily} />
                    </div>

                    {/* Model breakdown table */}
                    <Card className="p-4 bg-card/80 border-border mb-6">
                        <h3 className="text-sm font-semibold mb-3">Cost by Model</h3>
                        <div className="space-y-2">
                            {byModel.length === 0 ? (
                                <p className="text-xs text-muted-foreground text-center py-4">No usage data yet</p>
                            ) : (
                                byModel.map((m) => (
                                    <div key={m.model} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium truncate">{shortModel(m.model)}</p>
                                            <p className="text-[10px] text-muted-foreground">
                                                {m.requests.toLocaleString()} requests · {fmtTokens(m.totalTokens)} tokens
                                            </p>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <p className="text-sm font-semibold text-emerald-400">{fmtCost(m.costUsd)}</p>
                                            <p className="text-[9px] text-muted-foreground">{m.pctOfTotal}% of total</p>
                                        </div>
                                        <div className="w-20 h-1.5 bg-muted/30 rounded-full overflow-hidden shrink-0">
                                            <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${m.pctOfTotal}%` }} />
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </Card>

                    {/* Agent breakdown */}
                    <Card className="p-4 bg-card/80 border-border">
                        <h3 className="text-sm font-semibold mb-3">Cost by Agent</h3>
                        <div className="space-y-2">
                            {byAgent.length === 0 ? (
                                <p className="text-xs text-muted-foreground text-center py-4">No usage data yet</p>
                            ) : (
                                byAgent.map((a) => (
                                    <div key={a.agentId} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium truncate">{a.agentName}</p>
                                            <p className="text-[10px] text-muted-foreground">
                                                {a.requests} requests · {a.models.length} model{a.models.length !== 1 ? "s" : ""}
                                            </p>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <p className="text-sm font-semibold text-amber-400">{fmtCost(a.costUsd)}</p>
                                            <Badge variant="outline" className="text-[8px]">{fmtTokens(a.totalTokens)}</Badge>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </Card>
                </>
            )}
        </div>
    );
}
