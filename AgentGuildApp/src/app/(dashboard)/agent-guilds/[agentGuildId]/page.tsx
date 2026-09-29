/** Agent Guild Detail — Individual project view with agents, tasks, activity, and agent comms tabs. */
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWalletAccount } from "@/lib/wallet";
import { useChainCurrency } from "@/hooks/useChainCurrency";
import dynamic from "next/dynamic";
import Link from "next/link";

const AgentMap = dynamic(() => import("@/components/agent-map/agent-map"), { ssr: false });
// [agent-guild-core] GitHub mod extracted
const GitHubIcon = ({ className }: { className?: string }) => <span className={className}>GH</span>;
const GitHubPanel = (_props: Record<string, unknown>) => null;
const RepoSelector = (_props: Record<string, unknown>) => null;
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useOrg } from "@/contexts/OrgContext";
import {
  getProject,
  getAgentsByOrg,
  getTasksByProject,
  getUnassignedAgents,
  assignAgentToProject,
  unassignAgentFromProject,
  createTask,
  updateTask,
  getOrCreateProjectChannel,
  sendMessage,
  onMessagesByChannel,
  getJobsByProject,
  createJob,
  claimJob,
  closeJob,
  updateJob,
  onAgentCommsByOrg,
  type Project,
  type Agent,
  type Task,
  type Job,
  type Message,
  type Channel,
  type Profile,
  type AgentComm,
  updateProject,
  deleteProject,
  getProfile,
  getProfilesByAddresses,
} from "@/lib/firestore";
import { db } from "@/lib/firebase";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import type { DispatchPayload } from "@/components/agent-map/agent-map";
import { Paperclip, Mic, Square, X, Download } from "lucide-react";
import { uploadFiles, uploadVoiceRecording, validateFiles, getFileCategory, formatFileSize } from "@/lib/storage";
import type { Attachment } from "@/lib/firestore";

const TASK_STATUS_COLORS: Record<string, string> = {
  todo: "bg-muted text-muted-foreground",
  in_progress: "bg-amber-100 text-amber-700",
  done: "bg-emerald-100 text-emerald-700",
};

const PRIORITY_LABELS: Record<string, { label: string; color: string }> = {
  low: { label: "Low", color: "text-muted-foreground" },
  medium: { label: "Medium", color: "text-amber-600 dark:text-amber-400" },
  high: { label: "High", color: "text-orange-600 dark:text-orange-400" },
};

export default function ProjectDetailPage() {
  const params = useParams();
  const projectId = params.agentGuildId as string;
  const { currentOrg } = useOrg();
  const account = useWalletAccount();
  const { symbol: currencySymbol, fmt: fmtCurrency } = useChainCurrency();

  const [project, setProject] = useState<Project | null>(null);
  const [assignedAgents, setAssignedAgents] = useState<Agent[]>([]);
  const [unassignedAgents, setUnassignedAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [agentComms, setAgentComms] = useState<AgentComm[]>([]);
  const [commsFilterType, setCommsFilterType] = useState<string>('all');
  const [commsSearch, setCommsSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dialog states
  const [showAssignAgent, setShowAssignAgent] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [showCreateJob, setShowCreateJob] = useState(false);
  const [newJobTitle, setNewJobTitle] = useState('');
  const [newJobDesc, setNewJobDesc] = useState('');
  const [newJobReward, setNewJobReward] = useState('');
  const [newJobPriority, setNewJobPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [creatingJob, setCreatingJob] = useState(false);
  const [showTaskDetail, setShowTaskDetail] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  // Form states
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [activeTab, setActiveTab] = useState('agents');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [taskPriority, setTaskPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [showEditProject, setShowEditProject] = useState(false);
  const [showDeleteProject, setShowDeleteProject] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const router = useRouter();
  const [taskAssignee, setTaskAssignee] = useState<string>('__none__');
  const [creating, setCreating] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [batchAssigning, setBatchAssigning] = useState(false);

  // Chat state
  const [channel, setChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [agentThinking, setAgentThinking] = useState(false);
  const lastMsgCountRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Media upload state
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);

  // @ mention autocomplete state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionStart, setMentionStart] = useState(0);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const mentionRef = useRef<HTMLDivElement>(null);

  // Profile state
  const [profileMap, setProfileMap] = useState<Map<string, Profile>>(new Map());
  const [myProfile, setMyProfile] = useState<Profile | null>(null);

  const loadProjectData = async () => {
    if (!currentOrg) return;

    try {
      setLoading(true);
      setError(null);

      const [projectData, allAgents, projectTasks, projectJobs] = await Promise.all([
        getProject(projectId),
        getAgentsByOrg(currentOrg.id),
        getTasksByProject(projectId),
        getJobsByProject(projectId),
      ]);

      if (!projectData) {
        setError('Project not found');
        return;
      }

      setProject(projectData);

      // Split agents into assigned and unassigned
      const assigned = allAgents.filter(agent => agent.projectIds.includes(projectId));
      const unassigned = allAgents.filter(agent => !agent.projectIds.includes(projectId));

      setAssignedAgents(assigned);
      setUnassignedAgents(unassigned);
      setTasks(projectTasks);
      setJobs(projectJobs);
    } catch (err) {
      console.error('Failed to load project data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load project data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjectData();
  }, [projectId, currentOrg]);

  // Subscribe to agent comms for this org
  useEffect(() => {
    if (!currentOrg) return;
    const unsub = onAgentCommsByOrg(currentOrg.id, (comms) => {
      setAgentComms(comms);
    });
    return () => unsub();
  }, [currentOrg]);

  // Auto-create project channel & subscribe to messages
  useEffect(() => {
    if (!currentOrg || !project) return;
    let unsub: (() => void) | undefined;

    (async () => {
      try {
        const ch = await getOrCreateProjectChannel(projectId, currentOrg.id, project.name);
        setChannel(ch);
        unsub = onMessagesByChannel(ch.id, (msgs) => {
          setMessages(msgs);
        });
      } catch (err) {
        console.error('Failed to setup project channel:', err);
      }
    })();

    return () => { unsub?.(); };
  }, [projectId, currentOrg, project]);

  // Fetch own profile
  useEffect(() => {
    if (!account?.address) return;
    getProfile(account.address).then(p => setMyProfile(p));
  }, [account?.address]);

  // Fetch profiles for human message senders
  useEffect(() => {
    const humanAddrs = [...new Set(
      messages.filter(m => m.senderType === 'human').map(m => m.senderId)
    )];
    if (humanAddrs.length === 0) return;
    getProfilesByAddresses(humanAddrs).then(setProfileMap);
  }, [messages]);

  // Filtered agents for @ mention
  const mentionAgents = mentionQuery !== null
    ? assignedAgents.filter(a => a.name.toLowerCase().includes(mentionQuery.toLowerCase()))
    : [];

  // Click outside to dismiss mention popup
  useEffect(() => {
    if (mentionQuery === null) return;
    const handler = (e: MouseEvent) => {
      if (mentionRef.current && !mentionRef.current.contains(e.target as Node)) {
        setMentionQuery(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [mentionQuery]);

  const handleChatInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setChatInput(val);
    const pos = e.target.selectionStart || 0;
    // Find @ before cursor
    const before = val.slice(0, pos);
    const atIdx = before.lastIndexOf('@');
    if (atIdx !== -1) {
      const between = before.slice(atIdx + 1);
      // Only trigger if @ is at start or preceded by space, and no space in query
      if ((atIdx === 0 || before[atIdx - 1] === ' ') && !between.includes(' ')) {
        setMentionQuery(between);
        setMentionStart(atIdx);
        setMentionIndex(0);
        return;
      }
    }
    setMentionQuery(null);
  };

  const insertMention = (agentName: string) => {
    const before = chatInput.slice(0, mentionStart);
    const after = chatInput.slice((chatInputRef.current?.selectionStart || mentionStart + (mentionQuery?.length || 0) + 1));
    setChatInput(before + '@' + agentName + ' ' + after);
    setMentionQuery(null);
    chatInputRef.current?.focus();
  };

  // Auto-scroll on new messages + detect agent responses
  useEffect(() => {
    // Use instant scroll on first load, smooth for subsequent messages
    const behavior = lastMsgCountRef.current === 0 ? 'instant' : 'smooth';
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior }), 100);
    // If new messages arrived and any are from agents, stop thinking
    if (messages.length > lastMsgCountRef.current) {
      const newMsgs = messages.slice(lastMsgCountRef.current);
      if (newMsgs.some(m => m.senderType === 'agent')) {
        setAgentThinking(false);
      }
    }
    lastMsgCountRef.current = messages.length;
  }, [messages]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const error = validateFiles(files);
    if (error) { alert(error); return; }
    const total = pendingFiles.length + files.length;
    if (total > 5) { alert('Maximum 5 files per message'); return; }
    setPendingFiles(prev => [...prev, ...files]);
    e.target.value = '';
  }, [pendingFiles]);

  const removePendingFile = useCallback((index: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const startRecording = useCallback(async () => {
    if (!channel || !currentOrg) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
        setIsRecording(false);
        setRecordingDuration(0);
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        if (blob.size === 0) return;
        try {
          setUploading(true);
          const att = await uploadVoiceRecording(blob, currentOrg.id, channel.id);
          const addr = account?.address || 'anonymous';
          await sendMessage({
            channelId: channel.id,
            senderId: addr,
            senderName: myProfile?.displayName || (addr.slice(0, 6) + '...' + addr.slice(-4)),
            senderType: 'human',
            content: '',
            orgId: currentOrg.id,
            attachments: [att],
            createdAt: new Date(),
          });
        } catch (err) { console.error('Failed to send voice:', err); }
        finally { setUploading(false); }
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setRecordingDuration(0);
      recordingTimerRef.current = setInterval(() => setRecordingDuration(d => d + 1), 1000);
    } catch (err) { console.error('Microphone access denied:', err); }
  }, [channel, currentOrg, account, myProfile]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const handleSendChat = async () => {
    if ((!chatInput.trim() && pendingFiles.length === 0) || !channel || !currentOrg) return;
    const addr = account?.address || 'anonymous';
    try {
      setSendingChat(true);
      let attachments: Attachment[] | undefined;
      if (pendingFiles.length > 0) {
        setUploading(true);
        attachments = await uploadFiles(pendingFiles, currentOrg.id, channel.id);
        setUploading(false);
      }
      await sendMessage({
        channelId: channel.id,
        senderId: addr,
        senderName: myProfile?.displayName || (addr.slice(0, 6) + '...' + addr.slice(-4)),
        senderType: 'human',
        content: chatInput.trim(),
        orgId: currentOrg.id,
        ...(attachments ? { attachments } : {}),
        createdAt: new Date(),
      });
      setChatInput('');
      setPendingFiles([]);
      if (assignedAgents.length > 0) {
        setAgentThinking(true);
        setTimeout(() => setAgentThinking(false), 30000);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      setUploading(false);
    } finally {
      setSendingChat(false);
    }
  };

  const handleAssignAgent = async () => {
    if (!selectedAgentId) return;

    try {
      await assignAgentToProject(projectId, selectedAgentId);
      setSelectedAgentId('');
      setShowAssignAgent(false);
      await loadProjectData();
    } catch (err) {
      console.error('Failed to assign agent:', err);
      setError(err instanceof Error ? err.message : 'Failed to assign agent');
    }
  };

  const handleUnassignAgent = async (agentId: string) => {
    try {
      await unassignAgentFromProject(projectId, agentId);
      await loadProjectData();
    } catch (err) {
      console.error('Failed to unassign agent:', err);
      setError(err instanceof Error ? err.message : 'Failed to unassign agent');
    }
  };

  const handleCreateTask = async () => {
    if (!currentOrg || !taskTitle.trim()) return;

    try {
      setCreating(true);
      await createTask({
        orgId: currentOrg.id,
        projectId,
        title: taskTitle.trim(),
        description: taskDescription.trim(),
        assigneeAgentId: taskAssignee === "__none__" ? undefined : taskAssignee || undefined,
        status: 'todo',
        priority: taskPriority,
        createdAt: new Date(),
      });

      // Reset form
      setTaskTitle('');
      setTaskDescription('');
      setTaskPriority('medium');
      setTaskAssignee('__none__');
      setShowCreateTask(false);

      await loadProjectData();
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
      await loadProjectData();
    } catch (err) {
      console.error('Failed to update task:', err);
      setError(err instanceof Error ? err.message : 'Failed to update task');
    } finally {
      setUpdating(false);
    }
  };

  // Batch assign agents to jobs from Agent Map
  const handleBatchAssign = async (assignments: { jobId: string; agentId: string; jobTitle: string; agentName: string }[]) => {
    if (!currentOrg) return;
    try {
      setBatchAssigning(true);
      setError(null);
      for (const { jobId, agentId, jobTitle, agentName } of assignments) {
        await claimJob(jobId, agentId, currentOrg.id, projectId);
        if (channel) {
          try {
            await sendMessage({
              channelId: channel.id,
              senderId: "system",
              senderName: "System",
              senderType: "system" as any,
              content: `📋 **Agent Assignment**\nJob: "${jobTitle}"\nAssigned to: @${agentName}\n\nExecuted via Agent Map workflow.`,
              orgId: currentOrg.id,
              createdAt: new Date(),
            });
          } catch { /* non-critical */ }
        }
      }
      await loadProjectData();
    } catch (err) {
      console.error("Batch assign failed:", err);
      setError(err instanceof Error ? err.message : "Failed to assign agents to jobs");
    } finally {
      setBatchAssigning(false);
    }
  };

  // Quick Dispatch from Agent Map — create job + assign agents + coordination comms
  const handleDispatch = async (payload: DispatchPayload) => {
    if (!currentOrg) return;
    const { prompt, priority, reward, agentIds } = payload;
    const agentNames = agentIds.map(id => assignedAgents.find(a => a.id === id)?.name || id);

    try {
      setBatchAssigning(true);
      setError(null);

      // 1. Create the job
      const jobId = await createJob({
        orgId: currentOrg.id,
        projectId,
        title: prompt.slice(0, 120) + (prompt.length > 120 ? '…' : ''),
        description: prompt,
        status: 'open',
        reward: reward || undefined,
        requiredSkills: [],
        postedByAddress: account?.address || 'unknown',
        priority,
        createdAt: new Date(),
      });

      // 2. Assign each selected agent
      for (const agentId of agentIds) {
        await claimJob(jobId, agentId, currentOrg.id, projectId);
      }

      // 3. Post coordination to agent comms (handoff type)
      try {
        await addDoc(collection(db, "agentComms"), {
          orgId: currentOrg.id,
          fromAgentId: "system",
          fromAgentName: "Agent Dispatch",
          toAgentId: agentIds.join(","),
          toAgentName: agentNames.join(", "),
          type: "handoff",
          content: `🚀 **Job Dispatched**\n\n**Prompt:** ${prompt}\n\n**Assigned Agents:** ${agentNames.map(n => `@${n}`).join(", ")}\n**Priority:** ${priority}${reward ? `\n**Reward:** ${reward} ${currencySymbol}` : ""}\n\nCoordinate as a team to complete this task.`,
          metadata: { jobId, projectId, priority, reward, agentIds },
          createdAt: serverTimestamp(),
        });
      } catch { /* comms log is non-critical */ }

      // 4. Post prompt to project channel
      if (channel) {
        try {
          await sendMessage({
            channelId: channel.id,
            senderId: "system",
            senderName: "Agent Dispatch",
            senderType: "system" as any,
            content: `🚀 **New Job Dispatched via Agent Map**\n\n${prompt}\n\n**Team:** ${agentNames.map(n => `@${n}`).join(", ")}\n**Priority:** ${priority}${reward ? ` · **Reward:** ${reward} ${currencySymbol}` : ""}`,
            orgId: currentOrg.id,
            createdAt: new Date(),
          });
        } catch { /* non-critical */ }
      }

      await loadProjectData();
    } catch (err) {
      console.error("Dispatch failed:", err);
      setError(err instanceof Error ? err.message : "Failed to dispatch job");
    } finally {
      setBatchAssigning(false);
    }
  };

  // Cost helpers
  const parseReward = (reward?: string): number => {
    if (!reward) return 0;
    const n = parseFloat(reward.replace(/[^0-9.]/g, ''));
    return isNaN(n) ? 0 : n;
  };
  const totalBudget = jobs.reduce((s, j) => s + parseReward(j.reward), 0);
  const spentBudget = jobs.filter(j => j.status === 'completed').reduce((s, j) => s + parseReward(j.reward), 0);
  const inProgressBudget = jobs.filter(j => j.status === 'in_progress').reduce((s, j) => s + parseReward(j.reward), 0);
  const openBudget = jobs.filter(j => j.status === 'open').reduce((s, j) => s + parseReward(j.reward), 0);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <p>Loading project...</p>
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="text-4xl mb-4">😕</div>
          <h2 className="text-xl font-bold mb-2">Project Not Found</h2>
          <p className="text-muted-foreground mb-4">{error}</p>
          <Button asChild variant="outline">
            <Link href="/agent-guilds">← Back to Projects</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Link href="/agent-guilds" className="text-muted-foreground hover:text-amber-600 transition-colors text-lg">
            ←
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
              <Badge
                className={
                  project.status === "active"
                    ? "bg-amber-100 text-amber-700 border-amber-200"
                    : project.status === "paused"
                      ? "bg-yellow-100 text-yellow-700 border-yellow-200"
                      : "bg-muted text-muted-foreground border-border"
                }
              >
                {project.status === "active" ? "● Active" :
                  project.status === "paused" ? "⏸ Paused" : "✓ Done"}
              </Badge>
            </div>
            <p className="text-muted-foreground mt-1">{project.description || 'No description'}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { setEditName(project.name); setEditDescription(project.description || ''); setShowEditProject(true); }}>✏️ Edit</Button>
          <Button variant="outline" size="sm" className="text-red-400 border-red-400 hover:bg-red-500/10" onClick={() => setShowDeleteProject(true)}>🗑️ Delete</Button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-600">
          {error}
        </div>
      )}

      {/* Project Metrics Overview */}
      {(() => {
        const tasksDone = tasks.filter(t => t.status === 'done').length;
        const tasksInProgress = tasks.filter(t => t.status === 'in_progress').length;
        const tasksTodo = tasks.filter(t => t.status === 'todo').length;
        const taskCompletionRate = tasks.length > 0 ? Math.round((tasksDone / tasks.length) * 100) : 0;

        const jobsOpenCount = jobs.filter(j => j.status === 'open').length;
        const jobsActiveCount = jobs.filter(j => j.status === 'in_progress' || j.status === 'claimed').length;
        const jobsCompletedCount = jobs.filter(j => j.status === 'completed' || j.status === 'closed').length;
        const jobCompletionRate = jobs.length > 0 ? Math.round((jobsCompletedCount / jobs.length) * 100) : 0;

        const highPriorityTasks = tasks.filter(t => t.priority === 'high' && t.status !== 'done').length;
        const unassignedTasks = tasks.filter(t => !t.assigneeAgentId).length;

        return (
          <div className="space-y-4">
            {/* KPI Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
              {[
                { label: "Agents", value: assignedAgents.length, icon: "🤖" },
                { label: "Tasks", value: tasks.length, icon: "🎯" },
                { label: "Done", value: tasksDone, icon: "✅", color: "text-emerald-500" },
                { label: "Active", value: tasksInProgress, icon: "⚙️", color: "text-amber-500" },
                { label: "Todo", value: tasksTodo, icon: "📋" },
                { label: "Jobs", value: jobs.length, icon: "💼" },
                { label: "High Priority", value: highPriorityTasks, icon: "🔴", color: highPriorityTasks > 0 ? "text-orange-500" : undefined },
                { label: "Unassigned", value: unassignedTasks, icon: "👤", color: unassignedTasks > 0 ? "text-yellow-500" : undefined },
              ].map((s) => (
                <Card key={s.label} className="border-border">
                  <CardContent className="p-2.5">
                    <div className="flex items-center gap-1 mb-0.5">
                      <span className="text-[10px]">{s.icon}</span>
                      <p className="text-[10px] text-muted-foreground truncate">{s.label}</p>
                    </div>
                    <p className={`text-lg font-bold ${s.color || ''}`}>{s.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Progress bars row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Task progress */}
              <Card className="border-border">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium">Task Completion</span>
                    <span className="text-sm font-bold text-amber-600 dark:text-amber-400">{taskCompletionRate}%</span>
                  </div>
                  <div className="h-3 bg-muted rounded-full overflow-hidden flex">
                    {tasks.length > 0 && (
                      <>
                        <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(tasksDone / tasks.length) * 100}%` }} />
                        <div className="h-full bg-amber-500 transition-all" style={{ width: `${(tasksInProgress / tasks.length) * 100}%` }} />
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-[11px]">
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" />{tasksDone} done</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" />{tasksInProgress} active</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-muted-foreground/40" />{tasksTodo} todo</span>
                  </div>
                </CardContent>
              </Card>

              {/* Job progress */}
              <Card className="border-border">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium">Job Completion</span>
                    <span className="text-sm font-bold text-amber-600 dark:text-amber-400">{jobCompletionRate}%</span>
                  </div>
                  <div className="h-3 bg-muted rounded-full overflow-hidden flex">
                    {jobs.length > 0 && (
                      <>
                        <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(jobsCompletedCount / jobs.length) * 100}%` }} />
                        <div className="h-full bg-amber-500 transition-all" style={{ width: `${(jobsActiveCount / jobs.length) * 100}%` }} />
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-[11px]">
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" />{jobsCompletedCount} completed</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" />{jobsActiveCount} active</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" />{jobsOpenCount} open</span>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Budget breakdown */}
            {jobs.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Total Budget", value: totalBudget, icon: "💰", color: "text-amber-500" },
                  { label: "Open", value: openBudget, icon: "📢", color: "text-blue-500" },
                  { label: "In Progress", value: inProgressBudget, icon: "⚙️", color: "text-amber-400" },
                  { label: "Completed", value: spentBudget, icon: "✅", color: "text-emerald-500" },
                ].map((stat) => (
                  <Card key={stat.label} className="border-border">
                    <CardContent className="p-3">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-xs">{stat.icon}</span>
                        <p className="text-[11px] text-muted-foreground">{stat.label}</p>
                      </div>
                      <p className={`text-lg font-bold ${stat.color}`}>
                        {stat.value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} <span className="text-xs font-normal text-muted-foreground">{currencySymbol}</span>
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="agents">🤖 Agents ({assignedAgents.length})</TabsTrigger>
          <TabsTrigger value="tasks">📋 Tasks ({tasks.length})</TabsTrigger>
          <TabsTrigger value="jobs" className="relative">
            💼 Jobs ({jobs.length})
            {jobs.filter(j => j.status === 'in_progress').length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold rounded-full bg-amber-500 text-white animate-pulse">
                {jobs.filter(j => j.status === 'in_progress').length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="map">🗺️ Agent Map</TabsTrigger>
          <TabsTrigger value="comms">📡 Agent Comms</TabsTrigger>
          <TabsTrigger value="channel">💬 Project Channel</TabsTrigger>
          <TabsTrigger value="github" className="flex items-center gap-1">
            <GitHubIcon className="w-3.5 h-3.5" />
            GitHub
            {project?.githubRepos && project.githubRepos.length > 0 && (
              <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
                {project.githubRepos.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Agents Tab */}
        <TabsContent value="agents" className="space-y-4">
          <div className="flex justify-end">
            <Button
              onClick={() => setShowAssignAgent(true)}
              disabled={unassignedAgents.length === 0}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              + Assign Agent
            </Button>
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {assignedAgents.map((agent) => (
              <Card key={agent.id} className="relative">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-lg font-bold text-amber-700">
                      {agent.name.charAt(0)}
                    </div>
                    <div>
                      <CardTitle className="text-base">{agent.name}</CardTitle>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="secondary" className="text-xs">{agent.type}</Badge>
                        <span className={`text-xs ${agent.status === "online" ? "text-emerald-600" : agent.status === "busy" ? "text-orange-600" : "text-muted-foreground"}`}>
                          {agent.status === "online" ? "● Online" :
                            agent.status === "busy" ? "● Busy" : "○ Offline"}
                        </span>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <p className="text-sm text-muted-foreground mb-3">{agent.description}</p>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground">
                      {(agent.capabilities ?? []).length} capabilities
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleUnassignAgent(agent.id)}
                      className="text-red-600 hover:bg-red-50"
                    >
                      Remove
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            {assignedAgents.length === 0 && (
              <div className="col-span-full text-center py-12 text-muted-foreground">
                <div className="text-4xl mb-3">🤖</div>
                <p>No agents assigned</p>
                {unassignedAgents.length > 0 ? (
                  <Button
                    onClick={() => setShowAssignAgent(true)}
                    className="mt-2"
                  >
                    Assign First Agent
                  </Button>
                ) : (
                  <div className="mt-2 space-y-2">
                    <p className="text-sm">No agents in your organization yet</p>
                    <Link href="/agents">
                      <Button className="bg-amber-500 hover:bg-amber-600 text-white">
                        + Register Your First Agent
                      </Button>
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Tasks Tab */}
        <TabsContent value="tasks" className="space-y-4">
          <div className="flex justify-end">
            <Button
              onClick={() => setShowCreateTask(true)}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              + Create Task
            </Button>
          </div>

          <div className="space-y-3">
            {tasks.map((task) => {
              const assignee = task.assigneeAgentId ? assignedAgents.find(a => a.id === task.assigneeAgentId) : null;
              const priority = PRIORITY_LABELS[task.priority] || PRIORITY_LABELS.medium;
              return (
                <Card key={task.id} className="cursor-pointer hover:border-amber-300"
                  onClick={() => { setSelectedTask(task); setShowTaskDetail(true); }}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-medium">{task.title}</h3>
                          <Badge className={TASK_STATUS_COLORS[task.status] || ""}>
                            {task.status === 'in_progress' ? 'In Progress' :
                              task.status === 'todo' ? 'To Do' : 'Done'}
                          </Badge>
                        </div>
                        <CardDescription>{task.description}</CardDescription>
                        <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                          <span className={priority.color}>● {priority.label}</span>
                          {assignee && <span>🤖 {assignee.name}</span>}
                          <span>Created {formatTime(task.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {tasks.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                <div className="text-4xl mb-3">🎯</div>
                <p>No tasks yet</p>
                <Button
                  onClick={() => setShowCreateTask(true)}
                  className="mt-2"
                >
                  Create First Task
                </Button>
              </div>
            )}
          </div>
        </TabsContent>

        {/* Jobs Tab */}
        <TabsContent value="jobs" className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setShowCreateJob(true)} className="bg-amber-500 hover:bg-amber-600 text-white font-semibold">
              + Post Job
            </Button>
          </div>
          {jobs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No jobs posted for this project yet.</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {jobs.map((job) => (
                <Card key={job.id} className={`border-border relative ${job.status === 'in_progress' ? 'border-amber-500/40 animate-glow-pulse' : ''}`}>
                  {/* Indeterminate progress bar for in_progress */}
                  {job.status === 'in_progress' && (
                    <div className="absolute top-0 left-0 right-0 h-0.5 bg-amber-500/10 overflow-hidden rounded-t-lg">
                      <div className="w-1/3 h-full bg-amber-500/60 animate-indeterminate" />
                    </div>
                  )}
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        {job.status === 'in_progress' && (
                          <span className="relative flex h-2.5 w-2.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
                          </span>
                        )}
                        <h3 className="font-semibold text-sm">{job.title}</h3>
                      </div>
                      <Badge variant="outline" className={`text-[10px] capitalize ${job.status === 'in_progress' ? 'bg-amber-500/15 text-amber-500 border-amber-500/30' : ''}`}>
                        {job.status === 'in_progress' ? '⚙️ In Progress' : job.status}
                      </Badge>
                    </div>
                    {job.status === 'in_progress' && (
                      <div className="text-xs text-amber-500 animate-processing font-medium">
                        🔄 Agent working...
                      </div>
                    )}
                    {job.description && <p className="text-xs text-muted-foreground line-clamp-2">{job.description}</p>}
                    {job.reward && (
                      <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-amber-500/10 border border-amber-500/20 w-fit">
                        <span className="text-sm font-bold text-amber-500">{job.reward}</span>
                        <span className="text-[10px] text-amber-500/70">{currencySymbol}</span>
                      </div>
                    )}
                    {job.requiredSkills && job.requiredSkills.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {job.requiredSkills.map((s) => <Badge key={s} variant="outline" className="text-[10px]">{s}</Badge>)}
                      </div>
                    )}
                    {job.status === "open" && assignedAgents.length > 0 && (
                      <div className="pt-2 space-y-2">
                        <Select onValueChange={async (agentId) => {
                          try {
                            await claimJob(job.id, agentId, job.orgId, job.projectId);
                            await loadProjectData();
                          } catch (e) { setError(e instanceof Error ? e.message : "Claim failed"); }
                        }}>
                          <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="▶️ Start — pick an agent..." /></SelectTrigger>
                          <SelectContent>
                            {assignedAgents.map((a) => <SelectItem key={a.id} value={a.id}>🤖 {a.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {job.takenByAgentId && (
                      <div className="text-xs text-muted-foreground">🤖 {assignedAgents.find(a => a.id === job.takenByAgentId)?.name || job.takenByAgentId}</div>
                    )}
                    {(job.status === 'in_progress' || job.status === 'completed') && (
                      <div className="pt-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs h-7"
                          onClick={async () => {
                            try {
                              await updateJob(job.id, { status: 'open', takenByAgentId: '' } as Partial<Job>);
                              await loadProjectData();
                            } catch (e) { setError(e instanceof Error ? e.message : "Restart failed"); }
                          }}
                        >
                          🔄 Restart Job
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Create Job Dialog */}
        <Dialog open={showCreateJob} onOpenChange={setShowCreateJob}>
          <DialogContent>
            <DialogHeader><DialogTitle>Post a Job for this Project</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <Input placeholder="Job title" value={newJobTitle} onChange={(e) => setNewJobTitle(e.target.value)} />
              <Textarea placeholder="Description" value={newJobDesc} onChange={(e) => setNewJobDesc(e.target.value)} rows={3} />
              <Input placeholder="Reward (optional)" value={newJobReward} onChange={(e) => setNewJobReward(e.target.value)} />
              <Select value={newJobPriority} onValueChange={(v: 'low' | 'medium' | 'high') => setNewJobPriority(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setShowCreateJob(false)}>Cancel</Button>
                <Button
                  disabled={creatingJob || !newJobTitle.trim()}
                  className="bg-amber-500 hover:bg-amber-600 text-white font-semibold"
                  onClick={async () => {
                    if (!currentOrg || !newJobTitle.trim()) return;
                    setCreatingJob(true);
                    try {
                      await createJob({
                        orgId: currentOrg.id,
                        projectId,
                        title: newJobTitle.trim(),
                        description: newJobDesc.trim(),
                        status: 'open',
                        reward: newJobReward.trim() || undefined,
                        requiredSkills: [],
                        postedByAddress: account?.address || 'unknown',
                        priority: newJobPriority,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                      });
                      setNewJobTitle(''); setNewJobDesc(''); setNewJobReward(''); setNewJobPriority('medium');
                      setShowCreateJob(false);
                      await loadProjectData();
                    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to create job'); }
                    finally { setCreatingJob(false); }
                  }}
                >
                  {creatingJob ? 'Posting...' : 'Post Job'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Agent Map Tab */}
        <TabsContent value="map">
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button
                onClick={() => setShowAssignAgent(true)}
                disabled={unassignedAgents.length === 0}
                className="bg-amber-600 hover:bg-amber-700"
              >
                ➕ Add Agent
              </Button>
            </div>
            <AgentMap
              projectName={project.name}
              agents={assignedAgents.map((a) => {
                const activeJob = jobs.find(j => j.takenByAgentId === a.id && j.status === 'in_progress');
                const agentJobs = jobs.filter(j => j.takenByAgentId === a.id);
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
              tasks={tasks.map((t) => ({
                id: t.id,
                status: t.status,
                assigneeAgentId: t.assigneeAgentId,
              }))}
              jobs={jobs.map((j) => ({
                id: j.id,
                title: j.title,
                reward: j.reward,
                priority: j.priority,
                requiredSkills: j.requiredSkills ?? [],
                status: j.status,
              }))}
              onAssign={handleBatchAssign}
              onDispatch={handleDispatch}
              executing={batchAssigning}
              currencySymbol={currencySymbol}
            />
          </div>
        </TabsContent>

        {/* Agent Comms Tab */}
        <TabsContent value="comms">
          <div className="space-y-4">
            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-3">
              <Input
                placeholder="Search communications..."
                value={commsSearch}
                onChange={(e) => setCommsSearch(e.target.value)}
                className="max-w-xs"
              />
              <Select value={commsFilterType} onValueChange={setCommsFilterType}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Filter by type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="message">💬 Message</SelectItem>
                  <SelectItem value="status">📊 Status</SelectItem>
                  <SelectItem value="handoff">🤝 Handoff</SelectItem>
                  <SelectItem value="error">❌ Error</SelectItem>
                </SelectContent>
              </Select>
              {(commsFilterType !== 'all' || commsSearch) && (
                <Button variant="outline" size="sm" onClick={() => { setCommsFilterType('all'); setCommsSearch(''); }}>Clear</Button>
              )}
            </div>

            {/* Stats chips */}
            <div className="flex gap-3 flex-wrap">
              {[
                { type: 'message', icon: '💬', label: 'Messages' },
                { type: 'status', icon: '📊', label: 'Status' },
                { type: 'handoff', icon: '🤝', label: 'Handoffs' },
                { type: 'error', icon: '❌', label: 'Errors' },
              ].map(({ type, icon, label }) => {
                const count = agentComms.filter(c => c.type === type).length;
                return (
                  <button
                    key={type}
                    onClick={() => setCommsFilterType(commsFilterType === type ? 'all' : type)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-all ${commsFilterType === type ? 'ring-2 ring-amber-500/50 border-amber-500/40' : 'border-border/50 hover:border-amber-500/20'
                      }`}
                  >
                    <span>{icon}</span>
                    <span>{label}</span>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{count}</Badge>
                  </button>
                );
              })}
            </div>

            {/* Feed */}
            {(() => {
              const filtered = agentComms.filter((comm) => {
                if (commsFilterType !== 'all' && comm.type !== commsFilterType) return false;
                if (commsSearch) {
                  const q = commsSearch.toLowerCase();
                  return (
                    comm.content?.toLowerCase().includes(q) ||
                    comm.fromAgentName?.toLowerCase().includes(q) ||
                    comm.toAgentName?.toLowerCase().includes(q)
                  );
                }
                return true;
              });

              if (filtered.length === 0) {
                return (
                  <div className="text-center py-16 text-muted-foreground">
                    <div className="text-5xl mb-4">📡</div>
                    <p className="text-lg font-medium">No agent communications yet</p>
                    <p className="text-sm mt-2 max-w-md mx-auto">
                      Communications will appear here as your agents coordinate, exchange status updates, and perform handoffs.
                    </p>
                  </div>
                );
              }

              return (
                <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
                  {filtered.map((comm) => {
                    const typeStyles: Record<string, { badge: string; icon: string }> = {
                      message: { badge: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400', icon: '💬' },
                      status: { badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400', icon: '📊' },
                      handoff: { badge: 'bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-400', icon: '🤝' },
                      error: { badge: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400', icon: '❌' },
                    };
                    const style = typeStyles[comm.type] || typeStyles.message;
                    return (
                      <Card key={comm.id} className="border-border hover:border-amber-500/20 transition-colors">
                        <CardContent className="p-3">
                          <div className="flex items-start gap-3">
                            <span className="text-lg mt-0.5 shrink-0">{style.icon}</span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <Badge variant="outline" className={`text-[10px] ${style.badge}`}>
                                  {comm.type.charAt(0).toUpperCase() + comm.type.slice(1)}
                                </Badge>
                                <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">🤖 {comm.fromAgentName}</span>
                                <span className="text-muted-foreground text-xs">→</span>
                                <span className="text-xs font-semibold text-cyan-600 dark:text-cyan-400">🤖 {comm.toAgentName}</span>
                              </div>
                              <p className="text-sm leading-relaxed">{comm.content}</p>
                              {comm.metadata && Object.keys(comm.metadata).length > 0 && (
                                <div className="mt-1.5 px-2 py-1 rounded bg-muted/50 text-[11px] text-muted-foreground font-mono truncate">
                                  {JSON.stringify(comm.metadata).slice(0, 100)}{JSON.stringify(comm.metadata).length > 100 && '…'}
                                </div>
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">{formatTime(comm.createdAt)}</span>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </TabsContent>

        {/* Channel Tab */}
        <TabsContent value="channel">
          <div className="grid grid-cols-[1fr_220px] gap-4">
            {/* Main Chat Area */}
            <Card>
              <CardHeader className="pb-3 border-b">
                <CardTitle className="text-base">📡 Project Channel</CardTitle>
                <CardDescription>
                  Real-time communication with project agents
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 flex flex-col" style={{ height: '500px' }}>
                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {messages.length === 0 && (
                    <div className="flex items-center justify-center h-full text-muted-foreground">
                      <div className="text-center">
                        <div className="text-4xl mb-3">💬</div>
                        <p className="text-sm">No messages yet — say hello!</p>
                      </div>
                    </div>
                  )}
                  {messages.map((msg) => {
                    const isAgent = msg.senderType === 'agent';
                    const isMe = msg.senderId === (account?.address || '');
                    const ts = msg.createdAt && typeof msg.createdAt === 'object' && 'seconds' in msg.createdAt
                      ? new Date((msg.createdAt as { seconds: number }).seconds * 1000)
                      : msg.createdAt instanceof Date ? msg.createdAt : null;

                    // Resolve display name
                    const agentMatch = isAgent ? assignedAgents.find(a => a.id === msg.senderId || a.name === msg.senderName) : null;
                    const humanProfile = !isAgent ? profileMap.get(msg.senderId.toLowerCase()) : null;
                    const displayName = isAgent
                      ? (agentMatch?.name || msg.senderName)
                      : isMe ? 'You' : (humanProfile?.displayName || msg.senderName || (msg.senderId.slice(0, 6) + '...' + msg.senderId.slice(-4)));
                    const badgeLabel = isAgent
                      ? (agentMatch?.type || 'Agent')
                      : 'Operator';

                    return (
                      <div key={msg.id} className={`flex gap-3 ${isMe ? 'flex-row-reverse' : ''}`}>
                        {/* Avatar */}
                        <div
                          className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${isAgent
                            ? 'bg-amber-500/20 text-amber-400'
                            : 'bg-blue-500/20 text-blue-400'
                            }`}
                        >
                          {isAgent ? '🤖' : '👤'}
                        </div>
                        {/* Bubble */}
                        <div className={`max-w-[75%] min-w-0 ${isMe ? 'text-right' : ''}`}>
                          <div className={`flex items-center gap-2 mb-0.5 ${isMe ? 'justify-end' : ''}`}>
                            <span className="font-medium text-sm">{displayName}</span>
                            <Badge
                              variant="secondary"
                              className={`text-[10px] px-1.5 py-0 ${isAgent
                                ? 'bg-amber-500/15 text-amber-500 border-amber-500/30'
                                : 'bg-blue-500/15 text-blue-400 border-blue-500/30'
                                }`}
                            >
                              {badgeLabel}
                            </Badge>
                            {ts && (
                              <span className="text-[10px] text-muted-foreground">
                                {ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            )}
                          </div>
                          <div
                            className={`inline-block rounded-lg px-3 py-1.5 text-sm break-words ${isMe
                              ? 'bg-amber-500/15 text-foreground'
                              : isAgent
                                ? 'bg-muted/60 text-foreground border border-amber-500/10'
                                : 'bg-muted/60 text-foreground'
                              }`}
                          >
                            {msg.content && <p className="whitespace-pre-wrap">{msg.content}</p>}
                            {msg.attachments && msg.attachments.length > 0 && (
                              <div className={`space-y-2 ${msg.content ? 'mt-2' : ''}`}>
                                {msg.attachments.map((att, i) => {
                                  const cat = getFileCategory(att.type);
                                  if (cat === 'image') return <img key={i} src={att.url} alt={att.name} className="max-w-xs max-h-60 rounded-md cursor-pointer" onClick={() => window.open(att.url, '_blank')} />;
                                  if (cat === 'video') return <video key={i} src={att.url} controls className="max-w-sm rounded-md" />;
                                  if (cat === 'audio') return (
                                    <div key={i} className="flex flex-col gap-1">
                                      <span className="text-xs text-muted-foreground">{att.name.startsWith('voice_') ? 'Voice message' : att.name}</span>
                                      <audio src={att.url} controls className="max-w-[250px]" />
                                    </div>
                                  );
                                  return (
                                    <a key={i} href={att.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 p-2 rounded-md bg-muted/50 hover:bg-muted transition-colors">
                                      <Download className="w-4 h-4 text-amber-500 shrink-0" />
                                      <span className="text-xs truncate">{att.name}</span>
                                      <span className="text-[10px] text-muted-foreground shrink-0">{formatFileSize(att.size)}</span>
                                    </a>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {/* Agent thinking indicator */}
                  {agentThinking && (
                    <div className="flex items-start gap-3 px-4 py-2">
                      <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center text-sm">🤖</div>
                      <div className="bg-muted/40 border border-amber-500/20 rounded-2xl rounded-tl-sm px-4 py-2">
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-muted-foreground">Agent is thinking</span>
                          <span className="flex gap-1 ml-1">
                            <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                            <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                            <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
                {/* Input */}
                <div className="border-t p-3 relative">
                  {/* Pending files preview */}
                  {pendingFiles.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {pendingFiles.map((f, i) => (
                        <div key={i} className="flex items-center gap-1.5 bg-muted/60 rounded-md px-2 py-1 text-xs">
                          <span className="truncate max-w-[120px]">{f.name}</span>
                          <span className="text-muted-foreground">{formatFileSize(f.size)}</span>
                          <button onClick={() => removePendingFile(i)} className="text-muted-foreground hover:text-foreground">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Voice recording indicator */}
                  {isRecording && (
                    <div className="flex items-center gap-2 mb-2 text-sm">
                      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                      <span className="text-red-400">Recording... {recordingDuration}s</span>
                      <button onClick={stopRecording} className="ml-auto text-muted-foreground hover:text-foreground">
                        <Square className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  {/* @ Mention Autocomplete Popup */}
                  {mentionQuery !== null && mentionAgents.length > 0 && (
                    <div
                      ref={mentionRef}
                      className="absolute bottom-full left-3 right-3 mb-1 rounded-lg border border-amber-500/30 bg-[#1a1a1a] shadow-lg overflow-hidden z-50"
                    >
                      {mentionAgents.map((agent, i) => (
                        <button
                          key={agent.id}
                          className={`w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${i === mentionIndex ? 'bg-amber-500/15 text-amber-400' : 'text-amber-200/80 hover:bg-amber-500/10'
                            }`}
                          onMouseDown={(e) => { e.preventDefault(); insertMention(agent.name); }}
                          onMouseEnter={() => setMentionIndex(i)}
                        >
                          <span className="font-medium text-amber-400">{agent.name}</span>
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500/70 border border-amber-500/20">{agent.type}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="shrink-0 h-9 w-9"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={sendingChat || uploading || isRecording || !channel}
                    >
                      <Paperclip className="w-4 h-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className={`shrink-0 h-9 w-9 ${isRecording ? 'border-red-500 text-red-500' : ''}`}
                      onClick={isRecording ? stopRecording : startRecording}
                      disabled={sendingChat || uploading || !channel}
                    >
                      {isRecording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                    </Button>
                    <Input
                      ref={chatInputRef}
                      placeholder="Type a message... (@ to mention)"
                      value={chatInput}
                      onChange={handleChatInputChange}
                      onKeyDown={(e) => {
                        if (mentionQuery !== null && mentionAgents.length > 0) {
                          if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => Math.min(i + 1, mentionAgents.length - 1)); return; }
                          if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex(i => Math.max(i - 1, 0)); return; }
                          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(mentionAgents[mentionIndex].name); return; }
                          if (e.key === 'Escape') { e.preventDefault(); setMentionQuery(null); return; }
                        }
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); }
                      }}
                      disabled={sendingChat || uploading || isRecording || !channel}
                      className="flex-1"
                    />
                    <Button
                      onClick={handleSendChat}
                      disabled={sendingChat || uploading || (!chatInput.trim() && pendingFiles.length === 0) || !channel}
                      className="bg-amber-600 hover:bg-amber-700 text-white"
                    >
                      {uploading ? 'Uploading...' : 'Send'}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Participants Sidebar */}
            <Card className="h-fit">
              <CardHeader className="pb-2 border-b">
                <CardTitle className="text-sm">👥 Participants</CardTitle>
              </CardHeader>
              <CardContent className="p-3 space-y-2">
                {/* Current user */}
                <div className="flex items-center gap-2 p-1.5 rounded-md bg-blue-500/10">
                  <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center text-xs">👤</div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">
                      {myProfile?.displayName || (account?.address ? account.address.slice(0, 6) + '...' + account.address.slice(-4) : 'You')}
                    </p>
                    <p className="text-[10px] text-blue-400">Operator</p>
                  </div>
                  <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                </div>

                {/* Assigned agents */}
                {assignedAgents.map((agent) => (
                  <div key={agent.id} className="flex items-center gap-2 p-1.5 rounded-md hover:bg-muted/50 transition-colors">
                    <div className="w-6 h-6 rounded-full bg-amber-500/20 flex items-center justify-center text-xs">🤖</div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{agent.name}</p>
                      <p className="text-[10px] text-amber-500">{agent.type}</p>
                    </div>
                    <span
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${agent.status === 'online' ? 'bg-emerald-500' : agent.status === 'busy' ? 'bg-orange-500' : 'bg-red-500'
                        }`}
                    />
                  </div>
                ))}

                {assignedAgents.length === 0 && (
                  <p className="text-[10px] text-muted-foreground text-center py-2">No agents assigned</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* GitHub Tab */}
        <TabsContent value="github" className="space-y-4">
          {!currentOrg?.githubInstallationId ? (
            <div className="text-center py-12 text-muted-foreground">
              <div className="text-4xl mb-3">🔗</div>
              <p className="mb-2">GitHub not connected</p>
              <p className="text-sm mb-4">Connect GitHub in Settings to link repos to this project</p>
              <Button variant="outline" asChild>
                <Link href="/settings">Go to Settings</Link>
              </Button>
            </div>
          ) : !project?.githubRepos?.length ? (
            <RepoSelector
              projectId={projectId}
              existingRepos={[]}
              onLinked={loadProjectData}
            />
          ) : (
            <GitHubPanel
              project={project}
              orgId={currentOrg.id}
              onRefresh={loadProjectData}
            />
          )}
        </TabsContent>
      </Tabs>

      {/* Assign Agent Dialog */}
      <Dialog open={showAssignAgent} onOpenChange={setShowAssignAgent}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign Agent to Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Select Agent</label>
              <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an agent" />
                </SelectTrigger>
                <SelectContent>
                  {unassignedAgents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name} ({agent.type})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowAssignAgent(false)}>
                Cancel
              </Button>
              <Button onClick={handleAssignAgent} disabled={!selectedAgentId}>
                Assign Agent
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create Task Dialog */}
      <Dialog open={showCreateTask} onOpenChange={setShowCreateTask}>
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
                <label className="text-sm font-medium mb-1 block">Priority</label>
                <Select value={taskPriority} onValueChange={(value: any) => setTaskPriority(value)}>
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
              <div>
                <label className="text-sm font-medium mb-1 block">Assignee</label>
                <Select value={taskAssignee} onValueChange={setTaskAssignee}>
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Unassigned</SelectItem>
                    {assignedAgents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowCreateTask(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreateTask} disabled={creating || !taskTitle.trim()}>
                {creating ? 'Creating...' : 'Create Task'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Task Detail Dialog */}
      {selectedTask && (
        <Dialog open={showTaskDetail} onOpenChange={setShowTaskDetail}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{selectedTask.title}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{selectedTask.description}</p>

              <div className="flex items-center gap-4 text-sm">
                <span className="text-muted-foreground">Priority:</span>
                <Badge className={PRIORITY_LABELS[selectedTask.priority]?.color}>
                  {PRIORITY_LABELS[selectedTask.priority]?.label}
                </Badge>
              </div>

              <div className="flex items-center gap-4 text-sm">
                <span className="text-muted-foreground">Status:</span>
                <div className="flex gap-2">
                  {(['todo', 'in_progress', 'done'] as const).map((status) => (
                    <Button
                      key={status}
                      size="sm"
                      variant={selectedTask.status === status ? 'default' : 'outline'}
                      onClick={() => handleUpdateTaskStatus(selectedTask, status)}
                      disabled={updating}
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

      {/* Edit Project Dialog */}
      <Dialog open={showEditProject} onOpenChange={setShowEditProject}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Project</DialogTitle></DialogHeader>
          <div className="space-y-4 pt-2">
            <div><label className="text-sm font-medium">Name</label><Input value={editName} onChange={e => setEditName(e.target.value)} /></div>
            <div><label className="text-sm font-medium">Description</label><Input value={editDescription} onChange={e => setEditDescription(e.target.value)} /></div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowEditProject(false)}>Cancel</Button>
              <Button className="bg-amber-500 hover:bg-amber-600 text-white" onClick={async () => {
                await updateProject(projectId, { name: editName.trim(), description: editDescription.trim() || '' });
                setProject(p => p ? { ...p, name: editName.trim(), description: editDescription.trim() || '' } : p);
                setShowEditProject(false);
              }}>Save</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Project Dialog */}
      <Dialog open={showDeleteProject} onOpenChange={setShowDeleteProject}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete Project</DialogTitle></DialogHeader>
          <p className="text-muted-foreground py-2">Are you sure you want to delete &quot;{project?.name}&quot;? This cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowDeleteProject(false)}>Cancel</Button>
            <Button className="bg-red-600 hover:bg-red-700 text-white" onClick={async () => {
              await deleteProject(projectId);
              router.push('/agent-guilds');
            }}>Delete Project</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}