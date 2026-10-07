/** Agent Map — Visual node graph of all agents showing status, connections, and workload. */
"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { useOrg } from "@/contexts/OrgContext";
import { useWalletAccount } from "@/lib/wallet";
import { useChainCurrency } from "@/hooks/useChainCurrency";
import { motion } from "motion/react";
import type { DispatchPayload } from "@/components/agent-map/agent-map";

const AgentMap = dynamic(
  () => import("@/components/agent-map/agent-map"),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-96 text-muted-foreground">
        Loading agent map...
      </div>
    ),
  }
);
import {
    getAgentsByOrg,
    getTasksByOrg,
    getJobsByOrg,
    getProjectsByOrg,
    type Agent,
    type Task,
    type Job,
    type Project,
} from "@/lib/firestore";
import { dispatchJob, assignJob } from "@/lib/jobs-client";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function AgentMapPage() {
    const { currentOrg } = useOrg();
    const { symbol: currencySymbol } = useChainCurrency();
    const account = useWalletAccount();
    const [agents, setAgents] = useState<Agent[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [jobs, setJobs] = useState<Job[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);
    const [selectedProject, setSelectedProject] = useState<string>("all");
    const [loading, setLoading] = useState(true);
    const [dispatching, setDispatching] = useState(false);

    const loadData = useCallback(async () => {
        if (!currentOrg) return;
        try {
            const [a, t, j, p] = await Promise.all([
                getAgentsByOrg(currentOrg.id),
                getTasksByOrg(currentOrg.id),
                getJobsByOrg(currentOrg.id),
                getProjectsByOrg(currentOrg.id),
            ]);
            setAgents(a);
            setTasks(t);
            setJobs(j);
            setProjects(p);
        } catch {
            // handled
        }
    }, [currentOrg]);

    useEffect(() => {
        if (!currentOrg) return;
        setLoading(true);
        loadData().finally(() => setLoading(false));
    }, [currentOrg, loadData]);

    // Dispatch handler — creates job, assigns agents, refreshes data
    const handleDispatch = useCallback(async (payload: DispatchPayload) => {
        if (!currentOrg) return;
        const { prompt, priority, reward, agentIds } = payload;
        const agentNames = agentIds.map(id => agents.find(a => a.id === id)?.name || id);

        try {
            setDispatching(true);

            // Server-side: validates, assigns agentIds[0] as lead and the rest as
            // collaborators, and records it all in the job's audit trail.
            const { jobId } = await dispatchJob({
              orgId: currentOrg.id,
              projectId: selectedProject === "all" ? "" : selectedProject,
              prompt,
              agentIds,
              priority,
              reward: reward || undefined,
            });

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

            await loadData();
        } catch (err) {
            console.error("Dispatch failed:", err);
        } finally {
            setDispatching(false);
        }
    }, [currentOrg, agents, account, currencySymbol, selectedProject, loadData]);

    // Assign handler — assigns agents to open jobs
    const handleAssign = useCallback(async (assignments: { jobId: string; agentId: string; jobTitle: string; agentName: string }[]) => {
        if (!currentOrg) return;
        try {
            setDispatching(true);
            for (const a of assignments) {
                await assignJob(a.jobId, a.agentId);
            }
            await loadData();
        } catch (err) {
            console.error("Assign failed:", err);
        } finally {
            setDispatching(false);
        }
    }, [currentOrg, selectedProject, loadData]);

    if (!currentOrg) {
        return (
            <div className="space-y-6">
                <p className="text-muted-foreground mt-1">No organization selected</p>
            </div>
        );
    }

    // Filter by selected project
    const filteredAgents = selectedProject === "all"
        ? agents
        : agents.filter(a => a.projectIds?.includes(selectedProject));

    const filteredTasks = selectedProject === "all"
        ? tasks
        : tasks.filter(t => t.projectId === selectedProject);

    const filteredJobs = selectedProject === "all"
        ? jobs
        : jobs.filter(j => j.projectId === selectedProject);

    const projectName = selectedProject === "all"
        ? currentOrg.name
        : projects.find(p => p.id === selectedProject)?.name || "Project";

    const parseReward = (r?: string) => { if (!r) return 0; const n = parseFloat(r.replace(/[^0-9.]/g, '')); return isNaN(n) ? 0 : n; };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-end">
                <Select value={selectedProject} onValueChange={setSelectedProject}>
                    <SelectTrigger className="w-[220px]">
                        <SelectValue placeholder="All Projects" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All Projects</SelectItem>
                        {projects.map(p => (
                            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            {/* Stats */}
            <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.1 }}
                className="flex gap-4 flex-wrap"
            >
                {[
                    { label: "Agents", value: filteredAgents.length, icon: "🤖" },
                    { label: "Online", value: filteredAgents.filter(a => a.status === "online").length, icon: "🟢" },
                    { label: "Tasks", value: filteredTasks.length, icon: "🎯" },
                    { label: "Jobs", value: filteredJobs.length, icon: "💼" },
                ].map(stat => (
                    <div
                        key={stat.label}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg border bg-card text-sm"
                    >
                        <span>{stat.icon}</span>
                        <span className="font-semibold">{stat.value}</span>
                        <span className="text-muted-foreground">{stat.label}</span>
                    </div>
                ))}
            </motion.div>

            {/* Map */}
            <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.2 }}
            >
                {loading ? (
                    <div className="flex items-center justify-center rounded-xl border bg-card text-muted-foreground" style={{ height: 400 }}>
                        Loading map...
                    </div>
                ) : filteredAgents.length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-xl border bg-card text-muted-foreground" style={{ height: 400 }}>
                        <span className="text-5xl mb-4">🗺️</span>
                        <p className="text-lg">No agents to display</p>
                        <p className="text-sm mt-1">Add agents to a project to see them on the map</p>
                    </div>
                ) : (
                    <AgentMap
                        projectName={projectName}
                        agents={filteredAgents.map(a => {
                            const activeJob = filteredJobs.find(j => j.takenByAgentId === a.id && j.status === 'in_progress');
                            const agentJobs = filteredJobs.filter(j => j.takenByAgentId === a.id);
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
                        tasks={filteredTasks.map(t => ({
                            id: t.id,
                            status: t.status,
                            assigneeAgentId: t.assigneeAgentId,
                        }))}
                        jobs={filteredJobs.map(j => ({
                            id: j.id,
                            title: j.title,
                            reward: j.reward,
                            priority: j.priority,
                            requiredSkills: j.requiredSkills ?? [],
                            status: j.status,
                        }))}
                        onDispatch={handleDispatch}
                        onAssign={handleAssign}
                        executing={dispatching}
                        currencySymbol={currencySymbol}
                    />
                )}
            </motion.div>
        </div>
    );
}
