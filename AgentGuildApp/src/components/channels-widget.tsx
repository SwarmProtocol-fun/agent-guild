"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import SpotlightCard from "@/components/reactbits/SpotlightCard";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import DecryptedText from "@/components/reactbits/DecryptedText";
import ShinyText from "@/components/reactbits/ShinyText";
import { MessageSquare, Hash, Bot, FolderKanban } from "lucide-react";
import { useOrg } from "@/contexts/OrgContext";
import {
  getChannelsByOrg,
  getLastMessageByChannel,
  ensureAgentGroupChat,
  type Channel,
  type Message,
  type Agent,
} from "@/lib/firestore";
import { ChannelPromptModal } from "@/components/channel-prompt-modal";

interface ChannelPreview {
  channel: Channel;
  lastMessage: Message | null;
  activityMs: number;
}

function toMs(ts: unknown): number {
  if (!ts) return 0;
  if (typeof ts === "object" && ts !== null && "seconds" in (ts as any)) return (ts as any).seconds * 1000;
  if (ts instanceof Date) return ts.getTime();
  return new Date(ts as any).getTime();
}

function formatRelativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function channelIcon(channel: Channel) {
  if (channel.projectId) return <FolderKanban className="w-3.5 h-3.5 text-blue-400" />;
  if (channel.agentId) return <Bot className="w-3.5 h-3.5 text-emerald-400" />;
  return <Hash className="w-3.5 h-3.5 text-amber-400" />;
}

async function loadChannelPreviews(orgId: string): Promise<ChannelPreview[]> {
  await ensureAgentGroupChat(orgId);
  const all = await getChannelsByOrg(orgId);

  // Dedupe: project channels by projectId, DM channels by agentId, named channels by name
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

  const previews = await Promise.all(
    deduped.map(async (channel): Promise<ChannelPreview> => {
      let lastMessage: Message | null = null;
      try {
        lastMessage = await getLastMessageByChannel(channel.id);
      } catch {
        // non-critical — show channel without a preview
      }
      const activityMs = lastMessage ? toMs(lastMessage.createdAt) : toMs(channel.createdAt);
      return { channel, lastMessage, activityMs };
    })
  );

  return previews.sort((a, b) => b.activityMs - a.activityMs);
}

interface ChannelsWidgetProps {
  agents?: Agent[];
}

export function ChannelsWidget({ agents = [] }: ChannelsWidgetProps) {
  const { currentOrg } = useOrg();
  const [promptChannel, setPromptChannel] = useState<Channel | null>(null);

  const { data: previews = [], isLoading: loading } = useQuery<ChannelPreview[]>({
    queryKey: ["dashboard-channels", currentOrg?.id],
    queryFn: () => loadChannelPreviews(currentOrg!.id),
    enabled: !!currentOrg,
    // One read per channel per refetch — a minute is plenty for previews.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const visible = previews.slice(0, 6);

  return (
    <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden rounded-xl" spotlightColor="rgba(255, 191, 0, 0.06)">
      <CardHeader className="flex flex-row items-center gap-2 px-4 pt-3 pb-1.5">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <MessageSquare className="w-4 h-4 text-amber-500" />
          <DecryptedText text="Channels" speed={30} maxIterations={6} animateOn="view" sequential className="text-sm font-semibold" encryptedClassName="text-sm font-semibold text-amber-500/40" />
        </CardTitle>
        <Link href="/chat" className="text-xs">
          <ShinyText text="Open Chat →" speed={3} color="#6d4fa0" shineColor="#7221FA" className="text-xs" />
        </Link>
      </CardHeader>
      <CardContent className="space-y-0.5 px-4 pb-3">
        {loading && visible.length === 0 ? (
          <div className="text-center py-4 text-muted-foreground text-sm">Loading channels...</div>
        ) : visible.length === 0 ? (
          <div className="text-center py-4 text-muted-foreground">
            <p>No channels yet</p>
            <Link href="/chat" className="text-amber-600 dark:text-amber-400 hover:underline text-sm">
              Start a conversation →
            </Link>
          </div>
        ) : (
          visible.map(({ channel, lastMessage, activityMs }, index) => (
            <button
              key={channel.id}
              type="button"
              onClick={() => setPromptChannel(channel)}
              className="flex items-center gap-2.5 py-2 w-full text-left border-b border-border last:border-0 animate-in fade-in slide-in-from-bottom-2 hover:bg-amber-500/5 -mx-2 px-2 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              style={{ animationDelay: `${index * 80}ms`, animationFillMode: "both" }}
            >
              <span className="shrink-0">{channelIcon(channel)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium truncate">{channel.name}</p>
                  <span className="text-[10px] text-muted-foreground shrink-0">{formatRelativeTime(activityMs)}</span>
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {lastMessage
                    ? `${lastMessage.senderName}: ${lastMessage.content}`
                    : "No messages yet"}
                </p>
              </div>
            </button>
          ))
        )}
      </CardContent>
      <ChannelPromptModal
        open={!!promptChannel}
        onOpenChange={(open) => { if (!open) setPromptChannel(null); }}
        channel={promptChannel}
        agents={agents}
      />
    </SpotlightCard>
  );
}
