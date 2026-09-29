/**
 * Agent Credit Tab — Full credit score explainability dashboard for a single agent.
 *
 * Shows gauge, drivers, sub-scores, history chart, recent events, and admin audit trail.
 * Route: /agents/[id]/credit
 */
"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2, Shield } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/contexts/OrgContext";
import { useSession } from "@/contexts/SessionContext";
import { getDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Agent } from "@/lib/firestore";
import type { ScoreExplanation, ScoreHistoryPoint } from "@/lib/credit-explainer";
import type { CreditAuditEntry } from "@/lib/credit-audit-log";
import { formatDelta, eventTypeLabel, pointsToNextTier } from "@/lib/credit-tiers";
import { CreditScoreGauge } from "@/components/credit/credit-score-gauge";
import { SubScoreBreakdown } from "@/components/credit/sub-score-breakdown";
import { ScoreHistoryChart } from "@/components/credit/score-history-chart";
import { ScoreDrivers } from "@/components/credit/score-drivers";
import { ConfidenceIndicator } from "@/components/credit/confidence-indicator";
import { TierBadgeTooltip } from "@/components/credit/tier-badge-tooltip";
import { CreditAuditTable } from "@/components/credit/credit-audit-table";
import { isPlatformAdmin } from "@/lib/platform-admins";

export default function AgentCreditPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = use(params);
    const agentId = resolvedParams.id;
    const router = useRouter();
    const { currentOrg } = useOrg();
    const { address: sessionAddress } = useSession();

    const [agent, setAgent] = useState<Agent | null>(null);
    const [explanation, setExplanation] = useState<ScoreExplanation | null>(null);
    const [history, setHistory] = useState<ScoreHistoryPoint[]>([]);
    const [auditEntries, setAuditEntries] = useState<CreditAuditEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const isAdmin = isPlatformAdmin(sessionAddress);

    useEffect(() => {
        if (!currentOrg?.id) return;

        const load = async () => {
            setLoading(true);
            setError(null);

            try {
                // Load agent
                const agentDoc = await getDoc(doc(db, "agents", agentId));
                if (!agentDoc.exists()) {
                    setError("Agent not found");
                    return;
                }
                const agentData = { id: agentDoc.id, ...agentDoc.data() } as Agent;
                setAgent(agentData);

                // Fetch explanation and history in parallel
                const [explainRes, historyRes] = await Promise.all([
                    fetch(`/api/v1/credit/explain?agentId=${agentId}`),
                    fetch(`/api/v1/credit/history?agentId=${agentId}&days=30`),
                ]);

                if (explainRes.ok) {
                    setExplanation(await explainRes.json());
                }
                if (historyRes.ok) {
                    const hData = await historyRes.json();
                    setHistory(hData.history || []);
                }

                // Admin: fetch audit trail
                if (isAdmin) {
                    try {
                        const auditRes = await fetch(`/api/v1/credit/audit?agentId=${agentId}&limit=100`);
                        if (auditRes.ok) {
                            const aData = await auditRes.json();
                            setAuditEntries(aData.entries || []);
                        }
                    } catch {
                        // Non-critical — admin audit is optional
                    }
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : "Failed to load credit data");
            } finally {
                setLoading(false);
            }
        };

        load();
    }, [currentOrg, agentId, isAdmin]);

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (error || !agent) {
        return (
            <div className="space-y-4">
                <Button variant="ghost" size="sm" onClick={() => router.back()}>
                    <ArrowLeft className="h-4 w-4 mr-1" /> Back
                </Button>
                <Card className="border-red-500/50">
                    <CardContent className="pt-6">
                        <p className="text-red-600">{error || "Agent not found"}</p>
                    </CardContent>
                </Card>
            </div>
        );
    }

    const credit = explanation?.currentCredit ?? agent.creditScore ?? 680;
    const trust = explanation?.currentTrust ?? agent.trustScore ?? 50;
    const toNext = pointsToNextTier(credit);

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3">
                <Link href={`/agents/${agentId}`}>
                    <Button variant="ghost" size="sm">
                        <ArrowLeft className="h-4 w-4 mr-1" /> {agent.name}
                    </Button>
                </Link>
                <span className="text-muted-foreground">/</span>
                <h1 className="text-xl font-bold">Credit Score</h1>
            </div>

            {/* Score Overview Row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Gauge */}
                <Card className="md:col-span-1">
                    <CardContent className="pt-6 flex flex-col items-center">
                        <CreditScoreGauge score={credit} />
                        {toNext > 0 && (
                            <p className="text-xs text-muted-foreground mt-2">
                                {toNext} points to next tier
                            </p>
                        )}
                    </CardContent>
                </Card>

                {/* Stats */}
                <Card className="md:col-span-2">
                    <CardHeader>
                        <CardTitle className="text-base">Score Summary</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div>
                                <p className="text-xs text-muted-foreground">Credit Score</p>
                                <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{credit}</p>
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground">Trust Score</p>
                                <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{trust}<span className="text-sm text-muted-foreground">/100</span></p>
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground">Tier</p>
                                <div className="mt-1">
                                    <TierBadgeTooltip creditScore={credit} tier={explanation?.tier} />
                                </div>
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground">Confidence</p>
                                <div className="mt-1">
                                    {explanation ? (
                                        <ConfidenceIndicator confidence={explanation.confidence} />
                                    ) : (
                                        <span className="text-xs text-muted-foreground">—</span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Movement indicators */}
                        {explanation && (
                            <div className="flex gap-4 pt-2 border-t border-border">
                                <div>
                                    <span className="text-xs text-muted-foreground">7-day: </span>
                                    <span className={`text-sm font-mono font-medium ${explanation.movement7d >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
                                        {formatDelta(explanation.movement7d)}
                                    </span>
                                </div>
                                <div>
                                    <span className="text-xs text-muted-foreground">30-day: </span>
                                    <span className={`text-sm font-mono font-medium ${explanation.movement30d >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
                                        {formatDelta(explanation.movement30d)}
                                    </span>
                                </div>
                            </div>
                        )}

                        {/* Active restrictions */}
                        {explanation && explanation.activeRestrictions.length > 0 && (
                            <div className="pt-2 border-t border-border">
                                <p className="text-xs font-medium text-muted-foreground mb-1">Active Restrictions</p>
                                <div className="flex flex-wrap gap-1">
                                    {explanation.activeRestrictions.map((r) => (
                                        <Badge key={r} variant="outline" className="text-[10px] text-red-600 border-red-300 dark:text-red-400 dark:border-red-800">
                                            {r}
                                        </Badge>
                                    ))}
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            {/* Score Drivers */}
            {explanation && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Score Drivers</CardTitle>
                        <CardDescription>Top factors affecting this agent's score</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ScoreDrivers
                            positiveFactors={explanation.topPositiveFactors}
                            negativeFactors={explanation.topNegativeFactors}
                        />
                    </CardContent>
                </Card>
            )}

            {/* Sub-scores + History Chart */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Sub-score breakdown */}
                {explanation && (
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Sub-Score Breakdown</CardTitle>
                            <CardDescription>Credit contribution by category</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <SubScoreBreakdown subScores={explanation.subScores} />
                        </CardContent>
                    </Card>
                )}

                {/* Score history chart */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Score History (30 days)</CardTitle>
                        <CardDescription>Credit and trust score over time</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ScoreHistoryChart data={history} />
                    </CardContent>
                </Card>
            </div>

            {/* Recent Events */}
            {explanation && explanation.recentEvents.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Recent Events</CardTitle>
                        <CardDescription>Last 10 score-affecting events</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-2">
                            {explanation.recentEvents.map((event, i) => (
                                <div
                                    key={`${event.timestamp}-${i}`}
                                    className="flex items-center justify-between p-2 rounded-md border border-border hover:bg-muted/30 transition-colors"
                                >
                                    <div className="flex items-center gap-2">
                                        <Badge variant="outline" className="text-[10px]">
                                            {eventTypeLabel(event.type)}
                                        </Badge>
                                        {event.metadata && (
                                            <span className="text-xs text-muted-foreground max-w-[200px] truncate">
                                                {event.metadata.taskId as string || event.metadata.reason as string || ""}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <span className={`text-xs font-mono ${event.creditDelta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
                                            {formatDelta(event.creditDelta)} credit
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {new Date(event.timestamp * 1000).toLocaleDateString()}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Admin: Audit Trail */}
            {isAdmin && (
                <Card>
                    <CardHeader>
                        <div className="flex items-center gap-2">
                            <Shield className="h-4 w-4 text-amber-500" />
                            <CardTitle className="text-base">Credit Audit Trail</CardTitle>
                        </div>
                        <CardDescription>Admin-only view of all score changes with audit details</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <CreditAuditTable entries={auditEntries} />
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
