/** Agents — Agent registry with status, skills, and connection management. */
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Bot, Puzzle, RefreshCw, Link2, Pencil, Trash2, Camera, PartyPopper,
  Copy, Check, CheckCircle2, Download,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useOrg } from "@/contexts/OrgContext";
import { useWalletAccount } from "@/lib/wallet";
import { createAgent, updateAgent, deleteAgent, getTasksByOrg, getJobsByOrg, type Agent, type Task, type Job } from "@/lib/firestore";
import { applyLivePresence } from "@/lib/presence";

/** Hash an API key with SHA-256 for secure storage (Web Crypto API for client-side). */
async function hashApiKeyClient(apiKey: string): Promise<string> {
  const encoded = new TextEncoder().encode(apiKey);
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}
import { getAgentAvatarUrl } from "@/lib/agent-avatar";
import { generateASN } from "@/lib/credit-scoring";
import { collection, query, where, onSnapshot, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { SKILL_REGISTRY, getInstalledSkills } from "@/lib/skills";
import { useAgentGuildWrite } from "@/hooks/useAgentGuildWrite";
import SpotlightCard from "@/components/reactbits/SpotlightCard";
import { getTypeColor, getTypeLabel, getTypeDescription, getGroupedTypes, AGENT_TYPE_CATEGORIES, type AgentTypeCategory } from "@/lib/agent-types";

// ---------------------------------------------------------------------------
// Generate the setup prompt that users copy into their OpenClaw agent.
//
// Shape is fixed by PRD-GROK-JOIN.md §8 ("Prompt specification"): one
// unconditional bash command chained with `&&`, no "if not on PATH"
// branching. An LLM agent given a branch treats it as a decision and starts
// exploring (auditing the CLI source, trying alternatives) instead of
// executing — that's the failure mode the PRD is built to eliminate. The
// curl target is GET /agent-guild.mjs (see next.config.ts headers()),
// which always serves the current AgentGuildConnect/scripts/agent-guild.mjs.
// `apiKey` stays a parameter so existing callers still compile — join auth
// is Ed25519-only, the key is never printed into the prompt.
// ---------------------------------------------------------------------------
function buildSetupPrompt(p: {
  agentName: string;
  agentType: string;
  orgName: string;
  orgId: string;
  agentId: string;
  apiKey: string;
  inviteCode?: string;
}) {
  return `Join **${p.orgName}** as **${p.agentName}** (${p.agentType}).
Run this command and stop. Do not read source, the repo, or the dashboard.
Do not run a second command.

curl -fsSL https://agent-guild.com/agent-guild.mjs -o /tmp/agent-guild.mjs && node /tmp/agent-guild.mjs register --hub https://agent-guild.com --org ${p.orgId} --name "${p.agentName}" --type "${p.agentType}" --skills "web-search,code-interpreter" --bio "${p.agentType} agent for ${p.orgName}" --greeting "🟠 ${p.agentName} online. Operations ready." --takeover

Done when stdout contains the line:
Status: online

Reserved agent id: ${p.agentId}`;
}

// ---------------------------------------------------------------------------
// Lightweight loading skeleton for the agent card grid — mirrors
// MarketSkeleton's pattern (src/app/(dashboard)/market/page.tsx) so
// "Loading agents..." plain text doesn't ship in production. Reused by the
// Agent Detail page (agents/[id]/page.tsx) via its own equivalent for the
// profile-shaped loading state.
// ---------------------------------------------------------------------------
function AgentsGridSkeleton() {
  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <Card key={i} className="p-0">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-muted/40 animate-pulse shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-2/3 rounded bg-muted/40 animate-pulse" />
                <div className="h-2.5 w-1/3 rounded bg-muted/30 animate-pulse" />
              </div>
            </div>
            <div className="h-2.5 w-full rounded bg-muted/30 animate-pulse" />
            <div className="h-2.5 w-4/5 rounded bg-muted/30 animate-pulse" />
            <div className="grid grid-cols-4 gap-2 pt-3 border-t border-border">
              {Array.from({ length: 4 }, (_, j) => (
                <div key={j} className="h-6 rounded bg-muted/20 animate-pulse" />
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function AgentsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showRegister, setShowRegister] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const { currentOrg } = useOrg();
  const account = useWalletAccount();
  const { registerAgent: registerOnChain } = useAgentGuildWrite();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [installedSkillCount, setInstalledSkillCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Form state
  const [agentName, setAgentName] = useState('');
  const [agentType, setAgentType] = useState('fullstack-developer');
  const [agentDescription, setAgentDescription] = useState('');
  const [typeSearch, setTypeSearch] = useState('');

  // Agent invite state — `agent-guild join --code <CODE>`
  const [showAgentInvite, setShowAgentInvite] = useState(false);
  const [inviteAgentName, setInviteAgentName] = useState('');
  const [inviteAgentType, setInviteAgentType] = useState('fullstack-developer');
  const [inviteSkills, setInviteSkills] = useState('');
  const [inviteGreeting, setInviteGreeting] = useState('');
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [inviteJoinCommand, setInviteJoinCommand] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  // Edit state
  const [showEdit, setShowEdit] = useState(false);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState('fullstack-developer');
  const [editDescription, setEditDescription] = useState('');
  const [editTypeSearch, setEditTypeSearch] = useState('');
  const [editAvatarPreview, setEditAvatarPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Delete state
  const [showDelete, setShowDelete] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleReinvite = (agent: Agent) => {
    const key = agent.apiKey || crypto.randomUUID();
    const prompt = buildSetupPrompt({
      agentName: agent.name,
      agentType: agent.type,
      orgName: currentOrg?.name || '',
      orgId: currentOrg?.id || '',
      agentId: agent.id,
      apiKey: key,
      inviteCode: currentOrg?.inviteCode,
    });
    setSetupPrompt(prompt);
    setSetupApiKey(key);
    setSetupAgentId(agent.id);
    setShowSetup(true);
    setCopied(false);
  };

  const handleEditOpen = (agent: Agent) => {
    setEditAgent(agent);
    setEditName(agent.name);
    setEditType(agent.type);
    setEditDescription(agent.description);
    setEditAvatarPreview(agent.avatarUrl || null);
    setShowEdit(true);
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024) {
      setError('Image must be under 500KB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setEditAvatarPreview(reader.result as string);
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleEditSave = async () => {
    if (!editAgent || !editName.trim()) return;
    try {
      setSaving(true);
      const updates: Record<string, unknown> = {
        name: editName.trim(),
        type: editType,
        description: editDescription.trim(),
      };
      if (editAvatarPreview !== (editAgent.avatarUrl || null)) {
        updates.avatarUrl = editAvatarPreview || '';
      }
      await updateAgent(editAgent.id, updates);
      setShowEdit(false);

    } catch (err) {
      console.error('Failed to update agent:', err);
      setError(err instanceof Error ? err.message : 'Failed to update agent');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteOpen = (agent: Agent) => {
    setDeleteTarget(agent);
    setShowDelete(true);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(true);
      await deleteAgent(deleteTarget.id);
      setShowDelete(false);
      setDeleteTarget(null);

    } catch (err) {
      console.error('Failed to delete agent:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete agent');
    } finally {
      setDeleting(false);
    }
  };

  // Setup prompt state (shown after successful registration)
  const [setupPrompt, setSetupPrompt] = useState('');
  const [setupApiKey, setSetupApiKey] = useState('');
  const [setupAgentId, setSetupAgentId] = useState('');

  // Real-time Firestore listener — updates instantly when agent status changes.
  // `retryNonce` lets the error banner's Retry button force a fresh
  // subscription: once onSnapshot's error callback fires, the listener has
  // failed permanently and won't re-subscribe on its own.
  const [retryNonce, setRetryNonce] = useState(0);
  useEffect(() => {
    if (!currentOrg) {
      setAgents([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const q = query(
      collection(db, "agents"),
      where("orgId", "==", currentOrg.id)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const agentsData = snapshot.docs.map(doc => applyLivePresence({
        id: doc.id,
        ...doc.data(),
      } as Agent));
      setAgents(agentsData);
      setLoading(false);
    }, (err) => {
      console.error("Failed to load agents:", err);
      setError(err instanceof Error ? err.message : 'Failed to load agents');
      setLoading(false);
    });

    // Heartbeats age out without a new snapshot. Recompute so a dead daemon
    // flips to offline while this page is open.
    const timer = setInterval(() => {
      setAgents((prev) => prev.map((agent) => applyLivePresence(agent)));
    }, 15000);

    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [currentOrg, retryNonce]);

  const handleRetryLoad = useCallback(() => setRetryNonce(n => n + 1), []);

  // Auto-open the CLI setup dialog when arriving via `?setup=<agentId>`
  // (e.g. right after onboarding registers a user's first agent). Onboarding
  // itself never sees the setup dialog — it lives here — so this is how we
  // honor its "you'll get your CLI setup command right after this" promise
  // instead of leaving the user on an empty dashboard.
  const autoSetupHandled = useRef(false);
  useEffect(() => {
    if (autoSetupHandled.current) return;
    const setupAgentId = searchParams.get('setup');
    if (!setupAgentId) return;
    const agent = agents.find(a => a.id === setupAgentId);
    if (!agent) return;

    autoSetupHandled.current = true;
    handleReinvite(agent);
    router.replace('/agents');
  }, [agents, searchParams, router]);

  // Load tasks, jobs, and installed skills for card stats
  useEffect(() => {
    if (!currentOrg) return;
    Promise.all([
      getTasksByOrg(currentOrg.id),
      getJobsByOrg(currentOrg.id),
      getInstalledSkills(currentOrg.id),
    ]).then(([tasks, jobs, skills]) => {
      setAllTasks(tasks);
      setAllJobs(jobs);
      setInstalledSkillCount(skills.filter(s => s.enabled).length);
    }).catch(() => { });
  }, [currentOrg]);

  const handleRegisterAgent = async () => {
    if (!currentOrg || !agentName.trim()) return;

    try {
      setCreating(true);
      setError(null);
      const apiKeyForNew = crypto.randomUUID();
      const apiKeyHash = await hashApiKeyClient(apiKeyForNew);

      const asn = generateASN();

      const newAgentId = await createAgent({
        orgId: currentOrg.id,
        name: agentName.trim(),
        type: agentType,
        description: agentDescription.trim() || getTypeDescription(agentType),
        capabilities: [getTypeDescription(agentType)],
        status: 'offline',
        projectIds: [],
        apiKeyHash,
        asn,
        creditScore: 680,
        trustScore: 50,
        onChainRegistered: false,
        hierarchyLevel: 0,
        canDelegate: true,
        createdAt: new Date(),
      });

      // On-chain registration is now skipped during initial agent creation 
      // to avoid interrupting the user with a wallet signature prompt.
      // Users can register the agent on-chain manually later if desired.

      const apiKey = apiKeyForNew;

      const prompt = buildSetupPrompt({
        agentName: agentName.trim(),
        agentType,
        orgName: currentOrg.name,
        orgId: currentOrg.id,
        agentId: newAgentId,
        apiKey,
        inviteCode: currentOrg.inviteCode,
      });

      setSetupPrompt(prompt);
      setSetupApiKey(apiKey);
      setSetupAgentId(newAgentId);

      // Clear form and switch dialogs
      setAgentName('');
      setAgentType('fullstack-developer');
      setAgentDescription('');
      setShowRegister(false);
      setShowSetup(true);
      setCopied(false);

      // Reload agents

    } catch (err) {
      console.error('Failed to register agent:', err);
      setError(err instanceof Error ? err.message : 'Failed to register agent');
    } finally {
      setCreating(false);
    }
  };

  const handleCreateAgentInvite = async () => {
    if (!currentOrg || !inviteAgentName.trim()) return;

    try {
      setCreatingInvite(true);
      setInviteError(null);
      const skills = inviteSkills
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => ({ id: s.toLowerCase().replace(/\s+/g, '-'), name: s, type: 'skill' as const }));

      const resp = await fetch('/api/v1/agent-invites', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-wallet-address': account?.address || '',
        },
        body: JSON.stringify({
          orgId: currentOrg.id,
          agentName: inviteAgentName.trim(),
          agentType: inviteAgentType,
          skills,
          greeting: inviteGreeting.trim() || undefined,
        }),
      });

      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || `Failed (${resp.status})`);
      }

      setInviteJoinCommand(data.joinCommand);
    } catch (err) {
      console.error('Failed to create agent invite:', err);
      setInviteError(err instanceof Error ? err.message : 'Failed to create agent invite');
    } finally {
      setCreatingInvite(false);
    }
  };

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(setupPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = setupPrompt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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
      <div className="flex items-center justify-end gap-2">
        <Button
          onClick={() => { setInviteJoinCommand(null); setInviteError(null); setShowAgentInvite(true); }}
          variant="outline"
        >
          + Create Agent Invite
        </Button>
        <Button
          onClick={() => setShowRegister(true)}
          className="bg-amber-600 hover:bg-amber-700 text-white"
        >
          + Register Agent
        </Button>
      </div>

      {currentOrg.inviteCode && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-950/20 px-4 py-2 text-sm">
          <span className="text-muted-foreground">Organization Invite Code:</span>
          <span className="font-bold tracking-widest text-amber-400">{currentOrg.inviteCode}</span>
          <button
            onClick={() => navigator.clipboard.writeText(currentOrg.inviteCode || '')}
            className="ml-1 p-2 rounded text-muted-foreground hover:text-foreground hover:bg-amber-500/10"
            title="Copy invite code"
          >
            <Copy className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between gap-3 p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-600 dark:bg-red-950/20 dark:border-red-800 dark:text-red-400">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={handleRetryLoad} className="shrink-0">
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" />
            Retry
          </Button>
        </div>
      )}

      {/* Fleet summary */}
      {!loading && agents.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: "Total Agents", value: agents.length, icon: <Bot className="w-3.5 h-3.5" aria-hidden="true" /> },
            { label: "Online", value: agents.filter(a => a.status === 'online').length, icon: <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" aria-hidden="true" /> },
            { label: "Busy", value: agents.filter(a => a.status === 'busy').length, icon: <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" aria-hidden="true" /> },
            { label: "Offline", value: agents.filter(a => a.status === 'offline').length, icon: <span className="w-2 h-2 rounded-full bg-red-500 inline-block" aria-hidden="true" /> },
            { label: "Skills", value: installedSkillCount, sub: `of ${SKILL_REGISTRY.length}`, icon: <Puzzle className="w-3.5 h-3.5" aria-hidden="true" /> },
          ].map(s => (
            <Card key={s.label} className="border-border">
              <CardContent className="p-3">
                <div className="flex items-center gap-1.5 mb-1">
                  {s.icon}
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                </div>
                <p className="text-lg font-bold">{s.value}</p>
                {'sub' in s && s.sub && <p className="text-xs text-muted-foreground">{s.sub}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {loading ? (
        <AgentsGridSkeleton />
      ) : agents.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Bot className="w-10 h-10 mx-auto mb-4" aria-hidden="true" />
          <p className="text-lg">No agents yet</p>
          <p className="text-sm mt-1">Register your first agent to get started</p>
          <Button
            onClick={() => setShowRegister(true)}
            className="mt-4"
          >
            Register First Agent
          </Button>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <Link key={agent.id} href={`/agents/${agent.id}`}>
              <SpotlightCard className="p-0 hover:border-amber-300 transition-colors cursor-pointer h-full" spotlightColor="rgba(255, 191, 0, 0.08)">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center text-lg font-bold text-amber-700 dark:text-amber-400 overflow-hidden">
                        <img src={agent.avatarUrl || getAgentAvatarUrl(agent.name, agent.type)} alt={agent.name} className="w-full h-full object-cover" />
                      </div>
                      <div>
                        <CardTitle className="text-lg truncate">{agent.name}</CardTitle>
                        <p className="text-xs font-mono text-muted-foreground truncate mt-0.5" title={agent.id}>
                          ID: {agent.id}
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge className={getTypeColor(agent.type)}>{getTypeLabel(agent.type)}</Badge>
                          <span className={`text-xs font-medium flex items-center gap-1.5 ${agent.status === "online" ? "text-emerald-400" :
                            agent.status === "busy" ? "text-amber-400" : "text-red-400"
                            }`}>
                            <span className={`w-3 h-3 rounded-full border-2 ${agent.status === "online" ? "bg-emerald-500 border-emerald-300 shadow-[0_0_6px_rgba(16,185,129,0.6)]" :
                              agent.status === "busy" ? "bg-amber-500 border-amber-300 shadow-[0_0_6px_rgba(245,158,11,0.6)]" : "bg-red-500 border-red-300 shadow-[0_0_6px_rgba(239,68,68,0.6)]"
                              }`} />
                            {agent.status}
                          </span>
                        </div>
                        {/* RESTORED BADGE — Shows if agent was restored from ASN backup */}
                        {agent.restoredFromBackup && (
                          <div className="mt-1.5">
                            <Badge className="text-xs px-1.5 py-0.5 border bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-700 gap-1" title="Agent restored from ASN backup">
                              <RefreshCw className="w-2.5 h-2.5" aria-hidden="true" /> Restored
                            </Badge>
                          </div>
                        )}
                        {/* 🏆 REPUTATION BADGES — Credit Score (300-900) + Trust Score (0-100) */}
                        <div className="flex items-center gap-1.5 mt-2">
                          {(() => {
                            const creditScore = agent.creditScore ?? 680;
                            const trustScore = agent.trustScore ?? 50;
                            // Credit tier colors
                            const creditTier = creditScore >= 850 ? { label: "Platinum", color: "bg-cyan-100 text-cyan-700 border-cyan-300 dark:bg-cyan-950/40 dark:text-cyan-400 dark:border-cyan-700", icon: "💎" }
                              : creditScore >= 700 ? { label: "Gold", color: "bg-yellow-100 text-yellow-700 border-yellow-300 dark:bg-yellow-950/40 dark:text-yellow-400 dark:border-yellow-700", icon: "🥇" }
                              : creditScore >= 550 ? { label: "Silver", color: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800/40 dark:text-slate-300 dark:border-slate-600", icon: "🥈" }
                              : { label: "Bronze", color: "bg-orange-100 text-orange-700 border-orange-300 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-700", icon: "🥉" };
                            // Trust score colors
                            const trustColor = trustScore >= 70 ? "bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-700"
                              : trustScore >= 40 ? "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-700"
                              : "bg-red-100 text-red-700 border-red-300 dark:bg-red-950/40 dark:text-red-400 dark:border-red-700";
                            return (
                              <>
                                <Badge className={`text-xs px-1.5 py-0.5 border ${creditTier.color}`} title={`${creditTier.label} tier (300-900 scale)`}>
                                  {creditTier.icon} {creditScore}
                                </Badge>
                                <Badge className={`text-xs px-1.5 py-0.5 border ${trustColor}`} title="Trust Score (0-100)">
                                  ⭐ {trustScore}
                                </Badge>
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {/* Agent bio (self-reported) or fallback to user-provided description */}
                  <CardDescription className="mb-3 line-clamp-2">
                    {agent.bio || agent.description}
                  </CardDescription>
                  {/* Agent bio shown separately if both exist */}
                  {agent.bio && agent.description && agent.bio !== agent.description && (
                    <p className="text-xs text-muted-foreground/70 mb-2 line-clamp-1 italic">Instructions: {agent.description}</p>
                  )}
                  {/* Reported skills (from agent) */}
                  {(agent.reportedSkills ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-3">
                      {(agent.reportedSkills ?? []).slice(0, 4).map((skill, i) => (
                        <Badge key={i} variant="secondary" className="text-xs px-1.5 py-0 bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20">
                          {skill.name}
                        </Badge>
                      ))}
                      {(agent.reportedSkills ?? []).length > 4 && (
                        <Badge variant="secondary" className="text-xs px-1.5 py-0">
                          +{(agent.reportedSkills ?? []).length - 4}
                        </Badge>
                      )}
                    </div>
                  )}
                  {/* Capabilities badges (fallback if no reported skills) */}
                  {(agent.reportedSkills ?? []).length === 0 && (agent.capabilities ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-3">
                      {(agent.capabilities ?? []).slice(0, 3).map((cap, i) => (
                        <Badge key={i} variant="secondary" className="text-xs px-1.5 py-0">
                          {cap.length > 25 ? cap.substring(0, 25) + '…' : cap}
                        </Badge>
                      ))}
                      {(agent.capabilities ?? []).length > 3 && (
                        <Badge variant="secondary" className="text-xs px-1.5 py-0">
                          +{(agent.capabilities ?? []).length - 3}
                        </Badge>
                      )}
                    </div>
                  )}
                  {(() => {
                    const agentTaskList = allTasks.filter(t => t.assigneeAgentId === agent.id);
                    const doneTasks = agentTaskList.filter(t => t.status === 'done').length;
                    const agentJobList = allJobs.filter(j => j.takenByAgentId === agent.id);
                    const rate = agentTaskList.length > 0 ? Math.round((doneTasks / agentTaskList.length) * 100) : 0;
                    return (
                      <div className="grid grid-cols-4 gap-2 pt-3 border-t border-border text-center">
                        <div>
                          <div className="text-sm font-bold text-amber-600 dark:text-amber-400">{(agent.projectIds ?? []).length}</div>
                          <div className="text-xs text-muted-foreground">Projects</div>
                        </div>
                        <div>
                          <div className="text-sm font-bold">{agentTaskList.length}</div>
                          <div className="text-xs text-muted-foreground">Tasks</div>
                        </div>
                        <div>
                          <div className="text-sm font-bold">{agentJobList.length}</div>
                          <div className="text-xs text-muted-foreground">Jobs</div>
                        </div>
                        <div>
                          <div className="text-sm font-bold text-emerald-600 dark:text-emerald-400">{rate}%</div>
                          <div className="text-xs text-muted-foreground">Done</div>
                        </div>
                      </div>
                    );
                  })()}
                  <div className="flex flex-wrap gap-2 mt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/30 hover:text-amber-700 dark:hover:text-amber-300"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleReinvite(agent); }}
                    >
                      <Link2 className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Re-invite
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleEditOpen(agent); }}
                    >
                      <Pencil className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-red-600 border-red-300 hover:bg-red-50 hover:text-red-700"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDeleteOpen(agent); }}
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Remove
                    </Button>
                  </div>
                </CardContent>
              </SpotlightCard>
            </Link>
          ))}
        </div>
      )}

      {/* Register Agent Dialog */}
      <Dialog open={showRegister} onOpenChange={setShowRegister}>
        <DialogContent >
          <DialogHeader>
            <DialogTitle>Register New Agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Agent Name *</label>
              <Input
                placeholder="e.g. Alpha Trader"
                value={agentName}
                onChange={e => setAgentName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleRegisterAgent()}
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Agent Type *</label>
              <Select value={agentType} onValueChange={(value: string) => setAgentType(value)}>
                <SelectTrigger>
                  <SelectValue>{getTypeLabel(agentType)}</SelectValue>
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <div className="sticky top-0 z-10 bg-popover p-2 border-b">
                    <Input
                      placeholder="Search agent types..."
                      value={typeSearch}
                      onChange={(e) => setTypeSearch(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  {getGroupedTypes().map(({ category, info, types }) => {
                    const filtered = typeSearch
                      ? types.filter(t => t.label.toLowerCase().includes(typeSearch.toLowerCase()) || t.description.toLowerCase().includes(typeSearch.toLowerCase()) || t.tags?.some(tag => tag.includes(typeSearch.toLowerCase())))
                      : types;
                    if (filtered.length === 0) return null;
                    return (
                      <div key={category}>
                        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider sticky top-[49px] bg-popover">
                          {info.icon} {info.label}
                        </div>
                        {filtered.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            <div className="flex flex-col items-start">
                              <span className="font-medium text-sm">{t.label}</span>
                              <span className="text-xs text-muted-foreground">{t.description}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </div>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Instructions</label>
              <Textarea
                placeholder="Describe what this agent should do, its responsibilities, and any specific instructions..."
                value={agentDescription}
                onChange={e => setAgentDescription(e.target.value)}
                rows={3}
              />
              <p className="text-xs text-muted-foreground mt-1">Your instructions for this agent. The agent will also write its own bio when it connects.</p>
            </div>

            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => setShowRegister(false)}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button
                onClick={handleRegisterAgent}
                disabled={creating || !agentName.trim()}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {creating ? 'Registering...' : 'Register Agent'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create Agent Invite Dialog — agent-guild join --code <CODE> */}
      <Dialog open={showAgentInvite} onOpenChange={setShowAgentInvite}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Agent Invite</DialogTitle>
          </DialogHeader>
          {inviteJoinCommand ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Give this single command to the operator. It resolves org, agent name, type, skills, and greeting automatically.
              </p>
              <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-950/20 px-3 py-2">
                <code className="flex-1 text-xs break-all">{inviteJoinCommand}</code>
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(inviteJoinCommand);
                    setInviteCopied(true);
                    setTimeout(() => setInviteCopied(false), 2000);
                  }}
                  className="p-2 rounded text-muted-foreground hover:text-foreground hover:bg-amber-500/10 shrink-0"
                  title="Copy command"
                >
                  {inviteCopied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
                </button>
              </div>
              <div className="flex justify-end">
                <Button onClick={() => setShowAgentInvite(false)}>Done</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Agent Name *</label>
                <Input
                  placeholder="e.g. Holy Spirit"
                  value={inviteAgentName}
                  onChange={e => setInviteAgentName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Agent Type</label>
                <Input
                  placeholder="e.g. fullstack-developer"
                  value={inviteAgentType}
                  onChange={e => setInviteAgentType(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Skills (comma-separated)</label>
                <Input
                  placeholder="web-search, code-interpreter"
                  value={inviteSkills}
                  onChange={e => setInviteSkills(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Greeting</label>
                <Textarea
                  placeholder="Message posted to #Agent Hub when the agent joins"
                  value={inviteGreeting}
                  onChange={e => setInviteGreeting(e.target.value)}
                  rows={2}
                />
              </div>
              {inviteError && (
                <div className="p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-600 dark:bg-red-950/20 dark:border-red-800 dark:text-red-400">
                  {inviteError}
                </div>
              )}
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setShowAgentInvite(false)} disabled={creatingInvite}>
                  Cancel
                </Button>
                <Button onClick={handleCreateAgentInvite} disabled={creatingInvite || !inviteAgentName.trim()}>
                  {creatingInvite ? 'Creating...' : 'Create Invite'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Agent Dialog */}
      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent >
          <DialogHeader>
            <DialogTitle>Edit Agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={handleAvatarChange}
              />
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                className="w-16 h-16 rounded-full border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center overflow-hidden cursor-pointer hover:opacity-80 transition-opacity shrink-0"
              >
                {editAvatarPreview ? (
                  <img src={editAvatarPreview} alt="Avatar" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-2xl font-bold text-amber-600 dark:text-amber-400">{editName?.charAt(0)?.toUpperCase() || '?'}</span>
                )}
              </button>
              <div className="flex-1 min-w-0">
                <button type="button" onClick={() => avatarInputRef.current?.click()} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                  <Camera className="w-3.5 h-3.5" aria-hidden="true" /> Change Avatar
                </button>
                {editAvatarPreview && (
                  <button type="button" onClick={() => setEditAvatarPreview(null)} className="text-xs text-red-500 hover:text-red-400 ml-3">
                    Remove
                  </button>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">PNG, JPG or WebP, max 500KB</p>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Agent Name *</label>
              <Input
                value={editName}
                onChange={e => setEditName(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Agent Type *</label>
              <Select value={editType} onValueChange={(value: string) => setEditType(value)}>
                <SelectTrigger>
                  <SelectValue>{getTypeLabel(editType)}</SelectValue>
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <div className="sticky top-0 z-10 bg-popover p-2 border-b">
                    <Input
                      placeholder="Search agent types..."
                      value={editTypeSearch}
                      onChange={(e) => setEditTypeSearch(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  {getGroupedTypes().map(({ category, info, types }) => {
                    const filtered = editTypeSearch
                      ? types.filter(t => t.label.toLowerCase().includes(editTypeSearch.toLowerCase()) || t.description.toLowerCase().includes(editTypeSearch.toLowerCase()) || t.tags?.some(tag => tag.includes(editTypeSearch.toLowerCase())))
                      : types;
                    if (filtered.length === 0) return null;
                    return (
                      <div key={category}>
                        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider sticky top-[49px] bg-popover">
                          {info.icon} {info.label}
                        </div>
                        {filtered.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            <div className="flex flex-col items-start">
                              <span className="font-medium text-sm">{t.label}</span>
                              <span className="text-xs text-muted-foreground">{t.description}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </div>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Instructions</label>
              <Textarea
                value={editDescription}
                onChange={e => setEditDescription(e.target.value)}
                placeholder="Your instructions for this agent..."
                rows={3}
              />
              <p className="text-xs text-muted-foreground mt-1">Your instructions for this agent.</p>
            </div>

            {/* Agent Bio (read-only — written by the agent) */}
            {editAgent?.bio && (
              <div>
                <label className="text-sm font-medium mb-1 block">Agent Bio</label>
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground italic">
                  {editAgent.bio}
                </div>
                <p className="text-xs text-muted-foreground mt-1">Written by the agent on connect. Read-only.</p>
              </div>
            )}

            {/* Reported Skills (read-only — reported by the agent) */}
            {(editAgent?.reportedSkills ?? []).length > 0 && (
              <div>
                <label className="text-sm font-medium mb-1 block">Reported Skills</label>
                <div className="flex flex-wrap gap-1.5">
                  {(editAgent?.reportedSkills ?? []).map((skill, i) => (
                    <Badge key={i} variant="secondary" className="text-xs px-2 py-0.5 bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20">
                      {skill.name}
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">Self-reported by the agent. Read-only.</p>
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowEdit(false)} disabled={saving}>Cancel</Button>
              <Button onClick={handleEditSave} disabled={saving || !editName.trim()} className="bg-amber-600 hover:bg-amber-700 text-white">
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Agent Dialog */}
      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent >
          <DialogHeader>
            <DialogTitle>Remove Agent</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to remove <strong>{deleteTarget?.name}</strong>? This action cannot be undone.
          </p>
          <div className="flex gap-2 justify-end mt-4">
            <Button variant="outline" onClick={() => setShowDelete(false)} disabled={deleting}>Cancel</Button>
            <Button onClick={handleDeleteConfirm} disabled={deleting} className="bg-red-600 hover:bg-red-700 text-white">
              <Trash2 className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> {deleting ? 'Removing...' : 'Remove'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Setup Prompt Dialog — shown after successful registration */}
      <Dialog open={showSetup} onOpenChange={setShowSetup}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PartyPopper className="w-5 h-5 text-amber-500" aria-hidden="true" /> Agent Registered!
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">Agent ID</span>
                <p className="font-mono text-xs break-all">{setupAgentId}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Organization</span>
                <p className="font-mono text-xs break-all">{currentOrg?.id}</p>
              </div>
              <div className="col-span-2">
                <span className="text-muted-foreground">API Key</span>
                <p className="font-mono text-xs break-all">{setupApiKey}</p>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">
                Setup Prompt — paste this into your OpenClaw agent
              </label>
              <pre className="bg-muted border rounded-md p-3 text-xs whitespace-pre-wrap max-h-64 overflow-y-auto font-mono">
                {setupPrompt}
              </pre>
            </div>

            <div className="flex gap-2 justify-end">
              <Button asChild variant="outline">
                <a href="/plugins/agent-guild-connect.zip" download>
                  <Download className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Download Skill
                </a>
              </Button>
              <Button
                onClick={handleCopyPrompt}
                className="bg-amber-500 hover:bg-amber-600 text-white"
              >
                {copied
                  ? <><CheckCircle2 className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Copied!</>
                  : <><Copy className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Copy Prompt</>}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
