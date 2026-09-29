/** Agent Comms — Direct communication channel between operators and connected agents. */
"use client";

import { useState, useEffect, useRef } from "react";
import { useOrg } from "@/contexts/OrgContext";
import { motion } from "motion/react";
import SpotlightCard from "@/components/reactbits/SpotlightCard";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    getChannelsByOrg,
    getAgentsByOrg,
    getProjectsByOrg,
    type Channel,
    type Agent,
    type Message,
    type Project,
} from "@/lib/firestore";
import { db } from "@/lib/firebase";
import {
    collection,
    query,
    where,
    orderBy,
    onSnapshot,
} from "firebase/firestore";

// ─── Helpers ─────────────────────────────────────────

function formatTimestamp(ts: unknown): string {
    if (!ts) return "—";
    if (typeof ts === "object" && ts !== null && "toDate" in ts) {
        return (ts as { toDate: () => Date }).toDate().toLocaleString();
    }
    if (typeof ts === "object" && ts !== null && "seconds" in ts) {
        return new Date((ts as { seconds: number }).seconds * 1000).toLocaleString();
    }
    if (ts instanceof Date) return ts.toLocaleString();
    if (typeof ts === "number") return new Date(ts).toLocaleString();
    return String(ts);
}

function relativeTime(ts: unknown): string {
    if (!ts) return "";
    let date: Date;
    if (typeof ts === "object" && ts !== null && "toDate" in ts) {
        date = (ts as { toDate: () => Date }).toDate();
    } else if (typeof ts === "object" && ts !== null && "seconds" in ts) {
        date = new Date((ts as { seconds: number }).seconds * 1000);
    } else {
        date = new Date(ts as string | number);
    }
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
}

// ─── Component ───────────────────────────────────────

export default function AgentCommsPage() {
    const { currentOrg } = useOrg();
    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(true);
    const [channels, setChannels] = useState<Channel[]>([]);
    const [agents, setAgents] = useState<Agent[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);
    const [filterChannel, setFilterChannel] = useState<string>("all");
    const [filterSender, setFilterSender] = useState<string>("all"); // "all" | "agents" | "humans"
    const [searchQuery, setSearchQuery] = useState("");
    const feedRef = useRef<HTMLDivElement>(null);

    // Load channels, agents, projects
    useEffect(() => {
        if (!currentOrg) return;
        Promise.all([
            getChannelsByOrg(currentOrg.id),
            getAgentsByOrg(currentOrg.id),
            getProjectsByOrg(currentOrg.id),
        ]).then(([ch, ag, pr]) => {
            setChannels(ch);
            setAgents(ag);
            setProjects(pr);
        });
    }, [currentOrg]);

    // Subscribe to real-time messages across all org channels
    useEffect(() => {
        if (!currentOrg || channels.length === 0) {
            setMessages([]);
            setLoading(false);
            return;
        }

        setLoading(true);
        const channelIds = channels.map(c => c.id);

        // Firestore 'in' limited to 30, batch if needed
        const unsubs: (() => void)[] = [];
        const allMessages = new Map<string, Message>();

        for (let i = 0; i < channelIds.length; i += 30) {
            const batch = channelIds.slice(i, i + 30);
            const q = query(
                collection(db, "messages"),
                where("channelId", "in", batch),
                orderBy("createdAt", "desc")
            );

            const unsub = onSnapshot(q, (snap) => {
                snap.docs.forEach(d => {
                    allMessages.set(d.id, { id: d.id, ...d.data() } as Message);
                });

                // Sort newest first and update state
                const sorted = Array.from(allMessages.values()).sort((a, b) => {
                    const aT = a.createdAt && typeof a.createdAt === "object" && "seconds" in a.createdAt
                        ? (a.createdAt as { seconds: number }).seconds : 0;
                    const bT = b.createdAt && typeof b.createdAt === "object" && "seconds" in b.createdAt
                        ? (b.createdAt as { seconds: number }).seconds : 0;
                    return bT - aT;
                });

                setMessages(sorted);
                setLoading(false);
            });
            unsubs.push(unsub);
        }

        return () => unsubs.forEach(u => u());
    }, [currentOrg, channels]);

    // Lookup helpers
    const channelMap = new Map(channels.map(c => [c.id, c]));
    const agentMap = new Map(agents.map(a => [a.id, a]));
    const projectMap = new Map(projects.map(p => [p.id, p]));

    const getChannelName = (channelId: string) => channelMap.get(channelId)?.name || channelId;
    const getProjectForChannel = (channelId: string) => {
        const ch = channelMap.get(channelId);
        if (!ch?.projectId) return null;
        return projectMap.get(ch.projectId) || null;
    };

    // Filter messages
    const filteredMessages = messages.filter(msg => {
        if (filterChannel !== "all" && msg.channelId !== filterChannel) return false;
        if (filterSender === "agents" && msg.senderType !== "agent") return false;
        if (filterSender === "humans" && msg.senderType !== "human") return false;
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            return (
                msg.content?.toLowerCase().includes(q) ||
                msg.senderName?.toLowerCase().includes(q) ||
                getChannelName(msg.channelId).toLowerCase().includes(q)
            );
        }
        return true;
    });

    // Stats
    const agentMsgCount = messages.filter(m => m.senderType === "agent").length;
    const humanMsgCount = messages.filter(m => m.senderType === "human").length;
    const uniqueAgents = new Set(messages.filter(m => m.senderType === "agent").map(m => m.senderId));

    if (!currentOrg) {
        return (
            <div className="space-y-6">
                <p className="text-muted-foreground mt-1">No organization selected</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Filters */}
            <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.1 }}
                className="flex flex-col sm:flex-row gap-3"
            >
                <Input
                    placeholder="Search messages..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="max-w-xs"
                />
                <Select value={filterChannel} onValueChange={setFilterChannel}>
                    <SelectTrigger className="w-[200px]">
                        <SelectValue placeholder="All Channels" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All Channels</SelectItem>
                        {channels.map(ch => (
                            <SelectItem key={ch.id} value={ch.id}>#{ch.name}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Select value={filterSender} onValueChange={setFilterSender}>
                    <SelectTrigger className="w-[160px]">
                        <SelectValue placeholder="All Senders" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All Senders</SelectItem>
                        <SelectItem value="agents">🤖 Agents Only</SelectItem>
                        <SelectItem value="humans">👤 Humans Only</SelectItem>
                    </SelectContent>
                </Select>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setFilterChannel("all"); setFilterSender("all"); setSearchQuery(""); }}
                    className="w-fit"
                >
                    Clear
                </Button>
            </motion.div>

            {/* Stats bar */}
            <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.15 }}
                className="flex gap-4 flex-wrap"
            >
                {[
                    { icon: "📨", label: "Total", value: messages.length },
                    { icon: "🤖", label: "Agent Messages", value: agentMsgCount },
                    { icon: "👤", label: "Human Messages", value: humanMsgCount },
                    { icon: "🟢", label: "Active Agents", value: uniqueAgents.size },
                    { icon: "📡", label: "Channels", value: channels.length },
                ].map(stat => (
                    <div
                        key={stat.label}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium bg-card"
                    >
                        <span>{stat.icon}</span>
                        <span className="font-semibold">{stat.value}</span>
                        <span className="text-muted-foreground">{stat.label}</span>
                    </div>
                ))}
            </motion.div>

            {/* Live Feed */}
            {loading ? (
                <div className="text-center py-12 text-muted-foreground">
                    <div className="inline-flex items-center gap-2">
                        <span className="h-4 w-4 border-2 border-amber-500/40 border-t-amber-500 rounded-full animate-spin" />
                        <span>Loading communications...</span>
                    </div>
                </div>
            ) : filteredMessages.length === 0 ? (
                <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.5 }}
                    className="text-center py-16 text-muted-foreground"
                >
                    <div className="text-6xl mb-4">📡</div>
                    <p className="text-lg font-medium">No communications yet</p>
                    <p className="text-sm mt-2 max-w-md mx-auto">
                        Messages will appear here in real-time as agents and team members
                        communicate in project channels.
                    </p>
                </motion.div>
            ) : (
                <motion.div
                    ref={feedRef}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.4, delay: 0.2 }}
                    className="space-y-2 max-h-[calc(100vh-360px)] overflow-y-auto pr-1"
                >
                    {filteredMessages.map((msg, index) => {
                        const isAgent = msg.senderType === "agent";
                        const project = getProjectForChannel(msg.channelId);

                        return (
                            <motion.div
                                key={msg.id}
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.3, delay: Math.min(index * 0.02, 0.3) }}
                            >
                                <SpotlightCard className="p-0" spotlightColor="rgba(255, 191, 0, 0.05)">
                                    <div className="flex items-start gap-3 p-4">
                                        {/* Sender icon */}
                                        <span className="text-lg mt-0.5 shrink-0">
                                            {isAgent ? "🤖" : "👤"}
                                        </span>

                                        {/* Content */}
                                        <div className="flex-1 min-w-0">
                                            {/* Sender + channel row */}
                                            <div className="flex items-center gap-2 flex-wrap mb-1">
                                                <span className={`text-xs font-semibold ${isAgent
                                                    ? "text-amber-600 dark:text-amber-400"
                                                    : "text-blue-600 dark:text-blue-400"
                                                    }`}>
                                                    {msg.senderName}
                                                </span>

                                                <span className="text-muted-foreground text-xs">in</span>

                                                <Badge variant="outline" className="text-[10px]">
                                                    #{getChannelName(msg.channelId)}
                                                </Badge>

                                                {project && (
                                                    <span className="text-[10px] text-muted-foreground">
                                                        📁 {project.name}
                                                    </span>
                                                )}

                                                {isAgent && (
                                                    <Badge className="text-[10px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">
                                                        verified ✓
                                                    </Badge>
                                                )}
                                            </div>

                                            {/* Message text */}
                                            <p className="text-sm mt-1 leading-relaxed whitespace-pre-wrap break-words">
                                                {msg.content}
                                            </p>
                                        </div>

                                        {/* Timestamp */}
                                        <div className="text-right shrink-0">
                                            <span
                                                className="text-xs text-muted-foreground whitespace-nowrap"
                                                title={formatTimestamp(msg.createdAt)}
                                            >
                                                {relativeTime(msg.createdAt)}
                                            </span>
                                        </div>
                                    </div>
                                </SpotlightCard>
                            </motion.div>
                        );
                    })}
                </motion.div>
            )}
        </div>
    );
}
