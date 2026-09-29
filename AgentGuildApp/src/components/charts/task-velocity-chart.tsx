"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { useChartPalette } from "./chart-theme";
import { ChartTooltip } from "./chart-tooltip";
import type { TaskVelocityPoint } from "@/lib/dashboard-data";

interface Props {
  data: TaskVelocityPoint[];
}

export function TaskVelocityChart({ data }: Props) {
  const palette = useChartPalette();

  if (!data.length || data.every((d) => d.created === 0 && d.completed === 0)) {
    return (
      <div className="flex items-center justify-center h-52 text-muted-foreground text-sm">
        No task data yet
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
          <defs>
            <linearGradient id="gradCreated" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={palette.primary} stopOpacity={0.3} />
              <stop offset="100%" stopColor={palette.primary} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradCompleted" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={palette.success} stopOpacity={0.3} />
              <stop offset="100%" stopColor={palette.success} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={palette.grid} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: palette.muted }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10, fill: palette.muted }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip content={<ChartTooltip />} />
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          />
          <Area
            type="monotone"
            dataKey="created"
            name="Created"
            stroke={palette.primary}
            strokeWidth={2}
            fill="url(#gradCreated)"
            dot={false}
          />
          <Area
            type="monotone"
            dataKey="completed"
            name="Completed"
            stroke={palette.success}
            strokeWidth={2}
            fill="url(#gradCompleted)"
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
