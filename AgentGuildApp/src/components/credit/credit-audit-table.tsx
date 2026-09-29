/**
 * Credit Audit Table — Admin-only table showing credit score change history.
 * Displays timestamp, source, before/after scores, reason, and performer.
 */
"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { CreditAuditEntry } from "@/lib/credit-audit-log";
import { formatDelta } from "@/lib/credit-tiers";

interface CreditAuditTableProps {
    entries: CreditAuditEntry[];
}

const SOURCE_BADGE: Record<string, string> = {
    auto: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
    admin: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
    system: "bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-300",
};

export function CreditAuditTable({ entries }: CreditAuditTableProps) {
    const [filter, setFilter] = useState<"all" | "auto" | "admin" | "system">("all");

    const filtered = filter === "all"
        ? entries
        : entries.filter((e) => e.source === filter);

    return (
        <div className="space-y-3">
            {/* Filter tabs */}
            <div className="flex gap-1">
                {(["all", "auto", "admin", "system"] as const).map((f) => (
                    <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={`px-3 py-1 text-xs rounded-md transition-colors ${
                            filter === f
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted text-muted-foreground hover:bg-muted/80"
                        }`}
                    >
                        {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
                        {f !== "all" && (
                            <span className="ml-1 opacity-60">
                                ({entries.filter((e) => e.source === f).length})
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {/* Table */}
            {filtered.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                    No audit entries found
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-border">
                                <th className="text-left py-2 px-2 text-xs font-medium text-muted-foreground">Time</th>
                                <th className="text-left py-2 px-2 text-xs font-medium text-muted-foreground">Source</th>
                                <th className="text-left py-2 px-2 text-xs font-medium text-muted-foreground">Credit</th>
                                <th className="text-left py-2 px-2 text-xs font-medium text-muted-foreground">Trust</th>
                                <th className="text-left py-2 px-2 text-xs font-medium text-muted-foreground">Reason</th>
                                <th className="text-left py-2 px-2 text-xs font-medium text-muted-foreground">By</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((entry) => {
                                const creditDelta = entry.creditAfter - entry.creditBefore;
                                const trustDelta = entry.trustAfter - entry.trustBefore;
                                const ts = entry.timestamp
                                    ? new Date(entry.timestamp.seconds * 1000).toLocaleString()
                                    : "—";

                                return (
                                    <tr
                                        key={entry.id}
                                        className="border-b border-border/50 hover:bg-muted/30 transition-colors"
                                    >
                                        <td className="py-2 px-2 text-xs text-muted-foreground whitespace-nowrap">
                                            {ts}
                                        </td>
                                        <td className="py-2 px-2">
                                            <Badge className={SOURCE_BADGE[entry.source] || SOURCE_BADGE.system}>
                                                {entry.source}
                                            </Badge>
                                        </td>
                                        <td className="py-2 px-2 font-mono text-xs">
                                            <span className="text-muted-foreground">{entry.creditBefore}</span>
                                            <span className="mx-1">→</span>
                                            <span className="font-medium">{entry.creditAfter}</span>
                                            <span className={`ml-1 ${creditDelta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
                                                ({formatDelta(creditDelta)})
                                            </span>
                                        </td>
                                        <td className="py-2 px-2 font-mono text-xs">
                                            <span className="text-muted-foreground">{entry.trustBefore}</span>
                                            <span className="mx-1">→</span>
                                            <span className="font-medium">{entry.trustAfter}</span>
                                            <span className={`ml-1 ${trustDelta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
                                                ({formatDelta(trustDelta)})
                                            </span>
                                        </td>
                                        <td className="py-2 px-2 text-xs max-w-[200px] truncate">
                                            {entry.reason}
                                        </td>
                                        <td className="py-2 px-2 text-xs text-muted-foreground font-mono">
                                            {entry.performedBy
                                                ? `${entry.performedBy.slice(0, 6)}...${entry.performedBy.slice(-4)}`
                                                : "—"}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
