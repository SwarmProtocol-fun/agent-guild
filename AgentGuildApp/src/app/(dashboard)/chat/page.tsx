/** Chat — Real-time messaging channels between operators and agents. */
"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Flag, Paperclip, Mic, Square, X, Download, GripVertical } from "lucide-react";
import {
  uploadFiles,
  uploadVoiceRecording,
  validateFiles,
  getFileCategory,
  formatFileSize,
} from "@/lib/storage";
import type { Attachment } from "@/lib/firestore";
import { useWalletAccount } from "@/lib/wallet";
import { useAuthAddress } from "@/hooks/useAuthAddress";
import { useOrg } from "@/contexts/OrgContext";
import {
  getChannelsByOrg,
  onMessagesByChannel,
  sendMessage,
  createChannel,
  updateChannel,
  deleteChannel,
  deleteMessagesByChannel,
  getAgentsByOrg,
  ensureAgentGroupChat,
  ensureAgentPrivateChannel,
  createReport,
  type Channel,
  type Message,
  type Agent,
} from "@/lib/firestore";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** Sort channels: most-recently-active first (fallback to createdAt) */
function sortByLatest(channels: Channel[], lastMsgMap: Map<string, number>): Channel[] {
  return [...channels].sort((a, b) => {
    const tA = lastMsgMap.get(a.id) ?? toMs(a.createdAt);
    const tB = lastMsgMap.get(b.id) ?? toMs(b.createdAt);
    return tB - tA;
  });
}

function toMs(ts: unknown): number {
  if (!ts) return 0;
  if (typeof ts === "object" && ts !== null && "seconds" in ts) return (ts as any).seconds * 1000;
  if (ts instanceof Date) return ts.getTime();
  return new Date(ts as any).getTime();
}

function formatTimestamp(ts: unknown): string {
  if (!ts) return "";
  const date = new Date(toMs(ts));
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isYesterday) return "Yesterday " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dateLabel(ts: unknown): string {
  if (!ts) return "";
  const date = new Date(toMs(ts));
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

/** Render message text with @mention highlights */
function renderMessageContent(content: string, agentNames: Set<string>): React.ReactNode {
  if (agentNames.size === 0) return content;
  // Build regex that matches @AgentName for all known agents (sorted longest-first to avoid partial matches)
  const sorted = [...agentNames].sort((a, b) => b.length - a.length);
  const escaped = sorted.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(@(?:${escaped.join("|")}))(?=\\s|$|[.,!?;:])`, "g");
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIdx) parts.push(content.slice(lastIdx, match.index));
    parts.push(
      <span key={match.index} className="px-1 rounded bg-amber-500/15 text-amber-400 font-medium">
        {match[1]}
      </span>
    );
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < content.length) parts.push(content.slice(lastIdx));
  return parts.length > 0 ? parts : content;
}

/* ------------------------------------------------------------------ */
/*  Channel Order Persistence                                         */
/* ------------------------------------------------------------------ */

const CHANNEL_ORDER_KEY = "agent-guild-channel-order";

function loadChannelOrder(): Record<string, string[]> | null {
  if (typeof window === "undefined") return null;
  try {
    const val = localStorage.getItem(CHANNEL_ORDER_KEY);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

function saveChannelOrder(order: Record<string, string[]>) {
  try { localStorage.setItem(CHANNEL_ORDER_KEY, JSON.stringify(order)); } catch {}
}

/** Apply saved order to channels, appending any new channels at the end */
function applyOrder(channels: Channel[], savedIds: string[] | undefined): Channel[] {
  if (!savedIds || savedIds.length === 0) return channels;
  const lookup = new Map(channels.map(c => [c.id, c]));
  const ordered: Channel[] = [];
  for (const id of savedIds) {
    const ch = lookup.get(id);
    if (ch) { ordered.push(ch); lookup.delete(id); }
  }
  for (const ch of lookup.values()) ordered.push(ch);
  return ordered;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export default function ChatPage() {
  const account = useWalletAccount();
  const authAddress = useAuthAddress();
  const address = account?.address || authAddress;
  const { currentOrg } = useOrg();

  // Channels / conversations
  const [channels, setChannels] = useState<Channel[]>([]);
  const [dmChannels, setDmChannels] = useState<Channel[]>([]);
  const [projectChannels, setProjectChannels] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [lastMsgTs, setLastMsgTs] = useState<Map<string, number>>(new Map());

  // Channel drag-and-drop
  const [dragCh, setDragCh] = useState<{ id: string; section: string } | null>(null);
  const [dropChTarget, setDropChTarget] = useState<{ id: string; section: string } | null>(null);

  // Messages
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageInput, setMessageInput] = useState("");

  // Agents (for online indicator)
  const [agents, setAgents] = useState<Agent[]>([]);

  // UI state
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Channel | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [reportingMsg, setReportingMsg] = useState<Message | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [submittingReport, setSubmittingReport] = useState(false);

  // File attachments
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Voice recording
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // @mention autocomplete
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionRef = useRef<HTMLDivElement>(null);

  /* ── Load channels ── */
  const loadChannels = useCallback(async () => {
    if (!currentOrg) return;
    try {
      setLoading(true);
      setError(null);
      // Ensure the Agent Hub group chat exists (also deduplicates)
      await ensureAgentGroupChat(currentOrg.id);
      const all = await getChannelsByOrg(currentOrg.id);

      // Deduplicate: project channels by projectId, DM channels by agentId, chat channels by name
      const seenProjects = new Set<string>();
      const seenAgents = new Set<string>();
      const seenNames = new Set<string>();
      const deduped = all.filter(c => {
        if (c.projectId) {
          if (seenProjects.has(c.projectId)) return false;
          seenProjects.add(c.projectId);
          return true;
        }
        if (c.agentId) {
          if (seenAgents.has(c.agentId)) return false;
          seenAgents.add(c.agentId);
          return true;
        }
        if (seenNames.has(c.name)) return false;
        seenNames.add(c.name);
        return true;
      });

      const chatChs = deduped.filter(c => !c.projectId && !c.agentId);
      const dmChs = deduped.filter(c => !!c.agentId);
      const projChs = deduped.filter(c => !!c.projectId);
      setChannels(chatChs);
      setDmChannels(dmChs);
      setProjectChannels(projChs);

      // Auto-select first if nothing selected
      const allVisible = [...chatChs, ...dmChs, ...projChs];
      if (!activeChannel && allVisible.length > 0) {
        const sorted = sortByLatest(allVisible, lastMsgTs);
        setActiveChannel(sorted[0]);
      }
    } catch (err) {
      console.error("Failed to load channels:", err);
      setError(err instanceof Error ? err.message : "Failed to load channels");
    } finally {
      setLoading(false);
    }
  }, [currentOrg, activeChannel, lastMsgTs]);

  // Load agents for online indicators
  useEffect(() => {
    if (!currentOrg) return;
    getAgentsByOrg(currentOrg.id).then(setAgents).catch(console.error);
  }, [currentOrg]);

  // Ensure DM channels exist for all agents, then reload channel list
  useEffect(() => {
    if (!currentOrg || agents.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        await Promise.all(
          agents.map(a => ensureAgentPrivateChannel(a.id, currentOrg.id, a.name))
        );
        if (!cancelled) {
          // Reload to pick up DM channels
          const all = await getChannelsByOrg(currentOrg.id);
          const seenAgents = new Set<string>();
          const dmChs = all.filter(c => {
            if (!c.agentId) return false;
            if (seenAgents.has(c.agentId)) return false;
            seenAgents.add(c.agentId);
            return true;
          });
          setDmChannels(dmChs);
        }
      } catch (err) {
        console.error("Failed to ensure agent DM channels:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [currentOrg, agents]);

  // Load channels on org change
  useEffect(() => {
    loadChannels();
  }, [currentOrg]);

  /* ── Subscribe to messages ── */
  useEffect(() => {
    if (!activeChannel) {
      setMessages([]);
      return;
    }

    const unsubscribe = onMessagesByChannel(activeChannel.id, (msgs) => {
      setMessages(msgs);
      // Track latest message timestamp for sorting
      if (msgs.length > 0) {
        const latest = msgs[msgs.length - 1];
        setLastMsgTs(prev => {
          const next = new Map(prev);
          next.set(activeChannel.id, toMs(latest.createdAt));
          return next;
        });
      }
    });

    return unsubscribe;
  }, [activeChannel]);

  /* ── Auto-scroll ── */
  useEffect(() => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  }, [messages]);

  /* ── Focus input on channel switch ── */
  useEffect(() => {
    if (activeChannel) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [activeChannel]);

  /* ── Actions ── */

  const handleNewConversation = async () => {
    if (!currentOrg) return;
    try {
      const now = new Date();
      const name = `Chat — ${now.toLocaleDateString([], { month: "short", day: "numeric" })} ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      const id = await createChannel({
        orgId: currentOrg.id,
        name,
        createdAt: now,
      });
      const newCh: Channel = { id, orgId: currentOrg.id, name, createdAt: now };
      setChannels(prev => [newCh, ...prev]);
      setActiveChannel(newCh);
      setMessages([]);
    } catch (err) {
      console.error("Failed to create conversation:", err);
      setError(err instanceof Error ? err.message : "Failed to create conversation");
    }
  };

  const handleDelete = async (channel: Channel) => {
    try {
      await deleteMessagesByChannel(channel.id);
      await deleteChannel(channel.id);
      setChannels(prev => prev.filter(c => c.id !== channel.id));
      if (activeChannel?.id === channel.id) {
        const remaining = channels.filter(c => c.id !== channel.id);
        setActiveChannel(remaining.length > 0 ? remaining[0] : null);
      }
      setDeleteTarget(null);
    } catch (err) {
      console.error("Failed to delete conversation:", err);
      setError(err instanceof Error ? err.message : "Failed to delete conversation");
    }
  };

  const handleRename = async (channelId: string) => {
    if (!renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      await updateChannel(channelId, { name: renameValue.trim() } as any);
      setChannels(prev => prev.map(c => c.id === channelId ? { ...c, name: renameValue.trim() } : c));
      if (activeChannel?.id === channelId) {
        setActiveChannel(prev => prev ? { ...prev, name: renameValue.trim() } : prev);
      }
      setRenamingId(null);
    } catch (err) {
      console.error("Failed to rename:", err);
    }
  };

  // ─── File selection ───
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const combined = [...pendingFiles, ...files];
    const err = validateFiles(combined);
    if (err) { setError(err); return; }
    setPendingFiles(combined);
    e.target.value = "";
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // ─── Voice recording ───
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        setRecordingDuration(0);

        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        if (blob.size === 0 || !activeChannel || !address || !currentOrg) return;

        try {
          setUploading(true);
          const attachment = await uploadVoiceRecording(blob, currentOrg.id, activeChannel.id);
          await sendMessage({
            channelId: activeChannel.id,
            senderId: address,
            senderAddress: address,
            senderName: address.slice(0, 6) + "..." + address.slice(-4),
            senderType: "human",
            content: "",
            orgId: currentOrg.id,
            createdAt: new Date(),
            attachments: [attachment],
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to send voice message");
        } finally {
          setUploading(false);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingDuration(0);
      recordingTimerRef.current = setInterval(() => setRecordingDuration((p) => p + 1), 1000);
    } catch {
      setError("Microphone access denied");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  // ─── @mention helpers ───

  /** Filtered agents matching the current @query */
  const mentionResults = mentionQuery !== null
    ? agents.filter(a => a.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6)
    : [];

  /** Detect @mention trigger on input change */
  const handleInputChange = useCallback((value: string) => {
    setMessageInput(value);

    const el = inputRef.current;
    if (!el) { setMentionQuery(null); return; }

    const cursor = el.selectionStart ?? value.length;
    const textBefore = value.slice(0, cursor);

    // Find the last @ that starts a mention (preceded by start-of-string or whitespace)
    const match = textBefore.match(/(?:^|\s)@(\w*)$/);
    if (match) {
      setMentionQuery(match[1]);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  }, []);

  /** Insert a selected @mention into the input */
  const insertMention = useCallback((agentName: string) => {
    const el = inputRef.current;
    if (!el) return;

    const cursor = el.selectionStart ?? messageInput.length;
    const textBefore = messageInput.slice(0, cursor);
    const textAfter = messageInput.slice(cursor);

    // Replace the @query with @AgentName
    const replaced = textBefore.replace(/(?:^|\s)@(\w*)$/, (m) => {
      const prefix = m.startsWith(" ") ? " " : "";
      return `${prefix}@${agentName} `;
    });

    setMessageInput(replaced + textAfter);
    setMentionQuery(null);

    // Re-focus and set cursor after inserted mention
    setTimeout(() => {
      el.focus();
      const pos = replaced.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  }, [messageInput]);

  /** Handle keyboard nav within mention popup */
  const handleMentionKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (mentionQuery === null || mentionResults.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMentionIndex(i => (i + 1) % mentionResults.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMentionIndex(i => (i - 1 + mentionResults.length) % mentionResults.length);
    } else if (e.key === "Tab" || e.key === "Enter") {
      if (mentionResults[mentionIndex]) {
        e.preventDefault();
        insertMention(mentionResults[mentionIndex].name);
      }
    } else if (e.key === "Escape") {
      setMentionQuery(null);
    }
  }, [mentionQuery, mentionResults, mentionIndex, insertMention]);

  // ─── Send message (text + optional attachments) ───
  const handleSend = useCallback(async () => {
    if (!activeChannel || !address) return;
    if (!messageInput.trim() && pendingFiles.length === 0) return;

    try {
      setSending(true);
      setUploading(pendingFiles.length > 0);

      let attachments: Attachment[] | undefined;
      if (pendingFiles.length > 0 && currentOrg) {
        attachments = await uploadFiles(pendingFiles, currentOrg.id, activeChannel.id);
      }

      await sendMessage({
        channelId: activeChannel.id,
        senderId: address,
        senderAddress: address,
        senderName: address.slice(0, 6) + "..." + address.slice(-4),
        senderType: "human",
        content: messageInput.trim(),
        orgId: currentOrg?.id,
        createdAt: new Date(),
        ...(attachments ? { attachments } : {}),
      });

      setMessageInput("");
      setPendingFiles([]);
      setMentionQuery(null);
    } catch (err) {
      console.error("Failed to send:", err);
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
      setUploading(false);
    }
  }, [activeChannel, address, messageInput, pendingFiles, currentOrg]);

  const handleSubmitReport = async () => {
    if (!reportingMsg || !currentOrg || !address || !reportReason.trim()) return;
    setSubmittingReport(true);
    try {
      await createReport({
        orgId: currentOrg.id,
        reportedUserId: reportingMsg.senderId,
        messageId: reportingMsg.id,
        channelId: activeChannel?.id,
        reason: reportReason.trim(),
        reportedBy: address,
      });
      setReportingMsg(null);
      setReportReason("");
    } catch (err) {
      console.error("Failed to submit report:", err);
      setError("Failed to submit report");
    } finally {
      setSubmittingReport(false);
    }
  };

  /* ── Channel drag-and-drop handlers ── */

  const onChDragStart = (section: string, chId: string) => (e: React.DragEvent) => {
    setDragCh({ id: chId, section });
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", `channel:${section}:${chId}`);
  };

  const onChDragOver = (section: string, chId: string) => (e: React.DragEvent) => {
    if (!dragCh || dragCh.section !== section) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropChTarget({ id: chId, section });
  };

  const onChDrop = (section: string, targetId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    setDropChTarget(null);
    if (!dragCh || dragCh.section !== section || dragCh.id === targetId) {
      setDragCh(null);
      return;
    }

    const setState = section === "chat" ? setChannels : section === "dm" ? setDmChannels : setProjectChannels;
    setState(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(c => c.id === dragCh.id);
      const toIdx = arr.findIndex(c => c.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);

      // Persist order
      const saved = loadChannelOrder() || {};
      saved[section] = arr.map(c => c.id);
      saveChannelOrder(saved);
      return arr;
    });
    setDragCh(null);
  };

  const onChDragEnd = () => {
    setDragCh(null);
    setDropChTarget(null);
  };

  /* ── Guards ── */

  if (!currentOrg) {
    return (
      <div className="space-y-6">
        <p className="text-muted-foreground mt-1">No organization selected</p>
      </div>
    );
  }

  if (!address && !authAddress) {
    return (
      <div className="space-y-6">
        <p className="text-muted-foreground mt-1">Connect your wallet to start chatting</p>
      </div>
    );
  }

  const onlineAgents = agents.filter(a => a.status === "online");
  const agentNameSet = new Set(agents.map(a => a.name));
  const savedOrder = loadChannelOrder();
  const sortedChannels = savedOrder?.chat ? applyOrder(channels, savedOrder.chat) : sortByLatest(channels, lastMsgTs);
  const sortedDmChannels = savedOrder?.dm ? applyOrder(dmChannels, savedOrder.dm) : sortByLatest(dmChannels, lastMsgTs);
  const sortedProjectChannels = savedOrder?.project ? applyOrder(projectChannels, savedOrder.project) : sortByLatest(projectChannels, lastMsgTs);

  /* ── Render ── */

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)]">
      {error && (
        <div className="p-2 rounded-md bg-red-950/40 border border-red-500/30 text-sm text-red-400 mx-4 mt-2">
          {error}
          <button className="ml-2 underline text-xs" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden rounded-lg border border-border bg-card">
        {/* ═══════════════ Sidebar ═══════════════ */}
        <div
          className={`${sidebarOpen ? "w-72" : "w-0"
            } transition-all duration-200 border-r border-border flex flex-col bg-muted/50 overflow-hidden shrink-0`}
        >
          {/* Sidebar header */}
          <div className="p-3 border-b border-border flex items-center justify-between shrink-0">
            <h2 className="font-semibold text-sm text-foreground">Conversations</h2>
            <Button
              onClick={handleNewConversation}
              size="sm"
              className="h-7 px-2.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium"
            >
              + New
            </Button>
          </div>

          {/* Channel list */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading…</div>
            ) : (
              <>
                {sortedChannels.length === 0 && sortedDmChannels.length === 0 && sortedProjectChannels.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    <div className="text-3xl mb-2">💬</div>
                    <p>No conversations yet</p>
                    <Button onClick={handleNewConversation} size="sm" className="mt-2 text-xs">
                      Start your first chat
                    </Button>
                  </div>
                ) : (
                  <>
                    {/* ── Chat Channels ── */}
                    {sortedChannels.length > 0 && (
                      <div className="py-1">
                        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-3 pt-2 pb-1">
                          Chats
                        </p>
                        {sortedChannels.map((ch) => (
                          <div
                            key={ch.id}
                            draggable
                            onDragStart={onChDragStart("chat", ch.id)}
                            onDragOver={onChDragOver("chat", ch.id)}
                            onDrop={onChDrop("chat", ch.id)}
                            onDragEnd={onChDragEnd}
                            className={`group relative flex items-center gap-2 px-3 py-2.5 text-sm cursor-pointer transition-colors ${
                              dragCh?.id === ch.id ? "opacity-30" : ""
                            } ${
                              dropChTarget?.id === ch.id && dropChTarget.section === "chat" ? "border-t-2 border-amber-500/50" : ""
                            } ${activeChannel?.id === ch.id
                              ? "bg-amber-500/10 border-r-2 border-amber-500 text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground hover:bg-card hover:text-foreground"
                            }`}
                            onClick={() => {
                              if (renamingId !== ch.id) setActiveChannel(ch);
                            }}
                          >
                            <GripVertical className="h-3 w-3 text-muted-foreground/0 group-hover:text-muted-foreground/40 transition-colors shrink-0 cursor-grab active:cursor-grabbing" />
                            <span className="text-base shrink-0">{ch.name === "Agent Hub" ? "🤖" : "💬"}</span>

                            {renamingId === ch.id ? (
                              <input
                                autoFocus
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onBlur={() => handleRename(ch.id)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleRename(ch.id);
                                  if (e.key === "Escape") setRenamingId(null);
                                }}
                                className="flex-1 bg-transparent border-b border-amber-500 outline-none text-sm py-0.5 min-w-0"
                                onClick={(e) => e.stopPropagation()}
                              />
                            ) : (
                              <span
                                className="flex-1 truncate"
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  setRenamingId(ch.id);
                                  setRenameValue(ch.name);
                                }}
                                title="Double-click to rename"
                              >
                                {ch.name}
                              </span>
                            )}

                            {renamingId !== ch.id && (
                              <button
                                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-red-400 text-xs shrink-0 p-1"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteTarget(ch);
                                }}
                                title="Delete conversation"
                              >
                                🗑️
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* ── Direct Messages ── */}
                    {sortedDmChannels.length > 0 && (
                      <div className="py-1">
                        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-3 pt-2 pb-1">
                          Direct Messages
                        </p>
                        {sortedDmChannels.map((ch) => {
                          const agent = agents.find(a => a.id === ch.agentId);
                          return (
                            <div
                              key={ch.id}
                              draggable
                              onDragStart={onChDragStart("dm", ch.id)}
                              onDragOver={onChDragOver("dm", ch.id)}
                              onDrop={onChDrop("dm", ch.id)}
                              onDragEnd={onChDragEnd}
                              className={`group relative flex items-center gap-2 px-3 py-2.5 text-sm cursor-pointer transition-colors ${
                                dragCh?.id === ch.id ? "opacity-30" : ""
                              } ${
                                dropChTarget?.id === ch.id && dropChTarget.section === "dm" ? "border-t-2 border-amber-500/50" : ""
                              } ${activeChannel?.id === ch.id
                                ? "bg-amber-500/10 border-r-2 border-amber-500 text-amber-600 dark:text-amber-400"
                                : "text-muted-foreground hover:bg-card hover:text-foreground"
                              }`}
                              onClick={() => setActiveChannel(ch)}
                            >
                              <GripVertical className="h-3 w-3 text-muted-foreground/0 group-hover:text-muted-foreground/40 transition-colors shrink-0 cursor-grab active:cursor-grabbing" />
                              <div className="relative shrink-0">
                                <span className="text-base">🤖</span>
                                {agent && (
                                  <span className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-card ${
                                    agent.status === "online" ? "bg-emerald-400" : agent.status === "busy" ? "bg-amber-400" : "bg-gray-500"
                                  }`} />
                                )}
                              </div>
                              <span className="flex-1 truncate">{ch.name}</span>
                              {agent && (
                                <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${
                                  agent.status === "online"
                                    ? "bg-emerald-500/10 text-emerald-400"
                                    : agent.status === "busy"
                                    ? "bg-amber-500/10 text-amber-400"
                                    : "bg-muted text-muted-foreground"
                                }`}>
                                  {agent.status}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* ── Project Channels ── */}
                    {sortedProjectChannels.length > 0 && (
                      <div className="py-1">
                        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-3 pt-2 pb-1">
                          Project Channels
                        </p>
                        {sortedProjectChannels.map((ch) => (
                          <div
                            key={ch.id}
                            draggable
                            onDragStart={onChDragStart("project", ch.id)}
                            onDragOver={onChDragOver("project", ch.id)}
                            onDrop={onChDrop("project", ch.id)}
                            onDragEnd={onChDragEnd}
                            className={`group relative flex items-center gap-2 px-3 py-2.5 text-sm cursor-pointer transition-colors ${
                              dragCh?.id === ch.id ? "opacity-30" : ""
                            } ${
                              dropChTarget?.id === ch.id && dropChTarget.section === "project" ? "border-t-2 border-amber-500/50" : ""
                            } ${activeChannel?.id === ch.id
                              ? "bg-amber-500/10 border-r-2 border-amber-500 text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground hover:bg-card hover:text-foreground"
                            }`}
                            onClick={() => setActiveChannel(ch)}
                          >
                            <GripVertical className="h-3 w-3 text-muted-foreground/0 group-hover:text-muted-foreground/40 transition-colors shrink-0 cursor-grab active:cursor-grabbing" />
                            <span className="text-base shrink-0">#</span>
                            <span className="flex-1 truncate">{ch.name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {/* ═══════════════ Main Chat Area ═══════════════ */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Chat header */}
          <div className="border-b border-border px-4 py-2.5 bg-card flex items-center gap-3 shrink-0">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="text-muted-foreground hover:text-foreground transition-colors text-lg"
              title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            >
              {sidebarOpen ? "◀" : "☰"}
            </button>

            {activeChannel ? (
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <h2 className="font-semibold text-foreground truncate">
                  {activeChannel.name}
                </h2>
                <Badge variant="secondary" className="text-xs shrink-0">
                  {messages.length} {messages.length === 1 ? "message" : "messages"}
                </Badge>
                {onlineAgents.length > 0 && (
                  <div className="flex items-center gap-1.5 ml-auto shrink-0">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.6)]" />
                    <span className="text-xs text-emerald-500">
                      {onlineAgents.length} agent{onlineAgents.length > 1 ? "s" : ""} online
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <h2 className="font-semibold text-muted-foreground">Select a conversation</h2>
            )}
          </div>

          {/* Messages */}
          {activeChannel ? (
            <>
              <div className="flex-1 overflow-y-auto px-4 py-4">
                {messages.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    <div className="text-center">
                      <div className="text-5xl mb-4">✨</div>
                      <p className="text-lg font-medium mb-1">New conversation</p>
                      <p className="text-sm text-muted-foreground">Send a message to get started</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1 max-w-3xl mx-auto">
                    {messages.map((msg, idx) => {
                      const prev = idx > 0 ? messages[idx - 1] : null;
                      const showSender = !prev || prev.senderId !== msg.senderId;
                      const isAgent = msg.senderType === "agent";

                      // Date separator
                      const prevDate = prev ? dateLabel(prev.createdAt) : null;
                      const currDate = dateLabel(msg.createdAt);
                      const showDateSep = currDate !== prevDate;

                      return (
                        <div key={msg.id}>
                          {showDateSep && (
                            <div className="flex items-center gap-3 my-4">
                              <div className="flex-1 h-px bg-border" />
                              <span className="text-[11px] text-muted-foreground font-medium">{currDate}</span>
                              <div className="flex-1 h-px bg-border" />
                            </div>
                          )}

                          <div className={`flex gap-3 ${showSender ? "mt-4" : "mt-0.5"}`}>
                            {/* Avatar */}
                            <div className="w-8 shrink-0">
                              {showSender && (
                                <div
                                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${isAgent
                                    ? "bg-gradient-to-br from-amber-500 to-orange-600 text-white"
                                    : "bg-gradient-to-br from-indigo-500 to-purple-600 text-white"
                                    }`}
                                >
                                  {isAgent ? "🤖" : msg.senderName.charAt(0).toUpperCase()}
                                </div>
                              )}
                            </div>

                            {/* Content */}
                            <div className="flex-1 min-w-0">
                              {showSender && (
                                <div className="flex items-baseline gap-2 mb-0.5">
                                  <span className={`text-sm font-semibold ${isAgent ? "text-amber-500" : "text-foreground"}`}>
                                    {msg.senderName}
                                  </span>
                                  {isAgent && (
                                    <Badge variant="outline" className="text-[9px] py-0 px-1 border-amber-500/30 text-amber-500">
                                      AI
                                    </Badge>
                                  )}
                                  <span className="text-[11px] text-muted-foreground">
                                    {formatTimestamp(msg.createdAt)}
                                  </span>
                                </div>
                              )}
                              <div className="relative group/msg flex items-start gap-2">
                                <div className="flex-1 min-w-0">
                                  {msg.content && (
                                    <p className="text-sm text-foreground/90 break-words whitespace-pre-wrap leading-relaxed">
                                      {renderMessageContent(msg.content, agentNameSet)}
                                    </p>
                                  )}
                                  {msg.attachments && msg.attachments.length > 0 && (
                                    <div className="flex flex-col gap-1.5 mt-1">
                                      {msg.attachments.map((att, ai) => {
                                        const cat = getFileCategory(att.type);
                                        if (cat === "image") {
                                          return (
                                            <a key={ai} href={att.url} target="_blank" rel="noopener noreferrer" className="block">
                                              <img src={att.url} alt={att.name} className="max-w-xs max-h-60 rounded-lg border border-border object-cover hover:opacity-90 transition-opacity" loading="lazy" />
                                            </a>
                                          );
                                        }
                                        if (cat === "video") {
                                          return <video key={ai} src={att.url} controls className="max-w-sm rounded-lg border border-border" preload="metadata" />;
                                        }
                                        if (cat === "audio") {
                                          return (
                                            <div key={ai} className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 border border-border max-w-xs">
                                              <audio src={att.url} controls className="h-8 flex-1" preload="metadata" />
                                              <span className="text-[10px] text-muted-foreground shrink-0">
                                                {att.name.startsWith("voice_") ? "Voice message" : att.name}
                                              </span>
                                            </div>
                                          );
                                        }
                                        return (
                                          <a key={ai} href={att.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 border border-border max-w-xs hover:bg-muted transition-colors">
                                            <Download className="w-4 h-4 text-muted-foreground shrink-0" />
                                            <div className="flex-1 min-w-0">
                                              <p className="text-sm text-foreground truncate">{att.name}</p>
                                              <p className="text-[10px] text-muted-foreground">{formatFileSize(att.size)}</p>
                                            </div>
                                          </a>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                                {/* Report Button */}
                                {msg.senderId !== address && (
                                  <button
                                    onClick={() => setReportingMsg(msg)}
                                    className="opacity-0 group-hover/msg:opacity-100 transition-opacity text-muted-foreground hover:text-red-400 p-1 rounded hover:bg-muted mt-0.5"
                                    title="Report abusive message"
                                  >
                                    <Flag className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <div ref={messagesEndRef} />
                  </div>
                )}
              </div>

              {/* @mention autocomplete popup — rendered outside scroll area */}
              {mentionQuery !== null && mentionResults.length > 0 && (
                <div className="shrink-0 px-4">
                  <div className="max-w-3xl mx-auto">
                    <div
                      ref={mentionRef}
                      className="w-64 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg mb-1"
                    >
                      {mentionResults.map((agent, i) => (
                        <button
                          key={agent.id}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                            i === mentionIndex ? "bg-amber-500/10 text-foreground" : "text-muted-foreground hover:bg-muted"
                          }`}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            insertMention(agent.name);
                          }}
                          onMouseEnter={() => setMentionIndex(i)}
                        >
                          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${
                            agent.status === "online" ? "bg-emerald-500/20 text-emerald-400" : "bg-muted text-muted-foreground"
                          }`}>
                            🤖
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="font-medium text-foreground truncate block">@{agent.name}</span>
                          </div>
                          <span className={`w-2 h-2 rounded-full shrink-0 ${
                            agent.status === "online" ? "bg-emerald-400" : agent.status === "busy" ? "bg-amber-400" : "bg-gray-400"
                          }`} />
                          <Badge variant="outline" className="text-[9px] shrink-0">{agent.type}</Badge>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Input */}
              <div className="border-t border-border p-4 shrink-0">
                <div className="max-w-3xl mx-auto">
                  {/* Pending files preview */}
                  {pendingFiles.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {pendingFiles.map((file, i) => (
                        <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted border border-border text-xs">
                          <span className="truncate max-w-[120px]">{file.name}</span>
                          <span className="text-muted-foreground">({formatFileSize(file.size)})</span>
                          <button onClick={() => removePendingFile(i)} className="text-muted-foreground hover:text-red-400">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Voice recording indicator */}
                  {isRecording && (
                    <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-md bg-red-950/20 border border-red-500/30 text-sm text-red-400">
                      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                      Recording... {recordingDuration}s
                      <button onClick={stopRecording} className="ml-auto p-1 hover:bg-red-500/20 rounded">
                        <Square className="w-4 h-4" />
                      </button>
                    </div>
                  )}

                  {/* Main input row */}
                  <div className="flex gap-2 items-end">
                    {/* Hidden file input */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={handleFileSelect}
                    />

                    {/* Attach button */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={sending || uploading || isRecording}
                      title="Attach files"
                    >
                      <Paperclip className="w-4 h-4" />
                    </Button>

                    {/* Voice button */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={`shrink-0 ${isRecording ? "text-red-500" : "text-muted-foreground hover:text-foreground"}`}
                      onClick={isRecording ? stopRecording : startRecording}
                      disabled={sending || uploading}
                      title={isRecording ? "Stop recording" : "Record voice message"}
                    >
                      {isRecording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                    </Button>

                    {/* Text input */}
                    <Input
                      ref={inputRef}
                      value={messageInput}
                      onChange={(e) => handleInputChange(e.target.value)}
                      placeholder={`Message ${activeChannel.name}… (type @ to mention agents)`}
                      className="flex-1 bg-muted/50 border-border focus-visible:border-amber-500/50"
                      onKeyDown={(e) => {
                        // Let mention popup handle arrow/tab/enter/esc first
                        if (mentionQuery !== null && mentionResults.length > 0) {
                          if (["ArrowDown", "ArrowUp", "Tab", "Escape"].includes(e.key)) {
                            handleMentionKeyDown(e);
                            return;
                          }
                          if (e.key === "Enter") {
                            handleMentionKeyDown(e);
                            return;
                          }
                        }
                        if (e.key === "Enter" && !e.shiftKey && (messageInput.trim() || pendingFiles.length > 0)) {
                          e.preventDefault();
                          handleSend();
                        }
                      }}
                      disabled={sending || isRecording}
                    />

                    {/* Send button */}
                    <Button
                      onClick={handleSend}
                      disabled={sending || uploading || isRecording || (!messageInput.trim() && pendingFiles.length === 0)}
                      className="bg-amber-600 hover:bg-amber-700 text-white px-6"
                    >
                      {uploading ? "Uploading..." : sending ? "…" : "Send"}
                    </Button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <div className="text-6xl mb-4">💬</div>
                <p className="text-lg font-medium mb-2">Welcome to Chat</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Create a new conversation to get started
                </p>
                <Button onClick={handleNewConversation} className="bg-amber-600 hover:bg-amber-700 text-white">
                  + New Conversation
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ═══════════════ Delete Confirmation Modal ═══════════════ */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl">
            <h3 className="text-lg font-semibold mb-2">Delete Conversation</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Are you sure you want to delete <strong>&ldquo;{deleteTarget.name}&rdquo;</strong>?
              All messages will be permanently removed.
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-red-600 hover:bg-red-700 text-white"
                onClick={() => handleDelete(deleteTarget)}
              >
                🗑️ Delete
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════ Report Abuse Modal ═══════════════ */}
      {reportingMsg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl">
            <h3 className="text-lg font-semibold mb-2">Report Abusive Message</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Please provide a reason for reporting this message from <strong>{reportingMsg.senderName}</strong>.
              Our moderation team will review it.
            </p>
            <textarea
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              className="w-full h-24 max-h-48 rounded bg-muted/50 border border-border p-2 text-sm text-foreground mb-4 focus:outline-none focus:border-amber-500/50"
              placeholder="Reason for report..."
            />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => { setReportingMsg(null); setReportReason(""); }} disabled={submittingReport}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-red-600 hover:bg-red-700 text-white"
                onClick={handleSubmitReport}
                disabled={submittingReport || !reportReason.trim()}
              >
                {submittingReport ? "Submitting..." : "Submit Report"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}