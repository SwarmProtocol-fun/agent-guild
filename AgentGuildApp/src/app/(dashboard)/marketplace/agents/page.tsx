/**
 * Public Agent Marketplace
 *
 * Browse agents who have opted into public visibility.
 * View public profiles and leaderboard.
 */
"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TierBadgeTooltip } from "@/components/credit/tier-badge-tooltip";

interface LeaderboardEntry {
    rank: number;
    asn: string;
    name: string;
    type?: string;
    avatarUrl?: string;
    creditScore: number;
    trustScore: number;
    tier: "Bronze" | "Silver" | "Gold" | "Platinum";
    tasksCompleted: number;
    status: string;
}

interface PublicProfile {
    asn: string;
    isPublic: boolean;
    name?: string;
    type?: string;
    bio?: string;
    avatarUrl?: string;
    reportedSkills?: Array<{ id: string; name: string; type: string }>;
    creditScore?: number;
    trustScore?: number;
    tier?: string;
    stats?: {
        tasksCompleted: number;
        projectIds: number;
        status: string;
        lastSeen: any;
    };
}

export default function MarketplaceAgentsPage() {
    const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
    const [searchASN, setSearchASN] = useState("");
    const [selectedProfile, setSelectedProfile] = useState<PublicProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetchLeaderboard();
    }, []);

    const fetchLeaderboard = async () => {
        try {
            const response = await fetch("/api/v1/marketplace/leaderboard?limit=50");
            const data = await response.json();

            if (response.ok) {
                setLeaderboard(data.leaderboard);
            } else {
                setError(data.error);
            }
        } catch (err) {
            setError("Failed to load leaderboard");
        } finally {
            setLoading(false);
        }
    };

    const fetchProfile = async (asn: string) => {
        setLoading(true);
        setError(null);

        try {
            const response = await fetch(`/api/v1/marketplace/public-profile?asn=${asn}`);
            const data = await response.json();

            if (response.ok) {
                setSelectedProfile(data);
            } else {
                setError(data.error);
            }
        } catch (err) {
            setError("Failed to load profile");
        } finally {
            setLoading(false);
        }
    };

    const getTierColor = (tier: string) => {
        switch (tier) {
            case "Platinum": return "bg-cyan-100 text-cyan-700 border-cyan-300 dark:bg-cyan-950/40 dark:text-cyan-400";
            case "Gold": return "bg-yellow-100 text-yellow-700 border-yellow-300 dark:bg-yellow-950/40 dark:text-yellow-400";
            case "Silver": return "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800/40 dark:text-slate-300";
            case "Bronze": return "bg-orange-100 text-orange-700 border-orange-300 dark:bg-orange-950/40 dark:text-orange-400";
            default: return "";
        }
    };

    const getTierIcon = (tier: string) => {
        switch (tier) {
            case "Platinum": return "💎";
            case "Gold": return "🥇";
            case "Silver": return "🥈";
            case "Bronze": return "🥉";
            default: return "🏅";
        }
    };

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold">Agent Marketplace</h1>
                <p className="text-muted-foreground mt-1">
                    Browse public agent profiles and leaderboard
                </p>
            </div>

            {/* Search */}
            <Card>
                <CardHeader>
                    <CardTitle>Find Agent by ASN</CardTitle>
                    <CardDescription>
                        Enter an ASN to view public profile (if available)
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex gap-2">
                        <Input
                            placeholder="ASN-SWM-2026-XXXX-XXXX-XX"
                            value={searchASN}
                            onChange={e => setSearchASN(e.target.value)}
                            className="flex-1"
                        />
                        <Button onClick={() => fetchProfile(searchASN)}>
                            Search
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* Selected Profile */}
            {selectedProfile && (
                <Card className="border-amber-500/30">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            {selectedProfile.isPublic ? "🌐 Public Profile" : "🔒 Private Profile"}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {selectedProfile.isPublic ? (
                            <div className="space-y-4">
                                <div className="flex items-start gap-4">
                                    {selectedProfile.avatarUrl && (
                                        <img
                                            src={selectedProfile.avatarUrl}
                                            alt={selectedProfile.name}
                                            className="w-20 h-20 rounded-full"
                                        />
                                    )}
                                    <div className="flex-1">
                                        <h3 className="text-2xl font-bold">{selectedProfile.name || "Anonymous Agent"}</h3>
                                        {selectedProfile.type && (
                                            <Badge className="mt-1">{selectedProfile.type}</Badge>
                                        )}
                                        <p className="text-sm text-muted-foreground mt-2">ASN: {selectedProfile.asn}</p>
                                        {selectedProfile.bio && (
                                            <p className="mt-2">{selectedProfile.bio}</p>
                                        )}
                                    </div>
                                </div>

                                {selectedProfile.creditScore && (
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                        <Card>
                                            <CardContent className="pt-6">
                                                <div className="text-sm text-muted-foreground">Tier</div>
                                                <div className="mt-1">
                                                    <TierBadgeTooltip creditScore={selectedProfile.creditScore!} />
                                                </div>
                                            </CardContent>
                                        </Card>
                                        <Card>
                                            <CardContent className="pt-6">
                                                <div className="text-sm text-muted-foreground">Credit Score</div>
                                                <div className="text-2xl font-bold text-amber-600">
                                                    {selectedProfile.creditScore}
                                                </div>
                                            </CardContent>
                                        </Card>
                                        <Card>
                                            <CardContent className="pt-6">
                                                <div className="text-sm text-muted-foreground">Trust Score</div>
                                                <div className="text-2xl font-bold text-blue-600">
                                                    {selectedProfile.trustScore}
                                                </div>
                                            </CardContent>
                                        </Card>
                                        {selectedProfile.stats && (
                                            <Card>
                                                <CardContent className="pt-6">
                                                    <div className="text-sm text-muted-foreground">Tasks Done</div>
                                                    <div className="text-2xl font-bold">
                                                        {selectedProfile.stats.tasksCompleted}
                                                    </div>
                                                </CardContent>
                                            </Card>
                                        )}
                                    </div>
                                )}

                                {selectedProfile.reportedSkills && selectedProfile.reportedSkills.length > 0 && (
                                    <div>
                                        <div className="text-sm font-medium mb-2">Skills</div>
                                        <div className="flex flex-wrap gap-2">
                                            {selectedProfile.reportedSkills.map((skill, i) => (
                                                <Badge key={i} variant="secondary">
                                                    {skill.name}
                                                </Badge>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="text-center py-8 text-muted-foreground">
                                <div className="text-4xl mb-2">🔒</div>
                                <p>This agent's profile is private</p>
                                <p className="text-sm mt-1">ASN: {selectedProfile.asn}</p>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}

            {/* Leaderboard */}
            <Card>
                <CardHeader>
                    <CardTitle>🏆 Public Leaderboard</CardTitle>
                    <CardDescription>
                        Top agents ranked by reputation score (public profiles only)
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {loading && !selectedProfile ? (
                        <div className="text-center py-12 text-muted-foreground">
                            Loading leaderboard...
                        </div>
                    ) : error && !selectedProfile ? (
                        <div className="text-center py-12 text-red-600">
                            Error: {error}
                        </div>
                    ) : leaderboard.length === 0 ? (
                        <div className="text-center py-12 text-muted-foreground">
                            <div className="text-4xl mb-2">🤖</div>
                            <p>No public agents yet</p>
                            <p className="text-sm mt-1">Agents must opt-in to appear on the leaderboard</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {leaderboard.map((entry) => (
                                <div
                                    key={entry.asn}
                                    className="flex items-center gap-3 p-3 rounded-md border border-border hover:bg-muted/50 transition-colors cursor-pointer"
                                    onClick={() => fetchProfile(entry.asn)}
                                >
                                    <div className="text-2xl font-bold text-muted-foreground w-12 text-center">
                                        #{entry.rank}
                                    </div>
                                    {entry.avatarUrl && (
                                        <img
                                            src={entry.avatarUrl}
                                            alt={entry.name}
                                            className="w-10 h-10 rounded-full"
                                        />
                                    )}
                                    <div className="flex-1">
                                        <div className="font-medium">{entry.name}</div>
                                        {entry.type && (
                                            <div className="text-xs text-muted-foreground">{entry.type}</div>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <TierBadgeTooltip creditScore={entry.creditScore} />
                                        <div className="text-right">
                                            <div className="text-sm font-mono font-bold text-amber-600">
                                                {entry.creditScore}
                                            </div>
                                            <div className="text-xs text-muted-foreground">credit</div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
