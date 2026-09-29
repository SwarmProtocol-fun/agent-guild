/** Missions — Strategic objectives and milestone tracking for agent operations. */
"use client";

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useOrg } from "@/contexts/OrgContext";
import {
  getTasksByOrg,
  getProjectsByOrg,
  getAgentsByOrg,
  createTask,
  updateTask,
  type Task,
  type Project,
  type Agent,
} from "@/lib/firestore";
import { collection, query, where, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import SpotlightCard from "@/components/reactbits/SpotlightCard";

const columns = [
  { status: "todo" as const, label: "To Do", icon: "📋", bg: "bg-muted", border: "border-border", text: "" },
  { status: "in_progress" as const, label: "In Progress", icon: "🔄", bg: "bg-amber-50 dark:bg-amber-900/50", border: "border-amber-200 dark:border-amber-700", text: "dark:text-amber-200" },
  { status: "done" as const, label: "Done", icon: "✅", bg: "bg-emerald-50 dark:bg-emerald-900/50", border: "border-green-200 dark:border-emerald-700", text: "dark:text-emerald-200" },
];

const priorityColors = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400",
};

export default function TasksPage() {
  const { currentOrg } = useOrg();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create task form state
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [taskProject, setTaskProject] = useState('');
  const [taskAssignee, setTaskAssignee] = useState('__none__');
  const [taskPriority, setTaskPriority] = useState<Task['priority']>('medium');
  const [creating, setCreating] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (!currentOrg) return;

    setLoading(true);
    setError(null);

    // Load projects and agents once
    Promise.all([
      getProjectsByOrg(currentOrg.id),
      getAgentsByOrg(currentOrg.id)
    ]).then(([projectsData, agentsData]) => {
      setProjects(projectsData);
      setAgents(agentsData);
    }).catch(err => {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    });

    // Real-time listener for tasks
    const q = query(collection(db, "tasks"), where("orgId", "==", currentOrg.id));
    const unsub = onSnapshot(q, (snap) => {
      const tasksData = snap.docs.map(d => ({ id: d.id, ...d.data() } as Task));
      setTasks(tasksData);
      setLoading(false);
    }, (err) => {
      console.error("Tasks listener error:", err);
      setError(err.message);
      setLoading(false);
    });

    return () => unsub();
  }, [currentOrg]);

  const getProjectName = (projectId: string) => {
    const project = projects.find(p => p.id === projectId);
    return project?.name || "Unknown Project";
  };

  const getAgentName = (agentId?: string) => {
    if (!agentId) return "Unassigned";
    const agent = agents.find(a => a.id === agentId);
    return agent?.name || "Unknown Agent";
  };

  const getTasksByStatus = (status: Task['status']) =>
    tasks.filter(task => task.status === status);

  const handleCreateTask = async () => {
    if (!currentOrg || !taskTitle.trim() || !taskProject) return;

    try {
      setCreating(true);
      setError(null);

      await createTask({
        orgId: currentOrg.id,
        projectId: taskProject,
        title: taskTitle.trim(),
        description: taskDescription.trim(),
        assigneeAgentId: taskAssignee === "__none__" ? "" : taskAssignee || "",
        status: 'todo',
        priority: taskPriority,
        createdAt: new Date(),
      });

      // Reset form
      setTaskTitle('');
      setTaskDescription('');
      setTaskProject('');
      setTaskAssignee('__none__');
      setTaskPriority('medium');
      setCreateOpen(false);

      // Real-time listener auto-updates
    } catch (err) {
      console.error('Failed to create task:', err);
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setCreating(false);
    }
  };

  const handleUpdateTaskStatus = async (task: Task, newStatus: Task['status']) => {
    try {
      setUpdating(true);
      await updateTask(task.id, { status: newStatus });
    } catch (err) {
      console.error('Failed to update task:', err);
      setError(err instanceof Error ? err.message : 'Failed to update task');
    } finally {
      setUpdating(false);
    }
  };

  const formatTime = (timestamp: unknown) => {
    if (!timestamp) return 'Unknown time';
    
    let date: Date;
    if (timestamp && typeof timestamp === 'object' && 'seconds' in timestamp) {
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
          onClick={() => setCreateOpen(true)}
          className="bg-amber-600 hover:bg-amber-700 text-white"
          disabled={projects.length === 0}
        >
          + New Task
        </Button>
      </div>

      {error && (
        <div className="p-3 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>Loading tasks...</p>
        </div>
      ) : projects.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <div className="text-4xl mb-4">📁</div>
          <p className="text-lg">No projects yet</p>
          <p className="text-sm mt-1">Create a project first to add tasks</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {columns.map((col) => {
            const colTasks = getTasksByStatus(col.status);
            return (
              <div key={col.status} className="space-y-3">
                <div className={`flex items-center justify-between rounded-lg px-4 py-2 ${col.bg} border ${col.border} ${col.text}`}>
                  <div className="flex items-center gap-2">
                    <span>{col.icon}</span>
                    <h2 className="font-semibold text-sm">{col.label}</h2>
                  </div>
                  <Badge variant="outline" className="text-xs">{colTasks.length}</Badge>
                </div>

                <div className="space-y-3 min-h-[200px]">
                  {colTasks.map((task) => (
                    <SpotlightCard
                      key={task.id}
                      className="p-0 cursor-pointer hover:shadow-md transition-shadow"
                      spotlightColor="rgba(255, 191, 0, 0.08)"
                      onClick={() => { setSelectedTask(task); setDetailOpen(true); }}
                    >
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-start justify-between">
                          <h3 className="text-sm font-semibold leading-tight line-clamp-2">{task.title}</h3>
                          <Badge 
                            variant="outline" 
                            className={`text-[10px] shrink-0 ml-2 ${priorityColors[task.priority]}`}
                          >
                            {task.priority}
                          </Badge>
                        </div>

                        {task.description && (
                          <p className="text-xs text-muted-foreground line-clamp-2">{task.description}</p>
                        )}

                        <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                          <span className="truncate">📁 {getProjectName(task.projectId)}</span>
                          <span className="shrink-0">·</span>
                          <span className="truncate">🤖 {getAgentName(task.assigneeAgentId)}</span>
                        </div>

                        <div className="text-xs text-muted-foreground">
                          Created {formatTime(task.createdAt)}
                        </div>
                      </CardContent>
                    </SpotlightCard>
                  ))}

                  {colTasks.length === 0 && (
                    <div className="text-center py-8 text-sm text-muted-foreground">No tasks</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Task Detail Dialog */}
      {selectedTask && (
        <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {selectedTask.title}
                <Badge className={`text-xs ${priorityColors[selectedTask.priority]}`}>
                  {selectedTask.priority} priority
                </Badge>
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <p className="text-sm text-muted-foreground">{selectedTask.description || 'No description provided'}</p>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Project:</span>
                  <p className="font-medium">{getProjectName(selectedTask.projectId)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Assignee:</span>
                  <p className="font-medium">{getAgentName(selectedTask.assigneeAgentId)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Status:</span>
                  <p className="font-medium capitalize">{selectedTask.status.replace('_', ' ')}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Created:</span>
                  <p className="font-medium">{formatTime(selectedTask.createdAt)}</p>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-4 border-t">
                <span className="text-sm text-muted-foreground">Update status:</span>
                <div className="flex gap-2">
                  {(['todo', 'in_progress', 'done'] as const).map((status) => (
                    <Button
                      key={status}
                      size="sm"
                      variant={selectedTask.status === status ? 'default' : 'outline'}
                      onClick={() => handleUpdateTaskStatus(selectedTask, status)}
                      disabled={updating}
                      className="text-xs"
                    >
                      {status === 'in_progress' ? 'In Progress' : 
                       status === 'todo' ? 'To Do' : 'Done'}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Create Task Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Task</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Title *</label>
              <Input
                placeholder="Task title"
                value={taskTitle}
                onChange={e => setTaskTitle(e.target.value)}
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Description</label>
              <Textarea
                placeholder="Task description"
                value={taskDescription}
                onChange={e => setTaskDescription(e.target.value)}
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Project *</label>
                <Select value={taskProject} onValueChange={setTaskProject}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-sm font-medium mb-1 block">Priority</label>
                <Select value={taskPriority} onValueChange={(value: Task['priority']) => setTaskPriority(value)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Assignee</label>
              <Select value={taskAssignee} onValueChange={setTaskAssignee}>
                <SelectTrigger>
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Unassigned</SelectItem>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name} ({agent.type})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
                Cancel
              </Button>
              <Button
                onClick={handleCreateTask}
                disabled={creating || !taskTitle.trim() || !taskProject}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {creating ? 'Creating...' : 'Create Task'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}