/** Operators — User tracking with role management (admin/member/viewer). */
"use client";

import { useState, useEffect, useCallback } from "react";
import { UserCog, Loader2, Shield, Clock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useOrg } from "@/contexts/OrgContext";
import { useAuthAddress } from "@/hooks/useAuthAddress";
import {
    type Operator,
    type OperatorRole,
    ROLE_CONFIG,
    getOperators,
    updateRole,
} from "@/lib/operators";

function timeAgo(d: Date | null): string {
    if (!d) return "—";
    const sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
}

export default function OperatorsPage() {
    const { currentOrg } = useOrg();
    const authAddress = useAuthAddress();
    const [operators, setOperators] = useState<Operator[]>([]);
    const [loading, setLoading] = useState(true);

    const loadOperators = useCallback(async () => {
        if (!currentOrg) return;
        try {
            setLoading(true);
            const data = await getOperators(currentOrg.id);
            setOperators(data);
        } catch (err) {
            console.error("Failed to load operators:", err);
        } finally {
            setLoading(false);
        }
    }, [currentOrg]);

    useEffect(() => { loadOperators(); }, [loadOperators]);

    const handleRoleChange = async (opId: string, role: OperatorRole) => {
        try {
            await updateRole(opId, role);
            setOperators(prev => prev.map(o => o.id === opId ? { ...o, role } : o));
        } catch (err) {
            console.error("Failed to update role:", err);
        }
    };

    if (!authAddress) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-muted-foreground">
                <UserCog className="h-12 w-12 opacity-30" />
                <p>Connect your wallet to view operators</p>
            </div>
        );
    }

    return (
        <div className="max-w-[900px] mx-auto px-4 py-8">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
                        <UserCog className="h-6 w-6 text-indigo-500" />
                    </div>
                    Operators
                </h1>
                <p className="text-sm text-muted-foreground mt-2">
                    Track who&apos;s interacting with your agents and manage permissions
                </p>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
                </div>
            ) : operators.length === 0 ? (
                <Card className="p-12 bg-card/80 border-border text-center">
                    <UserCog className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                    <h3 className="text-sm font-semibold mb-1">No operators yet</h3>
                    <p className="text-xs text-muted-foreground">
                        Operators are recorded as users interact with your agents
                    </p>
                </Card>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {operators.map(op => {
                        const cfg = ROLE_CONFIG[op.role];
                        return (
                            <Card key={op.id} className="p-4 bg-card/80 border-border hover:border-indigo-500/20 transition-colors">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-full bg-indigo-500/10 flex items-center justify-center text-sm font-bold text-indigo-400">
                                        {(op.displayName || op.address).charAt(0).toUpperCase()}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <p className="text-sm font-medium truncate">{op.displayName || op.address}</p>
                                            <Badge variant="outline" className={`text-[9px] ${cfg.color}`}>
                                                <Shield className="h-2 w-2 mr-0.5" />
                                                {cfg.label}
                                            </Badge>
                                        </div>
                                        <p className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">
                                            {op.address}
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-center justify-between mt-3 pt-2 border-t border-border">
                                    <div className="flex gap-4 text-[10px] text-muted-foreground">
                                        <span>{op.activeSessions} active · {op.totalSessions} total sessions</span>
                                        <span className="flex items-center gap-1">
                                            <Clock className="h-2.5 w-2.5" />
                                            {timeAgo(op.lastActive)}
                                        </span>
                                    </div>
                                    <select
                                        value={op.role}
                                        onChange={(e) => handleRoleChange(op.id, e.target.value as OperatorRole)}
                                        className="text-[10px] bg-muted/30 border border-border rounded px-1.5 py-0.5 text-foreground"
                                    >
                                        <option value="admin">Admin</option>
                                        <option value="member">Member</option>
                                        <option value="viewer">Viewer</option>
                                    </select>
                                </div>
                            </Card>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
