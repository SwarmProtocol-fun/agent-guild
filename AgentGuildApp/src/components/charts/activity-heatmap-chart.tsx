"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useChartPalette } from "./chart-theme";
import { ChartTooltip } from "./chart-tooltip";
import type { ActivityHeatmapPoint } from "@/lib/dashboard-data";

interface Props {
  data: ActivityHeatmapPoint[];
}

export function ActivityHeatmapChart({ data }: Props) {
  const palette = useChartPalette();

  const maxCount = Math.max(...data.map((d) => d.count), 1);

  if (data.every((d) => d.count === 0)) {
    return (
      <div className="flex items-center justify-center h-52 text-muted-foreground text-sm">
        No activity data yet
      </div>
    );
  }

  // Color each bar with varying opacity based on intensity
  const chartData = data.map((d) => ({
    ...d,
    fill: palette.primary,
    fillOpacity: d.count > 0 ? 0.25 + (d.count / maxCount) * 0.75 : 0.08,
  }));

  return (
    <div style={{ width: "100%", height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: -20 }}>
          <XAxis
            dataKey="hour"
            tick={{ fontSize: 9, fill: palette.muted }}
            tickLine={false}
            axisLine={false}
            interval={2}
          />
          <YAxis
            tick={{ fontSize: 10, fill: palette.muted }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip
            content={<ChartTooltip formatter={(v) => `${v} events`} />}
          />
          <Bar
            dataKey="count"
            name="Events"
            fill={palette.primary}
            radius={[3, 3, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
