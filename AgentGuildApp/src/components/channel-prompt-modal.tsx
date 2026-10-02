"use client";

import { useState } from "react";
import { Dialog, DialogHeader, DialogTitle, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/contexts/OrgContext";
import { useWalletAccount } from "@/lib/wallet";
import { useSession } from "@/contexts/SessionContext";
import { Send, Loader2, Hash } from "lucide-react";
import { sendMessage, type Channel, type Agent } from "@/lib/firestore";
import { getAgentAvatarUrl } from "@/lib/agent-avatar";

interface ChannelPromptModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: Channel | null;
  agents: Agent[];
}

export function ChannelPromptModal({ open, onOpenChange, channel, agents }: ChannelPromptModalProps) {
  const { currentOrg } = useOrg();
  const account = useWalletAccount();
  const { address: sessionAddress } = useSession();
  const userAddress = account?.address || sessionAddress || "";

  const [prompt, setPrompt] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId]
    );
  };

  const reset = () => {
    setPrompt("");
    setSelectedAgentIds([]);
  };

  const handleClose = () => {
    if (sending) return;
    reset();
    onOpenChange(false);
  };

  const handleSend = async () => {
    if (!channel || !currentOrg || !prompt.trim()) return;
    setSending(true);
    try {
      const mentionedAgents = agents.filter((a) => selectedAgentIds.includes(a.id));
      const mentionPrefix = mentionedAgents.length > 0
        ? mentionedAgents.map((a) => `@${a.name}`).join(" ") + " "
        : "";

      await sendMessage({
        channelId: channel.id,
        senderId: userAddress || "unknown",
        senderAddress: userAddress || undefined,
        senderName: userAddress ? `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}` : "Dashboard",
        senderType: "human",
        content: mentionPrefix + prompt.trim(),
        orgId: currentOrg.id,
        createdAt: new Date(),
      });

      reset();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to send prompt to channel:", err);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open && !!channel} onOpenChange={handleClose}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Hash className="h-4 w-4 text-amber-500" />
          {channel?.name || "Channel"}
        </DialogTitle>
      </DialogHeader>
      <DialogContent>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Prompt the agents in this channel..."
          autoFocus
          className="w-full min-h-[110px] rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-amber-500/50 focus:outline-none focus:ring-1 focus:ring-amber-500/20 resize-none transition-all"
        />

        {agents.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">Tag agents (optional)</p>
            <div className="flex flex-wrap gap-1.5">
              {agents.map((agent) => {
                const selected = selectedAgentIds.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => toggleAgent(agent.id)}
                    className={`flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full border text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                      selected
                        ? "border-amber-500/50 bg-amber-500/10 text-amber-400"
                        : "border-border text-muted-foreground hover:border-amber-500/30 hover:text-foreground"
                    }`}
                  >
                    <img
                      src={agent.avatarUrl || getAgentAvatarUrl(agent.name, agent.type)}
                      alt=""
                      className="w-4 h-4 rounded-full"
                    />
                    {agent.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </DialogContent>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={handleClose} disabled={sending}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleSend}
          disabled={!prompt.trim() || sending}
          className="bg-amber-500 hover:bg-amber-600 text-black px-4"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <Send className="h-3.5 w-3.5 mr-1.5" />
              Send
            </>
          )}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
