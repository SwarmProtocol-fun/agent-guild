"use client";

import Link from "next/link";
import { Monitor, Play, Square, RotateCcw } from "lucide-react";
import type { Computer } from "@/lib/compute/types";
import { SIZE_PRESETS } from "@/lib/compute/types";
import { StatusBadge } from "./status-badge";

interface ComputerCardProps {
  computer: Computer;
  onStart?: () => void;
  onStop?: () => void;
  onRestart?: () => void;
}

export function ComputerCard({ computer, onStart, onStop, onRestart }: ComputerCardProps) {
  const preset = SIZE_PRESETS[computer.sizeKey];

  return (
    <div className="group relative rounded-xl border border-border bg-card p-4 transition-all hover:border-muted-foreground/50 hover:shadow-lg">
      <Link href={`/compute/computers/${computer.id}`} className="absolute inset-0 z-0" />

      <div className="relative z-10 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
            <Monitor className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="font-semibold text-sm">{computer.name}</h3>
            <p className="text-xs text-muted-foreground">{preset.label}</p>
          </div>
        </div>
        <StatusBadge status={computer.status} />
      </div>

      <div className="relative z-10 mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <span>{computer.region}</span>
        <span>·</span>
        <span>{computer.controllerType}</span>
        {computer.modelKey && (
          <>
            <span>·</span>
            <span>{computer.modelKey}</span>
          </>
        )}
      </div>

      <div className="relative z-10 mt-3 flex gap-1">
        {computer.status === "stopped" && onStart && (
          <button
            onClick={(e) => { e.preventDefault(); onStart(); }}
            className="rounded-md bg-emerald-500/10 px-2 py-1 text-xs text-emerald-400 hover:bg-emerald-500/20 transition-colors"
          >
            <Play className="h-3 w-3 inline mr-1" />
            Start
          </button>
        )}
        {computer.status === "running" && onStop && (
          <button
            onClick={(e) => { e.preventDefault(); onStop(); }}
            className="rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-400 hover:bg-amber-500/20 transition-colors"
          >
            <Square className="h-3 w-3 inline mr-1" />
            Stop
          </button>
        )}
        {computer.status === "running" && onRestart && (
          <button
            onClick={(e) => { e.preventDefault(); onRestart(); }}
            className="rounded-md bg-blue-500/10 px-2 py-1 text-xs text-blue-400 hover:bg-blue-500/20 transition-colors"
          >
            <RotateCcw className="h-3 w-3 inline mr-1" />
            Restart
          </button>
        )}
      </div>
    </div>
  );
}
