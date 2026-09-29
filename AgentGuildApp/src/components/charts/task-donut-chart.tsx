"use client";

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { useChartPalette } from "./chart-theme";
import { ChartTooltip } from "./chart-tooltip";

interface Props {
  done: number;
  inProgress: number;
  todo: number;
}

export function TaskDonutChart({ done, inProgress, todo }: Props) {
  const palette = useChartPalette();
  const total = done + inProgress + todo;

  if (total === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        No tasks yet
      </div>
    );
  }

  const data = [
    { name: "Done", value: done, color: palette.task.done },
    { name: "In Progress", value: inProgress, color: palette.task.inProgress },
    { name: "Todo", value: todo, color: palette.task.todo },
  ].filter((d) => d.value > 0);

  const pct = ((done / total) * 100).toFixed(0);

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative w-full" style={{ height: 180 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={75}
              paddingAngle={2}
              dataKey="value"
              stroke="none"
            >
              {data.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        {/* Center label */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-2xl font-bold" style={{ color: palette.task.done }}>
            {pct}%
          </span>
          <span className="text-[10px] text-muted-foreground">Complete</span>
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-4 text-xs">
        {data.map((d) => (
          <div key={d.name} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: d.color }} />
            <span className="text-muted-foreground">{d.name}</span>
            <span className="font-semibold">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
