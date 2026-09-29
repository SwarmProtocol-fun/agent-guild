/**
 * StepLogsViewer — Modal overlay displaying persistent step logs for a workflow node.
 */
"use client";

import { useState, useEffect } from "react";
import { X, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { StepLog } from "@/lib/workflow/types";

interface StepLogsViewerProps {
  runId: string;
  nodeId: string;
  orgId: string;
  onClose: () => void;
}

const LEVEL_STYLES: Record<string, { bg: string; text: string }> = {
  info: { bg: "bg-blue-500/10", text: "text-blue-600" },
  warn: { bg: "bg-amber-500/10", text: "text-amber-600" },
  error: { bg: "bg-red-500/10", text: "text-red-600" },
  debug: { bg: "bg-muted", text: "text-muted-foreground" },
};

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions);
}

export function StepLogsViewer({ runId, nodeId, orgId, onClose }: StepLogsViewerProps) {
  const [logs, setLogs] = useState<StepLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    async function fetchLogs() {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/workflows/runs/${runId}/logs?orgId=${orgId}&nodeId=${nodeId}`,
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) setLogs(data.logs || []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load logs");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchLogs();
    return () => { cancelled = true; };
  }, [runId, nodeId, orgId]);

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold">Step Logs</h3>
            <code className="text-xs bg-muted px-2 py-0.5 rounded font-mono">
              {nodeId}
            </code>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {error && (
            <div className="text-sm text-red-600 text-center py-8">
              {error}
            </div>
          )}

          {!loading && !error && logs.length === 0 && (
            <div className="text-sm text-muted-foreground text-center py-8">
              No logs recorded for this step.
            </div>
          )}

          {!loading && logs.length > 0 && (
            <div className="space-y-1 font-mono text-xs">
              {logs.map((log) => {
                const style = LEVEL_STYLES[log.level] || LEVEL_STYLES.info;
                const hasMetadata = log.metadata && Object.keys(log.metadata).length > 0;
                const isExpanded = expandedIds.has(log.id);

                return (
                  <div key={log.id} className="group">
                    <div
                      className={`flex items-start gap-2 px-3 py-1.5 rounded transition-colors ${
                        hasMetadata ? "cursor-pointer hover:bg-muted/50" : ""
                      }`}
                      onClick={hasMetadata ? () => toggleExpanded(log.id) : undefined}
                    >
                      <span className="text-muted-foreground shrink-0 tabular-nums">
                        {formatTimestamp(log.timestamp)}
                      </span>
                      <Badge
                        variant="outline"
                        className={`${style.bg} ${style.text} text-[10px] py-0 px-1.5 shrink-0 uppercase`}
                      >
                        {log.level}
                      </Badge>
                      <span className="flex-1 break-words">{log.message}</span>
                      {hasMetadata && (
                        isExpanded
                          ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground mt-0.5" />
                          : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground mt-0.5" />
                      )}
                    </div>
                    {isExpanded && hasMetadata && (
                      <pre className="ml-[6.5rem] px-3 py-2 bg-muted rounded text-[11px] text-muted-foreground overflow-x-auto mb-1">
                        {JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
          <span>{logs.length} log entries</span>
          <span>Run {runId.slice(0, 8)}</span>
        </div>
      </div>
    </div>
  );
}
