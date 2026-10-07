/** Dashboard — the guild command center: what needs you today, what's moving, who to hire, and how it's trending. */
'use client';

import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import Link from "next/link";
import dynamic from "next/dynamic";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useOrg } from "@/contexts/OrgContext";
import { VitalsWidget } from "@/components/vitals-widget";
import { useWalletAccount } from "@/lib/wallet";
import { useSession } from "@/contexts/SessionContext";
import { RotateCcw, X } from "lucide-react";
import {
  getTasksByOrg,
  getProjectsByOrg,
  getAgentsByOrg,
  getJobsByOrg,
  getOrganization,
  type Task,
  type Agent,
  type Job,
} from "@/lib/firestore";
import { dispatchJob, assignJob } from "@/lib/jobs-client";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { getActivityFeed, type ActivityEvent } from "@/lib/activity";
import { getPendingCount } from "@/lib/approvals";
import type { DispatchPayload } from "@/components/agent-map/agent-map";
import { TaskVelocityChart } from "@/components/charts/task-velocity-chart";
import { CostTrendChart } from "@/components/charts/cost-trend-chart";
import { AgentWorkloadChart } from "@/components/charts/agent-workload-chart";
import { ActivityHeatmapChart } from "@/components/charts/activity-heatmap-chart";
import {
  computeTaskVelocity,
  computeAgentWorkload,
  computeActivityByHour,
} from "@/lib/dashboard-data";
import type { DailyCost } from "@/lib/usage";
import { getNamedCronJob, type CronJob } from "@/lib/cron";
import type { DailySummary } from "@/lib/daily-summary";
import { UsageWidget } from "@/components/usage-widget";
import { LiveFeedWidget } from "@/components/live-feed-widget";
import { CronWidget } from "@/components/cron-widget";
import AgentMessagesWidget from "@/components/agent-messages-widget";
import AgentSessionsWidget from "@/components/agent-sessions-widget";
import CoordinatorDashboardWidget from "@/components/coordinator-dashboard-widget";
import { PromptWidget } from "@/components/prompt-widget";
import { ChannelsWidget } from "@/components/channels-widget";
import {
  DashboardCard,
  NeedsAttentionCard,
  RecentTasksCard,
  RecentJobsCard,
  ActivityFeedCard,
  TopPerformersCard,
  toMillis,
} from "@/components/dashboard/dashboard-cards";
import { DailyBriefingCard } from "@/components/dashboard/daily-briefing-card";
import {
  CommandHero,
  ActionTiles,
  ActiveWorkPanel,
  RecommendedAgentsPanel,
  buildWorkItems,
} from "@/components/dashboard/command-center";

const AgentMap = dynamic(
  () => import('@/components/agent-map/agent-map'),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-96 text-muted-foreground">
        Loading agent map...
      </div>
    ),
  }
);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Section group label — establishes visual hierarchy between curated rows. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 px-0.5 pt-1">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60 shrink-0">
        {children}
      </h2>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  );
}

/** Staggered mount reveal — fires once on first mount only, skipped under reduced motion. */
function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const reduceMotion = useReducedMotion();
  if (reduceMotion) return <div className={className}>{children}</div>;
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: Math.min(delay, 0.5), ease: [0.25, 0.46, 0.45, 0.94] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Placeholder for agent-scoped widgets when the viewer has no registered agent. */
function RegisterAgentCard({ icon, title, what }: { icon: string; title: string; what: string }) {
  return (
    <DashboardCard icon={icon} title={title}>
      <div className="text-center py-4 text-muted-foreground">
        <p className="text-sm">Register as an agent to view {what}</p>
        <Button asChild variant="outline" size="sm" className="mt-2">
          <Link href="/agents">Register Agent</Link>
        </Button>
      </div>
    </DashboardCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function DashboardPage() {
  const { currentOrg } = useOrg();
  const currencySymbol = "$";
  const account = useWalletAccount();
  const { address: sessionAddress, authenticated } = useSession();
  const userAddress = account?.address || sessionAddress || "";
  const [recentTasks, setRecentTasks] = useState<(Task & { agentName?: string; projectName?: string })[]>([]);
  const [recentJobs, setRecentJobs] = useState<Job[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activityAll, setActivityAll] = useState<ActivityEvent[]>([]);
  const [dailyCosts, setDailyCosts] = useState<DailyCost[]>([]);
  const [agentSlots, setAgentSlots] = useState<Record<string, { agentId: string; assignedAt: unknown } | null>>({});
  const [briefingCronJob, setBriefingCronJob] = useState<CronJob | null>(null);
  const [latestBriefing, setLatestBriefing] = useState<DailySummary | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [dashTab, setDashTab] = useState("overview");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Compute analytics data
  const taskVelocity = useMemo(() => computeTaskVelocity(allTasks), [allTasks]);
  const agentWorkload = useMemo(() => computeAgentWorkload(allTasks, agents), [allTasks, agents]);
  const activityHeatmap = useMemo(() => computeActivityByHour(activityAll), [activityAll]);

  // Load dashboard data — extracted so dispatch can refresh
  const loadDashboardData = useCallback(async (isInitial = false) => {
    if (!currentOrg) return;
    try {
      if (isInitial) { setLoading(true); setError(null); }

      const [tasks, projects, agentsData, jobs, freshOrg] = await Promise.all([
        getTasksByOrg(currentOrg.id),
        getProjectsByOrg(currentOrg.id),
        getAgentsByOrg(currentOrg.id),
        getJobsByOrg(currentOrg.id),
        getOrganization(currentOrg.id),
      ]);

      setAgentSlots(freshOrg?.agentSlots || freshOrg?.swarmSlots || {});

      setAgents(agentsData);
      setAllTasks(tasks);
      setAllJobs(jobs);

      const projectMap = new Map(projects.map(p => [p.id, p.name]));
      const agentMap = new Map(agentsData.map(a => [a.id, a.name]));

      setRecentTasks(
        [...tasks]
          .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt))
          .slice(0, 5)
          .map(task => ({
            ...task,
            projectName: projectMap.get(task.projectId) || 'Unknown Project',
            agentName: task.assigneeAgentId ? agentMap.get(task.assigneeAgentId) || 'Unknown Agent' : 'Unassigned',
          }))
      );

      setRecentJobs(
        [...jobs]
          .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt))
          .slice(0, 5)
      );

      // Activity feed — 200 events feed the heatmap, the first few feed the Activity card
      try {
        setActivityAll(await getActivityFeed(currentOrg.id, { max: 200 }));
      } catch {
        // Activity feed is non-critical
      }

      // Governance approvals waiting on a human
      try {
        setPendingApprovals(await getPendingCount(currentOrg.id));
      } catch {
        // Approvals count is non-critical
      }

      // Cost data
      try {
        const { getUsageRecords, aggregateDaily } = await import("@/lib/usage");
        const records = await getUsageRecords(currentOrg.id, 14);
        setDailyCosts(aggregateDaily(records));
      } catch {
        // Cost data is non-critical
      }

      // Daily briefing cron job + latest summary
      try {
        // Use direct name lookup — avoids composite index requirement
        const briefingJob = await getNamedCronJob(currentOrg.id, "Daily Briefing");
        setBriefingCronJob(briefingJob && briefingJob.enabled ? briefingJob : null);
        if (briefingJob?.enabled) {
          const res = await fetch(`/api/summaries?orgId=${currentOrg.id}&limit=1`);
          if (res.ok) {
            const data = await res.json();
            if (data.summaries?.length > 0) setLatestBriefing(data.summaries[0]);
          }
        }
      } catch (briefErr) {
        console.error("[Dashboard] Failed to load briefing cron job:", briefErr);
      }
      setLastUpdated(new Date());
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
    } finally {
      if (isInitial) setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    loadDashboardData(true);
  }, [loadDashboardData]);

  // Auto-refresh every 5 minutes. Skip ticks while the tab is in the
  // background. Each reload reads every task, project, agent and job in the
  // org plus 200 activity events. At 30s an open tab cost tens of thousands
  // of Firestore reads an hour; the refresh button covers "show me now".
  useEffect(() => {
    if (!currentOrg) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") loadDashboardData();
    }, 5 * 60_000);
    return () => clearInterval(interval);
  }, [currentOrg, loadDashboardData]);

  const handleManualRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadDashboardData();
    } finally {
      setRefreshing(false);
    }
  }, [loadDashboardData]);

  // ── Dispatch handler — creates job, assigns agents, refreshes data ──
  const handleDispatch = useCallback(async (payload: DispatchPayload) => {
    if (!currentOrg) return;
    const { prompt, priority, reward, agentIds } = payload;
    const agentNames = agentIds.map(id => agents.find(a => a.id === id)?.name || id);

    try {
      setDispatching(true);
      setError(null);

      // 1. Create the job (org-wide, no single project)
      // Server-side: validates, assigns agentIds[0] as lead and the rest as
      // collaborators, and records it all in the job's audit trail.
      const { jobId } = await dispatchJob({
        orgId: currentOrg.id,
        projectId: "",
        prompt,
        agentIds,
        priority,
        reward: reward || undefined,
      });

      // 3. Log to agentComms
      try {
        await addDoc(collection(db, "agentComms"), {
          orgId: currentOrg.id,
          fromAgentId: "system",
          fromAgentName: "Agent Dispatch",
          toAgentId: agentIds.join(","),
          toAgentName: agentNames.join(", "),
          type: "handoff",
          content: `🚀 **Job Dispatched**\n\n**Prompt:** ${prompt}\n\n**Assigned Agents:** ${agentNames.map(n => `@${n}`).join(", ")}\n**Priority:** ${priority}${reward ? `\n**Reward:** ${reward} ${currencySymbol}` : ""}\n\nCoordinate as a team to complete this task.`,
          metadata: { jobId, priority, reward, agentIds },
          createdAt: serverTimestamp(),
        });
      } catch { /* comms log is non-critical */ }

      // 4. Refresh dashboard data so the new job appears on the map
      await loadDashboardData();
    } catch (err) {
      console.error("Dispatch failed:", err);
      setError(err instanceof Error ? err.message : "Failed to dispatch job");
    } finally {
      setDispatching(false);
    }
  }, [currentOrg, agents, currencySymbol, loadDashboardData, userAddress]);

  // ── Assign handler — assigns agents to open jobs via drag connections ──
  const handleAssign = useCallback(async (assignments: { jobId: string; agentId: string; jobTitle: string; agentName: string }[]) => {
    if (!currentOrg) return;
    try {
      setDispatching(true);
      setError(null);
      for (const a of assignments) {
        await assignJob(a.jobId, a.agentId);
      }
      await loadDashboardData();
    } catch (err) {
      console.error("Assign failed:", err);
      setError(err instanceof Error ? err.message : "Failed to assign agents");
    } finally {
      setDispatching(false);
    }
  }, [currentOrg, loadDashboardData]);

  const onlineCount = agents.filter(a => a.status === "online" || a.status === "busy").length;
  const userAgent = agents.find(a => a.walletAddress === userAddress);
  const spend14d = dailyCosts.reduce((sum, d) => sum + d.costUsd, 0);
  const workItems = useMemo(() => buildWorkItems(allJobs, allTasks, agents), [allJobs, allTasks, agents]);
  const ownAgentIds = useMemo(() => agents.map(a => a.id), [agents]);
  const activeJobs = allJobs.filter(j => j.status === "claimed" || j.status === "in_progress").length;
  const awaitingReview = allJobs.filter(j => j.status === "completed" && j.reviewStatus === "pending").length;
  const pendingCount = awaitingReview + pendingApprovals;

  /* ── Greeting ── */
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }, []);

  /* ── Guards ── */

  if (!currentOrg) {
    return (
      <div className="space-y-4">
        <div className="relative overflow-hidden rounded-xl border border-border/50 bg-gradient-to-br from-muted/30 via-transparent to-muted/20 px-6 py-5">
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">No organization selected</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {/* Hero skeleton */}
        <div className="relative overflow-hidden rounded-xl border border-amber-500/10 bg-gradient-to-br from-amber-500/5 via-transparent to-orange-500/5 px-6 py-5">
          <div className="space-y-2">
            <div className="h-7 w-48 rounded-lg skeleton-shimmer" />
            <div className="h-4 w-32 rounded-md skeleton-shimmer" />
          </div>
        </div>
        {/* Stat strip skeleton */}
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={`sk-stat-${i}`} className="h-20 rounded-xl skeleton-shimmer" style={{ animationDelay: `${i * 0.05}s` }} />
          ))}
        </div>
        {/* Command row skeleton */}
        <div className="grid gap-3 grid-cols-1 lg:grid-cols-3">
          <div className="lg:col-span-2 h-56 rounded-xl skeleton-shimmer" style={{ animationDelay: '0.2s' }} />
          <div className="h-56 rounded-xl skeleton-shimmer" style={{ animationDelay: '0.25s' }} />
        </div>
        <div className="grid gap-3 grid-cols-1 md:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={`sk-recent-${i}`} className="h-44 rounded-xl skeleton-shimmer" style={{ animationDelay: `${0.3 + i * 0.05}s` }} />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div className="relative overflow-hidden rounded-xl border border-red-500/10 bg-gradient-to-br from-red-500/5 via-transparent to-orange-500/5 px-6 py-5">
          <h1 className="text-2xl font-bold tracking-tight">{greeting}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{currentOrg.name}</p>
        </div>
        <div className="flex items-center justify-center py-16">
          <div className="text-center max-w-sm">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 mb-4">
              <X className="h-6 w-6 text-red-400" aria-hidden="true" />
            </div>
            <h2 className="text-lg font-semibold mb-1">Failed to load dashboard</h2>
            <p className="text-sm text-muted-foreground mb-6">{error}</p>
            <Button
              onClick={() => loadDashboardData(true)}
              variant="outline"
              className="gap-2 border-amber-500/20 hover:border-amber-500/40"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  /* ── Render ── */

  return (
    <div className="space-y-5">
      <CommandHero
        greeting={greeting}
        orgName={currentOrg.name}
        lastUpdated={lastUpdated}
        refreshing={refreshing}
        onRefresh={handleManualRefresh}
        readouts={[
          { label: "Agents online", value: `${onlineCount}/${agents.length}`, href: "/agents" },
          { label: "Jobs active", value: String(activeJobs), href: "/jobs" },
          { label: "Pending you", value: String(pendingCount), href: awaitingReview || !pendingApprovals ? "/jobs" : "/approvals", alert: pendingCount > 0 },
          { label: "Spend (14d)", value: `$${spend14d.toFixed(2)}`, href: "/usage" },
        ]}
      />

      <Tabs value={dashTab} onValueChange={setDashTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="agent-guild">Agent Map</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-3 space-y-5">

          {/* ═══ Primary actions ═══ */}
          <Reveal>
            <ActionTiles onJobPosted={() => loadDashboardData()} />
          </Reveal>

          {/* ═══ Mission board ═══ */}
          <div className="grid gap-3 grid-cols-1 lg:grid-cols-5">
            <Reveal delay={0.05} className="lg:col-span-3">
              <ActiveWorkPanel items={workItems} />
            </Reveal>
            <Reveal delay={0.08} className="lg:col-span-2">
              <RecommendedAgentsPanel ownAgentIds={ownAgentIds} />
            </Reveal>
          </div>

          {/* ═══ Command ═══ */}
          <div className="space-y-3">
            <SectionLabel>Dispatch</SectionLabel>
            <div className="grid gap-3 grid-cols-1 lg:grid-cols-3">
              <Reveal delay={0.05} className="lg:col-span-2">
                <PromptWidget onDispatch={handleDispatch} agents={agents} />
              </Reveal>
              <Reveal delay={0.08}>
                <NeedsAttentionCard
                  tasks={allTasks}
                  jobs={allJobs}
                  agents={agents}
                  briefingErrorCount={latestBriefing?.summary?.errors?.length || 0}
                />
              </Reveal>
            </div>
          </div>

          {/* ═══ Recent ═══ */}
          <div className="space-y-3">
            <SectionLabel>Recent</SectionLabel>
            <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
              <Reveal delay={0.1}><RecentTasksCard tasks={recentTasks} /></Reveal>
              <Reveal delay={0.13}><RecentJobsCard jobs={recentJobs} /></Reveal>
              <Reveal delay={0.16} className="md:col-span-2 xl:col-span-1">
                <ActivityFeedCard events={activityAll.slice(0, 5)} />
              </Reveal>
            </div>
            <Reveal delay={0.18}>
              <DailyBriefingCard
                orgId={currentOrg.id}
                agents={agents}
                slotAgentId={agentSlots["daily-briefings"]?.agentId}
                cronJob={briefingCronJob}
                latestBriefing={latestBriefing}
                createdBy={userAddress}
                canEdit={!!account || authenticated}
                onSaved={() => loadDashboardData()}
              />
            </Reveal>
          </div>

          {/* ═══ Trends ═══ */}
          <div className="space-y-3">
            <SectionLabel>Trends</SectionLabel>
            <div className="grid gap-3 grid-cols-1 lg:grid-cols-3">
              <Reveal delay={0.1}><TaskVelocityChart data={taskVelocity} /></Reveal>
              <Reveal delay={0.13}><CostTrendChart data={dailyCosts} /></Reveal>
              <Reveal delay={0.16}><AgentWorkloadChart data={agentWorkload} /></Reveal>
            </div>
            <div className="grid gap-3 grid-cols-1 lg:grid-cols-3">
              <Reveal delay={0.1} className="lg:col-span-2">
                <ActivityHeatmapChart data={activityHeatmap} />
              </Reveal>
              <Reveal delay={0.13}><TopPerformersCard agents={agents} /></Reveal>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="agent-guild">
          <AgentMap
            projectName={currentOrg?.name || "Organization"}
            agents={agents.map((a) => {
              const activeJob = allJobs.find(j => j.takenByAgentId === a.id && j.status === 'in_progress');
              const agentJobs = allJobs.filter(j => j.takenByAgentId === a.id);
              const parseReward = (r?: string) => { if (!r) return 0; const n = parseFloat(r.replace(/[^0-9.]/g, '')); return isNaN(n) ? 0 : n; };
              const agentCost = agentJobs.reduce((s, j) => s + parseReward(j.reward), 0);
              return {
                id: a.id,
                name: a.name,
                type: a.type,
                status: activeJob ? 'busy' : a.status,
                activeJobName: activeJob?.title,
                assignedCost: agentCost,
              };
            })}
            tasks={allTasks.map((t) => ({ id: t.id, status: t.status, assigneeAgentId: t.assigneeAgentId }))}
            jobs={allJobs.map((j) => ({ id: j.id, title: j.title, reward: j.reward, priority: j.priority, requiredSkills: j.requiredSkills ?? [], status: j.status }))}
            onDispatch={handleDispatch}
            onAssign={handleAssign}
            executing={dispatching}
            currencySymbol={currencySymbol}
          />
        </TabsContent>

        {/* Infra widgets fetch or subscribe on mount, so they only load once this tab is opened. */}
        <TabsContent value="system" className="mt-3 space-y-5">
          <div className="space-y-3">
            <SectionLabel>Infrastructure</SectionLabel>
            <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
              <UsageWidget />
              <CronWidget />
              <VitalsWidget />
            </div>
            <CoordinatorDashboardWidget orgId={currentOrg.id} />
          </div>

          <div className="space-y-3">
            <SectionLabel>Comms</SectionLabel>
            <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
              <ChannelsWidget agents={agents} />
              {userAgent ? (
                <AgentMessagesWidget agentId={userAgent.id} orgId={currentOrg.id} />
              ) : (
                <RegisterAgentCard icon="💬" title="Agent Messages" what="messages" />
              )}
              {userAgent ? (
                <AgentSessionsWidget agentId={userAgent.id} orgId={currentOrg.id} />
              ) : (
                <RegisterAgentCard icon="🔄" title="Agent Sessions" what="sessions" />
              )}
            </div>
            <LiveFeedWidget />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
