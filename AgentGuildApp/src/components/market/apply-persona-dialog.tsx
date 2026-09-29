"use client";

import { useState, useEffect } from "react";
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Bot, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import type { AgentPackage } from "@/lib/skills";
import { installMarketplaceAgent } from "@/lib/skills";
import type { Agent } from "@/lib/firestore";
import { getAgentsByOrg } from "@/lib/firestore";
import { updateAgentSOUL, toYAML } from "@/lib/soul";
import { identityToSOUL } from "@/lib/personas";

interface ApplyPersonaDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    persona: AgentPackage | null;
    orgId: string;
    installerAddress: string;
    onApplied: () => void;
}

export function ApplyPersonaDialog({
    open, onOpenChange, persona, orgId, installerAddress, onApplied,
}: ApplyPersonaDialogProps) {
    const [agents, setAgents] = useState<Agent[]>([]);
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadingAgents, setLoadingAgents] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Load org agents when dialog opens
    useEffect(() => {
        if (open && orgId) {
            setLoadingAgents(true);
            setDone(false);
            setError(null);
            setSelectedAgentId(null);
            getAgentsByOrg(orgId)
                .then(setAgents)
                .catch(() => setAgents([]))
                .finally(() => setLoadingAgents(false));
        }
    }, [open, orgId]);

    const handleApply = async () => {
        if (!persona || !selectedAgentId) return;
        setLoading(true);
        setError(null);

        try {
            // 1. Resolve SOUL config
            const soul = persona.soulTemplate || identityToSOUL(persona.identity, persona.name);

            // 2. Generate YAML
            const yamlContent = toYAML(soul);

            // 3. Save to agent's soulConfig (validates, checks org ownership, logs activity)
            await updateAgentSOUL(orgId, selectedAgentId, yamlContent);

            // 4. Track acquisition in marketplace
            await installMarketplaceAgent(
                persona.id,
                orgId,
                selectedAgentId,
                "config",
                installerAddress,
            );

            setDone(true);
            onApplied();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to apply persona");
        } finally {
            setLoading(false);
        }
    };

    if (!persona) return null;

    const selectedAgent = agents.find((a) => a.id === selectedAgentId);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <span className="text-2xl">{persona.icon}</span>
                        Apply {persona.name}
                    </DialogTitle>
                    <DialogDescription>
                        Select an agent to apply this persona&apos;s SOUL configuration to.
                    </DialogDescription>
                </DialogHeader>

                {/* Success state */}
                {done ? (
                    <div className="text-center py-6 space-y-3">
                        <CheckCircle2 className="h-12 w-12 text-emerald-400 mx-auto" />
                        <p className="text-sm font-semibold">Persona Applied!</p>
                        <p className="text-xs text-muted-foreground">
                            {persona.name}&apos;s SOUL config has been applied to{" "}
                            <span className="text-foreground font-medium">{selectedAgent?.name}</span>.
                            View the agent&apos;s SOUL page to see the full config.
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onOpenChange(false)}
                            className="mt-2"
                        >
                            Done
                        </Button>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {/* Error */}
                        {error && (
                            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
                                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                                {error}
                            </div>
                        )}

                        {/* Agent list */}
                        {loadingAgents ? (
                            <div className="flex items-center justify-center py-8 gap-2 text-sm text-muted-foreground">
                                <Loader2 className="h-4 w-4 animate-spin" /> Loading agents...
                            </div>
                        ) : agents.length === 0 ? (
                            <div className="text-center py-8">
                                <Bot className="h-10 w-10 mx-auto text-muted-foreground/30 mb-2" />
                                <p className="text-sm text-muted-foreground">No agents in your organization.</p>
                                <p className="text-xs text-muted-foreground mt-1">Create an agent first, then come back to apply a persona.</p>
                            </div>
                        ) : (
                            <div className="space-y-1.5 max-h-64 overflow-y-auto">
                                {agents.map((agent) => (
                                    <button
                                        key={agent.id}
                                        onClick={() => setSelectedAgentId(agent.id)}
                                        className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-all ${
                                            selectedAgentId === agent.id
                                                ? "border-purple-500/50 bg-purple-500/10"
                                                : "border-border hover:border-purple-500/20 hover:bg-muted/30"
                                        }`}
                                    >
                                        <div className="relative shrink-0">
                                            {agent.avatarUrl ? (
                                                <img
                                                    src={agent.avatarUrl}
                                                    alt={agent.name}
                                                    className="w-8 h-8 rounded-lg object-cover border border-border"
                                                />
                                            ) : (
                                                <div className="w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                                                    <Bot className="h-4 w-4 text-purple-400" />
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-medium truncate">{agent.name}</span>
                                                <Badge variant="outline" className="text-[10px]">{agent.type}</Badge>
                                            </div>
                                            <p className="text-[10px] text-muted-foreground">
                                                {agent.soulConfig ? "Has SOUL config (will be replaced)" : "No SOUL config"}
                                            </p>
                                        </div>
                                        {selectedAgentId === agent.id && (
                                            <CheckCircle2 className="h-4 w-4 text-purple-400 shrink-0" />
                                        )}
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* Warning if agent already has SOUL */}
                        {selectedAgent?.soulConfig && (
                            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
                                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                                This agent already has a SOUL configuration. Applying {persona.name} will replace it.
                            </div>
                        )}

                        {/* Apply button */}
                        <Button
                            className="w-full bg-purple-600 hover:bg-purple-700 text-white gap-2"
                            onClick={handleApply}
                            disabled={!selectedAgentId || loading}
                        >
                            {loading ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" /> Applying...
                                </>
                            ) : (
                                <>
                                    <Bot className="h-4 w-4" /> Apply {persona.name} to {selectedAgent?.name || "Agent"}
                                </>
                            )}
                        </Button>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
