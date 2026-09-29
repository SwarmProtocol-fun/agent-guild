"use client";

import { STATUS_COLORS, type ComputerStatus } from "@/lib/compute/types";

export function StatusBadge({ status }: { status: ComputerStatus }) {
  const cfg = STATUS_COLORS[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.bg} ${cfg.color}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${status === "running" ? "animate-pulse" : ""} bg-current`} />
      {cfg.label}
    </span>
  );
}
