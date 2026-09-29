/**
 * Reputation Analytics Dashboard
 *
 * Shows full HCS score event history for agents with timeline visualization.
 */
"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/contexts/OrgContext";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Agent } from "@/lib/firestore";

interface ScoreHistoryEntry {
    timestamp: string;
    sequenceNumber: number;
    event: {
        type: string;
        creditDelta: number;
        trustDelta: number;
        metadata?: Record<string, unknown>;
    };
    cumulativeCreditScore: number;
    cumulativeTrustScore: number;
}

interface ScoreHistory {
    asn: string;
    eventCount: number;
    currentCreditScore: number;
    currentTrustScore: number;
    history: ScoreHistoryEntry[];
}

export default function ReputationAnalyticsPage() {
    const { currentOrg } = useOrg();
    const [agents, setAgents] = useState<Agent[]>([]);
    const [selectedASN, setSelectedASN] = useState<string>("");
    const [scoreHistory, setScoreHistory] = useState<ScoreHistory | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Fetch agents on mount
    useEffect(() => {
        if (!currentOrg) return;

        const fetchAgents = async () => {
            const q = query(
                collection(db, "agents"),
                where("orgId", "==", currentOrg.id),
            );
            const snapshot = await getDocs(q);
            const agentList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Agent));
            setAgents(agentList.filter(a => a.asn)); // Only agents with ASN
        };

        fetchAgents();
    }, [currentOrg]);

    const fetchScoreHistory = async (asn: string) => {
        setLoading(true);
        setError(null);

        try {
            const response = await fetch(`/api/v1/analytics/score-history?asn=${asn}&limit=200`);

            if (!response.ok) {
                throw new Error("Failed to fetch score history");
            }

            const data: ScoreHistory = await response.json();
            setScoreHistory(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    };

    const getEventIcon = (type: string) => {
        switch (type) {
            case "task_complete": return "✅";
            case "task_fail": return "❌";
            case "skill_report": return "🧩";
            case "penalty": return "⚠️";
            case "bonus": return "🎁";
            case "checkpoint": return "📍";
            default: return "📊";
        }
    };

    const getEventColor = (delta: number) => {
        if (delta > 0) return "text-green-600 dark:text-green-400";
        if (delta < 0) return "text-red-600 dark:text-red-400";
        return "text-gray-600 dark:text-gray-400";
    };

    if (!currentOrg) {
        return (
            <div className="space-y-6">
                <h1 className="text-3xl font-bold">Reputation Analytics</h1>
                <p className="text-muted-foreground">No organization selected</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold">Reputation Analytics</h1>
                <p className="text-muted-foreground mt-1">
                    Full HCS score event history with timeline visualization
                </p>
            </div>

            {/* Agent Selector */}
            <Card>
                <CardHeader>
                    <CardTitle>Select Agent</CardTitle>
                    <CardDescription>
                        View score event history for any agent with an ASN
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex gap-2">
                        <Input
                            placeholder="Enter ASN or select agent..."
                            value={selectedASN}
                            onChange={e => setSelectedASN(e.target.value)}
                            className="flex-1"
                        />
                        <Button
                            onClick={() => fetchScoreHistory(selectedASN)}
                            disabled={!selectedASN || loading}
                        >
                            {loading ? "Loading..." : "Load History"}
                        </Button>
                    </div>

                    {agents.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                            {agents.map(agent => (
                                <Badge
                                    key={agent.id}
                                    className="cursor-pointer hover:bg-amber-600"
                                    onClick={() => {
                                        setSelectedASN(agent.asn || "");
                                        fetchScoreHistory(agent.asn || "");
                                    }}
                                >
                                    {agent.name} ({agent.asn?.slice(-8)})
                                </Badge>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {error && (
                <Card className="border-red-500">
                    <CardContent className="pt-6">
                        <p className="text-red-600">Error: {error}</p>
                    </CardContent>
                </Card>
            )}

            {/* Score Summary */}
            {scoreHistory && (
                <>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <Card>
                            <CardContent className="pt-6">
                                <div className="text-sm text-muted-foreground">Credit Score</div>
                                <div className="text-3xl font-bold text-amber-600">
                                    {scoreHistory.currentCreditScore}
                                </div>
                            </CardContent>
                        </Card>
                        <Card>
                            <CardContent className="pt-6">
                                <div className="text-sm text-muted-foreground">Trust Score</div>
                                <div className="text-3xl font-bold text-blue-600">
                                    {scoreHistory.currentTrustScore}
                                </div>
                            </CardContent>
                        </Card>
                        <Card>
                            <CardContent className="pt-6">
                                <div className="text-sm text-muted-foreground">Total Events</div>
                                <div className="text-3xl font-bold">
                                    {scoreHistory.eventCount}
                                </div>
                            </CardContent>
                        </Card>
                        <Card>
                            <CardContent className="pt-6">
                                <div className="text-sm text-muted-foreground">Tier</div>
                                <div className="text-2xl font-bold">
                                    {scoreHistory.currentCreditScore >= 850 ? "💎 Platinum" :
                                     scoreHistory.currentCreditScore >= 700 ? "🥇 Gold" :
                                     scoreHistory.currentCreditScore >= 550 ? "🥈 Silver" : "🥉 Bronze"}
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Event Timeline */}
                    <Card>
                        <CardHeader>
                            <CardTitle>Score Event Timeline</CardTitle>
                            <CardDescription>
                                All reputation events from Hedera Consensus Service
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-3">
                                {scoreHistory.history.slice().reverse().map((entry, i) => (
                                    <div
                                        key={entry.sequenceNumber}
                                        className="flex items-start gap-3 p-3 rounded-md border border-border hover:bg-muted/50 transition-colors"
                                    >
                                        <div className="text-2xl">{getEventIcon(entry.event.type)}</div>
                                        <div className="flex-1">
                                            <div className="flex items-center gap-2">
                                                <Badge variant="outline">
                                                    {entry.event.type.replace(/_/g, " ")}
                                                </Badge>
                                                <span className={`font-mono text-sm ${getEventColor(entry.event.creditDelta)}`}>
                                                    {entry.event.creditDelta > 0 ? "+" : ""}{entry.event.creditDelta} credit
                                                </span>
                                                <span className={`font-mono text-sm ${getEventColor(entry.event.trustDelta)}`}>
                                                    {entry.event.trustDelta > 0 ? "+" : ""}{entry.event.trustDelta} trust
                                                </span>
                                            </div>
                                            {entry.event.metadata && (
                                                <div className="text-xs text-muted-foreground mt-1">
                                                    {JSON.stringify(entry.event.metadata)}
                                                </div>
                                            )}
                                            <div className="text-xs text-muted-foreground mt-1">
                                                {new Date(parseFloat(entry.timestamp.replace(".", "")) / 1000000).toLocaleString()}
                                                {" • "}Seq #{entry.sequenceNumber}
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <div className="text-sm font-mono">
                                                Credit: {entry.cumulativeCreditScore}
                                            </div>
                                            <div className="text-sm font-mono text-muted-foreground">
                                                Trust: {entry.cumulativeTrustScore}
                                            </div>
                                        </div>
                                    </div>
                                ))}

                                {scoreHistory.history.length === 0 && (
                                    <div className="text-center py-12 text-muted-foreground">
                                        <p>No events found for this ASN</p>
                                        <p className="text-sm mt-1">Events will appear here when the agent completes tasks or reports skills</p>
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </>
            )}
        </div>
    );
}
