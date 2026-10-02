/** Dashboard — curated command center for org operations, analytics, and integrations. */
'use client';

import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import Link from "next/link";
import dynamic from "next/dynamic";
import { motion, useReducedMotion } from "motion/react";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { StatCard } from "@/components/analytics/stat-card";
import { useOrg } from "@/contexts/OrgContext";
import SpotlightCard from "@/components/reactbits/SpotlightCard";
import ShinyText from "@/components/reactbits/ShinyText";
import DecryptedText from "@/components/reactbits/DecryptedText";
import { VitalsWidget } from "@/components/vitals-widget";
import { useWalletAccount } from "@/lib/wallet";
import { useSession } from "@/contexts/SessionContext";
import { RotateCcw, X, FolderKanban, Target, Briefcase, Users, Loader2, Pencil, Wifi, TrendingUp } from "lucide-react";
import {
  getOrgStats,
  getTasksByOrg,
  getProjectsByOrg,
  getAgentsByOrg,
  getJobsByOrg,
  getOrganization,
  createJob,
  claimJob,
  type Task,
  type Agent,
  type Job,
  ensureAgentGroupChat,
  sendMessage,
} from "@/lib/firestore";
import { getAgentAvatarUrl } from "@/lib/agent-avatar";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  getActivityFeed,
  EVENT_TYPE_CONFIG,
  type ActivityEvent,
} from "@/lib/activity";
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
import { getNamedCronJob, createCronJob, updateCronJob, SCHEDULE_PRESETS, parseCronToHuman, type CronJob } from "@/lib/cron";
import type { DailySummary } from "@/lib/daily-summary";
import { UsageWidget } from "@/components/usage-widget";
import { LiveFeedWidget } from "@/components/live-feed-widget";
import { CronWidget } from "@/components/cron-widget";
import AgentMessagesWidget from "@/components/agent-messages-widget";
import AgentSessionsWidget from "@/components/agent-sessions-widget";
import CoordinatorDashboardWidget from "@/components/coordinator-dashboard-widget";
import { PromptWidget } from "@/components/prompt-widget";
import { ChannelsWidget } from "@/components/channels-widget";

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
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface OrgStats {
  projectCount: number;
  agentCount: number;
  taskCount: number;
  completedTasks: number;
  activeTasks: number;
  todoTasks: number;
  jobCount: number;
  openJobs: number;
  claimedJobs: number;
  closedJobs: number;
}

const statusColors: Record<string, string> = {
  todo: "badge-neon-default",
  in_progress: "badge-neon-amber",
  done: "badge-neon-green",
};

const statusLabels: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
};

const jobStatusColors: Record<string, string> = {
  open: "badge-neon-green",
  claimed: "badge-neon-amber",
  closed: "badge-neon-default",
};

const jobStatusLabels: Record<string, string> = {
  open: "Open",
  claimed: "Claimed",
  closed: "Closed",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatRelativeTime(date: Date | null): string {
  if (!date) return "";
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

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

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function DashboardPage() {
  const { currentOrg } = useOrg();
  const currencySymbol = "$";
  const account = useWalletAccount();
  const { address: sessionAddress, authenticated } = useSession();
  const userAddress = account?.address || sessionAddress || "";
  const [stats, setStats] = useState<OrgStats | null>(null);
  const [recentTasks, setRecentTasks] = useState<(Task & { agentName?: string; projectName?: string })[]>([]);
  const [recentJobs, setRecentJobs] = useState<Job[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activityFeed, setActivityFeed] = useState<ActivityEvent[]>([]);
  const [activityAll, setActivityAll] = useState<ActivityEvent[]>([]);
  const [dailyCosts, setDailyCosts] = useState<DailyCost[]>([]);
  const [agentSlots, setAgentSlots] = useState<Record<string, { agentId: string; assignedAt: unknown } | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [dashTab, setDashTab] = useState("overview");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Daily Briefing state
  const [briefingCronJob, setBriefingCronJob] = useState<CronJob | null>(null);
  const [latestBriefing, setLatestBriefing] = useState<DailySummary | null>(null);
  const [briefingSetupMode, setBriefingSetupMode] = useState(false);
  const [briefingSchedule, setBriefingSchedule] = useState("0 9 * * *");
  const [briefingPrompt, setBriefingPrompt] = useState(
    "Generate a daily activity summary for the organization. Include task completion stats, agent activity highlights, any errors or failures, and key metrics like token usage and cost."
  );
  const [briefingSaving, setBriefingSaving] = useState(false);
  const [briefingAgentId, setBriefingAgentId] = useState<string>("");

  // Compute analytics data
  const taskVelocity = useMemo(() => computeTaskVelocity(allTasks), [allTasks]);
  const agentWorkload = useMemo(() => computeAgentWorkload(allTasks, agents), [allTasks, agents]);
  const activityHeatmap = useMemo(() => computeActivityByHour(activityAll), [activityAll]);

  // Load dashboard data — extracted so dispatch can refresh
  const loadDashboardData = useCallback(async (isInitial = false) => {
    if (!currentOrg) return;
    try {
      if (isInitial) { setLoading(true); setError(null); }

      const orgStats = await getOrgStats(currentOrg.id);
      setStats(orgStats);

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

      const enrichedTasks = tasks
        .map(task => ({
          ...task,
          projectName: projectMap.get(task.projectId) || 'Unknown Project',
          agentName: task.assigneeAgentId ? agentMap.get(task.assigneeAgentId) || 'Unknown Agent' : 'Unassigned'
        }))
        .sort((a, b) => {
          const aTime = a.createdAt && typeof a.createdAt === 'object' && 'seconds' in a.createdAt
            ? (a.createdAt as any).seconds * 1000
            : new Date(a.createdAt as any).getTime();
          const bTime = b.createdAt && typeof b.createdAt === 'object' && 'seconds' in b.createdAt
            ? (b.createdAt as any).seconds * 1000
            : new Date(b.createdAt as any).getTime();
          return bTime - aTime;
        })
        .slice(0, 5);

      setRecentTasks(enrichedTasks);

      const sortedJobs = jobs
        .sort((a, b) => {
          const aTime = a.createdAt && typeof a.createdAt === 'object' && 'seconds' in a.createdAt
            ? (a.createdAt as any).seconds * 1000
            : new Date(a.createdAt as any).getTime();
          const bTime = b.createdAt && typeof b.createdAt === 'object' && 'seconds' in b.createdAt
            ? (b.createdAt as any).seconds * 1000
            : new Date(b.createdAt as any).getTime();
          return bTime - aTime;
        })
        .slice(0, 5);
      setRecentJobs(sortedJobs);

      // Load activity feed (200 for heatmap, slice 8 for feed widget)
      try {
        const feed = await getActivityFeed(currentOrg.id, { max: 200 });
        setActivityAll(feed);
        setActivityFeed(feed.slice(0, 8));
      } catch {
        // Activity feed is non-critical
      }

      // Load cost data
      try {
        const { getUsageRecords, aggregateDaily } = await import("@/lib/usage");
        const records = await getUsageRecords(currentOrg.id, 14);
        setDailyCosts(aggregateDaily(records));
      } catch {
        // Cost data is non-critical
      }

      // Load daily briefing cron job + latest summary
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
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
    } finally {
      if (isInitial) setLoading(false);
      setLastUpdated(new Date());
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

  // ── Daily Briefing setup/edit handler ──
  const handleBriefingSetup = useCallback(async () => {
    if (!currentOrg || (!account && !authenticated)) return;
    setBriefingSaving(true);
    try {
      const briefingAgent = briefingAgentId ? agents.find(a => a.id === briefingAgentId) : null;
      const scheduleLabel = parseCronToHuman(briefingSchedule);
      const isEditing = !!briefingCronJob;

      // Save the agent ID — preserve existing assignment if user didn't change it
      const agentIdsToSave = briefingAgentId
        ? [briefingAgentId]
        : briefingCronJob?.agentIds?.length
          ? briefingCronJob.agentIds
          : undefined;

      if (isEditing) {
        await updateCronJob(briefingCronJob.id, {
          message: briefingPrompt,
          schedule: briefingSchedule,
          scheduleLabel,
          agentIds: agentIdsToSave,
        });
      } else {
        await createCronJob({
          orgId: currentOrg.id,
          name: "Daily Briefing",
          message: briefingPrompt,
          schedule: briefingSchedule,
          scheduleLabel,
          agentIds: agentIdsToSave,
          priority: "medium",
          enabled: true,
          createdBy: userAddress || "unknown",
        });
      }

      // Notify assigned briefing agent through Agent Hub
      if (briefingAgent) {
        ensureAgentGroupChat(currentOrg.id).then(hub => {
          const action = isEditing ? "updated" : "configured";
          sendMessage({
            channelId: hub.id,
            senderId: "system",
            senderName: "Agent Guild Protocol",
            senderType: "agent",
            content: [
              `📋 **Daily Briefing ${action}** — assigned to **@${briefingAgent.name}**`,
              ``,
              `**Schedule:** ${scheduleLabel}`,
              `**Prompt:** ${briefingPrompt}`,
              ``,
              `You are responsible for generating briefings on this schedule. Begin operations when ready.`,
            ].join("\n"),
            orgId: currentOrg.id,
            createdAt: new Date(),
          });
        }).catch(() => {});
      }

      setBriefingSetupMode(false);
      await loadDashboardData();
    } catch (err) {
      console.error("Failed to set up daily briefing:", err);
    } finally {
      setBriefingSaving(false);
    }
  }, [currentOrg, account, authenticated, userAddress, briefingSchedule, briefingPrompt, briefingCronJob, briefingAgentId, agents, loadDashboardData]);

  // ── Open briefing editor pre-filled with current config ──
  const openBriefingEditor = useCallback(() => {
    if (briefingCronJob) {
      setBriefingSchedule(briefingCronJob.schedule);
      setBriefingPrompt(briefingCronJob.message);
      setBriefingAgentId(briefingCronJob.agentIds?.[0] || "");
    } else {
      // Default to agent-guild slot agent if one is assigned
      const slot = agentSlots["daily-briefings"];
      setBriefingAgentId(slot?.agentId || "");
    }
    setBriefingSetupMode(true);
  }, [briefingCronJob, agentSlots]);

  // ── Dispatch handler — creates job, assigns agents, refreshes data ──
  const handleDispatch = useCallback(async (payload: DispatchPayload) => {
    if (!currentOrg) return;
    const { prompt, priority, reward, agentIds } = payload;
    const agentNames = agentIds.map(id => agents.find(a => a.id === id)?.name || id);

    try {
      setDispatching(true);
      setError(null);

      // 1. Create the job (org-wide, no single project)
      const jobId = await createJob({
        orgId: currentOrg.id,
        projectId: "",
        title: prompt.slice(0, 120) + (prompt.length > 120 ? "…" : ""),
        description: prompt,
        status: "open",
        reward: reward || undefined,
        requiredSkills: [],
        postedByAddress: userAddress || "unknown",
        priority,
        createdAt: new Date(),
      });

      // 2. Assign each selected agent
      for (const agentId of agentIds) {
        await claimJob(jobId, agentId, currentOrg.id, "");
      }

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
  }, [currentOrg, agents, account, currencySymbol, loadDashboardData, userAddress]);

  // ── Assign handler — assigns agents to open jobs via drag connections ──
  const handleAssign = useCallback(async (assignments: { jobId: string; agentId: string; jobTitle: string; agentName: string }[]) => {
    if (!currentOrg) return;
    try {
      setDispatching(true);
      setError(null);
      for (const a of assignments) {
        await claimJob(a.jobId, a.agentId, currentOrg.id, "");
      }
      await loadDashboardData();
    } catch (err) {
      console.error("Assign failed:", err);
      setError(err instanceof Error ? err.message : "Failed to assign agents");
    } finally {
      setDispatching(false);
    }
  }, [currentOrg, loadDashboardData]);

  const onlineAgents = agents.filter(a => a.status === "online");
  const busyAgents = agents.filter(a => a.status === "busy");
  const offlineAgents = agents.filter(a => a.status === "offline");
  const userAgent = agents.find(a => a.walletAddress === userAddress);

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
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={`sk-stat-${i}`} className="h-20 rounded-xl skeleton-shimmer" style={{ animationDelay: `${i * 0.05}s` }} />
          ))}
        </div>
        {/* Command center skeleton */}
        <div className="grid gap-3 grid-cols-1 lg:grid-cols-3">
          <div className="lg:col-span-2 h-56 rounded-xl skeleton-shimmer" style={{ animationDelay: '0.2s' }} />
          <div className="h-56 rounded-xl skeleton-shimmer" style={{ animationDelay: '0.25s' }} />
        </div>
        <div className="grid gap-3 grid-cols-1 md:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={`sk-ops-${i}`} className="h-44 rounded-xl skeleton-shimmer" style={{ animationDelay: `${0.3 + i * 0.05}s` }} />
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

  /* ── Daily Briefing derived state ── */
  const cronAgentId = briefingCronJob?.agentIds?.[0];
  const briefingSlot = agentSlots["daily-briefings"];
  const briefingAgent = cronAgentId
    ? agents.find(a => a.id === cronAgentId)
    : briefingSlot ? agents.find(a => a.id === briefingSlot.agentId) : null;

  const todo = stats?.todoTasks || 0;
  const inProgress = stats?.activeTasks || 0;
  const done = stats?.completedTasks || 0;
  const totalTaskCount = todo + inProgress + done;

  const topPerformers = [...agents]
    .filter(a => a.tasksCompleted && a.tasksCompleted > 0)
    .sort((a, b) => (b.tasksCompleted || 0) - (a.tasksCompleted || 0))
    .slice(0, 5);

  /* ── Render ── */

  return (
    <div className="space-y-5">
      {/* Dashboard hero header */}
      <div className="relative overflow-hidden rounded-xl border border-amber-500/10 bg-gradient-to-br from-amber-500/5 via-transparent to-orange-500/5 dark:from-amber-500/[0.07] dark:to-orange-500/[0.04] px-5 py-3.5">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(114,33,250,0.08),transparent_60%)] pointer-events-none" />
        <div className="relative flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight text-glow-gold">{greeting}</h1>
            <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
              {currentOrg.name}
              {lastUpdated && (
                <>
                  <span className="text-muted-foreground/30">·</span>
                  <span className="text-xs text-muted-foreground/50 tabular-nums flex items-center gap-1.5">
                    <span className="relative flex h-1.5 w-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" /></span>
                    Updated {formatRelativeTime(lastUpdated)}
                  </span>
                </>
              )}
            </p>
          </div>
          {dashTab === "overview" && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleManualRefresh}
              disabled={refreshing}
              className="gap-1.5 h-8 border-amber-500/20 hover:border-amber-500/40 hover:bg-amber-500/5 shrink-0"
            >
              <RotateCcw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
              Refresh
            </Button>
          )}
        </div>
      </div>

      <Tabs value={dashTab} onValueChange={setDashTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="agent-guild">Agent Map</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-3 space-y-5">

          {/* ═══ At a glance ═══ */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            {[
              { title: "Online", value: String(onlineAgents.length), icon: Wifi, changeLabel: "agents online" },
              { title: "Active Tasks", value: String(stats?.activeTasks || 0), icon: Target, changeLabel: "in progress" },
              { title: "Open Jobs", value: String(stats?.openJobs || 0), icon: Briefcase, changeLabel: `${stats?.jobCount || 0} total jobs` },
              { title: "Done %", value: `${stats?.taskCount ? Math.round(((stats.completedTasks || 0) / stats.taskCount) * 100) : 0}%`, icon: TrendingUp, changeLabel: "completion rate" },
              { title: "Projects", value: String(stats?.projectCount || 0), icon: FolderKanban, changeLabel: "active projects" },
              { title: "Members", value: String(currentOrg?.members.length || 0), icon: Users, changeLabel: "org members" },
            ].map((s, i) => (
              <Reveal key={s.title} delay={i * 0.04}>
                <StatCard title={s.title} value={s.value} icon={s.icon} changeLabel={s.changeLabel} change={0} />
              </Reveal>
            ))}
          </div>

          {/* ═══ Command Center ═══ */}
          <div className="space-y-3">
            <SectionLabel>Command Center</SectionLabel>
            <div className="grid gap-3 grid-cols-1 lg:grid-cols-3">
              <Reveal delay={0.05} className="lg:col-span-2">
                <PromptWidget onDispatch={handleDispatch} agents={agents} />
              </Reveal>
              <Reveal delay={0.08}>
                <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden rounded-xl">
                  <CardHeader className="px-4 pt-3 pb-1.5">
                    <CardTitle className="text-sm">
                      🟢 <DecryptedText text="Agent Status" speed={30} maxIterations={6} animateOn="view" sequential className="text-sm font-semibold" encryptedClassName="text-sm font-semibold text-amber-500/40" />
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 px-4 pb-3">
                    {agents.length === 0 ? (
                      <div className="text-center py-4 text-muted-foreground">
                        <p>No agents registered</p>
                        <Link href="/agents" className="text-amber-600 dark:text-amber-400 hover:underline text-sm">
                          Register your first agent →
                        </Link>
                      </div>
                    ) : (
                      [
                        { label: "Online", count: onlineAgents.length, color: "bg-emerald-500", textColor: "text-emerald-500" },
                        { label: "Busy", count: busyAgents.length, color: "bg-amber-500", textColor: "text-amber-500" },
                        { label: "Offline", count: offlineAgents.length, color: "bg-muted-foreground/40", textColor: "text-muted-foreground" },
                      ].map(s => (
                        <div key={s.label} className="space-y-1.5">
                          <div className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                              <span className={`w-2 h-2 rounded-full ${s.color}`} />
                              <span className="font-medium">{s.label}</span>
                            </div>
                            <span className={`font-semibold tabular-nums ${s.textColor}`}>
                              {s.count} <span className="text-xs text-muted-foreground font-normal">/ {agents.length}</span>
                            </span>
                          </div>
                          <div className="h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-500 ${s.color}`}
                              style={{ width: `${agents.length > 0 ? (s.count / agents.length) * 100 : 0}%` }}
                            />
                          </div>
                        </div>
                      ))
                    )}
                  </CardContent>
                </SpotlightCard>
              </Reveal>
            </div>
          </div>

          {/* ═══ Operations ═══ */}
          <div className="space-y-3">
            <SectionLabel>Operations</SectionLabel>
            <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
              <Reveal delay={0.1}>
                <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden rounded-xl">
                  <CardHeader className="flex flex-row items-center gap-2 px-4 pt-3 pb-1.5">
                    <CardTitle className="text-sm">
                      📋 <DecryptedText text="Recent Tasks" speed={30} maxIterations={6} animateOn="view" sequential className="text-sm font-semibold" encryptedClassName="text-sm font-semibold text-amber-500/40" />
                    </CardTitle>
                    <Link href="/missions" className="text-xs">
                      <ShinyText text="View all →" speed={3} color="#6d4fa0" shineColor="#7221FA" className="text-xs" />
                    </Link>
                  </CardHeader>
                  <CardContent className="space-y-0.5 px-4 pb-3">
                    {recentTasks.length === 0 ? (
                      <div className="text-center py-4 text-muted-foreground">
                        <p>No tasks yet</p>
                        <Link href="/missions" className="text-amber-600 dark:text-amber-400 hover:underline text-sm">
                          Create your first task →
                        </Link>
                      </div>
                    ) : (
                      recentTasks.map((task) => (
                        <div
                          key={task.id}
                          className="flex items-center justify-between py-2 border-b border-border last:border-0"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">{task.title}</p>
                            <p className="text-xs text-muted-foreground truncate">
                              📁 {task.projectName} · 🤖 {task.agentName}
                            </p>
                          </div>
                          <Badge variant="outline" className={`text-[10px] ${statusColors[task.status]}`}>
                            {statusLabels[task.status]}
                          </Badge>
                        </div>
                      ))
                    )}
                  </CardContent>
                </SpotlightCard>
              </Reveal>

              <Reveal delay={0.13}>
                <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden rounded-xl">
                  <CardHeader className="flex flex-row items-center gap-2 px-4 pt-3 pb-1.5">
                    <CardTitle className="text-sm">
                      💼 <DecryptedText text="Recent Jobs" speed={30} maxIterations={6} animateOn="view" sequential className="text-sm font-semibold" encryptedClassName="text-sm font-semibold text-amber-500/40" />
                    </CardTitle>
                    <Link href="/jobs" className="text-xs">
                      <ShinyText text="View all →" speed={3} color="#6d4fa0" shineColor="#7221FA" className="text-xs" />
                    </Link>
                  </CardHeader>
                  <CardContent className="space-y-0.5 px-4 pb-3">
                    {recentJobs.length === 0 ? (
                      <div className="text-center py-4 text-muted-foreground">
                        <p>No jobs posted yet</p>
                        <Link href="/jobs" className="text-amber-600 dark:text-amber-400 hover:underline text-sm">
                          Post your first job →
                        </Link>
                      </div>
                    ) : (
                      recentJobs.map((job) => (
                        <div
                          key={job.id}
                          className="flex items-center justify-between py-2 border-b border-border last:border-0"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">{job.title}</p>
                            <p className="text-xs text-muted-foreground truncate">
                              {job.reward && <span>💰 {job.reward} · </span>}
                              {job.priority} priority
                            </p>
                          </div>
                          <Badge variant="outline" className={`text-[10px] ${jobStatusColors[job.status]}`}>
                            {jobStatusLabels[job.status]}
                          </Badge>
                        </div>
                      ))
                    )}
                  </CardContent>
                </SpotlightCard>
              </Reveal>

              <Reveal delay={0.16}>
                <ChannelsWidget agents={agents} />
              </Reveal>
            </div>
          </div>

          {/* ═══ Daily Briefing ═══ */}
          <Reveal delay={0.18}>
            {briefingSetupMode ? (
              (() => {
                const briefingPresets = SCHEDULE_PRESETS.filter(p =>
                  ["daily", "weekly"].includes(p.type) || p.value === "0 */6 * * *"
                );
                const isEditing = !!briefingCronJob;
                return (
                  <SpotlightCard className="p-0 glass-card-enhanced overflow-hidden rounded-xl">
                    <CardHeader className="px-4 pt-3 pb-1.5">
                      <CardTitle className="text-sm">
                        📋 <DecryptedText text={isEditing ? "Edit Briefing" : "Set Up Daily Briefing"} speed={30} maxIterations={6} animateOn="view" sequential className="text-sm font-semibold" encryptedClassName="text-sm font-semibold text-amber-500/40" />
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-3 space-y-3">
                      {/* Schedule picker */}
                      <div>
                        <label htmlFor="briefing-time" className="text-xs text-muted-foreground mb-1.5 block">Schedule</label>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                          {briefingPresets.map((preset) => (
                            <button
                              key={preset.value + preset.label}
                              type="button"
                              onClick={() => setBriefingSchedule(preset.value)}
                              className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                                briefingSchedule === preset.value
                                  ? "border-amber-500/50 bg-amber-500/10 text-amber-400"
                                  : "border-border hover:border-amber-500/30 text-muted-foreground hover:text-foreground"
                              }`}
                            >
                              <span aria-hidden="true">{preset.icon}</span>
                              <span className="truncate">{preset.label}</span>
                            </button>
                          ))}
                        </div>
                        {/* Custom time input */}
                        <div className="mt-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground whitespace-nowrap">Custom time:</span>
                            <input
                              id="briefing-time"
                              type="time"
                              autoComplete="off"
                              value={(() => {
                                const parts = briefingSchedule.split(" ");
                                if (parts.length === 5 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[0])) {
                                  return `${parts[1].padStart(2, "0")}:${parts[0].padStart(2, "0")}`;
                                }
                                return "";
                              })()}
                              onChange={(e) => {
                                const [h, m] = e.target.value.split(":");
                                if (h !== undefined && m !== undefined) {
                                  setBriefingSchedule(`${parseInt(m)} ${parseInt(h)} * * *`);
                                }
                              }}
                              className="flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Agent picker */}
                      <div>
                        <label htmlFor="briefing-agent" className="text-xs text-muted-foreground mb-1.5 block">Assigned Agent</label>
                        <select
                          id="briefing-agent"
                          value={briefingAgentId}
                          onChange={(e) => setBriefingAgentId(e.target.value)}
                          className="w-full rounded-lg border border-border bg-zinc-900 px-2.5 py-1.5 text-xs text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&>option]:bg-zinc-900 [&>option]:text-white"
                        >
                          <option value="">No agent assigned</option>
                          {agents.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} ({a.type}{a.status === "online" ? " · online" : ""})
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Prompt editor */}
                      <div>
                        <label htmlFor="briefing-prompt" className="text-xs text-muted-foreground mb-1.5 block">Briefing Prompt</label>
                        <textarea
                          id="briefing-prompt"
                          value={briefingPrompt}
                          onChange={(e) => setBriefingPrompt(e.target.value)}
                          rows={3}
                          className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
                          placeholder="Describe what the briefing should include..."
                        />
                      </div>

                      {/* Action buttons */}
                      <div className="flex justify-end gap-2 pt-1">
                        <Button variant="outline" size="sm" onClick={() => setBriefingSetupMode(false)}>
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={handleBriefingSetup}
                          disabled={briefingSaving || !briefingPrompt.trim()}
                          className="bg-amber-500 hover:bg-amber-600 text-white"
                        >
                          {briefingSaving ? (
                            <><Loader2 className="h-3 w-3 animate-spin mr-1" aria-hidden="true" /> Saving...</>
                          ) : isEditing ? (
                            "Save Changes"
                          ) : (
                            "Enable Briefings"
                          )}
                        </Button>
                      </div>
                    </CardContent>
                  </SpotlightCard>
                );
              })()
            ) : !briefingCronJob ? (
              <SpotlightCard className="p-0 glass-card-enhanced overflow-hidden rounded-xl">
                <CardHeader className="px-4 pt-3 pb-1.5">
                  <CardTitle className="text-sm">
                    📋 <DecryptedText text="Daily Briefing" speed={30} maxIterations={6} animateOn="view" sequential className="text-sm font-semibold" encryptedClassName="text-sm font-semibold text-amber-500/40" />
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3">
                  <div className="text-center py-4 space-y-2">
                    <div className="text-4xl opacity-30" aria-hidden="true">📋</div>
                    <p className="text-sm text-muted-foreground">Daily briefings are not configured</p>
                    <p className="text-xs text-muted-foreground/60">
                      {briefingAgent
                        ? "Set up a schedule to start receiving automated briefings."
                        : "Assign an agent in the Agent Guild inventory, then set up a schedule."}
                    </p>
                    <div className="flex justify-center gap-2 mt-2">
                      {!briefingAgent && (
                        <Button asChild variant="outline" size="sm">
                          <Link href="/agent-guild">Go to Agent Guild</Link>
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={() => { setBriefingAgentId(briefingSlot?.agentId || ""); setBriefingSetupMode(true); }}
                        className="bg-amber-500 hover:bg-amber-600 text-white"
                      >
                        Set Up
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </SpotlightCard>
            ) : (() => {
              const scheduleLabel = briefingCronJob.scheduleLabel || parseCronToHuman(briefingCronJob.schedule);
              const summary = latestBriefing?.summary;
              return (
                <SpotlightCard className="p-0 glass-card-enhanced overflow-hidden rounded-xl">
                  <CardHeader className="flex flex-row items-center gap-2 px-4 pt-3 pb-1.5">
                    <CardTitle className="text-sm">
                      📋 <DecryptedText text="Daily Briefing" speed={30} maxIterations={6} animateOn="view" sequential className="text-sm font-semibold" encryptedClassName="text-sm font-semibold text-amber-500/40" />
                    </CardTitle>
                    <Link href="/summaries" className="text-xs">
                      <ShinyText text="View All →" speed={3} color="#6d4fa0" shineColor="#7221FA" className="text-xs" />
                    </Link>
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-amber-500/10 border-amber-500/20 text-amber-400">
                      {scheduleLabel}
                    </Badge>
                    <button
                      onClick={openBriefingEditor}
                      className="p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      title="Edit briefing settings"
                      aria-label="Edit briefing settings"
                    >
                      <Pencil className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </CardHeader>
                  <CardContent className="px-4 pb-3 grid gap-4 sm:grid-cols-[auto_1fr]">
                    {/* Agent badge */}
                    {briefingAgent ? (
                      <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10 sm:w-56">
                        <img
                          src={briefingAgent.avatarUrl || getAgentAvatarUrl(briefingAgent.name, briefingAgent.type)}
                          alt=""
                          className="w-8 h-8 rounded-full border-2 border-amber-500/30"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{briefingAgent.name}</p>
                          <p className="text-[10px] text-muted-foreground">
                            Briefing Agent · {latestBriefing?.date || new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                          </p>
                        </div>
                        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${briefingAgent.status === "online" ? "bg-emerald-400" : briefingAgent.status === "busy" ? "bg-amber-400" : "bg-gray-400"}`} />
                      </div>
                    ) : cronAgentId ? (
                      <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10 sm:w-56">
                        <div className="w-8 h-8 rounded-full border-2 border-amber-500/30 bg-amber-500/10 flex items-center justify-center">
                          <span className="text-xs" aria-hidden="true">🤖</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">Agent {cronAgentId.slice(0, 8)}...</p>
                          <p className="text-[10px] text-muted-foreground">Briefing Agent (loading...)</p>
                        </div>
                      </div>
                    ) : <div />}

                    {/* Summary data from Firestore */}
                    {summary ? (
                      <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-base" aria-hidden="true">✅</span>
                          <span className="text-muted-foreground">Tasks completed:</span>
                          <span className="font-medium text-emerald-400">{summary.tasksCompleted}</span>
                          {summary.tasksFailed > 0 && (
                            <span className="text-red-400 text-xs">({summary.tasksFailed} failed)</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-base" aria-hidden="true">🪙</span>
                          <span className="text-muted-foreground">Tokens used:</span>
                          <span className="font-medium">{(summary.tokensUsed / 1000).toFixed(1)}K</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-base" aria-hidden="true">💰</span>
                          <span className="text-muted-foreground">Cost:</span>
                          <span className="font-medium">${summary.costUsd.toFixed(4)}</span>
                        </div>

                        {summary.highlights.length > 0 && (
                          <div className="sm:col-span-2 pt-2 border-t border-border space-y-1.5">
                            <p className="text-xs font-semibold text-muted-foreground/60 uppercase tracking-wider">Highlights</p>
                            {summary.highlights.map((h, i) => (
                              <div key={i} className="flex items-center gap-2 text-xs">
                                <span className="shrink-0" aria-hidden="true">✨</span>
                                <span className="text-muted-foreground truncate">{h}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {summary.topActivities.length > 0 && (
                          <div className="sm:col-span-2 pt-2 border-t border-border space-y-1.5">
                            <p className="text-xs font-semibold text-muted-foreground/60 uppercase tracking-wider">Top Activities</p>
                            {summary.topActivities.slice(0, 3).map((a, i) => (
                              <div key={i} className="flex items-center gap-2 text-xs">
                                <span className="shrink-0" aria-hidden="true">🎯</span>
                                <span className="text-muted-foreground truncate flex-1">{a.details}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {summary.errors.length > 0 && (
                          <div className="sm:col-span-2 pt-2 border-t border-border space-y-1.5">
                            <p className="text-xs font-semibold text-muted-foreground/60 uppercase tracking-wider text-red-400">Errors</p>
                            {summary.errors.slice(0, 2).map((e, i) => (
                              <div key={i} className="flex items-center gap-2 text-xs text-red-400/80">
                                <span className="shrink-0" aria-hidden="true">⚠️</span>
                                <span className="truncate">{e.lastError}</span>
                                <Badge variant="outline" className="text-[8px] px-1 border-red-500/20">{e.count}x</Badge>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="py-1 space-y-1">
                        <p className="text-sm text-muted-foreground">No briefing generated yet</p>
                        <p className="text-xs text-muted-foreground/60">
                          Schedule: {scheduleLabel}. Summaries will appear here automatically.
                        </p>
                      </div>
                    )}
                  </CardContent>
                </SpotlightCard>
              );
            })()}
          </Reveal>

          {/* ═══ Analytics ═══ */}
          <div className="space-y-3">
            <SectionLabel>Analytics</SectionLabel>
            <div className="grid gap-3 grid-cols-1 lg:grid-cols-3">
              <Reveal delay={0.1}><TaskVelocityChart data={taskVelocity} /></Reveal>
              <Reveal delay={0.13}><CostTrendChart data={dailyCosts} /></Reveal>
              <Reveal delay={0.16}><AgentWorkloadChart data={agentWorkload} /></Reveal>
            </div>
            <div className="grid gap-3 grid-cols-1 lg:grid-cols-3">
              <Reveal delay={0.1} className="lg:col-span-2">
                <ActivityHeatmapChart data={activityHeatmap} />
              </Reveal>
              <Reveal delay={0.13}>
                <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden rounded-xl">
                  <CardHeader className="px-4 pt-3 pb-1.5">
                    <CardTitle className="text-sm">📈 Task Breakdown</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 px-4 pb-3">
                    {totalTaskCount === 0 ? (
                      <div className="text-center py-4 text-muted-foreground">
                        <p>No tasks yet</p>
                      </div>
                    ) : (
                      <>
                        <div className="h-4 bg-muted rounded-full overflow-hidden flex">
                          {done > 0 && <div className="h-full bg-emerald-500" style={{ width: `${(done / totalTaskCount) * 100}%` }} title={`Done: ${done}`} />}
                          {inProgress > 0 && <div className="h-full bg-amber-500" style={{ width: `${(inProgress / totalTaskCount) * 100}%` }} title={`In Progress: ${inProgress}`} />}
                          {todo > 0 && <div className="h-full bg-muted-foreground/30" style={{ width: `${(todo / totalTaskCount) * 100}%` }} title={`Todo: ${todo}`} />}
                        </div>
                        <div className="space-y-2">
                          {[
                            { label: "Done", count: done, color: "bg-emerald-500", pct: ((done / totalTaskCount) * 100).toFixed(0) },
                            { label: "In Progress", count: inProgress, color: "bg-amber-500", pct: ((inProgress / totalTaskCount) * 100).toFixed(0) },
                            { label: "Todo", count: todo, color: "bg-muted-foreground/30", pct: ((todo / totalTaskCount) * 100).toFixed(0) },
                          ].map(item => (
                            <div key={item.label} className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-2">
                                <span className={`w-3 h-3 rounded-sm ${item.color}`} />
                                <span>{item.label}</span>
                              </div>
                              <span className="text-muted-foreground tabular-nums">
                                {item.count} <span className="text-xs">({item.pct}%)</span>
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="pt-2 border-t border-border text-center">
                          <span className="text-2xl font-bold text-emerald-500">
                            {totalTaskCount > 0 ? ((done / totalTaskCount) * 100).toFixed(0) : 0}%
                          </span>
                          <p className="text-xs text-muted-foreground">Completion Rate</p>
                        </div>
                      </>
                    )}
                  </CardContent>
                </SpotlightCard>
              </Reveal>
            </div>
            <div className="grid gap-3 grid-cols-1 lg:grid-cols-3">
              <Reveal delay={0.1} className="lg:col-span-2">
                <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden rounded-xl">
                  <CardHeader className="flex flex-row items-center gap-2 px-4 pt-3 pb-1.5">
                    <CardTitle className="text-sm">📜 Activity Feed</CardTitle>
                    <Link href="/activity" className="text-xs">
                      <ShinyText text="View all →" speed={3} color="#6d4fa0" shineColor="#7221FA" className="text-xs" />
                    </Link>
                  </CardHeader>
                  <CardContent className="space-y-1 px-4 pb-3">
                    {activityFeed.length === 0 ? (
                      <div className="text-center py-4 text-muted-foreground">
                        <p>No activity yet</p>
                        <p className="text-xs mt-1">Events will appear here as your agent-guild operates</p>
                      </div>
                    ) : (
                      activityFeed.map((event) => {
                        const config = EVENT_TYPE_CONFIG[event.eventType] || { label: event.eventType, icon: "📌", color: "text-muted-foreground" };
                        return (
                          <div key={event.id} className="flex items-start gap-3 py-2 border-b border-border last:border-0">
                            <span className="text-base shrink-0 mt-0.5" aria-hidden="true">{config.icon}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{event.description}</p>
                              <p className="text-xs text-muted-foreground">
                                {event.actorName && <span>{event.actorName} · </span>}
                                {formatRelativeTime(event.createdAt)}
                              </p>
                            </div>
                            <Badge variant="outline" className={`text-[10px] shrink-0 ${config.color}`}>
                              {config.label}
                            </Badge>
                          </div>
                        );
                      })
                    )}
                  </CardContent>
                </SpotlightCard>
              </Reveal>
              <Reveal delay={0.13}>
                <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden rounded-xl">
                  <CardHeader className="px-4 pt-3 pb-1.5">
                    <CardTitle className="text-sm">🏆 Top Performers</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-3">
                    {topPerformers.length === 0 ? (
                      <div className="text-center py-4 text-muted-foreground text-xs">No completed tasks yet</div>
                    ) : (
                      <div className="space-y-2">
                        {topPerformers.map((agent, index) => (
                          <div key={agent.id} className="flex items-center gap-2 py-1">
                            <span className="text-lg" aria-hidden="true">{index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏅'}</span>
                            <span className="text-xs truncate flex-1">{agent.name}</span>
                            <Badge variant="outline" className="text-[10px]">{agent.tasksCompleted}</Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </SpotlightCard>
              </Reveal>
            </div>
          </div>

          {/* ═══ Integrations ═══ */}
          <div className="space-y-3">
            <SectionLabel>Integrations</SectionLabel>
            <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
              <Reveal delay={0.1}><UsageWidget /></Reveal>
              <Reveal delay={0.13}><CronWidget /></Reveal>
              <Reveal delay={0.16}>
                {currentOrg ? <CoordinatorDashboardWidget orgId={currentOrg.id} /> : null}
              </Reveal>
            </div>
            <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
              <Reveal delay={0.1}>
                {userAgent && currentOrg ? (
                  <AgentMessagesWidget agentId={userAgent.id} orgId={currentOrg.id} />
                ) : (
                  <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden rounded-xl">
                    <CardHeader className="px-4 pt-3 pb-1.5">
                      <CardTitle className="text-sm">💬 Agent Messages</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-3">
                      <div className="text-center py-4 text-muted-foreground">
                        <p className="text-sm">Register as an agent to view messages</p>
                        <Button asChild variant="outline" size="sm" className="mt-2">
                          <Link href="/agents">Register Agent</Link>
                        </Button>
                      </div>
                    </CardContent>
                  </SpotlightCard>
                )}
              </Reveal>
              <Reveal delay={0.13}>
                {userAgent && currentOrg ? (
                  <AgentSessionsWidget agentId={userAgent.id} orgId={currentOrg.id} />
                ) : (
                  <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden rounded-xl">
                    <CardHeader className="px-4 pt-3 pb-1.5">
                      <CardTitle className="text-sm">🔄 Agent Sessions</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-3">
                      <div className="text-center py-4 text-muted-foreground">
                        <p className="text-sm">Register as an agent to view sessions</p>
                        <Button asChild variant="outline" size="sm" className="mt-2">
                          <Link href="/agents">Register Agent</Link>
                        </Button>
                      </div>
                    </CardContent>
                  </SpotlightCard>
                )}
              </Reveal>
              <Reveal delay={0.16}><VitalsWidget /></Reveal>
            </div>
            <Reveal delay={0.1}>
              <LiveFeedWidget />
            </Reveal>
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
      </Tabs>
    </div>
  );
}
