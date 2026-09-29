/**
 * RunDetailPanel — Full run detail view with node timeline, actions, and log access.
 * RunProgressOverlay — Compact overlay shown on the canvas during execution.
 */
"use client";

import { useState } from "react";
import {
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  MinusCircle,
  Pause,
  Play,
  Square,
  RotateCcw,
  FileText,
  X,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { WorkflowRun, NodeRunState, NodeRunStatus } from "@/lib/workflow/types";
import { StepLogsViewer } from "./step-logs-viewer";

// ── Status helpers ──────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  NodeRunStatus,
  { icon: typeof CheckCircle; color: string; label: string }
> = {
  completed: { icon: CheckCircle, color: "text-emerald-500", label: "Completed" },
  running: { icon: Loader2, color: "text-amber-500", label: "Running" },
  ready: { icon: ChevronRight, color: "text-blue-500", label: "Ready" },
  pending: { icon: Clock, color: "text-muted-foreground", label: "Pending" },
  failed: { icon: XCircle, color: "text-red-500", label: "Failed" },
  skipped: { icon: MinusCircle, color: "text-muted-foreground", label: "Skipped" },
  cancelled: { icon: MinusCircle, color: "text-muted-foreground", label: "Cancelled" },
};

const RUN_STATUS_COLORS: Record<string, string> = {
  running: "bg-amber-500/10 text-amber-600 border-amber-200",
  completed: "bg-emerald-500/10 text-emerald-600 border-emerald-200",
  failed: "bg-red-500/10 text-red-600 border-red-200",
  cancelled: "bg-muted text-muted-foreground border-border",
  paused: "bg-purple-500/10 text-purple-600 border-purple-200",
  pending: "bg-blue-500/10 text-blue-600 border-blue-200",
};

function formatDuration(startMs?: number, endMs?: number): string {
  if (!startMs) return "--";
  const end = endMs || Date.now();
  const ms = end - startMs;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatTimeAgo(timestamp: unknown): string {
  const ms =
    typeof timestamp === "number"
      ? timestamp
      : (timestamp as { toMillis?: () => number })?.toMillis?.() ?? Date.now();
  const ago = Date.now() - ms;
  if (ago < 60000) return "just now";
  if (ago < 3600000) return `${Math.floor(ago / 60000)}m ago`;
  if (ago < 86400000) return `${Math.floor(ago / 3600000)}h ago`;
  return `${Math.floor(ago / 86400000)}d ago`;
}

// ── RunDetailPanel (full page/tab view) ─────────────────────────────────────

interface RunDetailPanelProps {
  run: WorkflowRun;
  isPolling: boolean;
  orgId: string;
  onCancel?: () => Promise<void>;
  onPause?: () => Promise<void>;
  onResume?: () => Promise<void>;
  onRerunFromStep?: (nodeId: string) => Promise<void>;
  onClose: () => void;
}

export function RunDetailPanel({
  run,
  isPolling,
  orgId,
  onCancel,
  onPause,
  onResume,
  onRerunFromStep,
  onClose,
}: RunDetailPanelProps) {
  const [viewingLogsNodeId, setViewingLogsNodeId] = useState<string | null>(null);

  const nodeEntries = Object.values(run.nodeStates).sort((a, b) => {
    // Sort: completed first (by completedAt), then running, then ready, then pending
    const order: Record<string, number> = {
      completed: 0, failed: 1, running: 2, ready: 3, pending: 4, skipped: 5, cancelled: 6,
    };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9);
  });

  const isActive = run.status === "running" || run.status === "pending";
  const isPaused = run.status === "paused";
  const isTerminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold">
            Run {run.id.slice(0, 8)}
          </h3>
          <Badge
            variant="outline"
            className={`text-xs ${RUN_STATUS_COLORS[run.status] || ""}`}
          >
            {run.status === "running" && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            {run.status}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {run.progress}%
          </span>
        </div>

        <div className="flex items-center gap-2">
          {isPaused && onResume && (
            <Button size="sm" variant="outline" onClick={onResume}>
              <Play className="h-3 w-3 mr-1" /> Resume
            </Button>
          )}
          {isActive && onPause && (
            <Button size="sm" variant="outline" onClick={onPause}>
              <Pause className="h-3 w-3 mr-1" /> Pause
            </Button>
          )}
          {(isActive || isPaused) && onCancel && (
            <Button
              size="sm"
              variant="outline"
              className="text-red-600 border-red-200 hover:bg-red-50"
              onClick={onCancel}
            >
              <Square className="h-3 w-3 mr-1" /> Cancel
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-muted rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all duration-500 ${
            run.status === "failed"
              ? "bg-red-500"
              : run.status === "completed"
                ? "bg-emerald-500"
                : "bg-amber-500"
          }`}
          style={{ width: `${run.progress}%` }}
        />
      </div>

      {/* Node timeline */}
      <div className="space-y-1">
        {nodeEntries.map((state) => {
          const config = STATUS_CONFIG[state.status];
          const Icon = config.icon;
          const isRunning = state.status === "running";

          return (
            <div
              key={state.nodeId}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                state.status === "failed"
                  ? "bg-red-50 dark:bg-red-950/20"
                  : isRunning
                    ? "bg-amber-50 dark:bg-amber-950/20"
                    : "hover:bg-muted/50"
              }`}
            >
              <Icon
                className={`h-4 w-4 shrink-0 ${config.color} ${isRunning ? "animate-spin" : ""}`}
              />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium truncate block">
                  {state.nodeId}
                </span>
                {state.error && (
                  <p className="text-xs text-red-600 mt-0.5 truncate">
                    {state.error}
                  </p>
                )}
              </div>
              <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                {formatDuration(state.startedAt, state.completedAt)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 shrink-0"
                onClick={() => setViewingLogsNodeId(state.nodeId)}
              >
                <FileText className="h-3.5 w-3.5" />
              </Button>
              {state.status === "failed" && isTerminal && onRerunFromStep && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs shrink-0"
                  onClick={() => onRerunFromStep(state.nodeId)}
                >
                  <RotateCcw className="h-3 w-3 mr-1" /> Rerun
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {/* Metadata */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground pt-2 border-t border-border">
        <span>Started {formatTimeAgo(run.createdAt)}</span>
        {run.completedAt != null && <span>Finished {formatTimeAgo(run.completedAt)}</span>}
        <span>v{run.workflowVersion}</span>
      </div>

      {/* Step Logs Modal */}
      {viewingLogsNodeId && (
        <StepLogsViewer
          runId={run.id}
          nodeId={viewingLogsNodeId}
          orgId={orgId}
          onClose={() => setViewingLogsNodeId(null)}
        />
      )}
    </div>
  );
}

// ── RunProgressOverlay (compact canvas overlay) ─────────────────────────────

interface RunProgressOverlayProps {
  run: WorkflowRun;
  isPolling: boolean;
  onCancel: () => void;
  onClose: () => void;
}

export function RunProgressOverlay({
  run,
  isPolling,
  onCancel,
  onClose,
}: RunProgressOverlayProps) {
  const isTerminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled";
  const nodeEntries = Object.values(run.nodeStates);
  const completedCount = nodeEntries.filter(
    (s) => s.status === "completed" || s.status === "failed" || s.status === "skipped" || s.status === "cancelled",
  ).length;

  return (
    <div className="absolute top-4 right-4 w-72 bg-card border border-border rounded-xl shadow-lg z-50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          {isPolling && <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />}
          <span className="text-sm font-semibold">
            {isTerminal ? run.status : "Executing..."}
          </span>
          <Badge
            variant="outline"
            className={`text-[10px] ${RUN_STATUS_COLORS[run.status] || ""}`}
          >
            {run.progress}%
          </Badge>
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-muted h-1.5">
        <div
          className={`h-1.5 transition-all duration-500 ${
            run.status === "failed"
              ? "bg-red-500"
              : run.status === "completed"
                ? "bg-emerald-500"
                : "bg-amber-500"
          }`}
          style={{ width: `${run.progress}%` }}
        />
      </div>

      {/* Compact node list */}
      <div className="px-4 py-2 max-h-48 overflow-y-auto space-y-1">
        {nodeEntries.map((state) => {
          const config = STATUS_CONFIG[state.status];
          const Icon = config.icon;
          return (
            <div key={state.nodeId} className="flex items-center gap-2 text-xs">
              <Icon
                className={`h-3 w-3 shrink-0 ${config.color} ${state.status === "running" ? "animate-spin" : ""}`}
              />
              <span className="truncate flex-1">{state.nodeId}</span>
              <span className="text-muted-foreground tabular-nums">
                {formatDuration(state.startedAt, state.completedAt)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-border flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {completedCount}/{nodeEntries.length} steps
        </span>
        {!isTerminal && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-xs text-red-600 border-red-200 hover:bg-red-50"
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
