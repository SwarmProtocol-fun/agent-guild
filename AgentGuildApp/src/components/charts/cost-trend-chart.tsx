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
import { useChartPalette } from "./chart-theme";
import { ChartTooltip } from "./chart-tooltip";
import type { DailyCost } from "@/lib/usage";

interface Props {
  data: DailyCost[];
}

export function CostTrendChart({ data }: Props) {
  const palette = useChartPalette();

  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-52 text-muted-foreground text-sm">
        No cost data yet
      </div>
    );
  }

  // Show last 14 days, format dates
  const chartData = data.slice(-14).map((d) => ({
    ...d,
    label: new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  }));

  return (
    <div style={{ width: "100%", height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
          <defs>
            <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={palette.primary} stopOpacity={0.35} />
              <stop offset="100%" stopColor={palette.primary} stopOpacity={0} />
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
            tickFormatter={(v) => `$${v.toFixed(2)}`}
          />
          <Tooltip
            content={
              <ChartTooltip
                formatter={(value) => `$${value.toFixed(4)}`}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="costUsd"
            name="Cost"
            stroke={palette.primary}
            strokeWidth={2}
            fill="url(#gradCost)"
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
