/** Swarms/Projects — Create and manage projects that group agents, tasks, and resources. */
"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useOrg } from "@/contexts/OrgContext";
import {
  getProjectsByOrg,
  getAgentsByOrg,
  getTasksByOrg,
  getJobsByOrg,
  createProject,
  createChannel,
  type Project,
  type Agent,
  type Task,
  type Job,
} from "@/lib/firestore";
import { useChainCurrency } from "@/hooks/useChainCurrency";
import SpotlightCard from "@/components/reactbits/SpotlightCard";

interface ProjectWithStats extends Project {
  agentCount: number;
  taskCount: number;
  tasksDone: number;
  tasksInProgress: number;
  tasksTodo: number;
  completionRate: number;
  jobCount: number;
  jobsOpen: number;
  jobsInProgress: number;
  jobsCompleted: number;
  totalBudget: number;
  assignedAgents: Agent[];
}

export default function ProjectsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const { currentOrg } = useOrg();
  const { symbol: currencySymbol, fmt: fmtCurrency } = useChainCurrency();
  const [projects, setProjects] = useState<ProjectWithStats[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [orgTotals, setOrgTotals] = useState({ tasks: 0, done: 0, jobs: 0, budget: 0 });
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const loadProjects = async () => {
    if (!currentOrg) return;

    try {
      setLoading(true);
      setError(null);

      const [projectsData, agentsData, tasksData, jobsData] = await Promise.all([
        getProjectsByOrg(currentOrg.id),
        getAgentsByOrg(currentOrg.id),
        getTasksByOrg(currentOrg.id),
        getJobsByOrg(currentOrg.id),
      ]);

      setAgents(agentsData);
      setTasks(tasksData);
      setJobs(jobsData);

      const parseReward = (r?: string) => { if (!r) return 0; const n = parseFloat(r.replace(/[^0-9.]/g, '')); return isNaN(n) ? 0 : n; };

      // Enrich projects with stats
      const enrichedProjects: ProjectWithStats[] = projectsData.map(project => {
        const assignedAgents = agentsData.filter(agent =>
          agent.projectIds.includes(project.id)
        );
        const projectTasks = tasksData.filter(task =>
          task.projectId === project.id
        );
        const projectJobs = jobsData.filter(job =>
          job.projectId === project.id
        );

        const tasksDone = projectTasks.filter(t => t.status === 'done').length;
        const tasksInProgress = projectTasks.filter(t => t.status === 'in_progress').length;
        const tasksTodo = projectTasks.filter(t => t.status === 'todo').length;
        const completionRate = projectTasks.length > 0 ? Math.round((tasksDone / projectTasks.length) * 100) : 0;

        const jobsOpen = projectJobs.filter(j => j.status === 'open').length;
        const jobsInProgress = projectJobs.filter(j => j.status === 'in_progress' || j.status === 'claimed').length;
        const jobsCompleted = projectJobs.filter(j => j.status === 'completed' || j.status === 'closed').length;
        const totalBudget = projectJobs.reduce((s, j) => s + parseReward(j.reward), 0);

        return {
          ...project,
          agentCount: assignedAgents.length,
          taskCount: projectTasks.length,
          tasksDone,
          tasksInProgress,
          tasksTodo,
          completionRate,
          jobCount: projectJobs.length,
          jobsOpen,
          jobsInProgress,
          jobsCompleted,
          totalBudget,
          assignedAgents,
        };
      });

      // Org-wide totals
      const allDone = tasksData.filter(t => t.status === 'done').length;
      const allBudget = jobsData.reduce((s, j) => s + parseReward(j.reward), 0);
      setOrgTotals({ tasks: tasksData.length, done: allDone, jobs: jobsData.length, budget: allBudget });

      setProjects(enrichedProjects);
    } catch (err) {
      console.error("Failed to load projects:", err);
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, [currentOrg]);

  const handleCreateProject = async () => {
    if (!currentOrg || !name.trim()) return;

    try {
      setCreating(true);
      setError(null);

      const projectId = await createProject({
        orgId: currentOrg.id,
        name: name.trim(),
        description: description.trim() || undefined,
        status: 'active',
        agentIds: [],
        createdAt: new Date(),
      });

      // Auto-create a project channel
      await createChannel({
        orgId: currentOrg.id,
        projectId,
        name: `${name.trim()}`,
        createdAt: new Date(),
      });

      // Clear form and close dialog
      setName('');
      setDescription('');
      setShowCreate(false);

      // Reload projects
      await loadProjects();
    } catch (err) {
      console.error('Failed to create project:', err);
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setCreating(false);
    }
  };

  if (!currentOrg) {
    return (
      <div className="space-y-6">
        <p className="text-muted-foreground mt-1">No organization selected</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Button
          onClick={() => setShowCreate(true)}
          className="bg-amber-600 hover:bg-amber-700 text-white"
        >
          + Create Project
        </Button>
      </div>

      {error && (
        <div className="p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-600">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>Loading projects...</p>
        </div>
      ) : projects.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No projects yet</p>
          <p className="text-sm mt-1">Create your first project to get started</p>
        </div>
      ) : (
        <>
          {/* Org-wide summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Projects", value: projects.length, icon: "📁" },
              { label: "Total Tasks", value: orgTotals.tasks, sub: `${orgTotals.done} done`, icon: "🎯" },
              { label: "Total Jobs", value: orgTotals.jobs, icon: "💼" },
              { label: "Total Budget", value: fmtCurrency(orgTotals.budget, 2), icon: "💰" },
            ].map((s) => (
              <Card key={s.label} className="border-border">
                <CardContent className="p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-xs">{s.icon}</span>
                    <p className="text-[11px] text-muted-foreground">{s.label}</p>
                  </div>
                  <p className="text-lg font-bold">{s.value}</p>
                  {s.sub && <p className="text-[10px] text-muted-foreground">{s.sub}</p>}
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <Link key={project.id} href={`/swarms/${project.id}`}>
                <SpotlightCard className="p-0 hover:border-amber-300 transition-colors cursor-pointer h-full" spotlightColor="rgba(255, 191, 0, 0.08)">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1 min-w-0 flex-1">
                        <CardTitle className="text-lg truncate">{project.name}</CardTitle>
                        <CardDescription className="line-clamp-2">{project.description || 'No description'}</CardDescription>
                      </div>
                      <Badge
                        className={
                          project.status === "active"
                            ? "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800"
                            : project.status === "paused"
                            ? "bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-400 dark:border-yellow-800"
                            : "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800"
                        }
                      >
                        {project.status === "active" ? "● Active" :
                         project.status === "paused" ? "⏸ Paused" : "✓ Done"}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* Progress bar */}
                    {project.taskCount > 0 && (
                      <div>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="text-muted-foreground">Task Completion</span>
                          <span className="font-semibold text-amber-600 dark:text-amber-400">{project.completionRate}%</span>
                        </div>
                        <div className="h-2 bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${project.completionRate}%` }} />
                        </div>
                      </div>
                    )}

                    {/* Stats grid */}
                    <div className="grid grid-cols-4 gap-2 text-center">
                      <div>
                        <p className="text-sm font-bold">{project.agentCount}</p>
                        <p className="text-[10px] text-muted-foreground">Agents</p>
                      </div>
                      <div>
                        <p className="text-sm font-bold">{project.taskCount}</p>
                        <p className="text-[10px] text-muted-foreground">Tasks</p>
                      </div>
                      <div>
                        <p className="text-sm font-bold">{project.jobCount}</p>
                        <p className="text-[10px] text-muted-foreground">Jobs</p>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-amber-600 dark:text-amber-400">{project.totalBudget > 0 ? project.totalBudget.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</p>
                        <p className="text-[10px] text-muted-foreground">{currencySymbol}</p>
                      </div>
                    </div>

                    {/* Task status breakdown */}
                    {project.taskCount > 0 && (
                      <div className="flex items-center gap-3 text-[11px]">
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" />{project.tasksDone} done</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" />{project.tasksInProgress} active</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-muted-foreground/40" />{project.tasksTodo} todo</span>
                      </div>
                    )}

                    {/* Job status breakdown */}
                    {project.jobCount > 0 && (
                      <div className="flex items-center gap-3 text-[11px]">
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" />{project.jobsOpen} open</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" />{project.jobsInProgress} in progress</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" />{project.jobsCompleted} completed</span>
                      </div>
                    )}

                    {/* Agent avatars */}
                    <div className="flex -space-x-2 pt-1">
                      {project.assignedAgents.slice(0, 5).map((agent) => (
                        <div
                          key={agent.id}
                          className="w-7 h-7 rounded-full bg-amber-100 dark:bg-amber-900/40 border-2 border-background flex items-center justify-center text-[10px] font-bold text-amber-700 dark:text-amber-400"
                          title={agent.name}
                        >
                          {agent.name.charAt(0)}
                        </div>
                      ))}
                      {project.assignedAgents.length > 5 && (
                        <div className="w-7 h-7 rounded-full bg-muted border-2 border-background flex items-center justify-center text-[10px] font-medium text-muted-foreground">
                          +{project.assignedAgents.length - 5}
                        </div>
                      )}
                      {project.assignedAgents.length === 0 && (
                        <div className="text-xs text-muted-foreground">No agents assigned</div>
                      )}
                    </div>
                  </CardContent>
                </SpotlightCard>
              </Link>
            ))}
          </div>
        </>
      )}

      {/* Create Project Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Project Name *</label>
              <Input
                placeholder="e.g. Trading Bot Fleet"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateProject()}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Description</label>
              <Textarea
                placeholder="What is this project about?"
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={3}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => setShowCreate(false)}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateProject}
                disabled={creating || !name.trim()}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {creating ? 'Creating...' : 'Create Project'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}