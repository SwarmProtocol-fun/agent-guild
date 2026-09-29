"use client";

import { AreaChart, Area, ResponsiveContainer } from "recharts";

interface Props {
  data: number[];
  color: string;
  height?: number;
}

export function MiniSparkline({ data, color, height = 32 }: Props) {
  if (!data.length) return null;

  const chartData = data.map((value, i) => ({ i, v: value }));
  const gradientId = `spark-${color.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <div style={{ width: 80, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.4} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
