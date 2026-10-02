/** Dashboard cards — the list cards shown on the dashboard Overview tab. */
'use client';

import type { ReactNode } from "react";
import Link from "next/link";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import SpotlightCard from "@/components/reactbits/SpotlightCard";
import ShinyText from "@/components/reactbits/ShinyText";
import DecryptedText from "@/components/reactbits/DecryptedText";
import { CheckCircle2, ChevronRight } from "lucide-react";
import type { Task, Agent, Job } from "@/lib/firestore";
import { EVENT_TYPE_CONFIG, type ActivityEvent } from "@/lib/activity";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export function formatRelativeTime(date: Date | null): string {
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

/** Millis from a Firestore Timestamp, Date, string or number; 0 when unparseable. */
export function toMillis(ts: unknown): number {
  if (!ts) return 0;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === "object" && "seconds" in ts) return (ts as { seconds: number }).seconds * 1000;
  const t = new Date(ts as string | number).getTime();
  return isNaN(t) ? 0 : t;
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
  in_progress: "badge-neon-amber",
  completed: "badge-neon-default",
  closed: "badge-neon-default",
};

const jobStatusLabels: Record<string, string> = {
  open: "Open",
  claimed: "Claimed",
  in_progress: "In Progress",
  completed: "Completed",
  closed: "Closed",
};

/* ------------------------------------------------------------------ */
/*  Shell                                                              */
/* ------------------------------------------------------------------ */

/** Card frame shared by every dashboard card: emoji + title, optional "View all" link. */
export function DashboardCard({
  icon,
  title,
  href,
  className = "",
  children,
}: {
  icon: string;
  title: string;
  href?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <SpotlightCard className={`p-0 glass-card-enhanced h-full overflow-hidden rounded-xl ${className}`}>
      <CardHeader className="flex flex-row items-center gap-2 px-4 pt-3 pb-1.5">
        <CardTitle className="text-sm">
          <span aria-hidden="true">{icon}</span>{" "}
          <DecryptedText text={title} speed={30} maxIterations={6} animateOn="view" sequential className="text-sm font-semibold" encryptedClassName="text-sm font-semibold text-amber-500/40" />
        </CardTitle>
        {href && (
          <Link href={href} className="text-xs ml-auto">
            <ShinyText text="View all →" speed={3} color="#6d4fa0" shineColor="#7221FA" className="text-xs" />
          </Link>
        )}
      </CardHeader>
      <CardContent className="px-4 pb-3">{children}</CardContent>
    </SpotlightCard>
  );
}

function EmptyState({ children, href, cta }: { children: ReactNode; href?: string; cta?: string }) {
  return (
    <div className="text-center py-4 text-muted-foreground">
      <p className="text-sm">{children}</p>
      {href && cta && (
        <Link href={href} className="text-amber-600 dark:text-amber-400 hover:underline text-sm">
          {cta}
        </Link>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Needs Attention                                                    */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

interface AttentionItem {
  key: string;
  tone: "red" | "amber";
  label: string;
  detail: string;
  href: string;
}

/** Surfaces work that is blocked or waiting on a human. Pure derivation from already-loaded data. */
export function NeedsAttentionCard({
  tasks,
  jobs,
  agents,
  briefingErrorCount,
}: {
  tasks: Task[];
  jobs: Job[];
  agents: Agent[];
  briefingErrorCount: number;
}) {
  const now = Date.now();
  const agentById = new Map(agents.map(a => [a.id, a]));

  const stranded = tasks.filter(t =>
    t.status === "in_progress" &&
    (!t.assigneeAgentId || agentById.get(t.assigneeAgentId)?.status === "offline")
  );
  const urgentUnassigned = tasks.filter(t => t.status === "todo" && t.priority === "high" && !t.assigneeAgentId);
  const staleJobs = jobs.filter(j => j.status === "open" && !j.takenByAgentId && now - toMillis(j.createdAt) > DAY_MS);

  const items: AttentionItem[] = [];
  if (stranded.length > 0) {
    items.push({
      key: "stranded",
      tone: "red",
      label: `${stranded.length} in-progress task${stranded.length === 1 ? "" : "s"} stalled`,
      detail: "Assigned to an offline agent or nobody",
      href: "/missions",
    });
  }
  if (briefingErrorCount > 0) {
    items.push({
      key: "briefing-errors",
      tone: "red",
      label: `${briefingErrorCount} error${briefingErrorCount === 1 ? "" : "s"} in latest briefing`,
      detail: "Reported by the daily briefing agent",
      href: "/summaries",
    });
  }
  if (urgentUnassigned.length > 0) {
    items.push({
      key: "urgent",
      tone: "amber",
      label: `${urgentUnassigned.length} high-priority task${urgentUnassigned.length === 1 ? "" : "s"} unassigned`,
      detail: "Waiting for an agent",
      href: "/missions",
    });
  }
  if (staleJobs.length > 0) {
    items.push({
      key: "stale-jobs",
      tone: "amber",
      label: `${staleJobs.length} open job${staleJobs.length === 1 ? "" : "s"} unclaimed for 24h+`,
      detail: "No agent has picked these up",
      href: "/jobs",
    });
  }

  return (
    <DashboardCard icon="🚨" title="Needs Attention">
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1.5 py-6 text-center">
          <CheckCircle2 className="h-6 w-6 text-emerald-500" aria-hidden="true" />
          <p className="text-sm font-medium">All clear</p>
          <p className="text-xs text-muted-foreground">Nothing is blocked or waiting on you.</p>
        </div>
      ) : (
        <ul className="space-y-1">
          {items.map(item => (
            <li key={item.key}>
              <Link
                href={item.href}
                className="group flex items-center gap-3 rounded-lg px-2 py-2 -mx-2 hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${item.tone === "red" ? "bg-red-500" : "bg-amber-500"}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{item.label}</p>
                  <p className="text-xs text-muted-foreground truncate">{item.detail}</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-foreground shrink-0" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DashboardCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Recent lists                                                       */
/* ------------------------------------------------------------------ */

export function RecentTasksCard({ tasks }: { tasks: (Task & { agentName?: string; projectName?: string })[] }) {
  return (
    <DashboardCard icon="📋" title="Recent Tasks" href="/missions">
      {tasks.length === 0 ? (
        <EmptyState href="/missions" cta="Create your first task →">No tasks yet</EmptyState>
      ) : (
        <div className="space-y-0.5">
          {tasks.map(task => (
            <div key={task.id} className="flex items-center justify-between gap-2 py-2 border-b border-border last:border-0">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{task.title}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {task.projectName} · {task.agentName}
                </p>
              </div>
              <Badge variant="outline" className={`text-[10px] shrink-0 ${statusColors[task.status]}`}>
                {statusLabels[task.status]}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </DashboardCard>
  );
}

export function RecentJobsCard({ jobs }: { jobs: Job[] }) {
  return (
    <DashboardCard icon="💼" title="Recent Jobs" href="/jobs">
      {jobs.length === 0 ? (
        <EmptyState href="/jobs" cta="Post your first job →">No jobs posted yet</EmptyState>
      ) : (
        <div className="space-y-0.5">
          {jobs.map(job => (
            <div key={job.id} className="flex items-center justify-between gap-2 py-2 border-b border-border last:border-0">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{job.title}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {job.reward && <span>{job.reward} · </span>}
                  {job.priority} priority
                </p>
              </div>
              <Badge variant="outline" className={`text-[10px] shrink-0 ${jobStatusColors[job.status] ?? ""}`}>
                {jobStatusLabels[job.status] ?? job.status}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </DashboardCard>
  );
}

export function ActivityFeedCard({ events }: { events: ActivityEvent[] }) {
  return (
    <DashboardCard icon="📜" title="Activity" href="/activity">
      {events.length === 0 ? (
        <EmptyState>No activity yet</EmptyState>
      ) : (
        <div className="space-y-0.5">
          {events.map(event => {
            const config = EVENT_TYPE_CONFIG[event.eventType] || { label: event.eventType, icon: "📌", color: "text-muted-foreground" };
            return (
              <div key={event.id} className="flex items-start gap-2.5 py-2 border-b border-border last:border-0">
                <span className="text-sm shrink-0 mt-0.5" aria-hidden="true">{config.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{event.description}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {event.actorName && <span>{event.actorName} · </span>}
                    {formatRelativeTime(event.createdAt)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </DashboardCard>
  );
}

export function TopPerformersCard({ agents }: { agents: Agent[] }) {
  const top = agents
    .filter(a => a.tasksCompleted && a.tasksCompleted > 0)
    .sort((a, b) => (b.tasksCompleted || 0) - (a.tasksCompleted || 0))
    .slice(0, 5);

  return (
    <DashboardCard icon="🏆" title="Top Performers">
      {top.length === 0 ? (
        <EmptyState>No completed tasks yet</EmptyState>
      ) : (
        <ol className="space-y-2">
          {top.map((agent, index) => (
            <li key={agent.id} className="flex items-center gap-2 py-1">
              <span className="w-5 text-xs text-muted-foreground tabular-nums text-right">{index + 1}</span>
              <span className="text-sm truncate flex-1">{agent.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{agent.tasksCompleted} done</span>
            </li>
          ))}
        </ol>
      )}
    </DashboardCard>
  );
}
