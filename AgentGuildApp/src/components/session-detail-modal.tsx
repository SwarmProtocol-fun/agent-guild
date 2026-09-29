/** Session Detail Modal — Overlay showing session stats (tokens/cost/duration), tools, and recent messages. */
"use client";

import { X, Clock, Cpu, Coins, MessageSquare, Wrench } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmtTokens, fmtCost } from "@/lib/usage";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface SessionDetail {
    id: string;
    agentId: string;
    agentName?: string;
    model: string;
    status: "live" | "idle" | "completed";
    summary?: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    toolsUsed: string[];
    messages: { role: "user" | "agent"; content: string; timestamp: Date }[];
    startedAt: Date;
    duration?: string;
}

const STATUS_STYLE: Record<string, string> = {
    live: "bg-emerald-500/10 text-emerald-400",
    idle: "bg-amber-500/10 text-amber-400",
    completed: "bg-zinc-500/10 text-zinc-400",
};

// ═══════════════════════════════════════════════════════════════
// Modal Component
// ═══════════════════════════════════════════════════════════════

export function SessionDetailModal({
    session,
    onClose,
}: {
    session: SessionDetail;
    onClose: () => void;
}) {
    const totalTokens = session.tokensIn + session.tokensOut;

    return (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
            <Card
                className="w-full max-w-lg max-h-[80vh] overflow-y-auto bg-card border-border"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
                    <div>
                        <h2 className="text-sm font-semibold">{session.agentName || session.agentId}</h2>
                        <p className="text-[10px] text-muted-foreground font-mono">{session.id.slice(0, 12)}...</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Badge variant="outline" className={`text-[9px] ${STATUS_STYLE[session.status] || ""}`}>
                            {session.status}
                        </Badge>
                        <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground">
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-2 p-4 border-b border-border">
                    <div className="text-center">
                        <Cpu className="h-3.5 w-3.5 mx-auto text-muted-foreground mb-1" />
                        <p className="text-xs font-semibold">{fmtTokens(totalTokens)}</p>
                        <p className="text-[9px] text-muted-foreground">Tokens</p>
                    </div>
                    <div className="text-center">
                        <Coins className="h-3.5 w-3.5 mx-auto text-emerald-400 mb-1" />
                        <p className="text-xs font-semibold text-emerald-400">{fmtCost(session.costUsd)}</p>
                        <p className="text-[9px] text-muted-foreground">Cost</p>
                    </div>
                    <div className="text-center">
                        <Clock className="h-3.5 w-3.5 mx-auto text-muted-foreground mb-1" />
                        <p className="text-xs font-semibold">{session.duration || "—"}</p>
                        <p className="text-[9px] text-muted-foreground">Duration</p>
                    </div>
                </div>

                {/* Summary */}
                {session.summary && (
                    <div className="p-4 border-b border-border">
                        <h3 className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Summary</h3>
                        <p className="text-xs text-foreground">{session.summary}</p>
                    </div>
                )}

                {/* Model + Tools */}
                <div className="p-4 border-b border-border">
                    <div className="flex items-center gap-2 mb-2">
                        <Badge variant="outline" className="text-[9px]">{session.model}</Badge>
                    </div>
                    {session.toolsUsed.length > 0 && (
                        <div>
                            <h3 className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
                                <Wrench className="h-2.5 w-2.5" /> Tools Used
                            </h3>
                            <div className="flex flex-wrap gap-1">
                                {session.toolsUsed.map(tool => (
                                    <Badge key={tool} variant="outline" className="text-[9px] font-mono">
                                        {tool}
                                    </Badge>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Recent Messages */}
                {session.messages.length > 0 && (
                    <div className="p-4">
                        <h3 className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
                            <MessageSquare className="h-2.5 w-2.5" /> Recent Messages
                        </h3>
                        <div className="space-y-2 max-h-40 overflow-y-auto">
                            {session.messages.slice(-5).map((msg, i) => (
                                <div key={i} className={`text-xs p-2 rounded-lg ${msg.role === "user" ? "bg-blue-500/5 border border-blue-500/10" : "bg-muted/30 border border-border"
                                    }`}>
                                    <div className="flex items-center gap-2 mb-0.5">
                                        <span className="text-[9px] font-medium text-muted-foreground uppercase">
                                            {msg.role}
                                        </span>
                                        <span className="text-[8px] text-muted-foreground/60">
                                            {msg.timestamp.toLocaleTimeString()}
                                        </span>
                                    </div>
                                    <p className="line-clamp-3">{msg.content}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </Card>
        </div>
    );
}
