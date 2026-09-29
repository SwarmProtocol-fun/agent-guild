/** Map Hub Node — Custom React Flow node representing the central project hub/orchestrator. */
"use client";

import { memo, useState } from "react";
import { Handle, Position } from "@xyflow/react";

interface MapHubNodeData {
  label: string;
  projectName: string;
  agentCount: number;
  taskCount: number;
  activeCount: number;
  doneCount: number;
  [key: string]: unknown;
}

export const MapHubNode = memo(function MapHubNode({ data }: { data: MapHubNodeData }) {
  const [expanded, setExpanded] = useState(false);
  const completionRate = data.taskCount > 0 ? Math.round((data.doneCount / data.taskCount) * 100) : 0;
  const todoCount = data.taskCount - data.activeCount - data.doneCount;

  return (
    <div
      onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
      className={`relative rounded-xl bg-gradient-to-br from-amber-500 to-amber-700 px-6 py-4 shadow-2xl text-center cursor-pointer transition-all duration-200 ${
        expanded ? 'min-w-[260px] max-w-[320px]' : 'min-w-[220px] max-w-[260px]'
      }`}
    >
      {/* Glow ring */}
      <div className="absolute -inset-1 rounded-xl bg-amber-500/20 blur-md -z-10" />
      <Handle type="source" position={Position.Left} className="!bg-amber-900" id="left" />
      <Handle type="source" position={Position.Right} className="!bg-amber-900" id="right" />
      <Handle type="source" position={Position.Bottom} className="!bg-amber-900" />

      <p className="text-base font-bold text-amber-950">⚡ Project Hub</p>
      <p className="text-sm text-amber-900 font-medium truncate">&ldquo;{data.projectName}&rdquo;</p>

      {/* Collapsed */}
      {!expanded && (
        <>
          <div className="border-t border-amber-500 my-2" />
          <p className="text-xs text-amber-950">
            {data.agentCount} agents · {data.taskCount} tasks
          </p>
          <p className="text-[10px] text-amber-900/60 mt-1">Click to expand</p>
        </>
      )}

      {/* Expanded */}
      {expanded && (
        <div className="mt-3 space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
          {/* Progress bar */}
          {data.taskCount > 0 && (
            <div>
              <div className="flex items-center justify-between text-[10px] mb-1">
                <span className="text-amber-950/70">Completion</span>
                <span className="font-bold text-amber-950">{completionRate}%</span>
              </div>
              <div className="h-2 bg-amber-800/30 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-950 rounded-full transition-all"
                  style={{ width: `${completionRate}%` }}
                />
              </div>
            </div>
          )}

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-1.5">
            <div className="px-2 py-1.5 rounded bg-amber-800/20 text-center">
              <p className="text-lg font-bold text-amber-950">{data.agentCount}</p>
              <p className="text-[9px] text-amber-900">Agents</p>
            </div>
            <div className="px-2 py-1.5 rounded bg-amber-800/20 text-center">
              <p className="text-lg font-bold text-amber-950">{data.taskCount}</p>
              <p className="text-[9px] text-amber-900">Tasks</p>
            </div>
          </div>

          {/* Task breakdown */}
          <div className="flex items-center justify-center gap-3 text-[10px]">
            <span className="flex items-center gap-1 text-amber-950">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />{data.doneCount} done
            </span>
            <span className="flex items-center gap-1 text-amber-950">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-950" />{data.activeCount} active
            </span>
            {todoCount > 0 && (
              <span className="flex items-center gap-1 text-amber-950">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-800/40" />{todoCount} todo
              </span>
            )}
          </div>
        </div>
      )}

      <Handle type="target" position={Position.Top} className="!bg-amber-900" />
    </div>
  );
});
