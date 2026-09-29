/** Analytics — Organization performance analytics driven by Firestore data. */
"use client";

import { useState, useEffect, useMemo } from "react";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/analytics/stat-card";
import { PerformanceTable, PnlDisplay, WinRateBar } from "@/components/analytics/performance-table";
import { Leaderboard } from "@/components/leaderboard";
import { useOrg } from "@/contexts/OrgContext";
import {
  getTasksByOrg,
  getAgentsByOrg,
  getJobsByOrg,
  type Task,
  type Agent,
  type Job,
} from "@/lib/firestore";
import { cn } from "@/lib/utils";
import SpotlightCard from "@/components/reactbits/SpotlightCard";

// ─── Types ───────────────────────────────────────────────

interface AgentPerformance {
  agentId: string;
  name: string;
  type: string;
  winRate: number;
  totalPredictions: number;
  wins: number;
  losses: number;
  pending: number;
  pnl: number;
  streak: number;
}

// ─── Page ────────────────────────────────────────────────

export default function AnalyticsPage() {
  const { currentOrg } = useOrg();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg) {
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      getTasksByOrg(currentOrg.id),
      getAgentsByOrg(currentOrg.id),
      getJobsByOrg(currentOrg.id),
    ]).then(([t, a, j]) => {
      setTasks(t);
      setAgents(a);
      setJobs(j);
    }).catch(console.error).finally(() => setLoading(false));
  }, [currentOrg]);

  // ── Computed stats ──

  const stats = useMemo(() => {
    const doneTasks = tasks.filter(t => t.status === "done").length;
    const inProgress = tasks.filter(t => t.status === "in_progress").length;
    const total = tasks.length;
    const completionRate = total > 0 ? Math.round((doneTasks / total) * 100 * 10) / 10 : 0;

    const completedJobs = jobs.filter(j => j.status === "completed").length;
    const totalJobs = jobs.length;

    const onlineAgents = agents.filter(a => a.status === "online").length;
    const busyAgents = agents.filter(a => a.status === "busy").length;

    const totalReward = jobs.reduce((sum, j) => sum + (parseFloat(j.reward || "0") || 0), 0);

    return {
      totalTasks: total,
      doneTasks,
      inProgress,
      completionRate,
      totalJobs,
      completedJobs,
      onlineAgents,
      busyAgents,
      totalAgents: agents.length,
      totalReward,
    };
  }, [tasks, agents, jobs]);

  const agentPerfData = useMemo<AgentPerformance[]>(() => {
    return agents.map(agent => {
      const agentTasks = tasks.filter(t => t.assigneeAgentId === agent.id);
      const wins = agentTasks.filter(t => t.status === "done").length;
      const losses = 0;
      const pending = agentTasks.filter(t => t.status === "in_progress").length;
      const total = agentTasks.length;
      const winRate = total > 0 ? (wins / total) * 100 : 0;

      const agentJobs = jobs.filter(j => j.takenByAgentId === agent.id);
      const pnl = agentJobs.reduce((sum, j) => sum + (parseFloat(j.reward || "0") || 0), 0);

      return {
        agentId: agent.id,
        name: agent.name,
        type: agent.type,
        winRate: Math.round(winRate * 10) / 10,
        totalPredictions: total,
        wins,
        losses,
        pending,
        pnl,
        streak: 0,
      };
    });
  }, [agents, tasks, jobs]);

  // ── Column definitions ──

  const agentColumns = useMemo(() => [
    {
      key: "name",
      label: "Agent",
      render: (a: AgentPerformance) => (
        <div className="min-w-0">
          <span className="font-medium truncate block">{a.name}</span>
          <span className="text-xs text-muted-foreground">{a.type}</span>
        </div>
      ),
    },
    {
      key: "winRate",
      label: "Completion Rate",
      sortable: true,
      getValue: (a: AgentPerformance) => a.winRate,
      render: (a: AgentPerformance) => <WinRateBar rate={a.winRate} />,
    },
    {
      key: "pnl",
      label: "Value",
      sortable: true,
      getValue: (a: AgentPerformance) => a.pnl,
      render: (a: AgentPerformance) => <PnlDisplay value={a.pnl} />,
    },
    {
      key: "tasks",
      label: "Tasks",
      sortable: true,
      getValue: (a: AgentPerformance) => a.totalPredictions,
      render: (a: AgentPerformance) => (
        <div className="text-sm">
          <span className="font-medium">{a.totalPredictions}</span>
          <span className="text-muted-foreground ml-1 text-xs">
            ({a.wins} done / {a.pending} active)
          </span>
        </div>
      ),
    },
  ], []);

  // ── Render ──

  if (!currentOrg) {
    return (
      <div className="space-y-6">
        <p className="text-muted-foreground mt-1">No organization selected</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading analytics...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Overview Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Total Tasks" value={stats.totalTasks.toLocaleString()} icon="📋" />
        <StatCard title="Completion Rate" value={`${stats.completionRate}%`} icon="🎯" />
        <StatCard title="Total Jobs" value={stats.totalJobs.toLocaleString()} icon="💼" />
        <StatCard title="Active Agents" value={`${stats.onlineAgents + stats.busyAgents} / ${stats.totalAgents}`} icon="🤖" />
      </div>

      {/* Task Breakdown */}
      <div className="grid gap-4 md:grid-cols-3">
        {[
          { label: "To Do", value: tasks.filter(t => t.status === "todo").length, color: "text-muted-foreground", bg: "bg-muted/50" },
          { label: "In Progress", value: stats.inProgress, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10" },
          { label: "Done", value: stats.doneTasks, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10" },
        ].map(s => (
          <SpotlightCard key={s.label} className="p-4" spotlightColor="rgba(255, 191, 0, 0.06)">
            <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
            <p className={cn("text-2xl font-bold", s.color)}>{s.value}</p>
          </SpotlightCard>
        ))}
      </div>

      {/* Agent Performance + Leaderboard */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SpotlightCard className="p-0 overflow-hidden" spotlightColor="rgba(255, 191, 0, 0.06)">
            <CardHeader>
              <CardTitle className="text-lg">🤖 Agent Performance</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {agentPerfData.length > 0 ? (
                <PerformanceTable
                  data={agentPerfData}
                  columns={agentColumns}
                  defaultSortKey="pnl"
                />
              ) : (
                <p className="text-sm text-muted-foreground text-center py-8">No agent data available</p>
              )}
            </CardContent>
          </SpotlightCard>
        </div>
        <Leaderboard agents={agentPerfData} />
      </div>

      {/* Job Summary */}
      {stats.totalJobs > 0 && (
        <SpotlightCard className="p-0 overflow-hidden" spotlightColor="rgba(255, 191, 0, 0.06)">
          <CardHeader>
            <CardTitle className="text-lg">💼 Job Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              {[
                { label: "Open", value: jobs.filter(j => j.status === "open").length, icon: "📢" },
                { label: "In Progress", value: jobs.filter(j => j.status === "in_progress").length, icon: "🔄" },
                { label: "Completed", value: stats.completedJobs, icon: "✅" },
              ].map(s => (
                <div key={s.label} className="border rounded-lg p-4 hover:bg-muted transition-colors">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xl">{s.icon}</span>
                    <span className="font-semibold">{s.label}</span>
                  </div>
                  <p className="text-2xl font-bold">{s.value}</p>
                </div>
              ))}
            </div>
            {stats.totalReward > 0 && (
              <div className="mt-4 pt-4 border-t border-border flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Total job value:</span>
                <span className="font-semibold text-amber-600 dark:text-amber-400">${stats.totalReward.toLocaleString()}</span>
              </div>
            )}
          </CardContent>
        </SpotlightCard>
      )}
    </div>
  );
}
