/** Memory Browser — Browse and search agent memory files (journal, long-term, workspace, vector). */
"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { Brain, Search, FileText, Loader2, HardDrive, Download, Upload, ArrowRightLeft, Clock, Bot } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useOrg } from "@/contexts/OrgContext";
import { useAuthAddress } from "@/hooks/useAuthAddress";
import { FileManager } from "@/components/file-manager";
// [swarm-core] Storacha artifact browser — install storacha mod for full UI
const ArtifactBrowser = () => null;
import { db } from "@/lib/firebase";
import { collection, query, where, getDocs, onSnapshot } from "firebase/firestore";
import {
    type MemoryEntry,
    type MemoryType,
    MEMORY_TYPE_CONFIG,
    getMemoryEntries,
    searchMemory,
    fmtFileSize,
} from "@/lib/memory";

function timeAgo(d: Date | null): string {
    if (!d) return "\u2014";
    const sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
}

interface AgentOption { id: string; name: string; asn: string; status: string; }

type BackupFrequency = "off" | "6h" | "12h" | "daily" | "twice_daily";
const FREQ_OPTIONS: { value: BackupFrequency; label: string }[] = [
    { value: "off", label: "Off" },
    { value: "6h", label: "Every 6 hours" },
    { value: "12h", label: "Every 12 hours" },
    { value: "twice_daily", label: "Twice a day" },
    { value: "daily", label: "Once a day" },
];

type TabId = "memory" | "workspace" | "artifacts";
const VALID_TABS: TabId[] = ["memory", "workspace", "artifacts"];

export default function MemoryPage() {
    const { currentOrg } = useOrg();
    const authAddress = useAuthAddress();
    const searchParams = useSearchParams();
    const initialTab = useMemo(() => {
        const t = searchParams.get("tab");
        return t && VALID_TABS.includes(t as TabId) ? (t as TabId) : "memory";
    }, [searchParams]);
    const [entries, setEntries] = useState<MemoryEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState("");
    const [typeFilter, setTypeFilter] = useState<MemoryType | "all">("all");
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<TabId>(initialTab);

    // Agent selector state
    const [agents, setAgents] = useState<AgentOption[]>([]);
    const [selectedAgentId, setSelectedAgentId] = useState<string>("all");

    // Backup controls
    const [backingUp, setBackingUp] = useState(false);
    const [backupFreq, setBackupFreq] = useState<BackupFrequency>("off");
    const [freqLoading, setFreqLoading] = useState(false);
    const [backupStatus, setBackupStatus] = useState<{
        hasBackup: boolean; lastBackup?: string; messageCount?: number; cid?: string;
    } | null>(null);

    // Transfer state
    const [transferOpen, setTransferOpen] = useState(false);
    const [transferTarget, setTransferTarget] = useState<string>("");
    const [transferring, setTransferring] = useState(false);

    // Load agents for this org
    useEffect(() => {
        if (!currentOrg) return;
        const q = query(collection(db, "agents"), where("orgId", "==", currentOrg.id));
        const unsub = onSnapshot(q, (snap) => {
            const list: AgentOption[] = snap.docs.map(d => {
                const data = d.data();
                return { id: d.id, name: data.name || d.id, asn: data.asn || "", status: data.status || "offline" };
            });
            list.sort((a, b) => a.name.localeCompare(b.name));
            setAgents(list);
        });
        return unsub;
    }, [currentOrg]);

    // Load memory entries filtered by agent
    const load = useCallback(async () => {
        if (!currentOrg) return;
        try {
            setLoading(true);
            const agentId = selectedAgentId === "all" ? undefined : selectedAgentId;
            const data = await getMemoryEntries(currentOrg.id, agentId, typeFilter === "all" ? undefined : typeFilter);
            setEntries(data);
        } catch (err) { console.error(err); }
        finally { setLoading(false); }
    }, [currentOrg, typeFilter, selectedAgentId]);

    useEffect(() => { load(); }, [load]);

    // Load backup status & schedule when agent selected
    useEffect(() => {
        if (!currentOrg || selectedAgentId === "all") {
            setBackupStatus(null);
            setBackupFreq("off");
            return;
        }
        // Fetch backup status
        fetch(`/api/v1/asn-memory/agent-status?agentId=${selectedAgentId}&orgId=${currentOrg.id}`)
            .then(r => r.json())
            .then(data => {
                if (!data.error) setBackupStatus(data);
            })
            .catch(() => {});
        // Fetch backup schedule
        fetch(`/api/v1/asn-memory/schedule?agentId=${selectedAgentId}&orgId=${currentOrg.id}`)
            .then(r => r.json())
            .then(data => {
                if (!data.error) setBackupFreq(data.frequency || "off");
            })
            .catch(() => {});
    }, [currentOrg, selectedAgentId]);

    const filtered = searchQuery ? searchMemory(entries, searchQuery) : entries;

    const selectedAgent = agents.find(a => a.id === selectedAgentId);

    // Backup handler
    const handleBackup = async () => {
        if (!currentOrg || !selectedAgent) return;
        setBackingUp(true);
        try {
            const res = await fetch("/api/v1/asn-memory/backup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    agentId: selectedAgent.id,
                    asn: selectedAgent.asn,
                    orgId: currentOrg.id,
                }),
            });
            const data = await res.json();
            if (data.success) {
                setBackupStatus({ hasBackup: true, lastBackup: data.timestamp, messageCount: data.messageCount, cid: data.cid });
            }
        } catch (err) { console.error("Backup failed:", err); }
        finally { setBackingUp(false); }
    };

    // Frequency change handler
    const handleFreqChange = async (freq: BackupFrequency) => {
        if (!currentOrg || selectedAgentId === "all") return;
        setFreqLoading(true);
        try {
            const res = await fetch("/api/v1/asn-memory/schedule", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ agentId: selectedAgentId, orgId: currentOrg.id, frequency: freq }),
            });
            const data = await res.json();
            if (data.success) setBackupFreq(freq);
        } catch (err) { console.error("Schedule update failed:", err); }
        finally { setFreqLoading(false); }
    };

    // Transfer handler
    const handleTransfer = async () => {
        if (!currentOrg || !selectedAgentId || !transferTarget) return;
        setTransferring(true);
        try {
            const res = await fetch("/api/v1/asn-memory/transfer", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sourceAgentId: selectedAgentId,
                    targetAgentId: transferTarget,
                    orgId: currentOrg.id,
                }),
            });
            const data = await res.json();
            if (data.success) {
                setTransferOpen(false);
                setTransferTarget("");
            }
        } catch (err) { console.error("Transfer failed:", err); }
        finally { setTransferring(false); }
    };

    if (!authAddress) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-muted-foreground">
                <Brain className="h-12 w-12 opacity-30" /><p>Connect your wallet to browse memory</p>
            </div>
        );
    }

    return (
        <div className="max-w-[1000px] mx-auto px-4 py-8">
            <div className="mb-6">
                <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-purple-500/10 border border-purple-500/20">
                        <Brain className="h-6 w-6 text-purple-500" />
                    </div>
                    Memory
                </h1>
                <p className="text-sm text-muted-foreground mt-2">Browse agent memory files, artifacts, and run semantic search</p>
            </div>

            <div className="flex gap-2 mb-6 border-b border-border pb-2">
                <button
                    onClick={() => setActiveTab("memory")}
                    className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${activeTab === "memory"
                            ? "bg-purple-500/10 text-purple-400 border-b-2 border-purple-500"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                >
                    Memory Search
                </button>
                <button
                    onClick={() => setActiveTab("workspace")}
                    className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${activeTab === "workspace"
                            ? "bg-purple-500/10 text-purple-400 border-b-2 border-purple-500"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                >
                    Workspace Files
                </button>
                <button
                    onClick={() => setActiveTab("artifacts")}
                    className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${activeTab === "artifacts"
                            ? "bg-purple-500/10 text-purple-400 border-b-2 border-purple-500"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                >
                    <span className="flex items-center gap-1.5">
                        <HardDrive className="h-3.5 w-3.5" />
                        Artifacts
                    </span>
                </button>
            </div>

            {activeTab === "artifacts" ? (
                <ArtifactBrowser />
            ) : activeTab === "memory" ? (
                <>
                    {/* Agent selector + action bar */}
                    <Card className="p-4 mb-4 bg-card/80 border-border">
                        <div className="flex items-center gap-3 flex-wrap">
                            <div className="flex items-center gap-2 min-w-[220px]">
                                <Bot className="h-4 w-4 text-muted-foreground" />
                                <Select value={selectedAgentId} onValueChange={(v) => setSelectedAgentId(v)}>
                                    <SelectTrigger className="h-8 text-sm">
                                        <SelectValue placeholder="All Agents" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All Agents</SelectItem>
                                        {agents.map(a => (
                                            <SelectItem key={a.id} value={a.id}>
                                                <span className="flex items-center gap-2">
                                                    <span className={`h-1.5 w-1.5 rounded-full ${a.status === "online" ? "bg-green-500" : "bg-gray-500"}`} />
                                                    {a.name}
                                                    {a.asn && <span className="text-muted-foreground text-[10px] ml-1">{a.asn.slice(-9)}</span>}
                                                </span>
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            {selectedAgentId !== "all" && selectedAgent && (
                                <>
                                    {/* Backup button */}
                                    <button
                                        onClick={handleBackup}
                                        disabled={backingUp || !selectedAgent.asn}
                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-50"
                                    >
                                        {backingUp ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                                        Backup Now
                                    </button>

                                    {/* Transfer button */}
                                    <button
                                        onClick={() => setTransferOpen(!transferOpen)}
                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors"
                                    >
                                        <ArrowRightLeft className="h-3 w-3" />
                                        Transfer Memory
                                    </button>

                                    {/* Backup frequency */}
                                    <div className="flex items-center gap-2 ml-auto">
                                        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                                        <span className="text-[10px] text-muted-foreground">Auto-backup:</span>
                                        <Select
                                            value={backupFreq}
                                            onValueChange={(v) => handleFreqChange(v as BackupFrequency)}
                                            disabled={freqLoading}
                                        >
                                            <SelectTrigger className="h-7 text-xs w-[140px]">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {FREQ_OPTIONS.map(o => (
                                                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </>
                            )}
                        </div>

                        {/* Transfer dialog inline */}
                        {transferOpen && selectedAgentId !== "all" && (
                            <div className="mt-3 pt-3 border-t border-border flex items-center gap-3">
                                <span className="text-xs text-muted-foreground">Transfer to:</span>
                                <Select value={transferTarget} onValueChange={setTransferTarget}>
                                    <SelectTrigger className="h-8 text-sm w-[200px]">
                                        <SelectValue placeholder="Select agent..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {agents.filter(a => a.id !== selectedAgentId).map(a => (
                                            <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <button
                                    onClick={handleTransfer}
                                    disabled={!transferTarget || transferring}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors disabled:opacity-50"
                                >
                                    {transferring ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                                    Copy Memory
                                </button>
                                <button
                                    onClick={() => { setTransferOpen(false); setTransferTarget(""); }}
                                    className="text-xs text-muted-foreground hover:text-foreground"
                                >
                                    Cancel
                                </button>
                            </div>
                        )}

                        {/* Backup status bar */}
                        {selectedAgentId !== "all" && backupStatus && (
                            <div className="mt-3 pt-3 border-t border-border flex items-center gap-4 text-[10px] text-muted-foreground">
                                {backupStatus.hasBackup ? (
                                    <>
                                        <span>Last backup: {backupStatus.lastBackup ? timeAgo(new Date(backupStatus.lastBackup)) : "\u2014"}</span>
                                        <span>{backupStatus.messageCount ?? 0} messages</span>
                                        {backupStatus.cid && <span className="font-mono">{backupStatus.cid.slice(0, 16)}...</span>}
                                    </>
                                ) : (
                                    <span>No backups yet for this agent</span>
                                )}
                            </div>
                        )}
                    </Card>

                    {/* Search + type filter */}
                    <div className="flex items-center gap-3 mb-4">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                            <Input
                                placeholder="Search memory... (\u2318K)"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                className="pl-9 h-9 text-sm"
                            />
                        </div>
                        <div className="flex gap-1 bg-muted/30 rounded-lg p-0.5">
                            <button
                                onClick={() => setTypeFilter("all")}
                                className={`px-2.5 py-1 text-[10px] rounded-md transition-colors ${typeFilter === "all" ? "bg-purple-500/20 text-purple-400" : "text-muted-foreground hover:text-foreground"
                                    }`}
                            >All</button>
                            {(Object.keys(MEMORY_TYPE_CONFIG) as MemoryType[]).map(t => (
                                <button
                                    key={t}
                                    onClick={() => setTypeFilter(t)}
                                    className={`px-2.5 py-1 text-[10px] rounded-md transition-colors ${typeFilter === t ? "bg-purple-500/20 text-purple-400" : "text-muted-foreground hover:text-foreground"
                                        }`}
                                >{MEMORY_TYPE_CONFIG[t].icon} {MEMORY_TYPE_CONFIG[t].label}</button>
                            ))}
                        </div>
                    </div>

                    {loading ? (
                        <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-purple-500" /></div>
                    ) : filtered.length === 0 ? (
                        <Card className="p-12 bg-card/80 border-border text-center">
                            <Brain className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                            <h3 className="text-sm font-semibold mb-1">
                                {searchQuery ? "No results found" : "No memory entries"}
                            </h3>
                            <p className="text-xs text-muted-foreground">
                                {searchQuery ? "Try a different search term" : "Memory entries are recorded as agents interact"}
                            </p>
                        </Card>
                    ) : (
                        <div className="space-y-1.5">
                            {filtered.map(entry => {
                                const cfg = MEMORY_TYPE_CONFIG[entry.type];
                                const isExpanded = expandedId === entry.id;
                                return (
                                    <Card
                                        key={entry.id}
                                        className="bg-card/80 border-border hover:border-purple-500/20 transition-colors cursor-pointer"
                                        onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                                    >
                                        <div className="p-3">
                                            <div className="flex items-center gap-2.5">
                                                <span className="text-sm">{cfg.icon}</span>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <p className="text-sm font-medium truncate">{entry.title}</p>
                                                        <Badge variant="outline" className={`text-[9px] ${cfg.color}`}>{cfg.label}</Badge>
                                                    </div>
                                                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                                                        <span>{entry.agentName || entry.agentId}</span>
                                                        {entry.sizeBytes && <span>&middot; {fmtFileSize(entry.sizeBytes)}</span>}
                                                        <span>&middot; {timeAgo(entry.updatedAt)}</span>
                                                    </div>
                                                </div>
                                                {entry.tags && entry.tags.length > 0 && (
                                                    <div className="flex gap-1 shrink-0">
                                                        {entry.tags.slice(0, 3).map(tag => (
                                                            <Badge key={tag} variant="outline" className="text-[8px]">{tag}</Badge>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                            {isExpanded && (
                                                <div className="mt-3 pt-3 border-t border-border">
                                                    {entry.filePath && (
                                                        <p className="text-[10px] font-mono text-muted-foreground mb-2 flex items-center gap-1">
                                                            <FileText className="h-2.5 w-2.5" /> {entry.filePath}
                                                        </p>
                                                    )}
                                                    <pre className="text-xs text-foreground bg-muted/20 rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap font-mono">
                                                        {entry.content}
                                                    </pre>
                                                </div>
                                            )}
                                        </div>
                                    </Card>
                                );
                            })}
                        </div>
                    )}
                </>
            ) : (
                <div className="h-[600px]">
                    <FileManager />
                </div>
            )}
        </div>
    );
}
