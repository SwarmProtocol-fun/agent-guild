/** Map Job Node — Custom React Flow node representing a dispatched job with status and progress. */
"use client";

import { memo, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400",
};

interface MapJobNodeData {
  label: string;
  jobTitle: string;
  priority: string;
  reward: string;
  status: string;
  requiredSkills: string[];
  assignedAgent?: string;
  currencySymbol?: string;
  [key: string]: unknown;
}

export const MapJobNode = memo(function MapJobNode({ data }: { data: MapJobNodeData }) {
  const [expanded, setExpanded] = useState(false);
  const isOpen = data.status === "open";
  const isAssigned = !!data.assignedAgent;

  return (
    <div
      onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
      className={`rounded-lg border-2 bg-card px-3 py-2.5 shadow-lg cursor-pointer transition-all duration-200 ${
        expanded ? 'min-w-[220px] max-w-[300px]' : 'min-w-[180px] max-w-[240px]'
      } ${
        isAssigned
          ? "border-amber-500 animate-glow-pulse"
          : isOpen
          ? "border-emerald-500"
          : "border-border"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-emerald-500 !w-3 !h-3" />

      {/* Header — always visible */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-foreground truncate flex-1">
          💼 {data.jobTitle}
        </span>
        <Badge variant="outline" className={`text-[10px] ml-2 shrink-0 ${PRIORITY_COLORS[data.priority] || ""}`}>
          {data.priority}
        </Badge>
      </div>

      {/* Collapsed summary */}
      {!expanded && (
        <>
          {data.reward && (
            <p className="text-[11px] text-amber-500 font-medium">{data.reward} {data.currencySymbol || "$"}</p>
          )}
          {isAssigned && (
            <p className="text-[10px] text-amber-500 font-medium mt-1">🤖 → {data.assignedAgent}</p>
          )}
          {isOpen && !isAssigned && (
            <p className="text-[10px] text-emerald-500 mt-1">⬅ Connect to assign</p>
          )}
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">Click to expand</p>
        </>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="mt-2 space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
          {/* Full title */}
          <div className="px-2 py-1.5 rounded bg-muted/50">
            <p className="text-[10px] text-muted-foreground mb-0.5">Full Title</p>
            <p className="text-[11px] text-foreground break-words">{data.jobTitle}</p>
          </div>

          {/* Reward */}
          {data.reward && (
            <div className="flex items-center justify-between px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/20">
              <span className="text-[10px] text-muted-foreground">Reward</span>
              <span className="text-sm font-bold text-amber-500">{data.reward} {data.currencySymbol || "$"}</span>
            </div>
          )}

          {/* Status */}
          <div className="flex items-center justify-between px-2 py-1.5 rounded bg-muted/50">
            <span className="text-[10px] text-muted-foreground">Status</span>
            <Badge variant="outline" className={`text-[10px] ${
              isAssigned ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
              : isOpen ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
              : ''
            }`}>
              {isAssigned ? '🤖 Assigned' : isOpen ? '🟢 Open' : data.status}
            </Badge>
          </div>

          {/* Assigned agent */}
          {isAssigned && (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/20">
              <span className="text-[10px] text-muted-foreground">Agent</span>
              <span className="text-[11px] font-medium text-amber-500 ml-auto">{data.assignedAgent}</span>
            </div>
          )}

          {/* All required skills */}
          {data.requiredSkills.length > 0 && (
            <div>
              <p className="text-[10px] text-muted-foreground mb-1">Required Skills</p>
              <div className="flex flex-wrap gap-1">
                {data.requiredSkills.map((s) => (
                  <Badge key={s} variant="outline" className="text-[10px]">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {isOpen && !isAssigned && (
            <p className="text-[10px] text-emerald-500">⬅ Drag from an agent to assign</p>
          )}
        </div>
      )}
    </div>
  );
});
