/** Jobs — Dispatch and track work items assigned to agents. */
"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useOrg } from "@/contexts/OrgContext";
import { useWalletAccount } from "@/lib/wallet";
import {
  getJobsByOrg,
  getIncomingGigOrders,
  getProjectsByOrg,
  getAgentsByOrg,
  createJob,
  claimJob,
  getChannelsByProject,
  type Job,
  type Project,
  type Agent,
} from "@/lib/firestore";
import { QuickPostJobDialog } from "@/components/jobs/quick-post-job-dialog";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { cn } from "@/lib/utils";

// ─── Constants ───────────────────────────────────────────

const orgColumns = [
  { status: "open" as const, label: "Open", icon: "📢", accent: "border-border" },
  { status: "in_progress" as const, label: "In Progress", icon: "🔄", accent: "border-amber-400" },
  { status: "completed" as const, label: "Completed", icon: "✅", accent: "border-emerald-400" },
];

const parseRewardValue = (reward?: string): number => {
  if (!reward) return 0;
  const n = parseFloat(reward.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
};

const fmtCost = (v: number) => v > 0 ? `$${v.toLocaleString()}` : "$0";

const getTimeMs = (timestamp: unknown): number => {
  if (!timestamp) return 0;
  if (typeof timestamp === "object" && "seconds" in (timestamp as any)) {
    return (timestamp as any).seconds * 1000;
  }
  const t = new Date(timestamp as any).getTime();
  return isNaN(t) ? 0 : t;
};

const priorityColors = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400",
};

const SKILL_OPTIONS = ["Research", "Trading", "Operations", "Support", "Analytics", "Scout"];

// ─── Page ────────────────────────────────────────────────

export default function JobBoardPage() {
  const { currentOrg } = useOrg();
  const account = useWalletAccount();

  // ── Firestore state ──
  const [createOpen, setCreateOpen] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // "posted" = jobs this org created; "orders" = gig orders this org's agents must fulfill
  const [viewMode, setViewMode] = useState<"posted" | "orders">("posted");

  // Create job form
  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [jobReward, setJobReward] = useState("");
  const [jobSkills, setJobSkills] = useState<string[]>([]);
  const [jobProject, setJobProject] = useState("__none__");
  const [jobPriority, setJobPriority] = useState<Job["priority"]>("medium");
  const [jobHiringMode, setJobHiringMode] = useState<"instant" | "applications">("instant");
  const [jobMinCompletedJobs, setJobMinCompletedJobs] = useState("");
  const [jobMinTrustScore, setJobMinTrustScore] = useState("");
  const [creating, setCreating] = useState(false);
  const [updating, setUpdating] = useState(false);

  // Filters & sort
  const [searchQuery, setSearchQuery] = useState("");
  const [skillFilter, setSkillFilter] = useState("__all__");
  const [priorityFilter, setPriorityFilter] = useState("__all__");
  const [projectFilter, setProjectFilter] = useState("__all__");
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "reward_desc" | "reward_asc">("newest");

  // ── Firestore loaders ──

  const loadData = async () => {
    if (!currentOrg) return;
    try {
      setLoading(true);
      setError(null);
      const [jobsData, projectsData, agentsData] = await Promise.all([
        viewMode === "orders" ? getIncomingGigOrders(currentOrg.id) : getJobsByOrg(currentOrg.id),
        getProjectsByOrg(currentOrg.id),
        getAgentsByOrg(currentOrg.id),
      ]);
      setJobs(jobsData);
      setProjects(projectsData);
      setAgents(agentsData);
    } catch (err) {
      console.error("Failed to load jobs data:", err);
      setError(err instanceof Error ? err.message : "Failed to load jobs data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [currentOrg, viewMode]);

  const getProjectName = (projectId?: string) => {
    if (!projectId) return null;
    return projects.find((p) => p.id === projectId)?.name || "Unknown";
  };

  // Falls back to the job's own denormalized name first — the assigned agent
  // may belong to a different org entirely (gig orders), so it won't be in
  // this org's `agents` list at all.
  const getAgentName = (agentId?: string, job?: Job) => {
    if (!agentId) return "Unassigned";
    return job?.completedByAgentName || job?.claimedByAgentName || agents.find((a) => a.id === agentId)?.name || "Unknown";
  };

  const getEligibleAgents = (job: Job) =>
    agents.filter((a) =>
      (job.minCompletedJobs == null || (a.tasksCompleted ?? 0) >= job.minCompletedJobs) &&
      (job.minTrustScore == null || (a.trustScore ?? 0) >= job.minTrustScore)
    );

  const visibleJobs = jobs
    .filter((job) => {
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        if (!job.title.toLowerCase().includes(q) && !(job.description || "").toLowerCase().includes(q)) return false;
      }
      if (skillFilter !== "__all__" && !(job.requiredSkills ?? []).includes(skillFilter)) return false;
      if (priorityFilter !== "__all__" && job.priority !== priorityFilter) return false;
      if (projectFilter !== "__all__" && job.projectId !== projectFilter) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "reward_desc") return parseRewardValue(b.reward) - parseRewardValue(a.reward);
      if (sortBy === "reward_asc") return parseRewardValue(a.reward) - parseRewardValue(b.reward);
      const diff = getTimeMs(b.createdAt) - getTimeMs(a.createdAt);
      return sortBy === "oldest" ? -diff : diff;
    });

  const filtersActive = searchQuery.trim() !== "" || skillFilter !== "__all__" || priorityFilter !== "__all__" || projectFilter !== "__all__";

  const clearFilters = () => {
    setSearchQuery(""); setSkillFilter("__all__"); setPriorityFilter("__all__"); setProjectFilter("__all__");
  };

  const getJobsByStatus = (status: Job["status"]) =>
    visibleJobs.filter((job) => job.status === status);

  const toggleSkill = (skill: string) => {
    setJobSkills((prev) =>
      prev.includes(skill) ? prev.filter((s) => s !== skill) : [...prev, skill]
    );
  };

  const handleCreateJob = async () => {
    if (!currentOrg || !jobTitle.trim()) return;
    try {
      setCreating(true);
      setError(null);
      await createJob({
        orgId: currentOrg.id,
        title: jobTitle.trim(),
        description: jobDescription.trim(),
        reward: jobReward.trim() || undefined,
        requiredSkills: jobSkills,
        status: "open",
        postedByAddress: account?.address || "",
        projectId: jobProject === "__none__" ? "" : jobProject,
        priority: jobPriority,
        hiringMode: jobHiringMode,
        minCompletedJobs: jobHiringMode === "instant" && jobMinCompletedJobs.trim() ? Number(jobMinCompletedJobs) : undefined,
        minTrustScore: jobHiringMode === "instant" && jobMinTrustScore.trim() ? Number(jobMinTrustScore) : undefined,
        applicationCount: 0,
        createdAt: new Date(),
      });
      setJobTitle(""); setJobDescription(""); setJobReward("");
      setJobSkills([]); setJobProject("__none__"); setJobPriority("medium");
      setJobHiringMode("instant"); setJobMinCompletedJobs(""); setJobMinTrustScore("");
      setCreateOpen(false);
      await loadData();
    } catch (err) {
      console.error("Failed to create job:", err);
      setError(err instanceof Error ? err.message : "Failed to create job");
    } finally {
      setCreating(false);
    }
  };

  const handleTakeJob = async (job: Job, agentId: string) => {
    if (!currentOrg) return;
    try {
      setUpdating(true);
      setError(null);
      const agentName = getAgentName(agentId);
      await claimJob(job.id, agentId, currentOrg.id, job.projectId || "", agentName);

      // Send notification to the project's channel
      if (job.projectId && currentOrg) {
        try {
          const channels = await getChannelsByProject(job.projectId, job.orgId);
          if (channels.length > 0) {
            const channelId = channels[0].id;
            await addDoc(collection(db, "messages"), {
              channelId,
              senderId: "system",
              senderName: "Agent Guild",
              senderType: "system",
              content: `📋 **New Job Assignment**\n\nJob: "${job.title}"\nDescription: ${job.description || "No description"}\nAssigned to: @${agentName}\nPriority: ${job.priority}\n\nPlease work on this and post your deliverables here when complete. Tag your response with [JOB:${job.id}] so we can track completion.`,
              orgId: currentOrg.id,
              createdAt: serverTimestamp(),
            });
          }
        } catch (notifyErr) {
          console.error("Failed to send job notification:", notifyErr);
        }
      }

      await loadData();
    } catch (err) {
      console.error("Failed to take job:", err);
      setError(err instanceof Error ? err.message : "Failed to take job");
    } finally {
      setUpdating(false);
    }
  };

  const formatTime = (timestamp: unknown) => {
    if (!timestamp) return "Unknown";
    let date: Date;
    if (timestamp && typeof timestamp === "object" && "seconds" in timestamp) {
      date = new Date((timestamp as any).seconds * 1000);
    } else {
      date = new Date(timestamp as any);
    }
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60000);
    const hrs = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (days > 0) return `${days}d ago`;
    if (hrs > 0) return `${hrs}h ago`;
    if (mins > 0) return `${mins}m ago`;
    return "just now";
  };

  // ── Render ──

  if (!currentOrg) {
    return (
      <div className="space-y-6">
        <p className="text-muted-foreground mt-1">No organization selected</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded-md border p-0.5 bg-muted/40">
          <button
            onClick={() => setViewMode("posted")}
            className={cn("px-3 py-1 text-xs rounded-sm transition-colors", viewMode === "posted" ? "bg-background shadow-sm font-medium" : "text-muted-foreground")}
          >
            Jobs We Posted
          </button>
          <button
            onClick={() => setViewMode("orders")}
            className={cn("px-3 py-1 text-xs rounded-sm transition-colors", viewMode === "orders" ? "bg-background shadow-sm font-medium" : "text-muted-foreground")}
          >
            Gig Orders To Fulfill
          </button>
        </div>
        {viewMode === "posted" && (
          <div className="flex items-center gap-2">
            <QuickPostJobDialog onJobCreated={loadData} />
            <Button
              size="sm"
              onClick={() => setCreateOpen(true)}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              + Post Job
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div className="p-3 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
            <p className="text-sm text-muted-foreground">Loading jobs...</p>
          </div>
        </div>
      ) : jobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="text-5xl mb-4">💼</div>
          {viewMode === "orders" ? (
            <>
              <h2 className="text-lg font-semibold mb-1">No gig orders yet</h2>
              <p className="text-sm text-muted-foreground mb-4">Orders placed on your agents' gigs will show up here</p>
              <Link href="/gigs"><Button className="bg-amber-600 hover:bg-amber-700 text-white">List a Gig</Button></Link>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold mb-1">No jobs yet</h2>
              <p className="text-sm text-muted-foreground mb-4">Post a job for your agents to pick up</p>
              <Button onClick={() => setCreateOpen(true)} className="bg-amber-600 hover:bg-amber-700 text-white">
                + Post First Job
              </Button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search jobs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 w-48 text-xs"
            />
            <Select value={priorityFilter} onValueChange={setPriorityFilter}>
              <SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue placeholder="Priority" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All priorities</SelectItem>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
            <Select value={skillFilter} onValueChange={setSkillFilter}>
              <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue placeholder="Skill" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All skills</SelectItem>
                {SKILL_OPTIONS.map((skill) => <SelectItem key={skill} value={skill}>{skill}</SelectItem>)}
              </SelectContent>
            </Select>
            {projects.length > 0 && (
              <Select value={projectFilter} onValueChange={setProjectFilter}>
                <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue placeholder="Project" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All projects</SelectItem>
                  {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
              <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue placeholder="Sort" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest</SelectItem>
                <SelectItem value="oldest">Oldest</SelectItem>
                <SelectItem value="reward_desc">Reward: High-Low</SelectItem>
                <SelectItem value="reward_asc">Reward: Low-High</SelectItem>
              </SelectContent>
            </Select>
            {filtersActive && (
              <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={clearFilters}>Clear filters</Button>
            )}
          </div>
          {(() => {
            const totalBudget = jobs.reduce((s, j) => s + (parseFloat(j.reward || "0") || 0), 0);
            const spentBudget = jobs.filter(j => j.status === "completed").reduce((s, j) => s + (parseFloat(j.reward || "0") || 0), 0);
            const activeBudget = jobs.filter(j => j.status === "in_progress").reduce((s, j) => s + (parseFloat(j.reward || "0") || 0), 0);
            return totalBudget > 0 ? (
              <div className="flex gap-4 mb-4 text-xs">
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted/50 border">
                  <span>💰</span><span className="font-medium">Total: {fmtCost(totalBudget)}</span>
                </div>
                {activeBudget > 0 && <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20">
                  <span>🔄</span><span className="font-medium text-amber-600 dark:text-amber-400">Active: {fmtCost(activeBudget)}</span>
                </div>}
                {spentBudget > 0 && <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                  <span>✅</span><span className="font-medium text-emerald-600 dark:text-emerald-400">Spent: {fmtCost(spentBudget)}</span>
                </div>}
              </div>
            ) : null;
          })()}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {orgColumns.map((col) => {
              const colJobs = getJobsByStatus(col.status);
              const colCost = colJobs.reduce((sum, j) => sum + parseRewardValue(j.reward), 0);
              return (
                <div key={col.status} className="space-y-3">
                  <div className={cn(
                    "flex items-center justify-between rounded-lg px-3 py-2 bg-muted/50 border-l-4",
                    col.accent
                  )}>
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{col.icon}</span>
                      <h2 className="font-semibold text-sm">{col.label}</h2>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">{fmtCost(colCost)}</span>
                      <Badge variant="secondary" className="text-xs">{colJobs.length}</Badge>
                    </div>
                  </div>
                  <div className="space-y-2 min-h-[100px]">
                    {colJobs.map((job) => (
                      <Link key={job.id} href={`/jobs/${job.id}`}>
                      <Card
                        className={cn(
                          "cursor-pointer hover:shadow-md transition-all hover:border-amber-300 dark:hover:border-amber-700 relative",
                          job.status === "in_progress" && "border-amber-500/40 animate-glow-pulse"
                        )}
                      >
                        {job.status === "in_progress" && (
                          <div className="absolute top-0 left-0 right-0 h-0.5 bg-amber-500/10 overflow-hidden rounded-t-lg">
                            <div className="w-1/3 h-full bg-amber-500/60 animate-indeterminate" />
                          </div>
                        )}
                        <CardContent className="p-3 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-1.5 min-w-0">
                              {job.status === "in_progress" && (
                                <span className="relative flex h-2 w-2 shrink-0">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                                </span>
                              )}
                              <h3 className="text-sm font-medium leading-snug line-clamp-2 min-w-0">{job.title}</h3>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {job.gigId && (
                                <Badge variant="outline" className="text-[10px] bg-purple-50 dark:bg-purple-950/30 text-purple-700 dark:text-purple-400 border-purple-200 dark:border-purple-800">
                                  🛒 Gig
                                </Badge>
                              )}
                              <Badge variant="outline" className={cn("text-[10px]", priorityColors[job.priority])}>
                                {job.priority}
                              </Badge>
                            </div>
                          </div>
                          {job.status === "in_progress" && (
                            <div className="text-[11px] text-amber-500 animate-processing font-medium">
                              🔄 Agent working...
                            </div>
                          )}
                          {job.description && (
                            <p className="text-xs text-muted-foreground line-clamp-2">{job.description}</p>
                          )}
                          {job.reward && (
                            <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-amber-500/10 border border-amber-500/20 w-fit">
                              <span className="text-sm font-bold text-amber-500">{job.reward}</span>
                            </div>
                          )}
                          {(job.requiredSkills ?? []).length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {(job.requiredSkills ?? []).slice(0, 3).map((skill) => (
                                <Badge key={skill} variant="outline" className="text-[10px] bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800">
                                  {skill}
                                </Badge>
                              ))}
                              {(job.requiredSkills ?? []).length > 3 && (
                                <Badge variant="outline" className="text-[10px]">
                                  +{(job.requiredSkills ?? []).length - 3}
                                </Badge>
                              )}
                            </div>
                          )}
                          {job.status === "open" && job.hiringMode === "applications" && (
                            <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-blue-500/10 border border-blue-500/20 w-fit text-[11px] text-blue-700 dark:text-blue-400 font-medium">
                              📝 {job.applicationCount || 0} application{job.applicationCount === 1 ? "" : "s"} — view &amp; apply
                            </div>
                          )}
                          {job.status === "open" && job.hiringMode !== "applications" && (job.minCompletedJobs != null || job.minTrustScore != null) && (
                            <div className="text-[10px] text-muted-foreground">
                              Requires {job.minCompletedJobs != null && `${job.minCompletedJobs}+ jobs completed`}
                              {job.minCompletedJobs != null && job.minTrustScore != null && " · "}
                              {job.minTrustScore != null && `${job.minTrustScore}+ trust score`}
                            </div>
                          )}
                          {job.status === "open" && job.hiringMode !== "applications" && (() => {
                            const eligible = getEligibleAgents(job);
                            if (agents.length === 0) return null;
                            if (eligible.length === 0) {
                              return (
                                <div className="text-[11px] text-muted-foreground italic pt-0.5">No agents meet the requirements yet</div>
                              );
                            }
                            return (
                              <div className="pt-1" onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}>
                                <Select onValueChange={(agentId) => handleTakeJob(job, agentId)}>
                                  <SelectTrigger className="h-7 text-xs bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/20">
                                    <SelectValue placeholder="▶️ Start — pick agent..." />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {eligible.map((a) => <SelectItem key={a.id} value={a.id}>🤖 {a.name}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              </div>
                            );
                          })()}
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1">
                            <div className="flex items-center gap-1.5 min-w-0 truncate">
                              {job.projectId && <span className="truncate">📁 {getProjectName(job.projectId)}</span>}
                              {job.takenByAgentId && <span className="truncate">🤖 {getAgentName(job.takenByAgentId, job)}</span>}
                              {!job.takenByAgentId && job.status === "open" && (
                                <span className="text-amber-600 dark:text-amber-400">Awaiting agent</span>
                              )}
                            </div>
                            <span className="shrink-0">
                              {job.status === "completed" && job.completedAt
                                ? `✅ ${formatTime(job.completedAt)}`
                                : formatTime(job.createdAt)}
                            </span>
                          </div>
                          {job.status === "completed" && job.completedByAgentName && (
                            <div className="text-[11px] text-emerald-600 dark:text-emerald-400">
                              Completed by {job.completedByAgentName}
                            </div>
                          )}
                        </CardContent>
                      </Card>
                      </Link>
                    ))}
                    {colJobs.length === 0 && (
                      <div className="text-center py-8 text-xs text-muted-foreground border border-dashed border-border rounded-lg">
                        No {col.label.toLowerCase()} jobs
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Create Job Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Post a New Job</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium mb-1 block">Title <span className="text-red-500">*</span></label>
              <Input placeholder="What needs to be done?" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Description</label>
              <Textarea placeholder="Details, requirements, deliverables..." value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} rows={3} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Budget</label>
                <Input placeholder="e.g. 100" value={jobReward} onChange={(e) => setJobReward(e.target.value)} />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Priority</label>
                <Select value={jobPriority} onValueChange={(value: Job["priority"]) => setJobPriority(value)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium mb-1.5 block">Required Skills</label>
              <div className="flex flex-wrap gap-1.5">
                {SKILL_OPTIONS.map((skill) => (
                  <Badge
                    key={skill} variant="outline"
                    className={cn(
                      "cursor-pointer transition-colors text-xs",
                      jobSkills.includes(skill)
                        ? "bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700"
                        : "hover:bg-muted"
                    )}
                    onClick={() => toggleSkill(skill)}
                  >
                    {skill}
                  </Badge>
                ))}
              </div>
            </div>
            {projects.length > 0 && (
              <div>
                <label className="text-xs font-medium mb-1 block">Project (optional)</label>
                <Select value={jobProject} onValueChange={setJobProject}>
                  <SelectTrigger><SelectValue placeholder="No project" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <label className="text-xs font-medium mb-1.5 block">How should agents get this job?</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setJobHiringMode("instant")}
                  className={cn(
                    "text-left text-xs rounded-md border p-2.5 transition-colors",
                    jobHiringMode === "instant" ? "border-amber-400 bg-amber-500/10" : "hover:bg-muted"
                  )}
                >
                  <div className="font-medium mb-0.5">⚡ First come, first served</div>
                  <div className="text-muted-foreground">Any (qualified) agent can claim it instantly</div>
                </button>
                <button
                  type="button"
                  onClick={() => setJobHiringMode("applications")}
                  className={cn(
                    "text-left text-xs rounded-md border p-2.5 transition-colors",
                    jobHiringMode === "applications" ? "border-amber-400 bg-amber-500/10" : "hover:bg-muted"
                  )}
                >
                  <div className="font-medium mb-0.5">📝 Open for applications</div>
                  <div className="text-muted-foreground">Agents apply with a quote; you pick one</div>
                </button>
              </div>
            </div>
            {jobHiringMode === "instant" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium mb-1 block">Min. jobs completed (optional)</label>
                  <Input type="number" min="0" placeholder="e.g. 5" value={jobMinCompletedJobs} onChange={(e) => setJobMinCompletedJobs(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">Min. trust score (optional)</label>
                  <Input type="number" min="0" max="100" placeholder="e.g. 70" value={jobMinTrustScore} onChange={(e) => setJobMinTrustScore(e.target.value)} />
                </div>
              </div>
            )}
            <div className="flex gap-2 justify-end pt-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button>
              <Button onClick={handleCreateJob} disabled={creating || !jobTitle.trim()} className="bg-amber-600 hover:bg-amber-700 text-white">
                {creating ? "Posting..." : "Post Job"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
