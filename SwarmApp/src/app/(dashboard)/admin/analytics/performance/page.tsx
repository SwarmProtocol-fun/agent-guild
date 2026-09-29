"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Activity, Users, Zap, GitBranch, UserCheck, Share2, Loader2, RefreshCw,
  ShieldAlert, Trophy, CircleDot, Radio, KeyRound, Fingerprint, Router,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, AreaChart, Area,
} from "recharts";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";
import { useChartPalette } from "@/components/charts/chart-theme";
import { ChartTooltip } from "@/components/charts/chart-tooltip";
import type { AgentPerformanceOverview } from "@/lib/agent-performance-analytics";

export default function AgentPerformancePage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);
  const palette = useChartPalette();

  const [overview, setOverview] = useState<AgentPerformanceOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/analytics/performance");
      if (res.ok) {
        const d = await res.json();
        setOverview(d.overview);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) fetchData();
  }, [isAdmin, fetchData]);

  if (!authenticated) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-muted-foreground">Connect your wallet to continue.</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
        <ShieldAlert className="h-12 w-12 text-red-400" />
        <h2 className="text-lg font-semibold">Access Denied</h2>
        <p className="text-sm text-muted-foreground">Platform admin wallet required.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Activity className="h-6 w-6 text-cyan-400" />
          <h1 className="text-2xl font-bold">Agent & Swarm Performance</h1>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {loading && !overview ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : overview ? (
        <>
          {/* Agent health */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Agent Health</h3>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <StatCard icon={Users} label="Total Agents" value={overview.agents.total} />
              <StatCard icon={CircleDot} label="Online" value={overview.agents.online} accent="green" />
              <StatCard icon={CircleDot} label="Degraded" value={overview.agents.degraded} accent={overview.agents.degraded > 0 ? "amber" : undefined} />
              <StatCard icon={CircleDot} label="Offline" value={overview.agents.offline} accent={overview.agents.offline > 0 ? "red" : undefined} />
              <StatCard icon={CircleDot} label="Paused" value={overview.agents.paused} />
            </div>
          </div>

          {/* Success rates */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Success Rates — Last {overview.periodDays} Days
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <RateCard
                icon={Zap}
                title="Gateway Jobs"
                rate={overview.jobs.successRate}
                completed={overview.jobs.completed}
                failed={overview.jobs.failed}
                active={overview.jobs.active}
              />
              <RateCard
                icon={GitBranch}
                title="Workflow Runs"
                rate={overview.workflows.successRate}
                completed={overview.workflows.completed}
                failed={overview.workflows.failed}
                active={overview.workflows.active}
              />
              <RateCard
                icon={UserCheck}
                title="Task Assignments"
                rate={overview.taskAssignments.successRate}
                completed={overview.taskAssignments.completed}
                failed={overview.taskAssignments.failed}
                active={overview.taskAssignments.active}
              />
              <RateCard
                icon={Share2}
                title="Delegations"
                rate={overview.delegations.successRate}
                completed={overview.delegations.completed}
                failed={overview.delegations.failed}
                active={overview.delegations.active}
              />
            </div>
          </div>

          {/* Throughput chart */}
          {overview.dailyThroughput.length > 0 && (
            <div className="rounded-xl border border-border bg-card/50 p-4">
              <h3 className="text-sm font-medium mb-4">Swarm Throughput — Completed per Day</h3>
              <div style={{ width: "100%", height: 260 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={overview.dailyThroughput}
                    margin={{ top: 8, right: 8, bottom: 0, left: -20 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke={palette.grid} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: palette.muted }}
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: palette.muted }}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip content={<ChartTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="jobs" name="Jobs" stackId="a" fill={palette.primary} radius={[0, 0, 0, 0]} />
                    <Bar dataKey="workflows" name="Workflows" stackId="a" fill={palette.secondary} />
                    <Bar dataKey="assignments" name="Assignments" stackId="a" fill={palette.accent} radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Agent API calls */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Agent API Calls — Last {overview.apiCalls.periodDays} Days
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
              <StatCard icon={Radio} label="Total Calls" value={overview.apiCalls.total} />
              <StatCard
                icon={Fingerprint}
                label="Ed25519 Signed"
                value={overview.apiCalls.byAuthMethod.ed25519 || 0}
              />
              <StatCard
                icon={KeyRound}
                label="API Key"
                value={overview.apiCalls.byAuthMethod.apikey || 0}
              />
              <StatCard
                icon={Router}
                label="Gateway Workers"
                value={overview.apiCalls.byAuthMethod.gateway || 0}
              />
            </div>
            {overview.apiCalls.dailyVolume.some((d) => d.count > 0) && (
              <div className="rounded-xl border border-border bg-card/50 p-4 mb-3">
                <h4 className="text-xs font-medium text-muted-foreground mb-3">Calls per Day</h4>
                <div style={{ width: "100%", height: 200 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={overview.apiCalls.dailyVolume}
                      margin={{ top: 8, right: 8, bottom: 0, left: -20 }}
                    >
                      <defs>
                        <linearGradient id="gradCalls" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={palette.accent} stopOpacity={0.3} />
                          <stop offset="100%" stopColor={palette.accent} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={palette.grid} />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: palette.muted }}
                        tickLine={false}
                        axisLine={false}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: palette.muted }}
                        tickLine={false}
                        axisLine={false}
                        allowDecimals={false}
                      />
                      <Tooltip content={<ChartTooltip />} />
                      <Area
                        type="monotone"
                        dataKey="count"
                        name="Calls"
                        stroke={palette.accent}
                        strokeWidth={2}
                        fill="url(#gradCalls)"
                        dot={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
            {overview.apiCalls.topAgents.length > 0 && (
              <div className="rounded-xl border border-border bg-card/50 p-4">
                <h4 className="text-xs font-medium text-muted-foreground mb-3">Most Active Agents</h4>
                <div className="space-y-1.5">
                  {overview.apiCalls.topAgents.map((a, i) => (
                    <div key={a.agentId} className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-black/10 text-sm">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-xs text-muted-foreground w-5 shrink-0">#{i + 1}</span>
                        <span className="font-mono truncate">{a.agentId}</span>
                        <span className="text-xs text-muted-foreground font-mono truncate">{a.orgId}</span>
                      </div>
                      <span className="font-semibold shrink-0">{a.count} calls</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Top agents */}
          <div className="rounded-xl border border-border bg-card/50 p-4">
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <Trophy className="h-4 w-4 text-amber-400" />
              Top Agents by Tasks Completed
            </h3>
            {overview.topAgents.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No agent activity yet.</p>
            ) : (
              <div className="space-y-1.5">
                {overview.topAgents.map((agent, i) => (
                  <div
                    key={agent.agentId}
                    className="flex items-center justify-between px-3 py-2 rounded-lg bg-black/10"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-xs text-muted-foreground w-5 shrink-0">#{i + 1}</span>
                      <span className="font-medium truncate">{agent.name}</span>
                      <span className="text-xs text-muted-foreground font-mono truncate">
                        {agent.orgId}
                      </span>
                    </div>
                    <span className="text-sm font-semibold shrink-0">{agent.tasksCompleted}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="text-center py-24 text-muted-foreground">
          <p>No performance data available yet.</p>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof Users;
  label: string;
  value: number | string;
  accent?: "green" | "amber" | "red";
}) {
  const accentStyles: Record<string, { border: string; bg: string; text: string; icon: string }> = {
    green: { border: "border-emerald-500/30", bg: "bg-emerald-500/5", text: "text-emerald-400", icon: "text-emerald-400" },
    amber: { border: "border-amber-500/30", bg: "bg-amber-500/5", text: "text-amber-400", icon: "text-amber-400" },
    red: { border: "border-red-500/30", bg: "bg-red-500/5", text: "text-red-400", icon: "text-red-400" },
  };
  const s = accent ? accentStyles[accent] : null;

  return (
    <div className={`rounded-xl border p-3 ${s ? `${s.border} ${s.bg}` : "border-border bg-card/50"}`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${s ? s.icon : "text-muted-foreground"}`} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={`text-2xl font-bold mt-1 ${s ? s.text : ""}`}>{value}</p>
    </div>
  );
}

function RateCard({
  icon: Icon,
  title,
  rate,
  completed,
  failed,
  active,
}: {
  icon: typeof Users;
  title: string;
  rate: number;
  completed: number;
  failed: number;
  active: number;
}) {
  const color = rate >= 90 ? "text-emerald-400" : rate >= 70 ? "text-amber-400" : failed + completed > 0 ? "text-red-400" : "text-muted-foreground";

  return (
    <div className="rounded-xl border border-border bg-card/50 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{title}</span>
      </div>
      <p className={`text-3xl font-bold ${color}`}>{completed + failed > 0 ? `${rate}%` : "—"}</p>
      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
        <span className="text-emerald-400">{completed} done</span>
        <span className="text-red-400">{failed} failed</span>
        <span>{active} active</span>
      </div>
    </div>
  );
}
