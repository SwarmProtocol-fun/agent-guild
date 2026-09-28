"use client";

import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import SpotlightCard from "@/components/reactbits/SpotlightCard";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import DecryptedText from "@/components/reactbits/DecryptedText";
import { Check, Pause, Play, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";

interface LogEvent {
    ts: number;
    type: string;
    sessionId: string;
    message?: {
        role: string;
        content: string;
        tool_calls?: any[];
    };
    event?: string;
    [key: string]: any;
}

export function LiveFeedWidget() {
    const [paused, setPaused] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    const autoScroll = useRef(true);

    // Only fetch the last 30 events to keep it lightweight
    const { data, isLoading: loading } = useQuery({
        queryKey: ["live-feed"],
        queryFn: async () => {
            const res = await fetch("/api/live-feed?limit=30");
            if (!res.ok) throw new Error("Failed to fetch live feed");
            const json = await res.json();
            return (json.events ?? []) as LogEvent[];
        },
        // Show oldest first so newest is at the bottom
        select: (raw) => [...raw].reverse(),
        refetchInterval: paused ? false : 3000,
        refetchIntervalInBackground: false,
    });
    const events = data ?? [];

    useEffect(() => {
        if (autoScroll.current && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [events]);

    const handleScroll = () => {
        if (!scrollRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
        // If we're near the bottom, enable auto-scroll, else disable
        autoScroll.current = scrollHeight - scrollTop - clientHeight < 50;
    };

    if (loading && events.length === 0) {
        return (
            <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden" spotlightColor="rgba(255, 191, 0, 0.06)">
                <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                        <Terminal className="w-5 h-5 text-amber-500" />
                        <span className="text-lg font-semibold text-muted-foreground">Live Feed</span>
                    </CardTitle>
                </CardHeader>
                <CardContent className="h-64 flex items-center justify-center text-muted-foreground">
                    Establishing link...
                </CardContent>
            </SpotlightCard>
        );
    }

    return (
        <SpotlightCard className="p-0 glass-card-enhanced h-full flex flex-col overflow-hidden" spotlightColor="rgba(255, 191, 0, 0.06)">
            <CardHeader className="pb-2 flex-shrink-0 flex flex-row items-center justify-between border-b border-border/40">
                <CardTitle className="text-lg flex items-center gap-2">
                    <Terminal className="w-5 h-5 text-amber-500" />
                    <DecryptedText text="Live Stream" speed={30} maxIterations={6} animateOn="view" sequential className="text-lg font-semibold" encryptedClassName="text-lg font-semibold text-amber-500/40" />
                </CardTitle>

                <div className="flex items-center gap-2 text-xs">
                    <Badge variant="outline" className={`bg-black/40 font-mono text-[10px] ${paused ? 'text-amber-500' : 'text-emerald-500'}`}>
                        <span className={paused ? "" : "animate-pulse"}>●</span> {paused ? 'PAUSED' : 'LIVE'}
                    </Badge>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setPaused(!paused)}>
                        {paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                    </Button>
                </div>
            </CardHeader>

            <CardContent className="p-0 flex-1 overflow-hidden relative bg-black/40">
                <div
                    ref={scrollRef}
                    onScroll={handleScroll}
                    className="absolute inset-0 p-4 space-y-3 overflow-y-auto custom-scrollbar font-mono text-xs"
                >
                    {events.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">No recent terminal output</div>
                    ) : (
                        events.map((ev, i) => {
                            const time = new Date(ev.ts).toLocaleTimeString([], { hour12: false });
                            const isMsg = ev.type === 'message' && ev.message;
                            const hasTools = isMsg && ev.message?.tool_calls && ev.message.tool_calls.length > 0;

                            const roleStr = isMsg ? ev.message?.role : ev.type;
                            let content = "";
                            let color = "text-muted-foreground";

                            if (isMsg && ev.message) {
                                if (ev.message.role === 'user') {
                                    color = "text-blue-400";
                                    content = ev.message.content || '[Prompt]';
                                } else if (ev.message.role === 'assistant') {
                                    color = "text-emerald-400";
                                    content = ev.message.content || '[Response]';
                                    if (hasTools) content += ` (Used ${ev.message.tool_calls!.length} tools)`;
                                } else if (ev.message.role === 'tool') {
                                    color = "text-amber-400";
                                    content = ev.message.content
                                        ? `[Tool Result: ${ev.message.content.length} chars output]`
                                        : '[Tool Result empty]';
                                }
                            } else {
                                content = JSON.stringify(ev.event || ev);
                            }

                            return (
                                <div key={i} className="flex gap-3 leading-relaxed hover:bg-white/5 p-1 rounded transition-colors group">
                                    <span className="text-muted-foreground/60 shrink-0">[{time}]</span>
                                    <span className={`shrink-0 w-16 uppercase ${color}`}>{roleStr}</span>
                                    <span className="text-muted-foreground truncate flex-1 opacity-80 group-hover:opacity-100 transition-opacity">
                                        {content}
                                    </span>
                                    <span className="text-muted-foreground/30 shrink-0 text-[9px] truncate w-20 text-right">
                                        {ev.sessionId}
                                    </span>
                                </div>
                            );
                        })
                    )}
                </div>
            </CardContent>
        </SpotlightCard>
    );
}
