"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { useChartPalette } from "./chart-theme";
import { ChartTooltip } from "./chart-tooltip";
import type { AgentWorkloadItem } from "@/lib/dashboard-data";

interface Props {
  data: AgentWorkloadItem[];
}

export function AgentWorkloadChart({ data }: Props) {
  const palette = useChartPalette();

  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-52 text-muted-foreground text-sm">
        No agent workload data
      </div>
    );
  }

  // Truncate long names
  const chartData = data.map((d) => ({
    ...d,
    name: d.name.length > 14 ? d.name.slice(0, 12) + ".." : d.name,
  }));

  return (
    <div style={{ width: "100%", height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 8, right: 8, bottom: 0, left: 10 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={palette.grid} horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: 10, fill: palette.muted }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fontSize: 10, fill: palette.muted }}
            tickLine={false}
            axisLine={false}
            width={80}
          />
          <Tooltip content={<ChartTooltip />} />
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          />
          <Bar
            dataKey="completed"
            name="Completed"
            stackId="a"
            fill={palette.task.done}
            radius={[0, 0, 0, 0]}
          />
          <Bar
            dataKey="inProgress"
            name="In Progress"
            stackId="a"
            fill={palette.task.inProgress}
            radius={[0, 4, 4, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
