/** Activity Feed — Real-time timeline of all org events: agent actions, task updates, deployments. */
"use client";

import { useState, useEffect, useCallback } from "react";
import { Activity, Loader2, Filter } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useOrg } from "@/contexts/OrgContext";
import { useAuthAddress } from "@/hooks/useAuthAddress";
import {
    type ActivityEvent, type ActivityActor, type ActivityEventType,
    EVENT_TYPE_CONFIG, ACTOR_ICONS,
    getActivityFeed,
} from "@/lib/activity";

function formatTimeAgo(date: Date | null): string {
    if (!date) return "";
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

export default function ActivityPage() {
    const { currentOrg } = useOrg();
    const authAddress = useAuthAddress();
    const [events, setEvents] = useState<ActivityEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [actorFilter, setActorFilter] = useState<ActivityActor | "all">("all");

    const loadEvents = useCallback(async () => {
        if (!currentOrg) return;
        try {
            setLoading(true);
            const opts: { actorType?: ActivityActor; max?: number } = { max: 200 };
            if (actorFilter !== "all") opts.actorType = actorFilter;
            const data = await getActivityFeed(currentOrg.id, opts);
            setEvents(data);
        } catch (err) {
            console.error("Failed to load activity:", err);
        } finally {
            setLoading(false);
        }
    }, [currentOrg, actorFilter]);

    useEffect(() => { loadEvents(); }, [loadEvents]);

    if (!authAddress) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-muted-foreground">
                <Activity className="h-12 w-12 opacity-30" />
                <p>Connect your wallet to view activity</p>
            </div>
        );
    }

    const actorFilters: { key: ActivityActor | "all"; label: string; icon: string }[] = [
        { key: "all", label: "All", icon: "📊" },
        { key: "agent", label: "Agents", icon: "🤖" },
        { key: "user", label: "Users", icon: "👤" },
        { key: "system", label: "System", icon: "⚙️" },
        { key: "cron", label: "Cron", icon: "⏰" },
    ];

    return (
        <div className="max-w-5xl mx-auto px-6 py-8">
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20">
                            <Activity className="h-6 w-6 text-amber-500" />
                        </div>
                        Activity Timeline
                    </h1>
                    <p className="text-sm text-muted-foreground mt-2">
                        Everything that happened — who did what, when
                    </p>
                </div>
                <Badge variant="outline" className="text-xs">
                    {events.length} events
                </Badge>
            </div>

            {/* Actor Filter */}
            <div className="flex items-center gap-1.5 mb-6">
                {actorFilters.map(({ key, label, icon }) => (
                    <button
                        key={key}
                        onClick={() => setActorFilter(key)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${actorFilter === key
                                ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                                : "bg-muted/50 text-muted-foreground hover:bg-muted border border-transparent"
                            }`}
                    >
                        <span>{icon}</span>
                        {label}
                    </button>
                ))}
            </div>

            {/* Timeline */}
            {loading ? (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
                </div>
            ) : events.length === 0 ? (
                <Card className="p-12 text-center bg-card border-border border-dashed">
                    <Activity className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                    <h3 className="text-lg font-semibold mb-2">No activity yet</h3>
                    <p className="text-sm text-muted-foreground">
                        Events will appear here as agents and users interact with the system.
                    </p>
                </Card>
            ) : (
                <div className="relative">
                    {/* Timeline line */}
                    <div className="absolute left-5 top-0 bottom-0 w-px bg-border" />

                    <div className="space-y-1">
                        {events.map((event) => {
                            const config = EVENT_TYPE_CONFIG[event.eventType] || {
                                label: event.eventType, icon: "📌", color: "text-muted-foreground",
                            };
                            return (
                                <div key={event.id} className="relative flex items-start gap-3 pl-2 py-2 group">
                                    {/* Timeline dot */}
                                    <div className="relative z-10 w-7 h-7 flex items-center justify-center rounded-full bg-card border border-border text-sm shrink-0 group-hover:border-amber-500/30 transition-colors">
                                        {config.icon}
                                    </div>

                                    {/* Content */}
                                    <div className="flex-1 min-w-0 pt-0.5">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className={`text-sm font-medium ${config.color}`}>{config.label}</span>
                                            <span className="text-[10px] text-muted-foreground">
                                                {ACTOR_ICONS[event.actorType]} {event.actorName || event.actorId?.slice(0, 8) || event.actorType}
                                            </span>
                                            {event.targetName && (
                                                <span className="text-[10px] text-muted-foreground">
                                                    → {event.targetName}
                                                </span>
                                            )}
                                            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                                                {formatTimeAgo(event.createdAt)}
                                            </span>
                                        </div>
                                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{event.description}</p>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
