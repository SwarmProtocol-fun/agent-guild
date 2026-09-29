/** Metrics — Organization, Agent, and Project performance metrics with tab navigation. */
"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
    BarChart3, TrendingUp, Users, CheckCircle2, Clock,
    Loader2, Shield, Zap, Trophy, Target, Bot, FolderKanban,
    Building2, Activity, Briefcase, XCircle,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useOrg } from "@/contexts/OrgContext";
import { useAuthAddress } from "@/hooks/useAuthAddress";
import { getPendingCount } from "@/lib/approvals";
import {
    getProjectsByOrg, getAgentsByOrg, getTasksByOrg, getJobsByOrg,
    type Project, type Agent, type Task, type Job,
} from "@/lib/firestore";

// ═══════════════════════════════════════════════════════════════
// KPI Card
// ═══════════════════════════════════════════════════════════════

function KpiCard({
    label, value, subLabel, icon: Icon, iconColor, iconBg,
}: {
    label: string;
    value: string | number;
    subLabel?: string;
    icon: typeof BarChart3;
    iconColor: string;
    iconBg: string;
}) {
    return (
        <Card className="p-4 bg-card border-border">
            <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl ${iconBg}`}>
                    <Icon className={`h-5 w-5 ${iconColor}`} />
                </div>
                <div className="min-w-0">
                    <p className="text-2xl font-bold tracking-tight">{value}</p>
                    <p className="text-xs text-muted-foreground truncate">{label}</p>
                    {subLabel && <p className="text-[10px] text-muted-foreground truncate">{subLabel}</p>}
                </div>
            </div>
        </Card>
    );
}

// ═══════════════════════════════════════════════════════════════
// Progress Bar
// ═══════════════════════════════════════════════════════════════

function ProgressBar({ value, color, className }: { value: number; color: string; className?: string }) {
    return (
        <div className={`h-2 bg-muted rounded-full overflow-hidden ${className || ""}`}>
            <div
                className={`h-full rounded-full transition-all duration-500 ${color}`}
                style={{ width: `${Math.min(value, 100)}%` }}
            />
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════
// Tab types
// ═══════════════════════════════════════════════════════════════

type MetricsTab = "organization" | "agents" | "projects";

const TABS: { key: MetricsTab; label: string; icon: typeof Building2 }[] = [
    { key: "organization", label: "Organization", icon: Building2 },
    { key: "agents", label: "Agents", icon: Bot },
    { key: "projects", label: "Projects", icon: FolderKanban },
];

// ═══════════════════════════════════════════════════════════════
// Main Page
// ═══════════════════════════════════════════════════════════════

export default function MetricsPage() {
    const { currentOrg } = useOrg();
    const authAddress = useAuthAddress();
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState<MetricsTab>("organization");

    // Raw data
    const [projects, setProjects] = useState<Project[]>([]);
    const [agents, setAgents] = useState<Agent[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [jobs, setJobs] = useState<Job[]>([]);
    const [pendingApprovals, setPendingApprovals] = useState(0);

    const loadData = useCallback(async () => {
        if (!currentOrg) return;
        try {
            setLoading(true);
            const [p, a, t, j, pending] = await Promise.all([
                getProjectsByOrg(currentOrg.id),
                getAgentsByOrg(currentOrg.id),
                getTasksByOrg(currentOrg.id),
                getJobsByOrg(currentOrg.id),
                getPendingCount(currentOrg.id),
            ]);
            setProjects(p);
            setAgents(a);
            setTasks(t);
            setJobs(j);
            setPendingApprovals(pending);
        } catch (err) {
            console.error("Failed to load metrics:", err);
        } finally {
            setLoading(false);
        }
    }, [currentOrg]);

    useEffect(() => { loadData(); }, [loadData]);

    // ── Computed org metrics ──
    const orgMetrics = useMemo(() => {
        const completedTasks = tasks.filter(t => t.status === "done").length;
        const activeTasks = tasks.filter(t => t.status === "in_progress").length;
        const todoTasks = tasks.filter(t => t.status === "todo").length;
        const failedTasks = 0; // no explicit failed status in schema
        const completionRate = tasks.length > 0 ? Math.round((completedTasks / tasks.length) * 100) : 0;
        const onlineAgents = agents.filter(a => a.status === "online").length;
        const busyAgents = agents.filter(a => a.status === "busy").length;
        const openJobs = jobs.filter(j => j.status === "open").length;
        const claimedJobs = jobs.filter(j => j.status === "claimed").length;
        const closedJobs = jobs.filter(j => j.status === "closed").length;

        return {
            totalTasks: tasks.length, completedTasks, activeTasks, todoTasks, failedTasks,
            completionRate, onlineAgents, busyAgents,
            totalAgents: agents.length, totalProjects: projects.length,
            openJobs, claimedJobs, closedJobs, totalJobs: jobs.length,
            pendingApprovals,
        };
    }, [tasks, agents, projects, jobs, pendingApprovals]);

    // ── Computed per-agent metrics ──
    const agentMetrics = useMemo(() => {
        return agents.map(agent => {
            const agentTasks = tasks.filter(t => t.assigneeAgentId === agent.id);
            const completed = agentTasks.filter(t => t.status === "done").length;
            const inProgress = agentTasks.filter(t => t.status === "in_progress").length;
            const total = agentTasks.length;
            const rate = total > 0 ? Math.round((completed / total) * 100) : 0;
            const agentJobs = jobs.filter(j => j.takenByAgentId === agent.id);
            const completedJobs = agentJobs.filter(j => j.status === "closed" || j.status === "completed").length;

            return {
                agent,
                totalTasks: total,
                completedTasks: completed,
                inProgressTasks: inProgress,
                completionRate: rate,
                totalJobs: agentJobs.length,
                completedJobs,
                projectCount: agent.projectIds.length,
            };
        }).sort((a, b) => b.completedTasks - a.completedTasks);
    }, [agents, tasks, jobs]);

    // ── Computed per-project metrics ──
    const projectMetrics = useMemo(() => {
        return projects.map(project => {
            const projTasks = tasks.filter(t => t.projectId === project.id);
            const completed = projTasks.filter(t => t.status === "done").length;
            const inProgress = projTasks.filter(t => t.status === "in_progress").length;
            const todo = projTasks.filter(t => t.status === "todo").length;
            const total = projTasks.length;
            const rate = total > 0 ? Math.round((completed / total) * 100) : 0;
            const projJobs = jobs.filter(j => j.projectId === project.id);
            const assignedAgents = agents.filter(a => a.projectIds.includes(project.id));

            return {
                project,
                totalTasks: total,
                completedTasks: completed,
                inProgressTasks: inProgress,
                todoTasks: todo,
                completionRate: rate,
                totalJobs: projJobs.length,
                agentCount: assignedAgents.length,
                agents: assignedAgents,
            };
        }).sort((a, b) => b.totalTasks - a.totalTasks);
    }, [projects, tasks, jobs, agents]);

    if (!authAddress) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-muted-foreground">
                <BarChart3 className="h-12 w-12 opacity-30" />
                <p>Connect your wallet to view metrics</p>
            </div>
        );
    }

    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20">
                            <BarChart3 className="h-6 w-6 text-amber-500" />
                        </div>
                        Metrics
                    </h1>
                    <p className="text-sm text-muted-foreground mt-2">
                        Performance analytics across your organization, agents, and projects
                    </p>
                </div>
            </div>

            {/* Tab switcher */}
            <div className="flex items-center gap-1 bg-muted/30 rounded-lg p-1 mb-8 w-fit">
                {TABS.map(({ key, label, icon: TabIcon }) => (
                    <button
                        key={key}
                        onClick={() => setTab(key)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                            tab === key
                                ? "bg-amber-500/20 text-amber-400"
                                : "text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        <TabIcon className="h-4 w-4" />
                        {label}
                    </button>
                ))}
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
                </div>
            ) : (
                <>
                    {/* ═══════════════ Organization Tab ═══════════════ */}
                    {tab === "organization" && (
                        <div className="space-y-6">
                            {/* Primary KPIs */}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                <KpiCard
                                    label="Total Tasks"
                                    value={orgMetrics.totalTasks}
                                    icon={Target}
                                    iconColor="text-blue-400"
                                    iconBg="bg-blue-500/10"
                                />
                                <KpiCard
                                    label="Completion Rate"
                                    value={`${orgMetrics.completionRate}%`}
                                    subLabel={`${orgMetrics.completedTasks} completed`}
                                    icon={CheckCircle2}
                                    iconColor="text-emerald-400"
                                    iconBg="bg-emerald-500/10"
                                />
                                <KpiCard
                                    label="Active Agents"
                                    value={orgMetrics.onlineAgents + orgMetrics.busyAgents}
                                    subLabel={`of ${orgMetrics.totalAgents} total`}
                                    icon={Users}
                                    iconColor="text-purple-400"
                                    iconBg="bg-purple-500/10"
                                />
                                <KpiCard
                                    label="Pending Approvals"
                                    value={orgMetrics.pendingApprovals}
                                    icon={Shield}
                                    iconColor="text-amber-400"
                                    iconBg="bg-amber-500/10"
                                />
                            </div>

                            {/* Secondary KPIs */}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                <KpiCard
                                    label="Projects"
                                    value={orgMetrics.totalProjects}
                                    icon={FolderKanban}
                                    iconColor="text-cyan-400"
                                    iconBg="bg-cyan-500/10"
                                />
                                <KpiCard
                                    label="In Progress"
                                    value={orgMetrics.activeTasks}
                                    subLabel={`${orgMetrics.todoTasks} todo`}
                                    icon={Activity}
                                    iconColor="text-amber-400"
                                    iconBg="bg-amber-500/10"
                                />
                                <KpiCard
                                    label="Total Jobs"
                                    value={orgMetrics.totalJobs}
                                    subLabel={`${orgMetrics.openJobs} open`}
                                    icon={Briefcase}
                                    iconColor="text-indigo-400"
                                    iconBg="bg-indigo-500/10"
                                />
                                <KpiCard
                                    label="Members"
                                    value={currentOrg?.members.length || 0}
                                    icon={Users}
                                    iconColor="text-emerald-400"
                                    iconBg="bg-emerald-500/10"
                                />
                            </div>

                            {/* Task breakdown bar */}
                            <Card className="p-5 bg-card border-border">
                                <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                                    <Target className="h-4 w-4 text-amber-500" />
                                    Task Status Breakdown
                                </h3>
                                {orgMetrics.totalTasks === 0 ? (
                                    <p className="text-sm text-muted-foreground text-center py-4">No tasks yet</p>
                                ) : (
                                    <>
                                        <div className="h-4 bg-muted rounded-full overflow-hidden flex mb-3">
                                            {orgMetrics.completedTasks > 0 && (
                                                <div
                                                    className="h-full bg-emerald-500 transition-all duration-500"
                                                    style={{ width: `${(orgMetrics.completedTasks / orgMetrics.totalTasks) * 100}%` }}
                                                />
                                            )}
                                            {orgMetrics.activeTasks > 0 && (
                                                <div
                                                    className="h-full bg-amber-500 transition-all duration-500"
                                                    style={{ width: `${(orgMetrics.activeTasks / orgMetrics.totalTasks) * 100}%` }}
                                                />
                                            )}
                                            {orgMetrics.todoTasks > 0 && (
                                                <div
                                                    className="h-full bg-muted-foreground/30 transition-all duration-500"
                                                    style={{ width: `${(orgMetrics.todoTasks / orgMetrics.totalTasks) * 100}%` }}
                                                />
                                            )}
                                        </div>
                                        <div className="flex items-center gap-6 text-xs">
                                            <span className="flex items-center gap-1.5">
                                                <span className="w-3 h-3 rounded-sm bg-emerald-500" />
                                                Done ({orgMetrics.completedTasks})
                                            </span>
                                            <span className="flex items-center gap-1.5">
                                                <span className="w-3 h-3 rounded-sm bg-amber-500" />
                                                In Progress ({orgMetrics.activeTasks})
                                            </span>
                                            <span className="flex items-center gap-1.5">
                                                <span className="w-3 h-3 rounded-sm bg-muted-foreground/30" />
                                                Todo ({orgMetrics.todoTasks})
                                            </span>
                                        </div>
                                    </>
                                )}
                            </Card>

                            {/* Job breakdown */}
                            <Card className="p-5 bg-card border-border">
                                <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                                    <Briefcase className="h-4 w-4 text-amber-500" />
                                    Job Status Breakdown
                                </h3>
                                {orgMetrics.totalJobs === 0 ? (
                                    <p className="text-sm text-muted-foreground text-center py-4">No jobs yet</p>
                                ) : (
                                    <>
                                        <div className="h-4 bg-muted rounded-full overflow-hidden flex mb-3">
                                            {orgMetrics.closedJobs > 0 && (
                                                <div
                                                    className="h-full bg-emerald-500 transition-all"
                                                    style={{ width: `${(orgMetrics.closedJobs / orgMetrics.totalJobs) * 100}%` }}
                                                />
                                            )}
                                            {orgMetrics.claimedJobs > 0 && (
                                                <div
                                                    className="h-full bg-amber-500 transition-all"
                                                    style={{ width: `${(orgMetrics.claimedJobs / orgMetrics.totalJobs) * 100}%` }}
                                                />
                                            )}
                                            {orgMetrics.openJobs > 0 && (
                                                <div
                                                    className="h-full bg-blue-500 transition-all"
                                                    style={{ width: `${(orgMetrics.openJobs / orgMetrics.totalJobs) * 100}%` }}
                                                />
                                            )}
                                        </div>
                                        <div className="flex items-center gap-6 text-xs">
                                            <span className="flex items-center gap-1.5">
                                                <span className="w-3 h-3 rounded-sm bg-emerald-500" />
                                                Closed ({orgMetrics.closedJobs})
                                            </span>
                                            <span className="flex items-center gap-1.5">
                                                <span className="w-3 h-3 rounded-sm bg-amber-500" />
                                                Claimed ({orgMetrics.claimedJobs})
                                            </span>
                                            <span className="flex items-center gap-1.5">
                                                <span className="w-3 h-3 rounded-sm bg-blue-500" />
                                                Open ({orgMetrics.openJobs})
                                            </span>
                                        </div>
                                    </>
                                )}
                            </Card>
                        </div>
                    )}

                    {/* ═══════════════ Agents Tab ═══════════════ */}
                    {tab === "agents" && (
                        <div className="space-y-6">
                            {/* Summary stats */}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                <KpiCard
                                    label="Total Agents"
                                    value={agents.length}
                                    icon={Bot}
                                    iconColor="text-purple-400"
                                    iconBg="bg-purple-500/10"
                                />
                                <KpiCard
                                    label="Online"
                                    value={agents.filter(a => a.status === "online").length}
                                    icon={Zap}
                                    iconColor="text-emerald-400"
                                    iconBg="bg-emerald-500/10"
                                />
                                <KpiCard
                                    label="Busy"
                                    value={agents.filter(a => a.status === "busy").length}
                                    icon={Activity}
                                    iconColor="text-amber-400"
                                    iconBg="bg-amber-500/10"
                                />
                                <KpiCard
                                    label="Offline"
                                    value={agents.filter(a => a.status === "offline").length}
                                    icon={XCircle}
                                    iconColor="text-muted-foreground"
                                    iconBg="bg-muted/50"
                                />
                            </div>

                            {/* Agent table */}
                            {agentMetrics.length === 0 ? (
                                <Card className="p-12 text-center bg-card border-border border-dashed">
                                    <Bot className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                                    <h3 className="text-lg font-semibold mb-2">No agents registered</h3>
                                    <p className="text-sm text-muted-foreground">
                                        Register agents to see their performance metrics here.
                                    </p>
                                </Card>
                            ) : (
                                <Card className="bg-card border-border overflow-hidden">
                                    <div className="px-5 py-3 border-b border-border flex items-center gap-2">
                                        <Trophy className="h-4 w-4 text-amber-500" />
                                        <span className="text-sm font-semibold">Agent Performance</span>
                                        <Badge variant="outline" className="text-[10px] ml-auto">
                                            {agents.length} agents
                                        </Badge>
                                    </div>
                                    <div className="divide-y divide-border">
                                        {agentMetrics.map((am, index) => (
                                            <div key={am.agent.id} className="px-5 py-4 flex items-center gap-4">
                                                {/* Rank */}
                                                <span className="w-6 text-center shrink-0">
                                                    {index < 3 ? (
                                                        <span className="text-lg">{["🥇", "🥈", "🥉"][index]}</span>
                                                    ) : (
                                                        <span className="text-xs text-muted-foreground font-medium">#{index + 1}</span>
                                                    )}
                                                </span>

                                                {/* Agent info */}
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className={`w-2 h-2 rounded-full shrink-0 ${
                                                            am.agent.status === "online" ? "bg-emerald-500" :
                                                            am.agent.status === "busy" ? "bg-amber-500" : "bg-muted-foreground/40"
                                                        }`} />
                                                        <span className="text-sm font-medium truncate">{am.agent.name}</span>
                                                        <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0">
                                                            {am.agent.type}
                                                        </Badge>
                                                    </div>
                                                    <ProgressBar
                                                        value={am.completionRate}
                                                        color={am.completionRate >= 80 ? "bg-emerald-500" : am.completionRate >= 50 ? "bg-amber-500" : "bg-red-400"}
                                                    />
                                                </div>

                                                {/* Stats */}
                                                <div className="flex items-center gap-4 shrink-0 text-xs text-muted-foreground">
                                                    <div className="text-right">
                                                        <p className="font-semibold text-sm text-foreground">{am.completedTasks}</p>
                                                        <p>completed</p>
                                                    </div>
                                                    <div className="text-right">
                                                        <p className="font-semibold text-sm text-foreground">{am.totalTasks}</p>
                                                        <p>tasks</p>
                                                    </div>
                                                    <div className="text-right">
                                                        <p className={`font-semibold text-sm ${
                                                            am.completionRate >= 80 ? "text-emerald-400" :
                                                            am.completionRate >= 50 ? "text-amber-400" : "text-red-400"
                                                        }`}>
                                                            {am.completionRate}%
                                                        </p>
                                                        <p>rate</p>
                                                    </div>
                                                    <div className="text-right">
                                                        <p className="font-semibold text-sm text-foreground">{am.completedJobs}</p>
                                                        <p>jobs</p>
                                                    </div>
                                                    <div className="text-right">
                                                        <p className="font-semibold text-sm text-foreground">{am.projectCount}</p>
                                                        <p>projects</p>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </Card>
                            )}
                        </div>
                    )}

                    {/* ═══════════════ Projects Tab ═══════════════ */}
                    {tab === "projects" && (
                        <div className="space-y-6">
                            {/* Summary stats */}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                <KpiCard
                                    label="Total Projects"
                                    value={projects.length}
                                    icon={FolderKanban}
                                    iconColor="text-cyan-400"
                                    iconBg="bg-cyan-500/10"
                                />
                                <KpiCard
                                    label="Active"
                                    value={projects.filter(p => p.status === "active").length}
                                    icon={Zap}
                                    iconColor="text-emerald-400"
                                    iconBg="bg-emerald-500/10"
                                />
                                <KpiCard
                                    label="Paused"
                                    value={projects.filter(p => p.status === "paused").length}
                                    icon={Clock}
                                    iconColor="text-amber-400"
                                    iconBg="bg-amber-500/10"
                                />
                                <KpiCard
                                    label="Completed"
                                    value={projects.filter(p => p.status === "completed").length}
                                    icon={CheckCircle2}
                                    iconColor="text-emerald-400"
                                    iconBg="bg-emerald-500/10"
                                />
                            </div>

                            {/* Project cards */}
                            {projectMetrics.length === 0 ? (
                                <Card className="p-12 text-center bg-card border-border border-dashed">
                                    <FolderKanban className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                                    <h3 className="text-lg font-semibold mb-2">No projects yet</h3>
                                    <p className="text-sm text-muted-foreground">
                                        Create projects to see their performance metrics here.
                                    </p>
                                </Card>
                            ) : (
                                <div className="grid gap-4 md:grid-cols-2">
                                    {projectMetrics.map(pm => {
                                        const statusColor = pm.project.status === "active"
                                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                            : pm.project.status === "paused"
                                                ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                                : "bg-blue-500/10 text-blue-400 border-blue-500/20";
                                        return (
                                            <Card key={pm.project.id} className="p-5 bg-card border-border hover:border-amber-500/20 transition-colors">
                                                {/* Project header */}
                                                <div className="flex items-center justify-between mb-3">
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <FolderKanban className="h-4 w-4 text-amber-500 shrink-0" />
                                                        <h3 className="font-semibold truncate">{pm.project.name}</h3>
                                                    </div>
                                                    <Badge className={`text-[10px] shrink-0 ${statusColor}`}>
                                                        {pm.project.status}
                                                    </Badge>
                                                </div>

                                                {pm.project.description && (
                                                    <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
                                                        {pm.project.description}
                                                    </p>
                                                )}

                                                {/* Task progress */}
                                                <div className="mb-3">
                                                    <div className="flex items-center justify-between text-xs mb-1.5">
                                                        <span className="text-muted-foreground">Task progress</span>
                                                        <span className={`font-semibold ${
                                                            pm.completionRate >= 80 ? "text-emerald-400" :
                                                            pm.completionRate >= 50 ? "text-amber-400" : "text-foreground"
                                                        }`}>
                                                            {pm.completionRate}%
                                                        </span>
                                                    </div>
                                                    <ProgressBar
                                                        value={pm.completionRate}
                                                        color={pm.completionRate >= 80 ? "bg-emerald-500" : pm.completionRate >= 50 ? "bg-amber-500" : "bg-blue-500"}
                                                    />
                                                </div>

                                                {/* Stats row */}
                                                <div className="grid grid-cols-4 gap-2 text-center">
                                                    <div>
                                                        <p className="text-sm font-bold">{pm.completedTasks}</p>
                                                        <p className="text-[10px] text-muted-foreground">Done</p>
                                                    </div>
                                                    <div>
                                                        <p className="text-sm font-bold">{pm.inProgressTasks}</p>
                                                        <p className="text-[10px] text-muted-foreground">Active</p>
                                                    </div>
                                                    <div>
                                                        <p className="text-sm font-bold">{pm.todoTasks}</p>
                                                        <p className="text-[10px] text-muted-foreground">Todo</p>
                                                    </div>
                                                    <div>
                                                        <p className="text-sm font-bold">{pm.totalJobs}</p>
                                                        <p className="text-[10px] text-muted-foreground">Jobs</p>
                                                    </div>
                                                </div>

                                                {/* Assigned agents */}
                                                {pm.agents.length > 0 && (
                                                    <div className="mt-3 pt-3 border-t border-border">
                                                        <div className="flex items-center gap-1.5 flex-wrap">
                                                            <Bot className="h-3 w-3 text-muted-foreground shrink-0" />
                                                            {pm.agents.slice(0, 5).map(agent => (
                                                                <Badge
                                                                    key={agent.id}
                                                                    variant="outline"
                                                                    className="text-[9px] px-1.5 py-0 gap-1"
                                                                >
                                                                    <span className={`w-1.5 h-1.5 rounded-full ${
                                                                        agent.status === "online" ? "bg-emerald-500" :
                                                                        agent.status === "busy" ? "bg-amber-500" : "bg-muted-foreground/40"
                                                                    }`} />
                                                                    {agent.name}
                                                                </Badge>
                                                            ))}
                                                            {pm.agents.length > 5 && (
                                                                <span className="text-[10px] text-muted-foreground">
                                                                    +{pm.agents.length - 5} more
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                )}
                                            </Card>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
