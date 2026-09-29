"use client";

import { useState } from "react";
import Link from "next/link";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/contexts/OrgContext";
import SpotlightCard from "@/components/reactbits/SpotlightCard";
import DecryptedText from "@/components/reactbits/DecryptedText";
import { Bot, Send, Loader2 } from "lucide-react";
import type { DispatchPayload } from "@/components/agent-map/agent-map";
import { Agent } from "@/lib/firestore";
import { getAgentAvatarUrl } from "@/lib/agent-avatar";

interface PromptWidgetProps {
  onDispatch: (payload: DispatchPayload) => Promise<void>;
  agents: Agent[];
}

export function PromptWidget({ onDispatch, agents }: PromptWidgetProps) {
  const { currentOrg } = useOrg();
  const [prompt, setPrompt] = useState("");
  const [isDispatching, setIsDispatching] = useState(false);

  // Find the task coordinator
  const coordinatorSlot = currentOrg?.swarmSlots?.["task-coordinator"];
  const coordinatorAgent = coordinatorSlot?.agentId 
    ? agents.find(a => a.id === coordinatorSlot.agentId)
    : null;

  const handleSend = async () => {
    if (!prompt.trim() || !coordinatorAgent) return;
    setIsDispatching(true);
    try {
      await onDispatch({
        prompt: prompt.trim(),
        priority: "high",
        reward: "", // Optional reward but required by type
        agentIds: [coordinatorAgent.id],
      });
      setPrompt("");
    } catch (err) {
      console.error("Failed to dispatch prompt:", err);
    } finally {
      setIsDispatching(false);
    }
  };

  if (!currentOrg) return null;

  return (
    <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden rounded-xl">
      <CardHeader className="flex flex-row items-center justify-between px-4 pt-4 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Bot className="h-4 w-4 text-amber-500" />
          <DecryptedText text="Prompt Swarm" speed={30} maxIterations={6} animateOn="view" sequential className="font-semibold" encryptedClassName="text-amber-500/40" />
        </CardTitle>
        {coordinatorAgent && (
          <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/20">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="text-xs text-amber-400 font-medium">{coordinatorAgent.name} Ready</span>
          </div>
        )}
      </CardHeader>
      
      <CardContent className="px-4 pb-4">
        {!coordinatorAgent ? (
          <div className="flex flex-col items-center justify-center py-6 text-center space-y-3">
            <div className="h-10 w-10 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
              <Bot className="h-5 w-5 text-amber-500/50" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Task Coordinator Required</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-[250px] mx-auto">
                Assign an agent to the Task Coordinator role in the Swarm tab to dispatch prompts from here.
              </p>
            </div>
            <Button asChild size="sm" variant="outline" className="mt-2 border-amber-500/20 hover:border-amber-500/40">
              <Link href="/swarm">Assign Coordinator</Link>
            </Button>
          </div>
        ) : (
          <div className="flex flex-col h-full gap-3 mt-1">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={`Instruct @${coordinatorAgent.name}...`}
              className="w-full min-h-[90px] rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-amber-500/50 focus:outline-none focus:ring-1 focus:ring-amber-500/20 resize-none transition-all"
            />
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <img 
                  src={coordinatorAgent.avatarUrl || getAgentAvatarUrl(coordinatorAgent.name, coordinatorAgent.type)} 
                  alt={coordinatorAgent.name}
                  className="w-5 h-5 rounded-full"
                />
                Sending to Task Coordinator
              </div>
              <Button 
                size="sm" 
                onClick={handleSend}
                disabled={!prompt.trim() || isDispatching}
                className="bg-amber-500 hover:bg-amber-600 text-black px-4"
              >
                {isDispatching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5 mr-1.5" />
                    Dispatch
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </SpotlightCard>
  );
}
