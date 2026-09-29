/**
 * Agent Install Dialog — Multi-step flow for installing marketplace agents.
 * Steps: Generate AIN → Deploy Config → Register Agent → Attach Wallet → Activate → Ready
 */
"use client";

import { useState, useCallback } from "react";
import {
    Fingerprint, FileCode, Radio, Wallet, Activity,
    CheckCircle2, Loader2, AlertCircle, ExternalLink,
    Bot, Shield, TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { generateASN } from "@/lib/credit-scoring";
import { createAgent, type Agent } from "@/lib/firestore";
import {
    type AgentDistribution,
    installMarketplaceAgent,
    updateAgentInstallOnChain,
} from "@/lib/skills";
import { useSwarmWrite } from "@/hooks/useSwarmWrite";
import { db } from "@/lib/firebase";
import { doc, updateDoc } from "firebase/firestore";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface AgentInstallDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    agentName: string;
    agentType: string;
    orgId: string;
    installerAddress: string;
    distribution: AgentDistribution;
    onInstalled: () => void;
}

type StepStatus = "pending" | "active" | "done" | "error";

interface InstallStep {
    id: string;
    label: string;
    icon: typeof Fingerprint;
    status: StepStatus;
    detail?: string;
}

const INITIAL_STEPS: InstallStep[] = [
    { id: "ain", label: "Generate AIN", icon: Fingerprint, status: "pending" },
    { id: "deploy", label: "Deploy Config", icon: FileCode, status: "pending" },
    { id: "register", label: "Register Agent", icon: Radio, status: "pending" },
    { id: "wallet", label: "Attach Wallet", icon: Wallet, status: "pending" },
    { id: "monitor", label: "Activate Monitoring", icon: Activity, status: "pending" },
    { id: "ready", label: "Ready", icon: CheckCircle2, status: "pending" },
];

// ═══════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════

export function AgentInstallDialog({
    open,
    onOpenChange,
    agentName,
    agentType,
    orgId,
    installerAddress,
    distribution,
    onInstalled,
}: AgentInstallDialogProps) {
    const [steps, setSteps] = useState<InstallStep[]>(INITIAL_STEPS);
    const [running, setRunning] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [resultAin, setResultAin] = useState<string | null>(null);
    const [resultAgentId, setResultAgentId] = useState<string | null>(null);
    const [resultTxHash, setResultTxHash] = useState<string | null>(null);
    const { registerAgent: registerOnChain } = useSwarmWrite();

    const updateStep = (id: string, status: StepStatus, detail?: string) => {
        setSteps(prev => prev.map(s => s.id === id ? { ...s, status, ...(detail ? { detail } : {}) } : s));
    };

    const runInstall = useCallback(async () => {
        setRunning(true);
        setError(null);
        setSteps(INITIAL_STEPS);

        try {
            // Step 1: Generate AIN
            updateStep("ain", "active");
            const ain = generateASN();
            setResultAin(ain);
            updateStep("ain", "done", ain);

            // Step 2: Deploy Config — create agent in Firestore
            updateStep("deploy", "active");
            const agentId = await createAgent({
                name: agentName,
                type: agentType as Agent["type"],
                orgId,
                description: `${agentType} agent installed from marketplace`,
                capabilities: [],
                status: "online",
                projectIds: [],
                asn: ain,
                creditScore: 680,
                trustScore: 50,
                onChainRegistered: false,
                hierarchyLevel: 0,
                canDelegate: true,
                createdAt: new Date(),
            });
            setResultAgentId(agentId);
            updateStep("deploy", "done", `Agent ID: ${agentId.slice(0, 8)}...`);

            // Step 3: Register install record
            updateStep("register", "active");
            const installId = await installMarketplaceAgent(
                `marketplace-${agentName.toLowerCase().replace(/\s+/g, "-")}`,
                orgId,
                agentId,
                distribution,
                installerAddress,
                ain,
            );
            updateStep("register", "done", `Install ID: ${installId.slice(0, 8)}...`);

            // Step 4: On-chain registration (optional — skip if no wallet)
            updateStep("wallet", "active");
            let txHash: string | null = null;
            try {
                if (typeof window !== "undefined" && window.ethereum) {
                    txHash = await registerOnChain(
                        `${agentName} | ${ain}`,
                        agentType,
                        ain,
                        0,
                    );
                    if (txHash) {
                        setResultTxHash(txHash);
                        await updateDoc(doc(db, "agents", agentId), {
                            onChainTxHash: txHash,
                            onChainRegistered: true,
                        });
                        await updateAgentInstallOnChain(installId, txHash, ain);
                        updateStep("wallet", "done", `Tx: ${txHash.slice(0, 10)}...`);
                    } else {
                        updateStep("wallet", "done", "Skipped (no tx)");
                    }
                } else {
                    updateStep("wallet", "done", "Skipped (no wallet)");
                }
            } catch {
                updateStep("wallet", "done", "Skipped (wallet error)");
            }

            // Step 5: Activate monitoring
            updateStep("monitor", "active");
            await updateDoc(doc(db, "agents", agentId), { status: "online" });
            updateStep("monitor", "done", "Monitoring active");

            // Step 6: Ready
            updateStep("ready", "done", "Agent is live");
            setDone(true);
            onInstalled();
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Installation failed";
            setError(msg);
            setSteps(prev => {
                const activeIdx = prev.findIndex(s => s.status === "active");
                if (activeIdx >= 0) {
                    const updated = [...prev];
                    updated[activeIdx] = { ...updated[activeIdx], status: "error", detail: msg };
                    return updated;
                }
                return prev;
            });
        } finally {
            setRunning(false);
        }
    }, [agentName, agentType, orgId, installerAddress, distribution, registerOnChain, onInstalled]);

    const handleClose = () => {
        if (!running) {
            setSteps(INITIAL_STEPS);
            setDone(false);
            setError(null);
            setResultAin(null);
            setResultAgentId(null);
            setResultTxHash(null);
            onOpenChange(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <div className="p-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20">
                            <Bot className="h-4 w-4 text-cyan-400" />
                        </div>
                        Install Agent
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
                    {/* Agent info */}
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 border border-border">
                        <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                            <Bot className="h-4 w-4 text-cyan-400" />
                        </div>
                        <div>
                            <div className="font-semibold text-sm">{agentName}</div>
                            <div className="text-xs text-muted-foreground">{agentType} agent &middot; {distribution}</div>
                        </div>
                    </div>

                    {/* Steps */}
                    <div className="space-y-1">
                        {steps.map((step, i) => {
                            const Icon = step.icon;
                            return (
                                <div
                                    key={step.id}
                                    className={`flex items-center gap-3 p-2.5 rounded-lg transition-all ${
                                        step.status === "active" ? "bg-cyan-500/5 border border-cyan-500/20" :
                                        step.status === "done" ? "bg-emerald-500/5" :
                                        step.status === "error" ? "bg-red-500/5 border border-red-500/20" :
                                        "opacity-50"
                                    }`}
                                >
                                    <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                                        step.status === "done" ? "bg-emerald-500/20 text-emerald-400" :
                                        step.status === "active" ? "bg-cyan-500/20 text-cyan-400" :
                                        step.status === "error" ? "bg-red-500/20 text-red-400" :
                                        "bg-muted/50 text-muted-foreground"
                                    }`}>
                                        {step.status === "active" ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : step.status === "done" ? (
                                            <CheckCircle2 className="h-3.5 w-3.5" />
                                        ) : step.status === "error" ? (
                                            <AlertCircle className="h-3.5 w-3.5" />
                                        ) : (
                                            <Icon className="h-3.5 w-3.5" />
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-medium">{step.label}</div>
                                        {step.detail && (
                                            <div className={`text-[10px] truncate ${
                                                step.status === "error" ? "text-red-400" : "text-muted-foreground"
                                            }`}>
                                                {step.detail}
                                            </div>
                                        )}
                                    </div>
                                    <span className="text-[10px] text-muted-foreground shrink-0">
                                        {i + 1}/{steps.length}
                                    </span>
                                </div>
                            );
                        })}
                    </div>

                    {/* Completion card */}
                    {done && (
                        <div className="p-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 space-y-3">
                            <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
                                <CheckCircle2 className="h-4 w-4" />
                                Agent Installed Successfully
                            </div>
                            {resultAin && (
                                <div className="flex items-center gap-2">
                                    <Badge className="text-xs bg-cyan-500/10 text-cyan-400 border-cyan-500/20 font-mono">
                                        <Fingerprint className="h-3 w-3 mr-1" />
                                        {resultAin}
                                    </Badge>
                                </div>
                            )}
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                <span className="flex items-center gap-1">
                                    <TrendingUp className="h-3 w-3 text-amber-400" />Credit: 680
                                </span>
                                <span className="flex items-center gap-1">
                                    <Shield className="h-3 w-3 text-blue-400" />Trust: 50
                                </span>
                            </div>
                            <div className="flex items-center gap-2">
                                <a href="/agents" className="flex-1">
                                    <Button size="sm" className="w-full h-8 text-xs bg-cyan-600 hover:bg-cyan-700 text-white gap-1">
                                        <Bot className="h-3 w-3" /> View Agent
                                    </Button>
                                </a>
                                {resultTxHash && (
                                    <a
                                        href={`https://hashscan.io/testnet/transaction/${resultTxHash}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        <Button size="sm" variant="outline" className="h-8 text-xs gap-1">
                                            <ExternalLink className="h-3 w-3" /> HashScan
                                        </Button>
                                    </a>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Error retry */}
                    {error && !running && (
                        <div className="p-3 rounded-lg border border-red-500/20 bg-red-500/5">
                            <div className="flex items-center gap-2 text-red-400 text-sm mb-2">
                                <AlertCircle className="h-4 w-4" />
                                Installation Failed
                            </div>
                            <p className="text-xs text-muted-foreground mb-3">{error}</p>
                            <Button
                                size="sm"
                                onClick={runInstall}
                                className="h-7 text-xs bg-red-600 hover:bg-red-700 text-white gap-1"
                            >
                                Retry
                            </Button>
                        </div>
                    )}

                    {/* Start button */}
                    {!done && !running && !error && (
                        <Button
                            onClick={runInstall}
                            className="w-full bg-cyan-600 hover:bg-cyan-700 text-white gap-2"
                        >
                            <Bot className="h-4 w-4" />
                            Start Installation
                        </Button>
                    )}

                    {/* Running state */}
                    {running && (
                        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-2">
                            <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
                            Installing...
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
