/**
 * Command Center — the top of /dashboard. Answers "what does my agent fleet
 * need from me today?": live fleet counts, the three primary actions
 * (find / post / hire), work in flight, and agents worth hiring.
 */
"use client";

import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { Search, Zap, Handshake, RotateCcw, ArrowRight, Check, Bot, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QuickPostJobDialog } from "@/components/jobs/quick-post-job-dialog";
import SpotlightCard from "@/components/reactbits/SpotlightCard";
import { cn } from "@/lib/utils";
import type { Agent, Job, Task } from "@/lib/firestore";
import type { AgentPassport } from "@/lib/agent-passport";
import { formatRelativeTime, toMillis } from "@/components/dashboard/dashboard-cards";

/* ------------------------------------------------------------------ */
/*  Hero                                                               */
/* ------------------------------------------------------------------ */

interface Readout {
  label: string;
  value: string;
  href: string;
  /** Highlights the readout when it needs the operator's attention. */
  alert?: boolean;
}

export function CommandHero({
  greeting,
  orgName,
  readouts,
  lastUpdated,
  refreshing,
  onRefresh,
}: {
  greeting: string;
  orgName: string;
  readouts: Readout[];
  lastUpdated: Date | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <section className="relative overflow-hidden rounded-xl border border-amber-500/15 bg-gradient-to-br from-amber-500/[0.06] via-transparent to-orange-500/[0.04] px-5 py-5 sm:px-6">
      {/* Faint grid — the "mission control" backdrop */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.35] dark:opacity-[0.5] [background-image:linear-gradient(to_right,rgba(245,158,11,0.07)_1px,transparent_1px),linear-gradient(to_bottom,rgba(245,158,11,0.07)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(ellipse_at_top_left,black_30%,transparent_75%)]"
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(114,33,250,0.08),transparent_60%)]" />

      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-600/80 dark:text-amber-400/70 flex items-center gap-2">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-reduce:hidden" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
            </span>
            {orgName} · Command Center
          </p>
          <h1 className="mt-1.5 text-2xl sm:text-3xl font-bold tracking-tight text-glow-gold">
            {greeting}, Guildmaster
          </h1>
          {lastUpdated && (
            <p className="mt-1 text-xs text-[hsl(var(--muted-foreground)/0.6)] tabular-nums">Updated {formatRelativeTime(lastUpdated)}</p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          className="gap-1.5 h-8 shrink-0 border-amber-500/20 hover:border-amber-500/40 hover:bg-amber-500/5"
        >
          <RotateCcw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} aria-hidden="true" />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      <dl className="relative mt-5 grid grid-cols-2 sm:grid-cols-4 gap-px overflow-hidden rounded-lg border border-[hsl(var(--border)/0.6)] bg-[hsl(var(--border)/0.6)]">
        {readouts.map((r) => (
          <Link
            key={r.label}
            href={r.href}
            className="group bg-[hsl(var(--background)/0.8)] backdrop-blur-sm px-4 py-3 transition-colors hover:bg-amber-500/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-inset"
          >
            <dt className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{r.label}</dt>
            <dd
              className={cn(
                "mt-0.5 text-2xl font-semibold tabular-nums tracking-tight",
                r.alert ? "text-amber-600 dark:text-amber-400" : "",
              )}
            >
              {r.value}
            </dd>
          </Link>
        ))}
      </dl>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Primary actions                                                    */
/* ------------------------------------------------------------------ */

function ActionTileBody({
  icon: Icon,
  title,
  hint,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  hint: string;
}) {
  return (
    <>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400 transition-colors group-hover:bg-amber-500/15">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-sm font-semibold tracking-wide uppercase">{title}</span>
        <span className="block text-xs text-muted-foreground truncate">{hint}</span>
      </span>
      <ArrowRight
        className="h-4 w-4 shrink-0 text-[hsl(var(--muted-foreground)/0.4)] transition-transform group-hover:translate-x-0.5 group-hover:text-amber-500 motion-reduce:transition-none"
        aria-hidden="true"
      />
    </>
  );
}

const tileClass =
  "group flex w-full items-center gap-3 rounded-xl border border-[hsl(var(--border)/0.6)] bg-[hsl(var(--card)/0.6)] px-4 py-3.5 transition-colors hover:border-amber-500/40 hover:bg-amber-500/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50";

export function ActionTiles({ onJobPosted }: { onJobPosted: () => void }) {
  return (
    <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
      <Link href="/discover" className={tileClass}>
        <ActionTileBody icon={Search} title="Find Agent" hint="Search the guild by skill & trust" />
      </Link>
      <QuickPostJobDialog
        onJobCreated={onJobPosted}
        renderTrigger={(open) => (
          <button type="button" onClick={open} className={tileClass}>
            <ActionTileBody icon={Zap} title="Post Job" hint="Title, budget, done — in seconds" />
          </button>
        )}
      />
      <Link href="/gigs" className={tileClass}>
        <ActionTileBody icon={Handshake} title="Hire Agent" hint="Order a service from the market" />
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Panels                                                             */
/* ------------------------------------------------------------------ */

function Panel({ title, href, linkLabel = "View all", children }: { title: string; href?: string; linkLabel?: string; children: ReactNode }) {
  return (
    <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden rounded-xl">
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h2>
        <div className="h-px flex-1 bg-[hsl(var(--border)/0.6)]" />
        {href && (
          <Link href={href} className="text-xs text-muted-foreground hover:text-amber-500 transition-colors shrink-0">
            {linkLabel} →
          </Link>
        )}
      </div>
      <div className="px-2 pb-2">{children}</div>
    </SpotlightCard>
  );
}

function EmptyRow({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
      <p>{children}</p>
      {action}
    </div>
  );
}

/* ── Active work ── */

type Stage = "claimed" | "working" | "review" | "done";

const STAGES: Stage[] = ["claimed", "working", "review", "done"];

const STAGE_META: Record<Stage, { label: string; dot: string; text: string }> = {
  claimed: { label: "Claimed", dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400" },
  working: { label: "In progress", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
  review: { label: "Waiting review", dot: "bg-violet-500", text: "text-violet-600 dark:text-violet-400" },
  done: { label: "Completed", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
};

interface WorkItem {
  id: string;
  title: string;
  agentName: string;
  stage: Stage;
  href: string;
  at: number;
}

/** Jobs: claimed → in_progress → delivered (completed + reviewStatus pending) → approved. Tasks fill in as "working". */
export function buildWorkItems(jobs: Job[], tasks: Task[], agents: Agent[]): WorkItem[] {
  const agentName = new Map(agents.map((a) => [a.id, a.name]));
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const jobItems: WorkItem[] = [];
  for (const j of jobs) {
    let stage: Stage | null = null;
    if (j.status === "claimed") stage = "claimed";
    else if (j.status === "in_progress") stage = "working";
    else if (j.status === "completed" && j.reviewStatus === "pending") stage = "review";
    else if (j.status === "completed" && j.reviewStatus !== "rejected") stage = "done";
    if (!stage) continue;
    const at = toMillis(j.completedAt) || toMillis(j.updatedAt) || toMillis(j.claimedAt) || toMillis(j.createdAt);
    // Finished work only earns a row for a week, so the panel stays about what's moving.
    if (stage === "done" && now - at > WEEK_MS) continue;
    jobItems.push({
      id: `job-${j.id}`,
      title: j.title,
      agentName: j.completedByAgentName || j.claimedByAgentName || (j.takenByAgentId && agentName.get(j.takenByAgentId)) || "Unassigned",
      stage,
      href: `/jobs/${j.id}`,
      at,
    });
  }

  const taskItems: WorkItem[] = tasks
    .filter((t) => t.status === "in_progress")
    .map((t) => ({
      id: `task-${t.id}`,
      title: t.title,
      agentName: (t.assigneeAgentId && agentName.get(t.assigneeAgentId)) || "Unassigned",
      stage: "working" as const,
      href: "/kanban",
      at: toMillis(t.createdAt),
    }));

  // Needs-a-human first (review), then live work, then recent wins.
  const rank: Record<Stage, number> = { review: 0, working: 1, claimed: 2, done: 3 };
  return [...jobItems, ...taskItems].sort((a, b) => rank[a.stage] - rank[b.stage] || b.at - a.at);
}

function StageTrack({ stage }: { stage: Stage }) {
  const idx = STAGES.indexOf(stage);
  const meta = STAGE_META[stage];
  return (
    <div className="flex items-center gap-0.5" role="img" aria-label={`Stage ${idx + 1} of ${STAGES.length}: ${meta.label}`}>
      {STAGES.map((s, i) => (
        <span
          key={s}
          className={cn(
            "h-1.5 w-4 rounded-full",
            i < idx ? "bg-[hsl(var(--muted-foreground)/0.5)]" : i === idx ? meta.dot : "bg-[hsl(var(--border))]",
            i === idx && stage === "working" && "animate-pulse motion-reduce:animate-none",
          )}
        />
      ))}
    </div>
  );
}

export function ActiveWorkPanel({ items }: { items: WorkItem[] }) {
  const shown = items.slice(0, 6);
  return (
    <Panel title="Active Work" href="/jobs">
      {shown.length === 0 ? (
        <EmptyRow action={<Button asChild size="sm" variant="outline"><Link href="/jobs">Open the job board</Link></Button>}>
          Nothing in flight. Post a job or dispatch your fleet below.
        </EmptyRow>
      ) : (
        <ul className="divide-y divide-[hsl(var(--border)/0.5)]">
          {shown.map((w) => {
            const meta = STAGE_META[w.stage];
            return (
              <li key={w.id}>
                <Link
                  href={w.href}
                  className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-[hsl(var(--muted)/0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
                >
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", meta.dot)} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{w.agentName}</span>
                    <span className="block truncate text-xs text-muted-foreground">{w.title}</span>
                  </span>
                  <span className="hidden sm:flex flex-col items-end gap-1 shrink-0">
                    <span className={cn("text-xs font-medium", meta.text)}>{meta.label}</span>
                    <StageTrack stage={w.stage} />
                  </span>
                  <span className="sm:hidden shrink-0">
                    {w.stage === "done" ? (
                      <Check className="h-4 w-4 text-emerald-500" aria-label="Completed" />
                    ) : (
                      <span className={cn("text-xs font-medium", meta.text)}>{meta.label}</span>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {items.length > shown.length && (
        <p className="px-2 pt-1 pb-0.5 text-xs text-[hsl(var(--muted-foreground)/0.7)]">+{items.length - shown.length} more</p>
      )}
    </Panel>
  );
}

/* ── Recommended agents ── */

type DirectoryAgent = AgentPassport;

function trustTone(score: number) {
  if (score >= 85) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 65) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

/**
 * Public, edge-cached directory (/api/v1/directory) — agents from other orgs
 * that opted into a public profile. Your own fleet is excluded: these are
 * agents you could hire, not ones you already run.
 */
export function RecommendedAgentsPanel({ ownAgentIds }: { ownAgentIds: string[] }) {
  const [agents, setAgents] = useState<DirectoryAgent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/directory?limit=24")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { agents?: DirectoryAgent[] }) => { if (!cancelled) setAgents(d.agents ?? []); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const ranked = useMemo(() => {
    if (!agents) return [];
    const own = new Set(ownAgentIds);
    return agents
      .filter((a) => !own.has(a.agentId))
      .sort((a, b) =>
        (b.reputation?.trustScore ?? -1) - (a.reputation?.trustScore ?? -1) ||
        (b.reputation?.tasksCompleted ?? 0) - (a.reputation?.tasksCompleted ?? 0),
      )
      .slice(0, 5);
  }, [agents, ownAgentIds]);

  return (
    <Panel title="Recommended Agents" href="/discover" linkLabel="Discover">
      {agents === null && !failed ? (
        <ul className="space-y-1 px-2 py-1" aria-busy="true" aria-label="Loading recommended agents">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="h-11 rounded-lg skeleton-shimmer" style={{ animationDelay: `${i * 0.05}s` }} />
          ))}
        </ul>
      ) : failed ? (
        <EmptyRow action={<Button asChild size="sm" variant="outline"><Link href="/discover">Search the guild</Link></Button>}>
          Couldn’t load the agent directory.
        </EmptyRow>
      ) : ranked.length === 0 ? (
        <EmptyRow action={<Button asChild size="sm" variant="outline"><Link href="/gigs">Browse gigs</Link></Button>}>
          No public agents to recommend yet.
        </EmptyRow>
      ) : (
        <ul className="divide-y divide-[hsl(var(--border)/0.5)]">
          {ranked.map((a) => {
            const trust = a.reputation?.trustScore;
            const jobs = a.reputation?.tasksCompleted;
            const skills = [...a.capabilities.map((c) => c.name || c.key), ...a.reportedSkills.map((s) => s.name || s.id)].slice(0, 2);
            return (
              <li key={a.agentId} className="flex items-center gap-3 px-2 py-2">
                <span className="relative shrink-0">
                  {a.avatarUrl ? (
                    <img src={a.avatarUrl} alt="" className="h-8 w-8 rounded-lg object-cover" />
                  ) : (
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--muted))] text-muted-foreground">
                      <Bot className="h-4 w-4" aria-hidden="true" />
                    </span>
                  )}
                  {a.status === "online" && (
                    <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-[hsl(var(--background))]" aria-label="Online" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{a.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {skills.length ? skills.join(" · ") : a.type}
                  </span>
                </span>
                <span className="hidden sm:flex flex-col items-end shrink-0 tabular-nums">
                  {trust != null ? (
                    <span className={cn("flex items-center gap-1 text-xs font-semibold", trustTone(trust))}>
                      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                      Trust {trust}
                    </span>
                  ) : (
                    <span className="text-xs text-[hsl(var(--muted-foreground)/0.6)]">Score private</span>
                  )}
                  {jobs != null && <span className="text-[11px] text-muted-foreground">{jobs.toLocaleString()} jobs</span>}
                </span>
                <Button asChild size="sm" variant="ghost" className="h-7 px-2.5 text-xs shrink-0 hover:text-amber-600 hover:bg-amber-500/10">
                  <Link href="/gigs" aria-label={`Hire ${a.name}`}>Hire</Link>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
