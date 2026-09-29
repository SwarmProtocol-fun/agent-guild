"use client";

import { useChartPalette } from "./chart-theme";

interface Payload {
  name?: string;
  value?: number;
  color?: string;
  dataKey?: string;
  payload?: Record<string, unknown>;
}

interface Props {
  active?: boolean;
  payload?: Payload[];
  label?: string;
  formatter?: (value: number, name: string) => string;
}

export function ChartTooltip({ active, payload, label, formatter }: Props) {
  const palette = useChartPalette();

  if (!active || !payload?.length) return null;

  return (
    <div
      className="rounded-lg px-3 py-2 text-xs shadow-xl backdrop-blur-sm"
      style={{
        background: palette.tooltip.bg,
        border: `1px solid ${palette.tooltip.border}`,
        color: palette.tooltip.text,
      }}
    >
      {label && <p className="font-semibold mb-1 opacity-70">{label}</p>}
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: entry.color }}
          />
          <span className="opacity-70">{entry.name}:</span>
          <span className="font-semibold">
            {formatter
              ? formatter(entry.value ?? 0, entry.name ?? "")
              : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}
