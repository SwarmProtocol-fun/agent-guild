/** Gateways — Connect and manage remote execution gateways for distributed agent deployment. */
"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Network, Plus, Trash2, Loader2, RefreshCw, Play,
  Cpu, HardDrive, Activity, ChevronRight, BarChart3,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useOrg } from "@/contexts/OrgContext";
import { useAuthAddress } from "@/hooks/useAuthAddress";
import { JobDispatchForm } from "@/components/job-dispatch-form";
import {
  type Gateway,
  GATEWAY_STATUS,
  getGateways,
  addGateway,
  deleteGateway,
} from "@/lib/gateways";

interface Worker {
  id: string;
  name: string;
  status: string;
  region?: string;
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
}

interface QueueStats {
  queue: { queued: number; claimed: number; running: number; completed: number; failed: number };
  workers: { total: number; idle: number; busy: number; draining: number; offline: number };
}

const WORKER_STATUS: Record<string, { label: string; color: string; dot: string }> = {
  idle: { label: "Idle", color: "text-emerald-400", dot: "bg-emerald-400" },
  busy: { label: "Busy", color: "text-blue-400", dot: "bg-blue-400 animate-pulse" },
  draining: { label: "Draining", color: "text-amber-400", dot: "bg-amber-400" },
  offline: { label: "Offline", color: "text-zinc-400", dot: "bg-zinc-500" },
};

function timeAgo(d: Date | null): string {
  if (!d) return "never";
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function tsAgo(ts: { seconds: number } | undefined): string {
  if (!ts) return "never";
  const sec = Math.round((Date.now() / 1000) - ts.seconds);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export default function GatewaysPage() {
  const { currentOrg } = useOrg();
  const authAddress = useAuthAddress();
  const router = useRouter();
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showDispatch, setShowDispatch] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    try {
      setLoading(true);
      // Fetch legacy gateways, runtime workers, and queue stats in parallel
      const [gws, workersResp, statsResp] = await Promise.all([
        getGateways(currentOrg.id),
        fetch(`/api/gateway/workers?orgId=${currentOrg.id}`, {
          headers: { "x-wallet-address": authAddress || "" },
        }),
        fetch(`/api/gateway/stats?orgId=${currentOrg.id}`, {
          headers: { "x-wallet-address": authAddress || "" },
        }),
      ]);
      setGateways(gws);
      if (workersResp.ok) {
        const wd = await workersResp.json();
        setWorkers(wd.workers || []);
      }
      if (statsResp.ok) {
        const sd = await statsResp.json();
        setStats({ queue: sd.queue, workers: sd.workers });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [currentOrg, authAddress]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newName.trim() || !newUrl.trim() || !currentOrg) return;
    setAdding(true);
    try {
      await addGateway({ orgId: currentOrg.id, name: newName.trim(), url: newUrl.trim(), status: "disconnected", agentsConnected: 0 });
      setNewName(""); setNewUrl(""); setShowAdd(false);
      await load();
    } catch (err) { console.error(err); }
    finally { setAdding(false); }
  };

  const handleDelete = async (id: string) => {
    try { await deleteGateway(id); setGateways(prev => prev.filter(g => g.id !== id)); }
    catch (err) { console.error(err); }
  };

  if (!authAddress) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-muted-foreground">
        <Network className="h-12 w-12 opacity-30" /><p>Connect your wallet to manage gateways</p>
      </div>
    );
  }

  return (
    <div className="max-w-[1100px] mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <div className="p-2 rounded-xl bg-teal-500/10 border border-teal-500/20">
              <Network className="h-6 w-6 text-teal-500" />
            </div>
            Gateways
          </h1>
          <p className="text-sm text-muted-foreground mt-2">Manage runtime workers and remote execution gateways</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={load}>
            <RefreshCw className="h-3 w-3 mr-1.5" /> Refresh
          </Button>
          {currentOrg && (
            <Button size="sm" className="gap-1.5 bg-teal-500 hover:bg-teal-600 text-white" onClick={() => setShowDispatch(true)}>
              <Play className="h-3 w-3" /> Dispatch Job
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setShowAdd(true)} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Add Gateway
          </Button>
        </div>
      </div>

      {/* Queue Stats Banner */}
      {stats && (
        <div className="grid grid-cols-5 gap-3 mb-6">
          <Card className="p-3 bg-card/80 border-border">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <BarChart3 className="h-3.5 w-3.5" />
              <span className="text-[10px] uppercase tracking-wider">Queued</span>
            </div>
            <p className="text-lg font-semibold">{stats.queue.queued}</p>
          </Card>
          <Card className="p-3 bg-card/80 border-border">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Activity className="h-3.5 w-3.5" />
              <span className="text-[10px] uppercase tracking-wider">Running</span>
            </div>
            <p className="text-lg font-semibold">{stats.queue.running + stats.queue.claimed}</p>
          </Card>
          <Card className="p-3 bg-card/80 border-border">
            <div className="flex items-center gap-2 text-emerald-400/70 mb-1">
              <Cpu className="h-3.5 w-3.5" />
              <span className="text-[10px] uppercase tracking-wider">Workers</span>
            </div>
            <p className="text-lg font-semibold">{stats.workers.total}</p>
            <p className="text-[10px] text-muted-foreground">{stats.workers.idle} idle / {stats.workers.busy} busy</p>
          </Card>
          <Card className="p-3 bg-card/80 border-border">
            <div className="flex items-center gap-2 text-emerald-400/70 mb-1">
              <HardDrive className="h-3.5 w-3.5" />
              <span className="text-[10px] uppercase tracking-wider">Completed</span>
            </div>
            <p className="text-lg font-semibold">{stats.queue.completed}</p>
          </Card>
          <Card className="p-3 bg-card/80 border-border">
            <div className="flex items-center gap-2 text-red-400/70 mb-1">
              <Activity className="h-3.5 w-3.5" />
              <span className="text-[10px] uppercase tracking-wider">Failed</span>
            </div>
            <p className="text-lg font-semibold">{stats.queue.failed}</p>
          </Card>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-teal-500" /></div>
      ) : (
        <>
          {/* Runtime Workers */}
          {workers.length > 0 && (
            <div className="mb-8">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                <Cpu className="h-3.5 w-3.5" /> Runtime Workers ({workers.length})
              </h2>
              <div className="space-y-2">
                {workers.map((w) => {
                  const cfg = WORKER_STATUS[w.status] || WORKER_STATUS.offline;
                  return (
                    <Card
                      key={w.id}
                      className="p-4 bg-card/80 border-border hover:border-teal-500/20 transition-colors cursor-pointer"
                      onClick={() => router.push(`/gateways/${w.id}`)}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-2.5 h-2.5 rounded-full ${cfg.dot}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium">{w.name}</p>
                            <Badge variant="outline" className={`text-[9px] ${cfg.color}`}>{cfg.label}</Badge>
                            {w.region && (
                              <Badge variant="outline" className="text-[9px] text-muted-foreground">{w.region}</Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-1">
                            <span className="text-[10px] text-muted-foreground">
                              CPU: {w.resources.cpuUsagePercent ?? 0}% ({w.resources.maxCpuCores} cores)
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              Mem: {w.resources.memoryUsageMb ?? 0}/{w.resources.maxMemoryMb} MB
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              Tasks: {w.resources.activeTasks}/{w.resources.maxConcurrent}
                            </span>
                          </div>
                          <div className="flex gap-1 mt-1.5">
                            {w.capabilities.taskTypes.map((t) => (
                              <Badge key={t} variant="outline" className="text-[8px] py-0 px-1">{t}</Badge>
                            ))}
                            {w.capabilities.runtimes.map((r) => (
                              <Badge key={r} variant="outline" className="text-[8px] py-0 px-1 border-blue-500/30 text-blue-400">{r}</Badge>
                            ))}
                          </div>
                        </div>
                        <div className="text-right shrink-0 mr-1">
                          <p className="text-[10px] text-muted-foreground">Heartbeat {tsAgo(w.lastHeartbeat)}</p>
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          {/* Legacy Gateways */}
          {gateways.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                <Network className="h-3.5 w-3.5" /> URL Gateways ({gateways.length})
              </h2>
              <div className="space-y-2">
                {gateways.map(gw => {
                  const cfg = GATEWAY_STATUS[gw.status];
                  return (
                    <Card key={gw.id} className="p-4 bg-card/80 border-border hover:border-teal-500/20 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className={`w-2.5 h-2.5 rounded-full ${cfg.dot} animate-pulse`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium">{gw.name}</p>
                            <Badge variant="outline" className={`text-[9px] ${cfg.color}`}>{cfg.label}</Badge>
                          </div>
                          <p className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">{gw.url}</p>
                        </div>
                        <div className="text-right shrink-0 mr-2">
                          <p className="text-xs">{gw.agentsConnected} agents</p>
                          <p className="text-[9px] text-muted-foreground">Pinged {timeAgo(gw.lastPing)}</p>
                        </div>
                        <button onClick={() => handleDelete(gw.id)} className="p-1.5 text-muted-foreground hover:text-red-400 transition-colors">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          {/* Empty state */}
          {workers.length === 0 && gateways.length === 0 && (
            <Card className="p-12 bg-card/80 border-border text-center">
              <Network className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
              <h3 className="text-sm font-semibold mb-1">No gateways connected</h3>
              <p className="text-xs text-muted-foreground mb-4">
                Register a runtime worker with the Gateway Agent CLI or add a URL gateway
              </p>
              <code className="text-[10px] bg-muted/50 px-3 py-1.5 rounded font-mono text-muted-foreground">
                npx @swarmprotocol/gateway-agent register --org {currentOrg?.id || "<orgId>"}
              </code>
            </Card>
          )}
        </>
      )}

      {/* Add Gateway Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Gateway</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <Input placeholder="Gateway Name" value={newName} onChange={e => setNewName(e.target.value)} />
            <Input placeholder="Gateway URL (https://...)" value={newUrl} onChange={e => setNewUrl(e.target.value)} />
          </div>
          <DialogFooter>
            <Button onClick={handleAdd} disabled={adding || !newName.trim() || !newUrl.trim()}>
              {adding ? "Connecting..." : "Connect Gateway"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dispatch Job Dialog */}
      {currentOrg && (
        <JobDispatchForm
          orgId={currentOrg.id}
          open={showDispatch}
          onOpenChange={setShowDispatch}
          onDispatched={() => load()}
        />
      )}
    </div>
  );
}
