"use client";

import { RadialBarChart, RadialBar, ResponsiveContainer, Tooltip } from "recharts";
import { useChartPalette } from "./chart-theme";
import { ChartTooltip } from "./chart-tooltip";

interface Props {
  online: number;
  busy: number;
  offline: number;
}

export function AgentStatusChart({ online, busy, offline }: Props) {
  const palette = useChartPalette();
  const total = online + busy + offline;

  if (total === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        No agents registered
      </div>
    );
  }

  const data = [
    { name: "Offline", value: offline, fill: palette.agent.offline, pct: (offline / total) * 100 },
    { name: "Busy", value: busy, fill: palette.agent.busy, pct: (busy / total) * 100 },
    { name: "Online", value: online, fill: palette.agent.online, pct: (online / total) * 100 },
  ];

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="w-full" style={{ height: 180 }}>
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart
            cx="50%"
            cy="50%"
            innerRadius="30%"
            outerRadius="90%"
            barSize={14}
            data={data}
            startAngle={180}
            endAngle={-180}
          >
            <RadialBar
              dataKey="pct"
              background={{ fill: "rgba(255,255,255,0.03)" }}
              cornerRadius={4}
            />
            <Tooltip content={<ChartTooltip formatter={(_, name) => {
              const item = data.find(d => d.name === name);
              return item ? `${item.value} agents` : "";
            }} />} />
          </RadialBarChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex gap-4 text-xs">
        {[...data].reverse().map((d) => (
          <div key={d.name} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: d.fill }} />
            <span className="text-muted-foreground">{d.name}</span>
            <span className="font-semibold">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
