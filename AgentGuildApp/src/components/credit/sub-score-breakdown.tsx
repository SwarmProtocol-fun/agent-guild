/**
 * Sub-Score Breakdown — Horizontal bars showing credit contribution by category.
 */
"use client";

import type { SubScores } from "@/lib/credit-explainer";

interface SubScoreBreakdownProps {
    subScores: SubScores;
}

const CATEGORIES: Array<{
    key: keyof SubScores;
    label: string;
    color: string;
    bgColor: string;
}> = [
    { key: "taskPerformance", label: "Task Performance", color: "bg-emerald-500", bgColor: "bg-emerald-500/20" },
    { key: "skillDiversity", label: "Skill Diversity", color: "bg-blue-500", bgColor: "bg-blue-500/20" },
    { key: "bonusHistory", label: "Bonuses", color: "bg-amber-500", bgColor: "bg-amber-500/20" },
    { key: "penaltyHistory", label: "Penalties", color: "bg-red-500", bgColor: "bg-red-500/20" },
];

export function SubScoreBreakdown({ subScores }: SubScoreBreakdownProps) {
    // Find max absolute value for scaling
    const maxAbs = Math.max(
        1,
        ...CATEGORIES.map((c) => Math.abs(subScores[c.key])),
    );

    return (
        <div className="space-y-3">
            {CATEGORIES.map(({ key, label, color, bgColor }) => {
                const value = subScores[key];
                const width = Math.abs(value) / maxAbs * 100;
                const isNegative = value < 0;

                return (
                    <div key={key}>
                        <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-muted-foreground">{label}</span>
                            <span className={`text-xs font-mono font-medium ${isNegative ? "text-red-500" : "text-emerald-600 dark:text-emerald-400"}`}>
                                {value > 0 ? "+" : ""}{value}
                            </span>
                        </div>
                        <div className={`h-2 rounded-full ${bgColor}`}>
                            <div
                                className={`h-full rounded-full transition-all duration-500 ${color}`}
                                style={{ width: `${Math.max(2, width)}%` }}
                            />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
