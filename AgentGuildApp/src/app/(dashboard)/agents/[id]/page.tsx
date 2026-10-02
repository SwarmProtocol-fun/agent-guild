/** Agent Detail — Full agent profile with skills, jobs, on-chain status, and management actions. */
"use client";

import React, { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, ArrowRight, Frown, Pencil, Trash2, MessageSquare, Zap, Folder,
  Puzzle, X, Radio, Wrench, IdCard, Brain, Blocks, CheckCircle2, XCircle,
  ExternalLink, RefreshCw, Link2, Briefcase, ClipboardList, Pause, Play,
  Wallet, Copy, Check, Plus, KeyRound,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useOrg } from "@/contexts/OrgContext";
import { useAgentGuildData } from "@/hooks/useAgentGuildData";
import { getScoreBand } from "@/lib/credit-scoring";
import { getTier, type PolicyTierName } from "@/lib/credit-policy";
import { heartbeatAgeLabel } from "@/lib/presence";
import {
  getAgent,
  getProjectsByOrg,
  getTasksByOrg,
  getJobsByOrg,
  updateAgent,
  deleteAgent,
  agentCheckOut,
  type Agent,
  type Project,
  type Task,
  type Job,
  type ReportedSkill,
} from "@/lib/firestore";
import {
  SKILL_REGISTRY,
  getOwnedItems,
  getAgentSkills,
  installSkillOnAgent,
  removeSkillFromAgent,
  type OwnedItem,
  type AgentSkill,
  type Skill,
} from "@/lib/skills";
import { shortAddress } from "@/lib/chains";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import { IdentityNftCopies } from "@/components/identity-nft-copies";
import { AgentHarnessPanel } from "@/components/agent-harness-panel";
import { getAgentAvatarUrl } from "@/lib/agent-avatar";
import { useSession } from "@/contexts/SessionContext";
import { getTypeColor, getTypeLabel, getTypeDescription, getGroupedTypes, AGENT_TYPE_CATEGORIES } from "@/lib/agent-types";

/** Custodial wallet the platform generated on this agent's behalf — see /api/v1/agents/[id]/wallets. */
interface AgentWallet {
  id: string;
  publicKey: string;
  chain: "solana" | "evm";
  label?: string;
  createdAt: string | null;
  hyperliquidRegistered?: boolean;
  hyperliquidNetwork?: "testnet" | "mainnet";
  balance: { sol: number | null; usdc: number | null; hyperliquidEquity: number | null };
}

// ---------------------------------------------------------------------------
// Lightweight loading skeleton for the profile page — same "real skeleton
// instead of plain text" pattern as MarketSkeleton (market/page.tsx) and
// AgentsGridSkeleton (agents/page.tsx), shaped for this page's header +
// KPI row + card layout instead of a card grid.
// ---------------------------------------------------------------------------
function AgentDetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="w-16 h-16 rounded-full bg-muted/40 animate-pulse shrink-0" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="h-6 w-48 rounded bg-muted/40 animate-pulse" />
          <div className="h-3 w-64 rounded bg-muted/30 animate-pulse" />
        </div>
      </div>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 lg:grid-cols-8">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="h-16 rounded-lg border border-border bg-muted/20 animate-pulse" />
        ))}
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="h-32 rounded-lg border border-border bg-muted/20 animate-pulse" />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error Boundary — prevents uncaught errors from crashing the entire React
// tree (which would destroy ProtectedRoute context and log the user out).
// ---------------------------------------------------------------------------
class AgentDetailErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error?.message || "Unknown error" };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[AgentDetail] Error boundary caught:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-center max-w-md">
            <Frown className="w-10 h-10 mx-auto mb-4 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-xl font-bold mb-2">Something went wrong</h2>
            <p className="text-sm text-muted-foreground mb-4">{this.state.message}</p>
            <div className="flex gap-2 justify-center">
              <Button variant="outline" asChild>
                <Link href="/agents"><ArrowLeft className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Back to Fleet</Link>
              </Button>
              <Button
                onClick={() => {
                  this.setState({ hasError: false, message: "" });
                  window.location.reload();
                }}
              >
                Retry
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}


export default function AgentDetailPageWrapper() {
  return (
    <AgentDetailErrorBoundary>
      <AgentDetailPage />
    </AgentDetailErrorBoundary>
  );
}

function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const agentId = params.id as string;
  const { currentOrg } = useOrg();
  const { address: sessionAddress } = useSession();
  const agentGuild = useAgentGuildData();


  const [agent, setAgent] = useState<Agent | null>(null);
  const [assignedProjects, setAssignedProjects] = useState<Project[]>([]);
  const [agentTasks, setAgentTasks] = useState<Task[]>([]);
  const [agentJobs, setAgentJobs] = useState<Job[]>([]);
  const [ownedItems, setOwnedItems] = useState<OwnedItem[]>([]);
  const [agentSkills, setAgentSkills] = useState<AgentSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [skillBusy, setSkillBusy] = useState<string | null>(null);
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);


  // Edit state
  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState('fullstack-developer');
  const [editTypeSearch, setEditTypeSearch] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete state
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Solana / Metaplex state
  const [solanaLoading, setSolanaLoading] = useState(false);
  const [solanaError, setSolanaError] = useState<string | null>(null);

  // Custodial agent wallets (platform-generated, separate from the identity wallet above)
  const [wallets, setWallets] = useState<AgentWallet[]>([]);
  const [walletsLoading, setWalletsLoading] = useState(false);
  const [walletsMax, setWalletsMax] = useState(10);
  const [generatingWallet, setGeneratingWallet] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [copiedWalletId, setCopiedWalletId] = useState<string | null>(null);
  const [showGenerateWallet, setShowGenerateWallet] = useState(false);
  const [generateChain, setGenerateChain] = useState<"solana" | "evm">("solana");
  const [registerHyperliquid, setRegisterHyperliquid] = useState(false);
  const [hyperliquidPassphrase, setHyperliquidPassphrase] = useState('');
  const [hyperliquidNetwork, setHyperliquidNetwork] = useState<"testnet" | "mainnet">("testnet");
  const [resetPassphraseWallet, setResetPassphraseWallet] = useState<AgentWallet | null>(null);
  const [resetPassphraseValue, setResetPassphraseValue] = useState('');
  const [resetPassphraseNetwork, setResetPassphraseNetwork] = useState<"testnet" | "mainnet">("testnet");
  const [resettingPassphrase, setResettingPassphrase] = useState(false);
  const [resetPassphraseError, setResetPassphraseError] = useState<string | null>(null);

  // Pause/Resume state
  const [showPause, setShowPause] = useState(false);
  const [pauseReason, setPauseReason] = useState('');
  const [pausing, setPausing] = useState(false);

  // On-chain registration state
  const [showRegister, setShowRegister] = useState(false);
  const [registerName, setRegisterName] = useState('');
  const [registerSkills, setRegisterSkills] = useState('');
  const [registerFeeRate, setRegisterFeeRate] = useState('500');
  const [registerState, setRegisterState] = useState<{ isLoading: boolean; error: string | null; txHash: string | null }>({ isLoading: false, error: null, txHash: null });
  const resetRegisterState = () => setRegisterState({ isLoading: false, error: null, txHash: null });

  // Memory management state
  const [memoryBackingUp, setMemoryBackingUp] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<{
    hasBackup: boolean;
    lastBackup?: string;
    messageCount?: number;
    cid?: string;
  } | null>(null);
  const [memoryStatusLoading, setMemoryStatusLoading] = useState(false);
  const [suspendingASN, setSuspendingASN] = useState(false);

  const loadAgentData = async () => {
    if (!currentOrg) return;

    setLoading(true);
    setError(null);

    // Fetch agent first — if this fails, nothing else matters
    let agentData: Agent | null = null;
    try {
      agentData = await getAgent(agentId);
    } catch (err) {
      console.error('Failed to load agent:', err);
      setError(err instanceof Error ? err.message : 'Failed to load agent');
      setLoading(false);
      return;
    }

    if (!agentData) {
      setError('Agent not found');
      setLoading(false);
      return;
    }

    if (agentData.orgId !== currentOrg.id) {
      setError('Agent not found in this organization');
      setLoading(false);
      return;
    }

    setAgent(agentData);

    // Fetch remaining data in parallel — each wrapped in its own try-catch
    // so one failing query doesn't prevent the others from loading
    const [allProjects, allTasks, allJobs, orgItems, agentSkillData] = await Promise.all([
      getProjectsByOrg(currentOrg.id).catch((err) => { console.error('Failed to load projects:', err); return [] as Project[]; }),
      getTasksByOrg(currentOrg.id).catch((err) => { console.error('Failed to load tasks:', err); return [] as Task[]; }),
      getJobsByOrg(currentOrg.id).catch((err) => { console.error('Failed to load jobs:', err); return [] as Job[]; }),
      getOwnedItems(currentOrg.id).catch((err) => { console.error('Failed to load owned items:', err); return [] as OwnedItem[]; }),
      getAgentSkills(agentId).catch((err) => { console.error('Failed to load agent skills:', err); return [] as AgentSkill[]; }),
    ]);

    setOwnedItems(orgItems);
    setAgentSkills(agentSkillData);

    const assigned = allProjects.filter(project =>
      agentData.projectIds.includes(project.id)
    );
    setAssignedProjects(assigned);

    const tasks = allTasks.filter(task =>
      task.assigneeAgentId === agentId
    );
    setAgentTasks(tasks);

    const jobs = allJobs.filter(job =>
      job.takenByAgentId === agentId
    );
    setAgentJobs(jobs);

    setLoading(false);
  };

  useEffect(() => {
    loadAgentData();
  }, [agentId, currentOrg]);

  // Presence follows the daemon heartbeat. Re-read it so a dead process
  // flips offline and a live one flips online without a manual toggle.
  useEffect(() => {
    if (!agentId) return;
    const timer = setInterval(async () => {
      try {
        const fresh = await getAgent(agentId);
        if (!fresh) return;
        setAgent((prev) => prev ? {
          ...prev,
          status: fresh.status,
          lastSeen: fresh.lastSeen,
          offlineAt: fresh.offlineAt,
        } : fresh);
      } catch {
        // keep the last rendered presence
      }
    }, 20000);
    return () => clearInterval(timer);
  }, [agentId]);

  const handleEditOpen = () => {
    if (!agent) return;
    setEditName(agent.name);
    setEditType(agent.type);
    setEditDescription(agent.description);
    setShowEdit(true);
  };

  const handleEditSave = async () => {
    if (!agent || !editName.trim()) return;
    try {
      setSaving(true);
      await updateAgent(agentId, { name: editName.trim(), type: editType, description: editDescription.trim() });
      setAgent({ ...agent, name: editName.trim(), type: editType, description: editDescription.trim() });
      setShowEdit(false);
    } catch (err) {
      console.error('Failed to update agent:', err);
      setError(err instanceof Error ? err.message : 'Failed to update agent');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteConfirm = async () => {
    try {
      setDeleting(true);
      await deleteAgent(agentId);
      router.push('/agents');
    } catch (err) {
      console.error('Failed to delete agent:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete agent');
      setDeleting(false);
    }
  };

  const handlePauseConfirm = async () => {
    if (!agent || !currentOrg) return;
    try {
      setPausing(true);
      const res = await fetch(`/api/agents/${agentId}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: currentOrg.id,
          pausedBy: currentOrg.ownerAddress,
          reason: pauseReason,
        }),
      });
      if (res.ok) {
        setAgent({ ...agent, status: 'paused', pausedAt: new Date(), pausedBy: currentOrg.ownerAddress, pauseReason });
        setShowPause(false);
        setPauseReason('');
      }
    } catch (err) {
      console.error('Failed to pause agent:', err);
      setError(err instanceof Error ? err.message : 'Failed to pause agent');
    } finally {
      setPausing(false);
    }
  };

  const handleResumeConfirm = async () => {
    if (!agent || !currentOrg) return;
    try {
      setPausing(true);
      const res = await fetch(`/api/agents/${agentId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: currentOrg.id }),
      });
      if (res.ok) {
        setAgent({ ...agent, status: 'online', pausedAt: undefined, pausedBy: undefined, pauseReason: undefined });
      }
    } catch (err) {
      console.error('Failed to resume agent:', err);
      setError(err instanceof Error ? err.message : 'Failed to resume agent');
    } finally {
      setPausing(false);
    }
  };

  const handleRegisterOpen = () => {
    if (!agent) return;
    setRegisterName(agent.name);
    setRegisterSkills((agent.capabilities ?? []).join(', '));
    setRegisterFeeRate('500');
    resetRegisterState();
    setShowRegister(true);
  };

  const handleRegisterSubmit = async () => {
    if (!agent || !currentOrg || !registerName.trim()) return;
    const feeRate = parseInt(registerFeeRate, 10);
    if (isNaN(feeRate) || feeRate < 0) return;
    // Registers under the agent's own identity wallet (server-side, platform-sponsored) —
    // not the dashboard user's connected wallet.
    setRegisterState({ isLoading: true, error: null, txHash: null });
    try {
      const res = await fetch(`/api/v1/agents/${agent.id}/register-onchain`, {
        method: "POST",
        headers: solanaAuthHeaders,
        body: JSON.stringify({ orgId: currentOrg.id, name: registerName.trim(), skills: registerSkills.trim(), feeRateBps: feeRate }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRegisterState({ isLoading: false, error: data.error || "Failed to register agent", txHash: null });
        return;
      }
      setRegisterState({ isLoading: false, error: null, txHash: data.txSignature });
      setAgent({ ...agent, onChainRegistered: true, onChainTxHash: data.txSignature, onChainError: undefined });
      agentGuild.refetch();
    } catch (err) {
      setRegisterState({ isLoading: false, error: err instanceof Error ? err.message : "Failed to register agent", txHash: null });
    }
  };

  // Memory: fetch backup status
  const loadMemoryStatus = async () => {
    if (!agent || !currentOrg) return;
    setMemoryStatusLoading(true);
    try {
      const res = await fetch(`/api/v1/asn-memory/agent-status?agentId=${agent.id}&orgId=${currentOrg.id}`);
      if (res.ok) {
        const data = await res.json();
        setMemoryStatus(data);
      }
    } catch (err) {
      console.error("Failed to load memory status:", err);
    } finally {
      setMemoryStatusLoading(false);
    }
  };

  useEffect(() => {
    if (agent?.id && currentOrg?.id) loadMemoryStatus();
  }, [agent?.id, currentOrg?.id]);

  // Memory: trigger backup
  const handleBackupMemory = async () => {
    if (!agent || !currentOrg || !agent.asn) return;
    setMemoryBackingUp(true);
    try {
      const res = await fetch("/api/v1/asn-memory/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, asn: agent.asn, orgId: currentOrg.id }),
      });
      if (res.ok) {
        await loadMemoryStatus(); // Refresh status
      } else {
        const err = await res.json();
        setError(err.error || "Backup failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup failed");
    } finally {
      setMemoryBackingUp(false);
    }
  };

  // ASN: suspend (set offline to release ASN)
  const handleSuspendASN = async () => {
    if (!agent || !currentOrg) return;
    setSuspendingASN(true);
    try {
      await updateAgent(agentId, { status: "offline" as Agent['status'] });
      if (agent.status === "online") {
        await agentCheckOut(agent, currentOrg.id);
      }
      setAgent({ ...agent, status: "offline" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to suspend ASN");
    } finally {
      setSuspendingASN(false);
    }
  };

  const handleInstallSkill = async (skillId: string) => {
    if (!currentOrg) return;
    setSkillBusy(skillId);
    try {
      await installSkillOnAgent(agentId, skillId, currentOrg.id, "system");
      const updated = await getAgentSkills(agentId);
      setAgentSkills(updated);
    } catch (err) {
      console.error("Failed to install skill on agent:", err);
    } finally {
      setSkillBusy(null);
    }
  };

  const handleRemoveSkill = async (agentSkill: AgentSkill) => {
    setSkillBusy(agentSkill.skillId);
    try {
      await removeSkillFromAgent(agentSkill.id);
      const updated = await getAgentSkills(agentId);
      setAgentSkills(updated);
    } catch (err) {
      console.error("Failed to remove skill from agent:", err);
    } finally {
      setSkillBusy(null);
    }
  };

  // ── Solana / Metaplex handlers ──
  const solanaAuthHeaders = {
    "Content-Type": "application/json",
    "x-wallet-address": sessionAddress || "",
  };

  const handleGenerateSolanaWallet = async () => {
    if (!agent || !currentOrg) return;
    setSolanaLoading(true);
    setSolanaError(null);
    try {
      const res = await fetch("/api/v1/solana/wallet/generate", {
        method: "POST",
        headers: solanaAuthHeaders,
        body: JSON.stringify({ agentId: agent.id, orgId: currentOrg.id }),
      });
      const data = await res.json();
      if (res.ok) {
        setAgent({ ...agent, solanaAddress: data.solanaAddress });
      } else {
        setSolanaError(data.error || "Failed to generate Solana wallet");
      }
    } catch (err) {
      setSolanaError(err instanceof Error ? err.message : "Failed to generate Solana wallet");
    } finally {
      setSolanaLoading(false);
    }
  };

  const handleMintSolanaNft = async () => {
    if (!agent || !currentOrg) return;
    setSolanaLoading(true);
    setSolanaError(null);
    try {
      const res = await fetch("/api/v1/metaplex/mint", {
        method: "POST",
        headers: solanaAuthHeaders,
        body: JSON.stringify({ agentId: agent.id, orgId: currentOrg.id }),
      });
      const data = await res.json();
      if (res.ok) {
        setAgent({
          ...agent,
          nftStandard: "mpl-core",
          nftMintAddress: data.agentAsset,
          nftCollectionAddress: data.collection,
          nftPlatformAssetAddress: data.platformAsset,
          nftOwnerAssetAddress: data.ownerAsset,
          nftAgentAssetAddress: data.agentAsset,
          nftMintError: undefined,
          nftMintedAt: new Date(),
        });
      } else {
        setSolanaError(data.error || "Failed to mint identity NFTs");
      }
    } catch (err) {
      setSolanaError(err instanceof Error ? err.message : "Failed to mint identity NFTs");
    } finally {
      setSolanaLoading(false);
    }
  };

  const handleUpdateSolanaMetadata = async () => {
    if (!agent || !currentOrg || !agent.nftMintAddress) return;
    setSolanaLoading(true);
    setSolanaError(null);
    try {
      const res = await fetch("/api/v1/metaplex/update", {
        method: "POST",
        headers: solanaAuthHeaders,
        body: JSON.stringify({ agentId: agent.id, orgId: currentOrg.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSolanaError(data.error || "Failed to update metadata");
      }
    } catch (err) {
      setSolanaError(err instanceof Error ? err.message : "Failed to update metadata");
    } finally {
      setSolanaLoading(false);
    }
  };

  // ── Custodial agent wallets ──
  const loadWallets = async () => {
    if (!agent || !currentOrg) return;
    setWalletsLoading(true);
    try {
      const res = await fetch(`/api/v1/agents/${agent.id}/wallets?org=${currentOrg.id}`, {
        headers: solanaAuthHeaders,
      });
      const data = await res.json();
      if (res.ok) {
        setWallets(data.wallets ?? []);
        setWalletsMax(data.max ?? 10);
      }
    } catch (err) {
      console.error("Failed to load agent wallets:", err);
    } finally {
      setWalletsLoading(false);
    }
  };

  useEffect(() => {
    if (agent?.id && currentOrg?.id) loadWallets();
  }, [agent?.id, currentOrg?.id]);

  const handleOpenGenerateWallet = () => {
    setGenerateChain("solana");
    setRegisterHyperliquid(false);
    setHyperliquidPassphrase('');
    setHyperliquidNetwork("testnet");
    setWalletError(null);
    setShowGenerateWallet(true);
  };

  const handleGenerateWallet = async () => {
    if (!agent || !currentOrg) return;
    setWalletError(null);
    setGeneratingWallet(true);
    try {
      const res = await fetch(`/api/v1/agents/${agent.id}/wallets`, {
        method: "POST",
        headers: solanaAuthHeaders,
        body: JSON.stringify({
          orgId: currentOrg.id,
          chain: generateChain,
          ...(generateChain === "evm" && registerHyperliquid
            ? { hyperliquid: { masterSecret: hyperliquidPassphrase, network: hyperliquidNetwork } }
            : {}),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setWallets((prev) => [...prev, data.wallet]);
        setShowGenerateWallet(false);
        setHyperliquidPassphrase('');
      } else {
        setWalletError(data.error || "Failed to generate wallet");
      }
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : "Failed to generate wallet");
    } finally {
      setGeneratingWallet(false);
    }
  };

  const copyWalletAddress = (walletId: string, address: string) => {
    navigator.clipboard.writeText(address);
    setCopiedWalletId(walletId);
    setTimeout(() => setCopiedWalletId(null), 2000);
  };

  const handleOpenResetPassphrase = (wallet: AgentWallet) => {
    setResetPassphraseWallet(wallet);
    setResetPassphraseValue('');
    setResetPassphraseNetwork(wallet.hyperliquidNetwork ?? "testnet");
    setResetPassphraseError(null);
  };

  const handleResetPassphrase = async () => {
    if (!agent || !currentOrg || !resetPassphraseWallet) return;
    setResetPassphraseError(null);
    setResettingPassphrase(true);
    try {
      const res = await fetch(`/api/v1/agents/${agent.id}/wallets/${resetPassphraseWallet.id}/hyperliquid-passphrase`, {
        method: "POST",
        headers: solanaAuthHeaders,
        body: JSON.stringify({ orgId: currentOrg.id, masterSecret: resetPassphraseValue, network: resetPassphraseNetwork }),
      });
      const data = await res.json();
      if (res.ok) {
        setWallets((prev) => prev.map((w) => w.id === resetPassphraseWallet.id
          ? { ...w, hyperliquidRegistered: true, hyperliquidNetwork: resetPassphraseNetwork }
          : w));
        setResetPassphraseWallet(null);
        setResetPassphraseValue('');
      } else {
        setResetPassphraseError(data.error || "Failed to reset passphrase");
      }
    } catch (err) {
      setResetPassphraseError(err instanceof Error ? err.message : "Failed to reset passphrase");
    } finally {
      setResettingPassphrase(false);
    }
  };

  const formatTime = (timestamp: unknown) => {
    if (!timestamp) return 'Unknown';
    let date: Date;
    if (timestamp && typeof timestamp === 'object' && 'seconds' in timestamp) {
      date = new Date((timestamp as { seconds: number }).seconds * 1000);
    } else {
      date = new Date(timestamp as string | number);
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

  const parseReward = (r?: string) => {
    if (!r) return 0;
    const n = parseFloat(r.replace(/[^0-9.]/g, ''));
    return isNaN(n) ? 0 : n;
  };

  if (loading) {
    return <AgentDetailSkeleton />;
  }

  if (error || !agent) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <Frown className="w-10 h-10 mx-auto mb-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-xl font-bold mb-2">Agent Not Found</h2>
          <p className="text-muted-foreground mb-4">{error}</p>
          <div className="flex gap-2 justify-center">
            <Button asChild variant="outline">
              <Link href="/agents"><ArrowLeft className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Back to Fleet</Link>
            </Button>
            {error && (
              <Button onClick={loadAgentData}>
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Retry
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Compute metrics
  const completedTasks = agentTasks.filter(t => t.status === 'done').length;
  const activeTasks = agentTasks.filter(t => t.status === 'in_progress').length;
  const todoTasks = agentTasks.filter(t => t.status === 'todo').length;
  const completionRate = agentTasks.length > 0 ? Math.round((completedTasks / agentTasks.length) * 100) : 0;

  const jobsCompleted = agentJobs.filter(j => j.status === 'completed' || j.status === 'closed').length;
  const jobsInProgress = agentJobs.filter(j => j.status === 'in_progress' || j.status === 'claimed').length;
  const totalEarnings = agentJobs
    .filter(j => j.status === 'completed' || j.status === 'closed')
    .reduce((sum, j) => sum + parseReward(j.reward), 0);

  // On-chain matching — Solana AgentGuild program registry
  const onchainMatch = agentGuild.agents.find(
    a => a.name.toLowerCase() === agent.name.toLowerCase()
  );
  // Credit scoring
  const creditScore = agent.creditScore ?? 680;
  const trustScore = agent.trustScore ?? 50;
  const scoreBand = getScoreBand(creditScore);
  const policyTier = getTier((agent.policyTier ?? "standard") as PolicyTierName);

  // Skills — agent-level skills (installed on THIS agent)
  const agentSkillIds = new Set(agentSkills.map(s => s.skillId));
  const ownedSkillIds = new Set(ownedItems.map(i => i.skillId));
  const activeSkills = SKILL_REGISTRY.filter(s => agentSkillIds.has(s.id));
  // Available = in org inventory but not yet on this agent (skills & plugins only — mods are protocol-wide)
  const availableForAgent = SKILL_REGISTRY.filter(
    s => ownedSkillIds.has(s.id) && !agentSkillIds.has(s.id) && (s.type === "skill" || s.type === "plugin")
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link href="/agents" className="text-muted-foreground hover:text-amber-600 transition-colors mt-2" aria-label="Back to Fleet">
          <ArrowLeft className="w-5 h-5" aria-hidden="true" />
        </Link>
        <div className="flex items-center gap-4 flex-1">
          <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center text-2xl font-bold text-amber-700 dark:text-amber-400 overflow-hidden">
            <img src={agent.avatarUrl || getAgentAvatarUrl(agent.name, agent.type)} alt={agent.name} className="w-full h-full object-cover" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-3xl font-bold tracking-tight">{agent.name}</h1>
              <Badge className={getTypeColor(agent.type)}>{getTypeLabel(agent.type)}</Badge>
              <span className={`text-sm flex items-center gap-1.5 ${agent.status === "online" ? "text-emerald-600 dark:text-emerald-400" :
                  agent.status === "busy" ? "text-amber-600 dark:text-amber-400" :
                  agent.status === "paused" ? "text-gray-500" : "text-red-600 dark:text-red-400"
                }`}>
                <span className={`w-2.5 h-2.5 rounded-full ${agent.status === "online" ? "bg-emerald-500" :
                    agent.status === "busy" ? "bg-amber-500" :
                    agent.status === "paused" ? "bg-gray-400" : "bg-red-500"
                  }`} />
                {agent.status}
                {heartbeatAgeLabel(agent.lastSeen) ? (
                  <span className="text-xs text-muted-foreground">· {heartbeatAgeLabel(agent.lastSeen)}</span>
                ) : null}
              </span>
              {onchainMatch && (
                <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800">
                  On-Chain
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground mt-1">{agent.description}</p>
            <p className="text-xs font-mono text-muted-foreground mt-1" title={agent.id}>
              ID: {agent.id}
            </p>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            {agent.status === 'paused' ? (
              <Button
                variant="outline"
                className="border-green-300 text-green-600 hover:bg-green-50 hover:text-green-700"
                onClick={handleResumeConfirm}
                disabled={pausing}
              >
                <Play className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> {pausing ? 'Resuming...' : 'Resume'}
              </Button>
            ) : (
              <Button
                variant="outline"
                className="border-orange-300 text-orange-600 hover:bg-orange-50 hover:text-orange-700"
                onClick={() => setShowPause(true)}
                disabled={agent.status === 'offline'}
              >
                <Pause className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Pause
              </Button>
            )}
            <Button variant="outline" onClick={handleEditOpen}>
              <Pencil className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Edit
            </Button>
            <Button variant="outline" className="text-red-600 border-red-300 hover:bg-red-50 hover:text-red-700" onClick={() => setShowDelete(true)}>
              <Trash2 className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Remove
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-600 dark:bg-red-950/20 dark:border-red-800 dark:text-red-400">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={loadAgentData} className="shrink-0">
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Retry
          </Button>
        </div>
      )}

      {/* Agent Bio */}
      {agent.bio && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <MessageSquare className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" aria-hidden="true" />
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Agent Bio</p>
                <p className="text-sm leading-relaxed">{agent.bio}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* KPI Stats */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 lg:grid-cols-8">
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-xl font-bold text-amber-600 dark:text-amber-400">{assignedProjects.length}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Projects</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-xl font-bold">{agentTasks.length}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Tasks</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400">{completedTasks}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Done</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-xl font-bold text-amber-600 dark:text-amber-400">{activeTasks}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Active</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-xl font-bold text-muted-foreground">{todoTasks}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Todo</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-xl font-bold">{agentJobs.length}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Jobs</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-xl font-bold text-amber-600 dark:text-amber-400">
              {completionRate}%
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Completion</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
              {totalEarnings > 0 ? totalEarnings.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Earnings</div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="passport" className="gap-1.5">
            <IdCard className="w-3.5 h-3.5" aria-hidden="true" /> Agent Passport
          </TabsTrigger>
          <TabsTrigger value="harness">Harness</TabsTrigger>
        </TabsList>

      <TabsContent value="overview" className="space-y-6">
      {/* Agent Wallets — custodial, platform-generated */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><Wallet className="w-4 h-4" aria-hidden="true" /> Agent Wallets</CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">{wallets.length}/{walletsMax}</Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={handleOpenGenerateWallet}
                disabled={generatingWallet || walletsLoading || wallets.length >= walletsMax}
                className="h-7 text-xs gap-1 border-amber-500/30 text-amber-500 hover:bg-amber-500/10"
              >
                <Plus className="w-3 h-3" aria-hidden="true" /> Generate Wallet
              </Button>
            </div>
          </div>
          <CardDescription>Platform-held Solana or EVM/Hyperliquid wallets generated for this agent — separate from its own identity key below</CardDescription>
        </CardHeader>
        <CardContent>
          {walletsLoading && wallets.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading wallets...</p>
          ) : wallets.length > 0 ? (
            <div className="space-y-2">
              {wallets.map((w) => (
                <div
                  key={w.id}
                  className="flex items-center justify-between gap-3 p-2.5 rounded-lg border border-border bg-muted/30"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-xs uppercase">{w.chain}</Badge>
                      <code className="font-mono text-xs truncate">{shortAddress(w.publicKey)}</code>
                      <button
                        onClick={() => copyWalletAddress(w.id, w.publicKey)}
                        className="p-0.5 text-muted-foreground hover:text-foreground transition-colors shrink-0"
                        title="Copy address"
                      >
                        {copiedWalletId === w.id ? (
                          <Check className="w-3 h-3 text-emerald-500" aria-hidden="true" />
                        ) : (
                          <Copy className="w-3 h-3" aria-hidden="true" />
                        )}
                      </button>
                      <a
                        href={w.chain === "solana"
                          ? `https://solscan.io/account/${w.publicKey}?cluster=devnet`
                          : `https://app.hyperliquid${w.hyperliquidNetwork === "mainnet" ? "" : "-testnet"}.xyz/trade`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-0.5 text-muted-foreground hover:text-foreground transition-colors shrink-0"
                        title={w.chain === "solana" ? "View on Solscan" : "Open on Hyperliquid"}
                      >
                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                      </a>
                      {w.chain === "evm" && (
                        <Badge className={`text-xs ${w.hyperliquidRegistered
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                          : "bg-muted text-muted-foreground"}`}
                        >
                          {w.hyperliquidRegistered ? `Hyperliquid (${w.hyperliquidNetwork})` : "Not registered for trading"}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                      {w.chain === "solana" ? (
                        <>
                          <span>{(w.balance.sol ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL</span>
                          {w.balance.usdc != null && <span>{w.balance.usdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC</span>}
                        </>
                      ) : (
                        <span>
                          {w.balance.hyperliquidEquity != null
                            ? `$${w.balance.hyperliquidEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })} account equity`
                            : "No Hyperliquid account yet"}
                        </span>
                      )}
                    </div>
                  </div>
                  {w.chain === "evm" && (
                    <button
                      onClick={() => handleOpenResetPassphrase(w)}
                      className="p-1.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
                      title={w.hyperliquidRegistered ? "Reset trading passphrase" : "Set trading passphrase"}
                    >
                      <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-6 text-muted-foreground">
              <Wallet className="w-6 h-6 mx-auto mb-2" aria-hidden="true" />
              <p className="text-sm">No wallets generated yet</p>
              <p className="text-xs mt-1">Click &quot;Generate Wallet&quot; to create one</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Task completion progress */}
      {agentTasks.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="font-medium">Task Progress</span>
              <span className="text-amber-600 dark:text-amber-400 font-semibold">{completionRate}%</span>
            </div>
            <div className="h-2.5 bg-muted rounded-full overflow-hidden flex">
              {completedTasks > 0 && (
                <div className="h-full bg-emerald-500 transition-[width]" style={{ width: `${(completedTasks / agentTasks.length) * 100}%` }} />
              )}
              {activeTasks > 0 && (
                <div className="h-full bg-amber-500 transition-[width]" style={{ width: `${(activeTasks / agentTasks.length) * 100}%` }} />
              )}
            </div>
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" />{completedTasks} done</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" />{activeTasks} active</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-muted-foreground/30" />{todoTasks} todo</span>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Capabilities */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Zap className="w-4 h-4" aria-hidden="true" /> Capabilities</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {(agent.capabilities ?? []).map((cap, index) => (
                <Badge key={index} variant="secondary" className="text-xs">
                  {cap}
                </Badge>
              ))}
              {(agent.capabilities ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground">No capabilities defined</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Project Assignments */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Folder className="w-4 h-4" aria-hidden="true" /> Project Assignments</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {assignedProjects.map((project) => (
                <Link
                  key={project.id}
                  href={`/agent-guilds/${project.id}`}
                  className="flex items-center justify-between p-2 rounded-lg hover:bg-muted transition-colors"
                >
                  <span className="font-medium text-sm">{project.name}</span>
                  <Badge
                    className={
                      project.status === "active"
                        ? "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                        : project.status === "paused"
                          ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-400"
                          : "bg-muted text-muted-foreground"
                    }
                  >
                    {project.status}
                  </Badge>
                </Link>
              ))}
              {assignedProjects.length === 0 && (
                <p className="text-sm text-muted-foreground">Not assigned to any projects</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Skills & Plugins */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><Puzzle className="w-4 h-4" aria-hidden="true" /> Agent Skills & Plugins</CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">{activeSkills.length} installed</Badge>
              {availableForAgent.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowSkillPicker(!showSkillPicker)}
                  className="h-7 text-xs gap-1 border-amber-500/30 text-amber-500 hover:bg-amber-500/10"
                >
                  + Add
                </Button>
              )}
            </div>
          </div>
          <CardDescription>Skills and plugins installed on this agent. Get items from the Market, then add them here.</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Available skills picker */}
          {showSkillPicker && availableForAgent.length > 0 && (
            <div className="mb-4 p-3 rounded-lg border border-amber-500/20 bg-amber-500/5">
              <p className="text-xs font-medium text-amber-500 mb-2">Available from Inventory</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {availableForAgent.map((skill) => (
                  <button
                    key={skill.id}
                    onClick={() => handleInstallSkill(skill.id)}
                    disabled={skillBusy === skill.id}
                    className="flex items-center gap-3 p-2.5 rounded-lg border border-border bg-card hover:border-amber-500/30 transition-colors text-left"
                  >
                    <span className="text-lg flex-shrink-0">{skill.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{skill.name}</span>
                        <Badge variant="outline" className="text-xs capitalize">{skill.type}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{skill.description}</p>
                    </div>
                    {skillBusy === skill.id ? (
                      <span className="text-amber-500 text-xs">...</span>
                    ) : (
                      <span className="text-amber-500 text-xs font-medium">+ Add</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Installed skills */}
          {activeSkills.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {activeSkills.map((skill) => {
                const agentSkill = agentSkills.find(s => s.skillId === skill.id);
                return (
                  <div
                    key={skill.id}
                    className="flex items-center gap-3 p-2.5 rounded-lg border border-border bg-muted/30 group"
                  >
                    <span className="text-lg flex-shrink-0">{skill.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{skill.name}</span>
                        <span className="text-xs text-muted-foreground">v{skill.version}</span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{skill.description}</p>
                    </div>
                    {agentSkill && (
                      <button
                        onClick={() => handleRemoveSkill(agentSkill)}
                        disabled={skillBusy === skill.id}
                        className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-1.5 rounded text-red-400 hover:bg-red-500/10 transition-opacity flex-shrink-0"
                        title="Remove from agent"
                      >
                        {skillBusy === skill.id ? (
                          <span className="text-xs">...</span>
                        ) : (
                          <X className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-6 text-muted-foreground">
              <Puzzle className="w-6 h-6 mx-auto mb-2" aria-hidden="true" />
              <p className="text-sm">No skills installed on this agent</p>
              <p className="text-xs mt-1">
                {availableForAgent.length > 0
                  ? "Click \"+ Add\" above to install from your inventory"
                  : "Get skills from the Market first, then add them here"}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Self-Reported Skills (from agent on connect) */}
      {(agent.reportedSkills ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2"><Radio className="w-4 h-4" aria-hidden="true" /> Reported Skills</CardTitle>
              <Badge variant="secondary" className="text-xs">{(agent.reportedSkills ?? []).length} reported</Badge>
            </div>
            <CardDescription>Skills and plugins this agent reported when it connected to the platform</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(agent.reportedSkills ?? []).map((rs: ReportedSkill) => {
                // Try to match with a registry item for a richer display
                const registryMatch = SKILL_REGISTRY.find(s => s.id === rs.id);
                return (
                  <div
                    key={rs.id}
                    className="flex items-center gap-3 p-2.5 rounded-lg border border-border bg-muted/30"
                  >
                    <span className="text-lg flex-shrink-0">{registryMatch?.icon ?? (rs.type === "plugin" ? "🔌" : "⚙️")}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{rs.name}</span>
                        {rs.version && <span className="text-xs text-muted-foreground">v{rs.version}</span>}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-xs capitalize">{rs.type}</Badge>
                        {registryMatch && (
                          <span className="text-xs text-emerald-600 dark:text-emerald-400">verified</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Protocol Mods (org-wide) */}
      {(() => {
        const activeMods = SKILL_REGISTRY.filter(s => s.type === "mod" && ownedSkillIds.has(s.id));
        if (activeMods.length === 0) return null;
        return (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2"><Wrench className="w-4 h-4" aria-hidden="true" /> Active Protocol Mods</CardTitle>
              <CardDescription>Organization-wide mods applied to all agents</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {activeMods.map((mod) => (
                  <div key={mod.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-border bg-muted/30">
                    <span className="text-lg flex-shrink-0">{mod.icon}</span>
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium truncate block">{mod.name}</span>
                      <p className="text-xs text-muted-foreground truncate">{mod.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })()}

      </TabsContent>

      <TabsContent value="passport" className="space-y-6">
      {/* Spending Policy — economic consequences of the resolved credit tier */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><IdCard className="w-4 h-4" aria-hidden="true" /> Spending Policy</CardTitle>
            <Badge className="bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-950/40 dark:text-slate-300 dark:border-slate-800">
              {policyTier.label} Tier
            </Badge>
          </div>
          <CardDescription>Economic consequences of this agent&apos;s resolved credit policy tier</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="text-center p-3 rounded-lg border border-border">
              <div className="text-lg font-bold">${policyTier.spendingCapUsd.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Spending Cap</div>
            </div>
            <div className="text-center p-3 rounded-lg border border-border">
              <div className="text-lg font-bold">{Math.round(policyTier.escrowRatio * 100)}%</div>
              <div className="text-xs text-muted-foreground mt-0.5">Escrow Ratio</div>
            </div>
            <div className="text-center p-3 rounded-lg border border-border">
              <div className="text-lg font-bold">{policyTier.maxConcurrentTasks}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Max Concurrent</div>
            </div>
            <div className="text-center p-3 rounded-lg border border-border">
              <div className="text-lg font-bold">{policyTier.feeMultiplier}x</div>
              <div className="text-xs text-muted-foreground mt-0.5">Fee Multiplier</div>
            </div>
            <div className="text-center p-3 rounded-lg border border-border">
              <div className="text-lg font-bold capitalize">{policyTier.payoutSpeed}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Payout Speed</div>
            </div>
            <div className="text-center p-3 rounded-lg border border-border">
              <div className="text-lg font-bold">{policyTier.canClaimHighValueJobs ? "Yes" : "No"}</div>
              <div className="text-xs text-muted-foreground mt-0.5">High-Value Jobs</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ASN Identity & Credit Score */}
      {agent.asn && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2"><IdCard className="w-4 h-4" aria-hidden="true" /> Agent Identity (ASN)</CardTitle>
              <Badge className="bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-400 dark:border-cyan-800 font-mono text-xs">
                {agent.asn}
              </Badge>
            </div>
            <CardDescription>Agent Social Number — on-chain identity and credit scoring</CardDescription>
            <Link href={`/agents/${agentId}/credit`} className="text-xs text-amber-600 hover:text-amber-500 hover:underline transition-colors mt-1 inline-flex items-center gap-1">
              View Credit Details <ArrowRight className="w-3 h-3" aria-hidden="true" />
            </Link>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="text-center p-3 rounded-lg border border-border">
                <div className={`text-2xl font-bold ${scoreBand.color}`}>{creditScore}</div>
                <div className="text-xs text-muted-foreground mt-0.5">Credit Score</div>
                <Badge className={`mt-1 text-xs ${scoreBand.bgColor} ${scoreBand.color} ${scoreBand.borderColor}`}>
                  {scoreBand.label} ({scoreBand.range})
                </Badge>
              </div>
              <div className="text-center p-3 rounded-lg border border-border">
                <div className="text-2xl font-bold text-blue-500">{trustScore}</div>
                <div className="text-xs text-muted-foreground mt-0.5">Trust Score</div>
                <div className="w-full bg-muted rounded-full h-1.5 mt-2">
                  <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${trustScore}%` }} />
                </div>
              </div>
              <div className="text-center p-3 rounded-lg border border-border">
                <div className="text-2xl font-bold text-purple-500">{agent.tasksCompleted ?? 0}</div>
                <div className="text-xs text-muted-foreground mt-0.5">Tasks Completed</div>
                <div className="text-xs text-muted-foreground mt-1">On-chain verified</div>
              </div>
              <div className="text-center p-3 rounded-lg border border-border">
                <div className="flex items-center justify-center gap-1">
                  {agent.asnOnChainRegistered ? (
                    <span className="text-emerald-500 text-lg font-bold">On-Chain</span>
                  ) : agent.onChainRegistered ? (
                    <span className="text-amber-500 text-lg font-bold">Pending</span>
                  ) : (
                    <span className="text-muted-foreground text-lg font-bold">Off-Chain</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">ASN Status</div>
                {agent.asnOnChainTxHash && (
                  <a
                    href={`https://sepolia.etherscan.io/tx/${agent.asnOnChainTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-cyan-600 hover:underline mt-1 block"
                  >
                    View TX
                  </a>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Memory & ASN Management */}
      {agent.asn && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2"><Brain className="w-4 h-4" aria-hidden="true" /> Memory & ASN Management</CardTitle>
              <div className="flex gap-2">
                {(agent.status === "online" || agent.status === "busy") && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-red-300 text-red-600 hover:bg-red-50"
                    onClick={handleSuspendASN}
                    disabled={suspendingASN}
                  >
                    {suspendingASN ? "Suspending..." : "Suspend ASN"}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs border-purple-300 text-purple-600 hover:bg-purple-50"
                  onClick={handleBackupMemory}
                  disabled={memoryBackingUp || !agent.asn}
                >
                  {memoryBackingUp ? "Backing up..." : "Backup Now"}
                </Button>
              </div>
            </div>
            <CardDescription>Manage agent memory backups, ASN suspension, and memory topics</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-lg border border-border">
                <div className="text-xs text-muted-foreground mb-1">Backup Status</div>
                {memoryStatusLoading ? (
                  <div className="text-xs text-muted-foreground">Loading...</div>
                ) : memoryStatus?.hasBackup ? (
                  <>
                    <div className="text-sm font-medium text-emerald-600 dark:text-emerald-400">Backed Up</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {memoryStatus.lastBackup ? new Date(memoryStatus.lastBackup).toLocaleDateString() : "—"}
                    </div>
                  </>
                ) : (
                  <div className="text-sm font-medium text-muted-foreground">No Backup</div>
                )}
              </div>
              <div className="p-3 rounded-lg border border-border">
                <div className="text-xs text-muted-foreground mb-1">Messages</div>
                <div className="text-xl font-bold">{memoryStatus?.messageCount ?? 0}</div>
              </div>
              <div className="p-3 rounded-lg border border-border">
                <div className="text-xs text-muted-foreground mb-1">Memory Topic</div>
                <div className={`text-sm font-medium ${agent.memoryEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
                  {agent.memoryEnabled ? "Enabled" : "Not Set Up"}
                </div>
                {agent.memoryTopicId && (
                  <div className="text-xs font-mono text-muted-foreground mt-0.5 truncate" title={agent.memoryTopicId}>
                    {agent.memoryTopicId}
                  </div>
                )}
              </div>
              <div className="p-3 rounded-lg border border-border">
                <div className="text-xs text-muted-foreground mb-1">ASN Active</div>
                <div className={`text-sm font-medium ${agent.status === "online" || agent.status === "busy" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
                  {agent.status === "online" || agent.status === "busy" ? "Yes" : "Suspended"}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {agent.status === "online" || agent.status === "busy"
                    ? "Suspend to release ASN"
                    : "ASN available for reassignment"}
                </div>
              </div>
            </div>
            {memoryStatus?.cid && (
              <div className="mt-3 p-2 rounded-lg bg-muted/50 text-xs">
                <span className="text-muted-foreground">Backup CID: </span>
                <span className="font-mono text-xs break-all">{memoryStatus.cid}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* On-Chain Registration — Solana */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><Blocks className="w-4 h-4" aria-hidden="true" /> On-Chain Status</CardTitle>
            <div className="flex gap-1.5">
              <Badge className={`gap-1 ${onchainMatch
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                : "bg-muted text-muted-foreground"
              }`}>
                Registry {onchainMatch ? <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> : <XCircle className="w-3 h-3" aria-hidden="true" />}
              </Badge>
              <Badge className={`gap-1 ${agent.nftMintAddress
                ? "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400"
                : "bg-muted text-muted-foreground"
              }`}>
                Reputation Token {agent.nftMintAddress ? <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> : <XCircle className="w-3 h-3" aria-hidden="true" />}
              </Badge>
            </div>
          </div>
          <CardDescription>On-chain registry entry and reputation token (Solana)</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {solanaError && (
              <div className="flex items-center justify-between gap-3 p-2.5 rounded-md bg-red-50 border border-red-200 text-xs text-red-600 dark:bg-red-950/20 dark:border-red-800 dark:text-red-400">
                <span>{solanaError}</span>
                <button onClick={() => setSolanaError(null)} className="shrink-0 hover:text-red-800 dark:hover:text-red-300">
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            )}
            {/* Agent Registry (Solana AgentGuild program) */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-medium">Agent Registry</span>
                <Badge variant="outline" className="text-xs">SOL</Badge>
              </div>
              {onchainMatch ? (
                <div className="grid grid-cols-2 gap-3 text-sm pl-2 border-l-2 border-emerald-500/30">
                  <div>
                    <span className="text-xs text-muted-foreground">Agent Address</span>
                    <p className="font-mono text-xs mt-0.5">{shortAddress(onchainMatch.agentAddress)}</p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Fee Rate</span>
                    <p className="text-xs font-medium mt-0.5">{onchainMatch.feeRate} bps ({(onchainMatch.feeRate / 100).toFixed(1)}%)</p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Status</span>
                    <p className="text-xs mt-0.5">
                      <span className={`inline-flex items-center gap-1 ${onchainMatch.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                        <span className={`w-2 h-2 rounded-full ${onchainMatch.active ? 'bg-emerald-500' : 'bg-muted'}`} />
                        {onchainMatch.active ? 'Active' : 'Inactive'}
                      </span>
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Registered</span>
                    <p className="text-xs mt-0.5">
                      {onchainMatch.registeredAt > 0
                        ? new Date(onchainMatch.registeredAt * 1000).toLocaleDateString()
                        : '—'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="pl-2 border-l-2 border-muted">
                  <p className="text-xs text-muted-foreground">Not registered on-chain yet</p>
                  <Button onClick={handleRegisterOpen} size="sm" className="mt-2 bg-amber-600 hover:bg-amber-700 text-white text-xs h-7">
                    Register On-Chain
                  </Button>
                </div>
              )}
            </div>


            {/* Identity NFT (three soulbound Metaplex Core copies) */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-medium">Reputation Token</span>
                <Badge variant="outline" className="text-xs">SOL</Badge>
              </div>
              {agent.nftMintAddress || agent.nftStandard === "mpl-core" ? (
                <IdentityNftCopies
                  agent={agent}
                  sessionAddress={sessionAddress}
                  isOrgOwner={Boolean(
                    sessionAddress && currentOrg?.ownerAddress &&
                    canonicalizeWalletAddress(currentOrg.ownerAddress) === canonicalizeWalletAddress(sessionAddress)
                  )}
                  loading={solanaLoading}
                  onMint={handleMintSolanaNft}
                  onRefresh={handleUpdateSolanaMetadata}
                />
              ) : agent.solanaAddress ? (
                <div className="pl-2 border-l-2 border-purple-500/30">
                  <p className="text-xs">
                    Wallet: <code className="font-mono text-xs">{shortAddress(agent.solanaAddress)}</code>
                  </p>
                  <Button
                    onClick={handleMintSolanaNft}
                    disabled={solanaLoading}
                    size="sm"
                    className="mt-2 bg-purple-600 hover:bg-purple-700 text-white text-xs h-7"
                  >
                    {solanaLoading ? "Minting..." : "Mint Identity NFT"}
                  </Button>
                </div>
              ) : (
                <div className="pl-2 border-l-2 border-muted">
                  <p className="text-xs text-muted-foreground">No Solana wallet</p>
                  <Button
                    onClick={handleGenerateSolanaWallet}
                    disabled={solanaLoading}
                    size="sm"
                    className="mt-2 bg-purple-600 hover:bg-purple-700 text-white text-xs h-7"
                  >
                    {solanaLoading ? "Generating..." : "Generate Wallet"}
                  </Button>
                </div>
              )}
            </div>

            {/* On-Chain Skills (from registry match) */}
            {onchainMatch?.skills && (
              <div className="border-t border-border pt-3">
                <span className="text-xs text-muted-foreground">On-Chain Skills</span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {onchainMatch.skills.split(',').map(s => s.trim()).filter(Boolean).map(skill => (
                    <Badge key={skill} variant="outline" className="text-xs">{skill}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* AgentGuildConnect / OpenClaw Connection */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Link2 className="w-4 h-4" aria-hidden="true" /> AgentGuildConnect</CardTitle>
          <CardDescription>Agent connection details for OpenClaw integration</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-xs text-muted-foreground">Agent ID</span>
                <p className="font-mono text-xs break-all mt-0.5">{agent.id}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Organization</span>
                <p className="text-xs mt-0.5">{currentOrg?.name} ({currentOrg?.id})</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Connection Method</span>
                <p className="text-xs mt-0.5">Ed25519 Signed Requests</p>
              </div>
            </div>
            <div className="border-t border-border pt-3">
              <span className="text-xs text-muted-foreground block mb-1.5">Quick Setup</span>
              <div className="bg-muted rounded-md p-3 font-mono text-xs space-y-1">
                <p className="text-muted-foreground"># Install the AgentGuildConnect skill</p>
                <p>npm install -g @agent-guild/agent-skill</p>
                <p className="text-muted-foreground mt-2"># Register this agent (with skills)</p>
                <p>agent-guild register --hub https://agent-guild.com --org {currentOrg?.id} --name &quot;{agent.name}&quot; --type &quot;{agent.type}&quot; --skills &quot;web-search,code-interpreter&quot;</p>
                <p className="text-muted-foreground mt-2"># Report skills at any time</p>
                <p>agent-guild report-skills --skills &quot;web-search,code-interpreter&quot;</p>
                <p className="text-muted-foreground mt-2"># Check for messages</p>
                <p>agent-guild check</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      </TabsContent>

      <TabsContent value="overview" className="space-y-6">
      {/* Jobs */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><Briefcase className="w-4 h-4" aria-hidden="true" /> Assigned Jobs</CardTitle>
            <div className="flex items-center gap-2">
              {jobsCompleted > 0 && <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">{jobsCompleted} completed</Badge>}
              {jobsInProgress > 0 && <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">{jobsInProgress} active</Badge>}
            </div>
          </div>
          <CardDescription>Jobs claimed or assigned to this agent</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {agentJobs.slice(0, 10).map((job) => (
              <div
                key={job.id}
                className="flex items-center justify-between p-3 rounded-lg border border-border"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{job.title}</div>
                  {job.description && (
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">
                      {job.description.substring(0, 100)}{job.description.length > 100 ? '...' : ''}
                    </div>
                  )}
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <span>Priority: {job.priority}</span>
                    {job.reward && <span className="text-amber-600 dark:text-amber-400 font-medium">{job.reward}</span>}
                    {job.requiredSkills?.length > 0 && (
                      <span>{job.requiredSkills.slice(0, 3).join(', ')}</span>
                    )}
                  </div>
                </div>
                <Badge
                  className={
                    job.status === "completed" || job.status === "closed"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                      : job.status === "in_progress" || job.status === "claimed"
                        ? "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                        : "bg-muted text-muted-foreground"
                  }
                >
                  {job.status === 'in_progress' ? 'In Progress' :
                    job.status === 'claimed' ? 'Claimed' :
                      job.status === 'completed' ? 'Completed' :
                        job.status === 'closed' ? 'Closed' : 'Open'}
                </Badge>
              </div>
            ))}
            {agentJobs.length === 0 && (
              <div className="text-center py-6 text-muted-foreground">
                <Briefcase className="w-6 h-6 mx-auto mb-2" aria-hidden="true" />
                <p className="text-sm">No jobs assigned yet</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Recent Tasks */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><ClipboardList className="w-4 h-4" aria-hidden="true" /> Assigned Tasks</CardTitle>
            <Badge variant="secondary" className="text-xs">{agentTasks.length} total</Badge>
          </div>
          <CardDescription>Tasks currently assigned to this agent</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {agentTasks.slice(0, 10).map((task) => (
              <div
                key={task.id}
                className="flex items-center justify-between p-3 rounded-lg border border-border"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{task.title}</div>
                  {task.description && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {task.description.substring(0, 80)}{task.description.length > 80 ? '...' : ''}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground mt-1">
                    Priority: {task.priority} · Created {formatTime(task.createdAt)}
                  </div>
                </div>
                <Badge
                  className={
                    task.status === "done"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                      : task.status === "in_progress"
                        ? "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                        : "bg-muted text-muted-foreground"
                  }
                >
                  {task.status === 'in_progress' ? 'In Progress' :
                    task.status === 'todo' ? 'To Do' : 'Done'}
                </Badge>
              </div>
            ))}
            {agentTasks.length === 0 && (
              <div className="text-center py-6 text-muted-foreground">
                <ClipboardList className="w-6 h-6 mx-auto mb-2" aria-hidden="true" />
                <p className="text-sm">No tasks assigned yet</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      </TabsContent>

      <TabsContent value="harness" className="space-y-6">
        <AgentHarnessPanel agentId={agentId} />
      </TabsContent>
      </Tabs>

      {/* Edit Agent Dialog */}
      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Agent Name *</label>
              <Input value={editName} onChange={e => setEditName(e.target.value)} />
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
              <label className="text-sm font-medium mb-1 block">Description</label>
              <Textarea value={editDescription} onChange={e => setEditDescription(e.target.value)} rows={3} />
            </div>
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Agent</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to remove <strong>{agent?.name}</strong>? This action cannot be undone.
          </p>
          <div className="flex gap-2 justify-end mt-4">
            <Button variant="outline" onClick={() => setShowDelete(false)} disabled={deleting}>Cancel</Button>
            <Button onClick={handleDeleteConfirm} disabled={deleting} className="bg-red-600 hover:bg-red-700 text-white">
              <Trash2 className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> {deleting ? 'Removing...' : 'Remove'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Pause Agent Dialog */}
      <Dialog open={showPause} onOpenChange={setShowPause}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pause Agent</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">
            Pausing <strong>{agent?.name}</strong> will prevent it from processing messages until resumed.
          </p>
          <div>
            <label className="text-sm font-medium mb-1 block">Reason (optional)</label>
            <Textarea
              value={pauseReason}
              onChange={(e) => setPauseReason(e.target.value)}
              placeholder="e.g., Maintenance, testing, cost limits..."
              rows={3}
            />
          </div>
          <div className="flex gap-2 justify-end mt-4">
            <Button variant="outline" onClick={() => { setShowPause(false); setPauseReason(''); }} disabled={pausing}>Cancel</Button>
            <Button onClick={handlePauseConfirm} disabled={pausing} className="bg-orange-600 hover:bg-orange-700 text-white">
              <Pause className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> {pausing ? 'Pausing...' : 'Pause Agent'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Register On-Chain Dialog */}
      <Dialog open={showRegister} onOpenChange={(open) => { setShowRegister(open); if (!open) resetRegisterState(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Blocks className="w-4 h-4" aria-hidden="true" /> Register Agent On-Chain</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Register <strong>{agent?.name}</strong> on the Solana Agent Registry program.
            </p>
            <div className="p-3 rounded-md bg-muted text-sm text-muted-foreground">
              {agent?.solanaAddress
                ? <>Registers under the agent&apos;s own wallet <span className="font-mono">{shortAddress(agent.solanaAddress)}</span>. Network fees are sponsored by the platform.</>
                : <>Registers under the agent&apos;s own identity wallet. Network fees are sponsored by the platform.</>}
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Agent Name *</label>
              <Input value={registerName} onChange={e => setRegisterName(e.target.value)} disabled={registerState.isLoading} />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Skills</label>
              <Input
                value={registerSkills}
                onChange={e => setRegisterSkills(e.target.value)}
                placeholder="e.g. research, analysis, trading"
                disabled={registerState.isLoading}
              />
              <p className="text-xs text-muted-foreground mt-1">Comma-separated list of skills stored onchain</p>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Fee Rate (basis points)</label>
              <Input
                type="number"
                value={registerFeeRate}
                onChange={e => setRegisterFeeRate(e.target.value)}
                min={0}
                max={10000}
                disabled={registerState.isLoading}
              />
              <p className="text-xs text-muted-foreground mt-1">500 bps = 5% fee on completed tasks</p>
            </div>

            {registerState.error && (
              <div className="p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-600 dark:bg-red-950/20 dark:border-red-800 dark:text-red-400">
                {registerState.error}
              </div>
            )}

            {registerState.txHash && (
              <div className="p-3 rounded-md bg-emerald-50 border border-emerald-200 text-sm text-emerald-700 dark:bg-emerald-950/20 dark:border-emerald-800 dark:text-emerald-400">
                <p className="font-medium">Registration successful!</p>
                <p className="text-xs font-mono mt-1 break-all">TX: {registerState.txHash}</p>
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowRegister(false)} disabled={registerState.isLoading}>
                {registerState.txHash ? 'Close' : 'Cancel'}
              </Button>
              {!registerState.txHash && (
                <Button
                  onClick={handleRegisterSubmit}
                  disabled={registerState.isLoading || !registerName.trim()}
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {registerState.isLoading
                    ? 'Registering...'
                    : <><Blocks className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Register</>}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Generate Agent Wallet Dialog */}
      <Dialog open={showGenerateWallet} onOpenChange={(open) => { setShowGenerateWallet(open); if (!open) setHyperliquidPassphrase(''); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Wallet className="w-4 h-4" aria-hidden="true" /> Generate Agent Wallet</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Chain</label>
              <Select value={generateChain} onValueChange={(v: string) => { setGenerateChain(v as "solana" | "evm"); setRegisterHyperliquid(false); }}>
                <SelectTrigger>
                  <SelectValue>{generateChain === "solana" ? "Solana" : "EVM (Hyperliquid-compatible)"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="solana">Solana</SelectItem>
                  <SelectItem value="evm">EVM (Hyperliquid-compatible)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {generateChain === "evm" && (
              <div className="space-y-3 rounded-lg border border-border p-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={registerHyperliquid}
                    onChange={(e) => setRegisterHyperliquid(e.target.checked)}
                    className="accent-amber-600"
                  />
                  Register for Hyperliquid trading
                </label>
                <p className="text-xs text-muted-foreground">
                  Hands the new key to mods/hyperliquid-trading, encrypted with a passphrase only you supply here.
                  The platform never stores this passphrase — you&apos;ll need to re-enter it every time this agent
                  places a trade, same as pasting in your own key. Lose it and the wallet shown below is still
                  yours (and still in the Agent Wallets list), but it won&apos;t be able to trade on Hyperliquid
                  anymore until you register it again with a new passphrase.
                </p>
                {registerHyperliquid && (
                  <>
                    <div>
                      <label className="text-xs font-medium mb-1 block">Trading Passphrase</label>
                      <Input
                        type="password"
                        value={hyperliquidPassphrase}
                        onChange={(e) => setHyperliquidPassphrase(e.target.value)}
                        placeholder="Used to encrypt this key for trading — not stored"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium mb-1 block">Network</label>
                      <Select value={hyperliquidNetwork} onValueChange={(v: string) => setHyperliquidNetwork(v as "testnet" | "mainnet")}>
                        <SelectTrigger>
                          <SelectValue>{hyperliquidNetwork === "mainnet" ? "Mainnet" : "Testnet"}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="testnet">Testnet</SelectItem>
                          <SelectItem value="mainnet">Mainnet</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}
              </div>
            )}

            {walletError && (
              <div className="p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-600 dark:bg-red-950/20 dark:border-red-800 dark:text-red-400">
                {walletError}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowGenerateWallet(false)} disabled={generatingWallet}>Cancel</Button>
              <Button
                onClick={handleGenerateWallet}
                disabled={generatingWallet || (generateChain === "evm" && registerHyperliquid && !hyperliquidPassphrase.trim())}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {generatingWallet ? "Generating..." : <><Plus className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Generate</>}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reset Hyperliquid Trading Passphrase Dialog */}
      <Dialog open={!!resetPassphraseWallet} onOpenChange={(open) => { if (!open) { setResetPassphraseWallet(null); setResetPassphraseValue(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><KeyRound className="w-4 h-4" aria-hidden="true" /> {resetPassphraseWallet?.hyperliquidRegistered ? "Reset" : "Set"} Trading Passphrase</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {resetPassphraseWallet?.hyperliquidRegistered
                ? "This re-encrypts the wallet's key for Hyperliquid trading under a new passphrase. The old passphrase stops working immediately."
                : "This wallet isn't registered for Hyperliquid trading yet. Setting a passphrase here hands its key to mods/hyperliquid-trading, encrypted so only this passphrase can use it."}
              {" "}The platform never stores it — you&apos;ll need to re-enter it on every trade.
            </p>
            <div>
              <label className="text-xs font-medium mb-1 block">New Trading Passphrase</label>
              <Input
                type="password"
                value={resetPassphraseValue}
                onChange={(e) => setResetPassphraseValue(e.target.value)}
                placeholder="Used to encrypt this key for trading — not stored"
              />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Network</label>
              <Select value={resetPassphraseNetwork} onValueChange={(v: string) => setResetPassphraseNetwork(v as "testnet" | "mainnet")}>
                <SelectTrigger>
                  <SelectValue>{resetPassphraseNetwork === "mainnet" ? "Mainnet" : "Testnet"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="testnet">Testnet</SelectItem>
                  <SelectItem value="mainnet">Mainnet</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {resetPassphraseError && (
              <div className="p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-600 dark:bg-red-950/20 dark:border-red-800 dark:text-red-400">
                {resetPassphraseError}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setResetPassphraseWallet(null)} disabled={resettingPassphrase}>Cancel</Button>
              <Button
                onClick={handleResetPassphrase}
                disabled={resettingPassphrase || !resetPassphraseValue.trim()}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {resettingPassphrase ? "Saving..." : (resetPassphraseWallet?.hyperliquidRegistered ? "Reset Passphrase" : "Set Passphrase")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
