/**
 * WorkflowRunsTab — Lists all runs for a workflow with status, progress, and detail view.
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import {
  CheckCircle,
  XCircle,
  Loader2,
  RefreshCw,
  Clock,
  Pause,
  MinusCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { WorkflowRun, RunStatus } from "@/lib/workflow/types";
import { useWorkflowRun } from "@/hooks/useWorkflowRun";
import { RunDetailPanel } from "./run-detail-panel";

interface WorkflowRunsTabProps {
  workflowId: string;
  orgId: string;
}

const STATUS_FILTERS: Array<{ label: string; value: RunStatus | "all" }> = [
  { label: "All", value: "all" },
  { label: "Running", value: "running" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
  { label: "Cancelled", value: "cancelled" },
];

const STATUS_ICONS: Record<string, typeof CheckCircle> = {
  completed: CheckCircle,
  running: Loader2,
  failed: XCircle,
  cancelled: MinusCircle,
  paused: Pause,
  pending: Clock,
};

const STATUS_COLORS: Record<string, string> = {
  running: "bg-amber-500/10 text-amber-600 border-amber-200",
  completed: "bg-emerald-500/10 text-emerald-600 border-emerald-200",
  failed: "bg-red-500/10 text-red-600 border-red-200",
  cancelled: "bg-muted text-muted-foreground border-border",
  paused: "bg-purple-500/10 text-purple-600 border-purple-200",
  pending: "bg-blue-500/10 text-blue-600 border-blue-200",
};

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

export function WorkflowRunsTab({ workflowId, orgId }: WorkflowRunsTabProps) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<RunStatus | "all">("all");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/workflows/${workflowId}/runs?orgId=${orgId}`,
      );
      if (res.ok) {
        const data = await res.json();
        setRuns(data.runs || []);
      }
    } catch (err) {
      console.error("Failed to fetch runs:", err);
    } finally {
      setLoading(false);
    }
  }, [workflowId, orgId]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  // Auto-refresh when there are active runs. Skip ticks while the tab is in
  // the background — a run left running unattended shouldn't keep the list
  // refetching every 5s until someone looks at it again.
  useEffect(() => {
    const hasActive = runs.some(
      (r) => r.status === "running" || r.status === "pending",
    );
    if (!hasActive) return;

    const interval = setInterval(() => {
      if (document.visibilityState === "visible") fetchRuns();
    }, 5000);
    return () => clearInterval(interval);
  }, [runs, fetchRuns]);

  const selectedRun = runs.find((r) => r.id === selectedRunId);
  const { run: liveRun, isPolling, cancel, pause, resume } = useWorkflowRun(
    selectedRunId && selectedRun && (selectedRun.status === "running" || selectedRun.status === "pending" || selectedRun.status === "paused")
      ? selectedRunId
      : null,
    orgId,
  );

  const displayRun = liveRun || selectedRun;

  const filteredRuns =
    filter === "all" ? runs : runs.filter((r) => r.status === filter);

  const handleRerunFromStep = async (nodeId: string) => {
    if (!selectedRunId) return;
    try {
      const res = await fetch(`/api/workflows/runs/${selectedRunId}/rerun`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, fromNodeId: nodeId }),
      });
      if (res.ok) {
        const data = await res.json();
        setSelectedRunId(data.newRunId);
        fetchRuns();
      }
    } catch (err) {
      console.error("Rerun failed:", err);
    }
  };

  const handleStartNewRun = async () => {
    try {
      const res = await fetch(`/api/workflows/${workflowId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId }),
      });
      if (res.ok) {
        const data = await res.json();
        setSelectedRunId(data.runId);
        fetchRuns();
      }
    } catch (err) {
      console.error("Failed to start run:", err);
    }
  };

  if (selectedRunId && displayRun) {
    return (
      <RunDetailPanel
        run={displayRun}
        isPolling={isPolling}
        orgId={orgId}
        onCancel={cancel}
        onPause={pause}
        onResume={resume}
        onRerunFromStep={handleRerunFromStep}
        onClose={() => setSelectedRunId(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                filter === f.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={fetchRuns} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={handleStartNewRun}>
            Run Workflow
          </Button>
        </div>
      </div>

      {/* Runs list */}
      {loading && runs.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : filteredRuns.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Clock className="h-8 w-8 mx-auto mb-3 opacity-40" />
          <p className="text-sm">
            {filter === "all"
              ? "No runs yet. Click \"Run Workflow\" to start."
              : `No ${filter} runs.`}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredRuns.map((run) => {
            const Icon = STATUS_ICONS[run.status] || Clock;
            return (
              <div
                key={run.id}
                className="flex items-center gap-4 px-4 py-3 rounded-lg border border-border bg-card hover:border-primary/30 cursor-pointer transition-colors"
                onClick={() => setSelectedRunId(run.id)}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${
                    run.status === "running" ? "animate-spin text-amber-500" :
                    run.status === "completed" ? "text-emerald-500" :
                    run.status === "failed" ? "text-red-500" :
                    "text-muted-foreground"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">
                    Run {run.id.slice(0, 8)}
                  </span>
                </div>
                <Badge
                  variant="outline"
                  className={`text-[10px] ${STATUS_COLORS[run.status] || ""}`}
                >
                  {run.status}
                </Badge>
                {/* Progress bar */}
                <div className="w-24 bg-muted rounded-full h-1.5">
                  <div
                    className={`h-1.5 rounded-full transition-all ${
                      run.status === "failed" ? "bg-red-500" :
                      run.status === "completed" ? "bg-emerald-500" :
                      "bg-amber-500"
                    }`}
                    style={{ width: `${run.progress}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">
                  {run.progress}%
                </span>
                <span className="text-xs text-muted-foreground w-16 text-right">
                  {formatTimeAgo(run.createdAt)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
