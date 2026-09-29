"use client";

import { useState, use } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  Network, Cpu, HardDrive, Activity, Clock, ArrowLeft, RefreshCw,
  Loader2, Play, Pause, Trash2, ChevronRight,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/contexts/OrgContext";
import { useAuthAddress } from "@/hooks/useAuthAddress";
import { JobLogsViewer } from "@/components/job-logs-viewer";
import { JobDispatchForm } from "@/components/job-dispatch-form";

interface WorkerDetail {
  id: string;
  name: string;
  orgId: string;
  status: string;
  region?: string;
  ipAddress?: string;
  resources: {
    maxCpuCores: number;
    maxMemoryMb: number;
    maxConcurrent: number;
    cpuUsagePercent?: number;
    memoryUsageMb?: number;
    activeTasks: number;
  };
  capabilities: {
    taskTypes: string[];
    runtimes: string[];
    tags: string[];
  };
  lastHeartbeat?: { seconds: number };
  registeredAt?: { seconds: number };
}

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

const STATUS_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  idle: { label: "Idle", color: "text-emerald-400", dot: "bg-emerald-400" },
  busy: { label: "Busy", color: "text-blue-400", dot: "bg-blue-400 animate-pulse" },
  draining: { label: "Draining", color: "text-amber-400", dot: "bg-amber-400" },
  offline: { label: "Offline", color: "text-zinc-400", dot: "bg-zinc-500" },
};

const JOB_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  queued: { label: "Queued", color: "text-zinc-400" },
  claimed: { label: "Claimed", color: "text-blue-300" },
  running: { label: "Running", color: "text-blue-400" },
  completed: { label: "Completed", color: "text-emerald-400" },
  failed: { label: "Failed", color: "text-red-400" },
  timeout: { label: "Timeout", color: "text-amber-400" },
  cancelled: { label: "Cancelled", color: "text-zinc-500" },
};

function timeAgo(ts: { seconds: number } | undefined): string {
  if (!ts) return "never";
  const sec = Math.round((Date.now() / 1000) - ts.seconds);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export default function GatewayDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: workerId } = use(params);
  const { currentOrg } = useOrg();
  const authAddress = useAuthAddress();
  const router = useRouter();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [showDispatch, setShowDispatch] = useState(false);

  const { data, isLoading: loading, refetch: load } = useQuery({
    queryKey: ["gateway-worker", workerId, currentOrg?.id, authAddress],
    queryFn: async () => {
      // Fetch worker details
      const wResp = await fetch(`/api/gateway/workers/${workerId}`, {
        headers: { "x-wallet-address": authAddress || "" },
      });
      let worker: WorkerDetail | null = null;
      if (wResp.ok) {
        const wData = await wResp.json();
        worker = wData.worker || wData;
      }

      // Fetch jobs for this org
      const jResp = await fetch(`/api/gateway/jobs?orgId=${currentOrg!.id}`, {
        headers: { "x-wallet-address": authAddress || "" },
      });
      let jobs: JobItem[] = [];
      if (jResp.ok) {
        const jData = await jResp.json();
        // Filter to jobs claimed by this worker
        const allJobs = (jData.jobs || []) as JobItem[];
        jobs = allJobs.filter((j: JobItem) => j.claimedBy === workerId || !j.claimedBy);
      }

      return { worker, jobs };
    },
    enabled: !!currentOrg,
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
  });
  const worker = data?.worker ?? null;
  const jobs = data?.jobs ?? [];

  if (!authAddress) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-muted-foreground">
        <Network className="h-12 w-12 opacity-30" />
        <p>Connect your wallet to view gateway details</p>
      </div>
    );
  }

  if (loading && !worker) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
      </div>
    );
  }

  if (!worker) {
    return (
      <div className="max-w-[900px] mx-auto px-4 py-8">
        <Button variant="ghost" size="sm" onClick={() => router.push("/gateways")} className="mb-4">
          <ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Back to Gateways
        </Button>
        <Card className="p-12 text-center">
          <Network className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
          <h3 className="text-sm font-semibold mb-1">Gateway not found</h3>
          <p className="text-xs text-muted-foreground">Worker ID: {workerId}</p>
        </Card>
      </div>
    );
  }

  const statusCfg = STATUS_CONFIG[worker.status] || STATUS_CONFIG.offline;
  const activeJobs = jobs.filter((j) => j.status === "running" || j.status === "claimed");
  const historyJobs = jobs.filter((j) => j.status === "completed" || j.status === "failed" || j.status === "timeout");

  return (
    <div className="max-w-[1100px] mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <Button variant="ghost" size="sm" onClick={() => router.push("/gateways")}>
          <ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Gateways
        </Button>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-medium">{worker.name}</span>
      </div>

      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-teal-500/10 border border-teal-500/20">
              <Network className="h-5 w-5 text-teal-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                {worker.name}
                <Badge variant="outline" className={`text-[10px] ${statusCfg.color}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${statusCfg.dot} mr-1`} />
                  {statusCfg.label}
                </Badge>
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                {worker.region || "auto"} &middot; {worker.ipAddress || "unknown"} &middot; ID: {worker.id}
              </p>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => load()}>
            <RefreshCw className="h-3 w-3 mr-1.5" /> Refresh
          </Button>
          <Button size="sm" className="bg-teal-500 hover:bg-teal-600 text-white" onClick={() => setShowDispatch(true)}>
            <Play className="h-3 w-3 mr-1.5" /> Dispatch Job
          </Button>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <Card className="p-3 bg-card/80 border-border">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Cpu className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wider">CPU</span>
          </div>
          <p className="text-lg font-semibold">{worker.resources.cpuUsagePercent ?? 0}%</p>
          <p className="text-[10px] text-muted-foreground">{worker.resources.maxCpuCores} cores</p>
        </Card>
        <Card className="p-3 bg-card/80 border-border">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <HardDrive className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wider">Memory</span>
          </div>
          <p className="text-lg font-semibold">{worker.resources.memoryUsageMb ?? 0} MB</p>
          <p className="text-[10px] text-muted-foreground">of {worker.resources.maxMemoryMb} MB</p>
        </Card>
        <Card className="p-3 bg-card/80 border-border">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Activity className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wider">Tasks</span>
          </div>
          <p className="text-lg font-semibold">{worker.resources.activeTasks}/{worker.resources.maxConcurrent}</p>
          <p className="text-[10px] text-muted-foreground">active / max</p>
        </Card>
        <Card className="p-3 bg-card/80 border-border">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Clock className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wider">Heartbeat</span>
          </div>
          <p className="text-lg font-semibold">{timeAgo(worker.lastHeartbeat)}</p>
          <p className="text-[10px] text-muted-foreground">registered {timeAgo(worker.registeredAt)}</p>
        </Card>
      </div>

      {/* Capabilities */}
      <Card className="p-4 bg-card/80 border-border mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Capabilities</h3>
        <div className="flex flex-wrap gap-2">
          {worker.capabilities.taskTypes.map((t) => (
            <Badge key={`type-${t}`} variant="outline" className="text-[10px]">type: {t}</Badge>
          ))}
          {worker.capabilities.runtimes.map((r) => (
            <Badge key={`rt-${r}`} variant="outline" className="text-[10px] border-blue-500/30 text-blue-400">runtime: {r}</Badge>
          ))}
          {worker.capabilities.tags.map((tag) => (
            <Badge key={`tag-${tag}`} variant="outline" className="text-[10px] border-amber-500/30 text-amber-400">tag: {tag}</Badge>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-6">
        {/* Active Jobs */}
        <div>
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-blue-400" />
            Active Jobs ({activeJobs.length})
          </h3>
          {activeJobs.length === 0 ? (
            <Card className="p-6 bg-card/80 border-border text-center">
              <p className="text-xs text-muted-foreground">No active jobs</p>
            </Card>
          ) : (
            <div className="space-y-2">
              {activeJobs.map((job) => {
                const jCfg = JOB_STATUS_CONFIG[job.status] || JOB_STATUS_CONFIG.queued;
                return (
                  <Card
                    key={job.id}
                    className="p-3 bg-card/80 border-border hover:border-teal-500/20 cursor-pointer transition-colors"
                    onClick={() => setSelectedJobId(job.id === selectedJobId ? null : job.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[9px]">{job.taskType}</Badge>
                          <span className={`text-[10px] ${jCfg.color}`}>{jCfg.label}</span>
                        </div>
                        <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{job.id}</p>
                      </div>
                      <Badge variant="outline" className="text-[9px]">{job.priority}</Badge>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* Job History */}
        <div>
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-zinc-400" />
            Job History ({historyJobs.length})
          </h3>
          {historyJobs.length === 0 ? (
            <Card className="p-6 bg-card/80 border-border text-center">
              <p className="text-xs text-muted-foreground">No completed jobs</p>
            </Card>
          ) : (
            <div className="space-y-2 max-h-[400px] overflow-auto">
              {historyJobs.slice(0, 20).map((job) => {
                const jCfg = JOB_STATUS_CONFIG[job.status] || JOB_STATUS_CONFIG.queued;
                return (
                  <Card
                    key={job.id}
                    className="p-3 bg-card/80 border-border hover:border-teal-500/20 cursor-pointer transition-colors"
                    onClick={() => setSelectedJobId(job.id === selectedJobId ? null : job.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[9px]">{job.taskType}</Badge>
                          <span className={`text-[10px] ${jCfg.color}`}>{jCfg.label}</span>
                          {job.retriesUsed > 0 && (
                            <span className="text-[9px] text-amber-400">retry {job.retriesUsed}/{job.maxRetries}</span>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{job.id}</p>
                        {job.error && (
                          <p className="text-[10px] text-red-400/80 mt-0.5 truncate max-w-[300px]">{job.error}</p>
                        )}
                      </div>
                      <span className="text-[9px] text-muted-foreground">{timeAgo(job.completedAt)}</span>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Log Viewer */}
      {selectedJobId && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold mb-3">
            Job Logs — <span className="font-mono text-muted-foreground text-xs">{selectedJobId}</span>
          </h3>
          <div className="h-[400px]">
            <JobLogsViewer jobId={selectedJobId} />
          </div>
        </div>
      )}

      {/* Dispatch Dialog */}
      {currentOrg && (
        <JobDispatchForm
          orgId={currentOrg.id}
          open={showDispatch}
          onOpenChange={setShowDispatch}
          onDispatched={(taskId) => {
            setSelectedJobId(taskId);
            load();
          }}
        />
      )}
    </div>
  );
}
