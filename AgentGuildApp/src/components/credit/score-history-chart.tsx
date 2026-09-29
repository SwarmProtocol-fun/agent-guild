/**
 * Score History Chart — Recharts AreaChart showing credit score over time.
 * Follows the same pattern as cost-trend-chart.tsx.
 */
"use client";

import {
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
} from "recharts";
import { useChartPalette } from "@/components/charts/chart-theme";
import { ChartTooltip } from "@/components/charts/chart-tooltip";
import type { ScoreHistoryPoint } from "@/lib/credit-explainer";

interface ScoreHistoryChartProps {
    data: ScoreHistoryPoint[];
}

export function ScoreHistoryChart({ data }: ScoreHistoryChartProps) {
    const palette = useChartPalette();

    if (!data.length) {
        return (
            <div className="flex items-center justify-center h-52 text-muted-foreground text-sm">
                No score history yet
            </div>
        );
    }

    const chartData = data.map((d) => ({
        ...d,
        label: new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    }));

    return (
        <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
                    <defs>
                        <linearGradient id="gradCredit" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={palette.primary} stopOpacity={0.35} />
                            <stop offset="100%" stopColor={palette.primary} stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="gradTrust" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={palette.secondary ?? "#3b82f6"} stopOpacity={0.2} />
                            <stop offset="100%" stopColor={palette.secondary ?? "#3b82f6"} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={palette.grid} />
                    <XAxis
                        dataKey="label"
                        tick={{ fontSize: 10, fill: palette.muted }}
                        tickLine={false}
                        axisLine={false}
                        interval="preserveStartEnd"
                    />
                    <YAxis
                        tick={{ fontSize: 10, fill: palette.muted }}
                        tickLine={false}
                        axisLine={false}
                        domain={[300, 900]}
                        ticks={[300, 450, 550, 700, 850, 900]}
                    />
                    <Tooltip
                        content={
                            <ChartTooltip
                                formatter={(value, name) =>
                                    name === "Trust" ? `${value}/100` : `${value}`
                                }
                            />
                        }
                    />
                    <Area
                        type="monotone"
                        dataKey="creditScore"
                        name="Credit"
                        stroke={palette.primary}
                        strokeWidth={2}
                        fill="url(#gradCredit)"
                        dot={false}
                    />
                    <Area
                        type="monotone"
                        dataKey="trustScore"
                        name="Trust"
                        stroke={palette.secondary ?? "#3b82f6"}
                        strokeWidth={1.5}
                        fill="url(#gradTrust)"
                        dot={false}
                        yAxisId={0}
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
}
