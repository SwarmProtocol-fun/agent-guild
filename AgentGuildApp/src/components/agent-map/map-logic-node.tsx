/** Map Logic Nodes — Condition, Switch, and Merge nodes with multi-handle layouts. */
"use client";

import { memo, useState } from "react";
import { Handle, Position } from "@xyflow/react";

/* ═══════════════ Condition Node ═══════════════ */

interface ConditionData {
  label: string;
  condition: string;
  [key: string]: unknown;
}

export const MapConditionNode = memo(function MapConditionNode({ data }: { data: ConditionData }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
      className={`rounded-lg border-2 border-purple-400 bg-card px-3 py-2.5 shadow-md cursor-pointer transition-all duration-200 ${
        expanded ? "min-w-[220px] max-w-[280px]" : "min-w-[160px] max-w-[220px]"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-purple-500" />

      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base">❓</span>
        <span className="text-xs font-semibold truncate flex-1">{data.label}</span>
        <span className="text-[9px] font-bold uppercase tracking-wider text-purple-600 dark:text-purple-400">
          Logic
        </span>
      </div>

      {/* Collapsed */}
      {!expanded && (
        <div className="flex items-center gap-3 mt-1">
          <span className="text-[10px] text-emerald-500 font-medium">✓ True</span>
          <span className="text-[10px] text-red-400 font-medium">✗ False</span>
        </div>
      )}

      {/* Expanded */}
      {expanded && (
        <div className="mt-2 space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
          <div className="px-2 py-1.5 rounded bg-purple-500/10 text-[11px]">
            <span className="text-[10px] text-muted-foreground">Condition</span>
            <p className="font-medium text-foreground truncate">
              {data.condition || "— not set —"}
            </p>
          </div>
          <div className="flex items-center justify-between text-[10px] px-1">
            <span className="flex items-center gap-1 text-emerald-500">
              <span className="w-2 h-2 rounded-full bg-emerald-500" /> True branch
            </span>
            <span className="flex items-center gap-1 text-red-400">
              <span className="w-2 h-2 rounded-full bg-red-400" /> False branch
            </span>
          </div>
        </div>
      )}

      {/* Two output handles — True (top-right) and False (bottom-right) */}
      <Handle
        type="source"
        position={Position.Right}
        id="true"
        className="!w-3 !h-3 !bg-emerald-500"
        style={{ top: "30%" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="false"
        className="!w-3 !h-3 !bg-red-400"
        style={{ top: "70%" }}
      />
    </div>
  );
});

/* ═══════════════ Switch Node ═══════════════ */

interface SwitchData {
  label: string;
  field: string;
  cases: string[];
  [key: string]: unknown;
}

export const MapSwitchNode = memo(function MapSwitchNode({ data }: { data: SwitchData }) {
  const [expanded, setExpanded] = useState(false);
  const cases = Array.isArray(data.cases) ? data.cases : [];

  return (
    <div
      onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
      className={`rounded-lg border-2 border-purple-400 bg-card px-3 py-2.5 shadow-md cursor-pointer transition-all duration-200 ${
        expanded ? "min-w-[220px] max-w-[280px]" : "min-w-[160px] max-w-[220px]"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-purple-500" />

      <div className="flex items-center gap-2 mb-1">
        <span className="text-base">🔀</span>
        <span className="text-xs font-semibold truncate flex-1">{data.label}</span>
        <span className="text-[9px] font-bold uppercase tracking-wider text-purple-600 dark:text-purple-400">
          Logic
        </span>
      </div>

      {!expanded && (
        <p className="text-[10px] text-muted-foreground mt-0.5">
          {cases.length} case{cases.length !== 1 ? "s" : ""}
        </p>
      )}

      {expanded && (
        <div className="mt-2 space-y-1 animate-in fade-in slide-in-from-top-1 duration-200">
          {data.field && (
            <div className="px-2 py-1.5 rounded bg-purple-500/10 text-[11px]">
              <span className="text-[10px] text-muted-foreground">Switch on</span>
              <p className="font-medium text-foreground truncate">{data.field}</p>
            </div>
          )}
          {cases.map((c, i) => (
            <div key={i} className="flex items-center gap-2 px-2 py-1 rounded bg-muted/50 text-[10px]">
              <span className="w-2 h-2 rounded-full bg-purple-400" />
              <span className="text-foreground truncate">{c}</span>
            </div>
          ))}
        </div>
      )}

      {/* Dynamic output handles for each case */}
      {cases.map((_, i) => {
        const pct = cases.length <= 1 ? 50 : 20 + (60 / (cases.length - 1)) * i;
        return (
          <Handle
            key={i}
            type="source"
            position={Position.Right}
            id={`case-${i}`}
            className="!w-3 !h-3 !bg-purple-400"
            style={{ top: `${pct}%` }}
          />
        );
      })}
    </div>
  );
});

/* ═══════════════ Merge Node ═══════════════ */

interface MergeData {
  label: string;
  mode: string;
  inputCount: number;
  [key: string]: unknown;
}

export const MapMergeNode = memo(function MapMergeNode({ data }: { data: MergeData }) {
  const [expanded, setExpanded] = useState(false);
  const inputCount = Math.max(2, Number(data.inputCount) || 2);

  return (
    <div
      onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
      className={`rounded-lg border-2 border-purple-400 bg-card px-3 py-2.5 shadow-md cursor-pointer transition-all duration-200 ${
        expanded ? "min-w-[200px] max-w-[260px]" : "min-w-[140px] max-w-[200px]"
      }`}
    >
      {/* Multiple input handles */}
      {Array.from({ length: inputCount }, (_, i) => {
        const pct = inputCount <= 1 ? 50 : 20 + (60 / (inputCount - 1)) * i;
        return (
          <Handle
            key={i}
            type="target"
            position={Position.Left}
            id={`in-${i}`}
            className="!w-3 !h-3 !bg-purple-500"
            style={{ top: `${pct}%` }}
          />
        );
      })}

      <div className="flex items-center gap-2 mb-1">
        <span className="text-base">🔗</span>
        <span className="text-xs font-semibold truncate flex-1">{data.label}</span>
        <span className="text-[9px] font-bold uppercase tracking-wider text-purple-600 dark:text-purple-400">
          Logic
        </span>
      </div>

      {!expanded && (
        <p className="text-[10px] text-muted-foreground mt-0.5">
          {inputCount} inputs · {data.mode || "waitAll"}
        </p>
      )}

      {expanded && (
        <div className="mt-2 space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
          <div className="px-2 py-1.5 rounded bg-purple-500/10 text-[11px]">
            <span className="text-[10px] text-muted-foreground">Mode</span>
            <p className="font-medium text-foreground">{data.mode || "waitAll"}</p>
          </div>
          <div className="px-2 py-1.5 rounded bg-purple-500/10 text-[11px]">
            <span className="text-[10px] text-muted-foreground">Inputs</span>
            <p className="font-medium text-foreground">{inputCount}</p>
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-purple-500" />
    </div>
  );
});
