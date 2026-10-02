/** Logs — Org-wide view of gateway job logs, with live streaming per job. */
"use client";

import { useState, useCallback, useEffect } from "react";
import { FileText, Loader2, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/contexts/OrgContext";
import { useAuthAddress } from "@/hooks/useAuthAddress";
import { JobLogsViewer } from "@/components/job-logs-viewer";

interface JobItem {
  id: string;
  taskType: string;
  status: string;
  priority: string;
  claimedBy?: string;
  createdAt?: { seconds: number };
  completedAt?: { seconds: number };
  error?: string;
  retriesUsed: number;
  maxRetries: number;
}

const JOB_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  queued: { label: "Queued", color: "text-zinc-400" },
  claimed: { label: "Claimed", color: "text-blue-300" },
  running: { label: "Running", color: "text-blue-400" },
  completed: { label: "Completed", color: "text-emerald-400" },
  failed: { label: "Failed", color: "text-red-400" },
  timeout: { label: "Timeout", color: "text-amber-400" },
  cancelled: { label: "Cancelled", color: "text-zinc-500" },
};

const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "queued", label: "Queued" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

function timeAgo(ts: { seconds: number } | undefined): string {
  if (!ts) return "—";
  const sec = Math.round(Date.now() / 1000 - ts.seconds);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export default function LogsPage() {
  const { currentOrg } = useOrg();
  const authAddress = useAuthAddress();
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    if (!currentOrg) return;
    try {
      setLoading(true);
      const params = new URLSearchParams({ orgId: currentOrg.id, limit: "100" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      const resp = await fetch(`/api/gateway/jobs?${params.toString()}`, {
        headers: { "x-wallet-address": authAddress || "" },
      });
      if (resp.ok) {
        const data = await resp.json();
        setJobs(data.jobs || []);
      }
    } catch (err) {
      console.error("Failed to load jobs:", err);
    } finally {
      setLoading(false);
    }
  }, [currentOrg, statusFilter, authAddress]);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  if (!authAddress) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-muted-foreground">
        <FileText className="h-12 w-12 opacity-30" />
        <p>Connect your wallet to view logs</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20">
              <FileText className="h-6 w-6 text-amber-500" />
            </div>
            Logs
          </h1>
          <p className="text-sm text-muted-foreground mt-2">
            Gateway job output, across every worker in this org
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">{jobs.length} jobs</Badge>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => loadJobs()}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Status Filter */}
      <div className="flex items-center gap-1.5 mb-6">
        {STATUS_FILTERS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
              statusFilter === key
                ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                : "bg-muted/50 text-muted-foreground hover:bg-muted border border-transparent"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Job list */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
        </div>
      ) : jobs.length === 0 ? (
        <Card className="p-12 text-center bg-card border-border border-dashed">
          <FileText className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-semibold mb-2">No jobs yet</h3>
          <p className="text-sm text-muted-foreground">
            Dispatch a gateway job to see its logs here.
          </p>
        </Card>
      ) : (
        <div className="space-y-2 mb-6">
          {jobs.map((job) => {
            const jCfg = JOB_STATUS_CONFIG[job.status] || JOB_STATUS_CONFIG.queued;
            const isSelected = job.id === selectedJobId;
            return (
              <Card
                key={job.id}
                className={`p-3 bg-card/80 border-border hover:border-amber-500/20 cursor-pointer transition-colors ${
                  isSelected ? "border-amber-500/40" : ""
                }`}
                onClick={() => setSelectedJobId(isSelected ? null : job.id)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[9px]">{job.taskType}</Badge>
                      <span className={`text-[10px] ${jCfg.color}`}>{jCfg.label}</span>
                      {job.retriesUsed > 0 && (
                        <span className="text-[9px] text-amber-400">
                          retry {job.retriesUsed}/{job.maxRetries}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{job.id}</p>
                    {job.error && (
                      <p className="text-[10px] text-red-400/80 mt-0.5 truncate max-w-[500px]">{job.error}</p>
                    )}
                  </div>
                  <span className="text-[9px] text-muted-foreground shrink-0">
                    {timeAgo(job.completedAt || job.createdAt)}
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Log Viewer */}
      {selectedJobId && (
        <div>
          <h3 className="text-sm font-semibold mb-3">
            Job Logs — <span className="font-mono text-muted-foreground text-xs">{selectedJobId}</span>
          </h3>
          <div className="h-[400px]">
            <JobLogsViewer jobId={selectedJobId} />
          </div>
        </div>
      )}
    </div>
  );
}
