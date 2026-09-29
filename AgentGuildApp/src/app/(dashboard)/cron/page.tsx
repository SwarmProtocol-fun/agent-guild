/** Cron Scheduler — Create and manage recurring tasks with cron expressions and agent assignments. */
"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Plus, Clock, Play, Pause, Trash2, Edit, X, Calendar,
    CheckCircle2, XCircle, Loader2, Timer, AlertCircle, Zap,
    Bot, CheckSquare, Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useOrg } from "@/contexts/OrgContext";
import { useWalletAccount } from "@/lib/wallet";
import { useAuthAddress } from "@/hooks/useAuthAddress";
import { getAgentsByOrg, type Agent } from "@/lib/firestore";
import {
    type CronJob, type CronJobCreateInput,
    SCHEDULE_PRESETS, parseCronToHuman,
    createCronJob, updateCronJob, deleteCronJob, toggleCronJob, getCronJobs,
} from "@/lib/cron";

// ═══════════════════════════════════════════════════════════════
// Task Dialog
// ═══════════════════════════════════════════════════════════════

function TaskDialog({
    job, agents, onClose, onSave,
}: {
    job?: CronJob;
    agents: Agent[];
    onClose: () => void;
    onSave: (input: CronJobCreateInput) => Promise<void>;
}) {
    const [saving, setSaving] = useState(false);
    const [name, setName] = useState(job?.name || "");
    const [message, setMessage] = useState(job?.message || "");
    const [schedule, setSchedule] = useState(job?.schedule || "0 9 * * *");
    const [customCron, setCustomCron] = useState("");
    const [useCustom, setUseCustom] = useState(false);
    const [priority, setPriority] = useState<"low" | "medium" | "high">(job?.priority || "medium");
    const [enabled, setEnabled] = useState(job?.enabled ?? true);
    const [selectedAgents, setSelectedAgents] = useState<string[]>(job?.agentIds || []);
    const [showAgentPicker, setShowAgentPicker] = useState(false);
    const account = useWalletAccount();
    const { currentOrg } = useOrg();

    const toggleAgent = (agentId: string) => {
        setSelectedAgents(prev =>
            prev.includes(agentId) ? prev.filter(id => id !== agentId) : [...prev, agentId]
        );
    };

    const selectAll = () => {
        if (selectedAgents.length === agents.length) {
            setSelectedAgents([]);
        } else {
            setSelectedAgents(agents.map(a => a.id));
        }
    };

    const handleSubmit = async () => {
        if (!name.trim() || !message.trim() || !currentOrg) return;
        const finalSchedule = useCustom ? customCron : schedule;
        if (!finalSchedule.trim()) return;
        setSaving(true);
        try {
            await onSave({
                orgId: currentOrg.id,
                name: name.trim(),
                message: message.trim(),
                schedule: finalSchedule,
                scheduleLabel: parseCronToHuman(finalSchedule),
                priority,
                enabled,
                agentIds: selectedAgents.length > 0 ? selectedAgents : undefined,
                createdBy: account?.address || "unknown",
            });
            onClose();
        } catch (err) {
            console.error("Failed to save cron job:", err);
        } finally {
            setSaving(false);
        }
    };

    const selectedAgentDetails = agents.filter(a => selectedAgents.includes(a.id));

    return (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
            <Card className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-card border-border p-0" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between p-6 pb-2">
                    <div>
                        <h3 className="text-lg font-bold">{job ? "Edit Task" : "New Scheduled Task"}</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">Schedule an agent prompt to run automatically</p>
                    </div>
                    <Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button>
                </div>

                <div className="p-6 pt-2 space-y-5">
                    {/* Name */}
                    <div>
                        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Task Name</label>
                        <Input
                            placeholder="e.g. Morning Status Report"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            autoFocus
                        />
                    </div>

                    {/* Message */}
                    <div>
                        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Prompt / Message</label>
                        <Textarea
                            placeholder="What should the agent do? e.g. 'Summarize yesterday's activity and flag any issues'"
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            rows={3}
                        />
                    </div>

                    {/* Assign Agents */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                                <Bot className="h-3.5 w-3.5" />
                                Assign Agents
                                {selectedAgents.length > 0 && (
                                    <Badge variant="outline" className="text-[9px] px-1 py-0 ml-1">
                                        {selectedAgents.length} selected
                                    </Badge>
                                )}
                            </label>
                            {agents.length > 1 && (
                                <button
                                    type="button"
                                    onClick={selectAll}
                                    className="text-xs text-amber-500 hover:text-amber-400 transition-colors"
                                >
                                    {selectedAgents.length === agents.length ? "Deselect all" : "Select all"}
                                </button>
                            )}
                        </div>

                        {/* Selected agent chips */}
                        {selectedAgentDetails.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mb-2">
                                {selectedAgentDetails.map(agent => (
                                    <button
                                        key={agent.id}
                                        type="button"
                                        onClick={() => toggleAgent(agent.id)}
                                        className="flex items-center gap-1 px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/30 text-xs text-amber-400 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 transition-colors"
                                    >
                                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                            agent.status === "online" ? "bg-emerald-500" :
                                            agent.status === "busy" ? "bg-amber-500" : "bg-muted-foreground/40"
                                        }`} />
                                        {agent.name}
                                        <X className="h-2.5 w-2.5 ml-0.5" />
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* Toggle agent list */}
                        <button
                            type="button"
                            onClick={() => setShowAgentPicker(!showAgentPicker)}
                            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:text-foreground hover:border-amber-500/30 transition-colors"
                        >
                            <Users className="h-3.5 w-3.5" />
                            {showAgentPicker ? "Hide agent list" : selectedAgents.length > 0 ? "Change agents" : "Choose agents"}
                        </button>

                        {showAgentPicker && (
                            <div className="mt-2 space-y-1 max-h-[180px] overflow-y-auto rounded-lg border border-border p-1">
                                {agents.length === 0 ? (
                                    <p className="text-xs text-muted-foreground py-3 text-center">No agents registered</p>
                                ) : (
                                    agents.map(agent => {
                                        const isSelected = selectedAgents.includes(agent.id);
                                        return (
                                            <button
                                                key={agent.id}
                                                type="button"
                                                onClick={() => toggleAgent(agent.id)}
                                                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                                                    isSelected ? "bg-amber-500/10 border border-amber-500/30" : "hover:bg-muted/50 border border-transparent"
                                                }`}
                                            >
                                                <div className={`w-2 h-2 rounded-full shrink-0 ${
                                                    agent.status === "online" ? "bg-emerald-500" :
                                                    agent.status === "busy" ? "bg-amber-500" : "bg-muted-foreground/40"
                                                }`} />
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-medium truncate">{agent.name}</p>
                                                    <p className="text-[10px] text-muted-foreground">{agent.type}</p>
                                                </div>
                                                {isSelected && (
                                                    <CheckSquare className="h-4 w-4 text-amber-500 shrink-0" />
                                                )}
                                            </button>
                                        );
                                    })
                                )}
                            </div>
                        )}
                    </div>

                    {/* Schedule */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-xs font-medium text-muted-foreground">Schedule</label>
                            <button
                                onClick={() => setUseCustom(!useCustom)}
                                className="text-xs text-amber-500 hover:text-amber-400 transition-colors"
                            >
                                {useCustom ? "Use presets" : "Custom cron"}
                            </button>
                        </div>
                        {!useCustom ? (
                            <div className="grid grid-cols-2 gap-2">
                                {SCHEDULE_PRESETS.map((preset) => (
                                    <button
                                        key={preset.value}
                                        type="button"
                                        onClick={() => setSchedule(preset.value)}
                                        className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-left text-sm transition-all ${schedule === preset.value
                                                ? "border-amber-500/50 bg-amber-500/10 text-amber-400"
                                                : "border-border hover:border-amber-500/30 text-muted-foreground hover:text-foreground"
                                            }`}
                                    >
                                        <span className="text-base">{preset.icon}</span>
                                        <span className="truncate">{preset.label}</span>
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <div>
                                <Input
                                    placeholder="*/5 * * * *"
                                    value={customCron}
                                    onChange={(e) => setCustomCron(e.target.value)}
                                    className="font-mono"
                                />
                                <p className="text-[10px] text-muted-foreground mt-1">
                                    Format: minute hour day-of-month month day-of-week
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Priority */}
                    <div>
                        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Priority</label>
                        <div className="flex gap-2">
                            {(["low", "medium", "high"] as const).map((p) => (
                                <button
                                    key={p}
                                    onClick={() => setPriority(p)}
                                    className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-all ${priority === p
                                            ? p === "high" ? "bg-red-500/20 text-red-400 border border-red-500/30"
                                                : p === "medium" ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                                                    : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                                            : "bg-muted/50 text-muted-foreground border border-transparent hover:border-border"
                                        }`}
                                >
                                    {p}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="flex justify-end gap-2 pt-2">
                        <Button variant="outline" onClick={onClose}>Cancel</Button>
                        <Button
                            onClick={handleSubmit}
                            disabled={!name.trim() || !message.trim() || saving}
                            className="bg-amber-500 hover:bg-amber-600 text-white"
                        >
                            {saving ? <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving...</> : job ? "Update Task" : "Create Task"}
                        </Button>
                    </div>
                </div>
            </Card>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════
// Main Page
// ═══════════════════════════════════════════════════════════════

export default function CronPage() {
    const { currentOrg } = useOrg();
    const account = useWalletAccount();
    const authAddress = useAuthAddress();
    const [jobs, setJobs] = useState<CronJob[]>([]);
    const [agents, setAgents] = useState<Agent[]>([]);
    const [loading, setLoading] = useState(true);
    const [showDialog, setShowDialog] = useState(false);
    const [editingJob, setEditingJob] = useState<CronJob | undefined>();
    const [togglingId, setTogglingId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const loadJobs = useCallback(async () => {
        if (!currentOrg) return;
        try {
            setLoading(true);
            const data = await getCronJobs(currentOrg.id);
            setJobs(data);
        } catch (err) {
            console.error("Failed to load cron jobs:", err);
        } finally {
            setLoading(false);
        }
    }, [currentOrg]);

    const loadAgents = useCallback(async () => {
        if (!currentOrg) return;
        try {
            const data = await getAgentsByOrg(currentOrg.id);
            setAgents(data);
        } catch (err) {
            console.error("Failed to load agents:", err);
        }
    }, [currentOrg]);

    useEffect(() => { loadJobs(); loadAgents(); }, [loadJobs, loadAgents]);

    const handleCreate = async (input: CronJobCreateInput) => {
        await createCronJob(input);
        await loadJobs();
    };

    const handleUpdate = async (input: CronJobCreateInput) => {
        if (!editingJob) return;
        await updateCronJob(editingJob.id, {
            name: input.name,
            message: input.message,
            schedule: input.schedule,
            scheduleLabel: input.scheduleLabel,
            priority: input.priority,
            enabled: input.enabled,
            agentIds: input.agentIds,
        });
        await loadJobs();
    };

    const handleToggle = async (job: CronJob) => {
        setTogglingId(job.id);
        try {
            await toggleCronJob(job.id, !job.enabled);
            setJobs((prev) => prev.map((j) => j.id === job.id ? { ...j, enabled: !j.enabled } : j));
        } finally {
            setTogglingId(null);
        }
    };

    const handleDelete = async (id: string) => {
        setDeletingId(id);
        try {
            await deleteCronJob(id);
            setJobs((prev) => prev.filter((j) => j.id !== id));
        } finally {
            setDeletingId(null);
        }
    };

    /** Resolve agent IDs to names for display */
    const getAgentNames = (agentIds?: string[]) => {
        if (!agentIds || agentIds.length === 0) return [];
        return agentIds.map(id => {
            const agent = agents.find(a => a.id === id);
            return agent ? { id: agent.id, name: agent.name, status: agent.status } : null;
        }).filter(Boolean) as { id: string; name: string; status: string }[];
    };

    if (!account && !authAddress) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-muted-foreground">
                <Clock className="h-12 w-12 opacity-30" />
                <p>Connect your wallet to manage scheduled tasks</p>
            </div>
        );
    }

    const activeJobs = jobs.filter((j) => j.enabled);
    const pausedJobs = jobs.filter((j) => !j.enabled);

    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20">
                            <Calendar className="h-6 w-6 text-amber-500" />
                        </div>
                        Cron Scheduler
                    </h1>
                    <p className="text-sm text-muted-foreground mt-2">
                        Schedule agent tasks to run automatically — daily reports, monitoring, recurring workflows
                    </p>
                </div>
                <Button
                    onClick={() => { setEditingJob(undefined); setShowDialog(true); }}
                    className="bg-amber-500 hover:bg-amber-600 text-white gap-2"
                >
                    <Plus className="h-4 w-4" /> New Task
                </Button>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4 mb-8">
                <Card className="p-4 bg-card border-border">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-emerald-500/10"><Zap className="h-4 w-4 text-emerald-400" /></div>
                        <div>
                            <p className="text-2xl font-bold">{activeJobs.length}</p>
                            <p className="text-xs text-muted-foreground">Active Tasks</p>
                        </div>
                    </div>
                </Card>
                <Card className="p-4 bg-card border-border">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-amber-500/10"><Pause className="h-4 w-4 text-amber-400" /></div>
                        <div>
                            <p className="text-2xl font-bold">{pausedJobs.length}</p>
                            <p className="text-xs text-muted-foreground">Paused</p>
                        </div>
                    </div>
                </Card>
                <Card className="p-4 bg-card border-border">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-blue-500/10"><Timer className="h-4 w-4 text-blue-400" /></div>
                        <div>
                            <p className="text-2xl font-bold">{jobs.length}</p>
                            <p className="text-xs text-muted-foreground">Total</p>
                        </div>
                    </div>
                </Card>
            </div>

            {/* Task List */}
            {loading ? (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
                </div>
            ) : jobs.length === 0 ? (
                <Card className="p-12 text-center bg-card border-border border-dashed">
                    <Clock className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                    <h3 className="text-lg font-semibold mb-2">No scheduled tasks yet</h3>
                    <p className="text-sm text-muted-foreground mb-6 max-w-md mx-auto">
                        Create your first scheduled task to have agents run prompts automatically on a schedule.
                    </p>
                    <Button
                        onClick={() => { setEditingJob(undefined); setShowDialog(true); }}
                        className="bg-amber-500 hover:bg-amber-600 text-white gap-2"
                    >
                        <Plus className="h-4 w-4" /> Create First Task
                    </Button>
                </Card>
            ) : (
                <div className="space-y-3">
                    {jobs.map((job) => {
                        const assignedAgents = getAgentNames(job.agentIds);
                        return (
                            <Card
                                key={job.id}
                                className={`p-4 bg-card border-border transition-all hover:border-amber-500/20 ${!job.enabled ? "opacity-60" : ""
                                    }`}
                            >
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                                            <h3 className="font-semibold truncate">{job.name}</h3>
                                            <Badge variant="outline" className={`text-[10px] ${job.priority === "high" ? "border-red-500/30 text-red-400" :
                                                    job.priority === "low" ? "border-emerald-500/30 text-emerald-400" :
                                                        "border-amber-500/30 text-amber-400"
                                                }`}>
                                                {job.priority || "medium"}
                                            </Badge>
                                            {job.enabled ? (
                                                <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px]">
                                                    <Play className="h-2.5 w-2.5 mr-0.5" /> Active
                                                </Badge>
                                            ) : (
                                                <Badge className="bg-muted text-muted-foreground text-[10px]">
                                                    <Pause className="h-2.5 w-2.5 mr-0.5" /> Paused
                                                </Badge>
                                            )}
                                        </div>

                                        <p className="text-sm text-muted-foreground line-clamp-2 mb-2">{job.message}</p>

                                        {/* Assigned agents */}
                                        {assignedAgents.length > 0 && (
                                            <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                                                <Bot className="h-3 w-3 text-muted-foreground shrink-0" />
                                                {assignedAgents.map(agent => (
                                                    <Badge
                                                        key={agent.id}
                                                        variant="outline"
                                                        className="text-[10px] px-1.5 py-0 gap-1"
                                                    >
                                                        <span className={`w-1.5 h-1.5 rounded-full ${
                                                            agent.status === "online" ? "bg-emerald-500" :
                                                            agent.status === "busy" ? "bg-amber-500" : "bg-muted-foreground/40"
                                                        }`} />
                                                        {agent.name}
                                                    </Badge>
                                                ))}
                                            </div>
                                        )}

                                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                            <span className="flex items-center gap-1">
                                                <Clock className="h-3 w-3" />
                                                {job.scheduleLabel || parseCronToHuman(job.schedule)}
                                            </span>
                                            {job.lastRun && (
                                                <span className="flex items-center gap-1">
                                                    {job.lastRun.success ? (
                                                        <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                                                    ) : (
                                                        <XCircle className="h-3 w-3 text-red-400" />
                                                    )}
                                                    Last: {job.lastRun.time.toLocaleString()}
                                                    {job.lastRun.durationMs && ` (${(job.lastRun.durationMs / 1000).toFixed(1)}s)`}
                                                </span>
                                            )}
                                            {job.lastRun?.error && (
                                                <span className="flex items-center gap-1 text-red-400">
                                                    <AlertCircle className="h-3 w-3" />
                                                    {job.lastRun.error}
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8"
                                            onClick={() => handleToggle(job)}
                                            disabled={togglingId === job.id}
                                            title={job.enabled ? "Pause" : "Resume"}
                                        >
                                            {togglingId === job.id ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : job.enabled ? (
                                                <Pause className="h-4 w-4" />
                                            ) : (
                                                <Play className="h-4 w-4" />
                                            )}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8"
                                            onClick={() => { setEditingJob(job); setShowDialog(true); }}
                                            title="Edit"
                                        >
                                            <Edit className="h-4 w-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                                            onClick={() => handleDelete(job.id)}
                                            disabled={deletingId === job.id}
                                            title="Delete"
                                        >
                                            {deletingId === job.id ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : (
                                                <Trash2 className="h-4 w-4" />
                                            )}
                                        </Button>
                                    </div>
                                </div>
                            </Card>
                        );
                    })}
                </div>
            )}

            {/* Dialog */}
            {showDialog && (
                <TaskDialog
                    job={editingJob}
                    agents={agents}
                    onClose={() => { setShowDialog(false); setEditingJob(undefined); }}
                    onSave={editingJob ? handleUpdate : handleCreate}
                />
            )}
        </div>
    );
}
