/** Performance Table — Sortable table of agent performance metrics (tasks, latency, uptime). */
"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

type SortDirection = "asc" | "desc";

interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  render: (item: T) => React.ReactNode;
  getValue?: (item: T) => number;
}

interface PerformanceTableProps<T> {
  data: T[];
  columns: Column<T>[];
  defaultSortKey?: string;
  defaultSortDir?: SortDirection;
}

export function PerformanceTable<T>({
  data,
  columns,
  defaultSortKey,
  defaultSortDir = "desc",
}: PerformanceTableProps<T>) {
  const [sortKey, setSortKey] = useState(defaultSortKey || "");
  const [sortDir, setSortDir] = useState<SortDirection>(defaultSortDir);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortedData = [...data].sort((a, b) => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.getValue) return 0;
    const aVal = col.getValue(a);
    const bVal = col.getValue(b);
    return sortDir === "asc" ? aVal - bVal : bVal - aVal;
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  "text-left py-3 px-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider",
                  col.sortable && "cursor-pointer hover:text-muted-foreground select-none"
                )}
                onClick={() => col.sortable && handleSort(col.key)}
              >
                <span className="flex items-center gap-1">
                  {col.label}
                  {col.sortable && sortKey === col.key && (
                    <span className="text-amber-600 dark:text-amber-400">
                      {sortDir === "desc" ? "▼" : "▲"}
                    </span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedData.map((item, i) => (
            <tr
              key={i}
              className="border-b border-border hover:bg-muted/80 transition-colors"
            >
              {columns.map((col) => (
                <td key={col.key} className="py-3 px-4">
                  {col.render(item)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PnlDisplay({ value, currency = "$" }: { value: number; currency?: string }) {
  const isPositive = value >= 0;
  const sign = isPositive ? "+" : "-";
  const abs = Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const display = `${sign}$${abs}`;
  return (
    <span className={cn("font-semibold", isPositive ? "text-amber-600 dark:text-amber-400" : "text-red-500")}>
      {display}
    </span>
  );
}

export function WinRateBar({ rate }: { rate: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-amber-600 rounded-full"
          style={{ width: `${Math.min(rate, 100)}%` }}
        />
      </div>
      <span className="text-sm font-medium">{rate.toFixed(1)}%</span>
    </div>
  );
}
