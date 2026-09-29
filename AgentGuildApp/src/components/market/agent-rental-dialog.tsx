/**
 * Agent Rental Dialog — Configure and activate agent rental.
 * Flow: Select model → Security config → Confirm & activate
 */
"use client";

import { useState } from "react";
import {
    Calendar, Zap, TrendingUp, Shield, Loader2,
    CheckCircle2, AlertCircle, Bot, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { type RentalModel, installMarketplaceAgent } from "@/lib/skills";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface AgentRentalDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    agentName: string;
    agentId: string;
    orgId: string;
    installerAddress: string;
    monthlyPrice?: number;
    usagePrice?: number;
    performanceShare?: number;
    onRented: () => void;
}

type Page = "model" | "security" | "confirm";

const RENTAL_MODELS: { id: RentalModel; label: string; icon: typeof Calendar; desc: string }[] = [
    { id: "monthly", label: "Monthly", icon: Calendar, desc: "Fixed monthly fee, unlimited tasks" },
    { id: "usage", label: "Per Usage", icon: Zap, desc: "Pay per request/task completed" },
    { id: "performance", label: "Performance", icon: TrendingUp, desc: "Revenue/profit share model" },
];

const CHAIN_OPTIONS = [
    { id: 296, label: "Hedera Testnet" },
    { id: 1, label: "Ethereum" },
    { id: 8453, label: "Base" },
    { id: 137, label: "Polygon" },
];

// ═══════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════

export function AgentRentalDialog({
    open,
    onOpenChange,
    agentName,
    agentId,
    orgId,
    installerAddress,
    monthlyPrice,
    usagePrice,
    performanceShare,
    onRented,
}: AgentRentalDialogProps) {
    const [page, setPage] = useState<Page>("model");
    const [selectedModel, setSelectedModel] = useState<RentalModel | null>(null);
    const [spendingCap, setSpendingCap] = useState("1000");
    const [taskLimit, setTaskLimit] = useState("100");
    const [allowedChains, setAllowedChains] = useState<number[]>([296]);
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const toggleChain = (chainId: number) => {
        setAllowedChains(prev =>
            prev.includes(chainId)
                ? prev.filter(c => c !== chainId)
                : [...prev, chainId]
        );
    };

    const handleConfirm = async () => {
        if (!selectedModel) return;
        setLoading(true);
        setError(null);
        try {
            await installMarketplaceAgent(
                `rental-${agentName.toLowerCase().replace(/\s+/g, "-")}`,
                orgId,
                agentId,
                "rental",
                installerAddress,
                undefined,
                selectedModel,
                parseFloat(spendingCap) || undefined,
                parseInt(taskLimit) || undefined,
                allowedChains.length > 0 ? allowedChains : undefined,
            );
            setDone(true);
            onRented();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to start rental");
        } finally {
            setLoading(false);
        }
    };

    const handleClose = () => {
        if (!loading) {
            setPage("model");
            setSelectedModel(null);
            setSpendingCap("1000");
            setTaskLimit("100");
            setAllowedChains([296]);
            setDone(false);
            setError(null);
            onOpenChange(false);
        }
    };

    const getPriceForModel = (model: RentalModel): string => {
        if (model === "monthly" && monthlyPrice) return `$${monthlyPrice}/mo`;
        if (model === "usage" && usagePrice) return `$${usagePrice}/req`;
        if (model === "performance" && performanceShare) return `${performanceShare}% share`;
        return "Free";
    };

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <div className="p-1.5 rounded-lg bg-purple-500/10 border border-purple-500/20">
                            <Bot className="h-4 w-4 text-purple-400" />
                        </div>
                        Rent Agent
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
                    {/* Page indicator */}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className={page === "model" ? "text-purple-400 font-medium" : ""}>1. Model</span>
                        <ChevronRight className="h-3 w-3" />
                        <span className={page === "security" ? "text-purple-400 font-medium" : ""}>2. Security</span>
                        <ChevronRight className="h-3 w-3" />
                        <span className={page === "confirm" ? "text-purple-400 font-medium" : ""}>3. Confirm</span>
                    </div>

                    {/* Page 1: Model selection */}
                    {page === "model" && (
                        <div className="space-y-2">
                            <p className="text-sm text-muted-foreground">
                                Choose a rental model for <span className="text-foreground font-medium">{agentName}</span>
                            </p>
                            {RENTAL_MODELS.map(({ id, label, icon: Icon, desc }) => (
                                <button
                                    key={id}
                                    onClick={() => { setSelectedModel(id); setPage("security"); }}
                                    className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                                        selectedModel === id
                                            ? "border-purple-500/30 bg-purple-500/5"
                                            : "border-border hover:border-purple-500/20 hover:bg-purple-500/5"
                                    }`}
                                >
                                    <div className="w-9 h-9 rounded-lg bg-purple-500/10 flex items-center justify-center shrink-0">
                                        <Icon className="h-4 w-4 text-purple-400" />
                                    </div>
                                    <div className="flex-1">
                                        <div className="text-sm font-medium">{label}</div>
                                        <div className="text-xs text-muted-foreground">{desc}</div>
                                    </div>
                                    <Badge className="text-[10px] bg-purple-500/10 text-purple-400 border-purple-500/20">
                                        {getPriceForModel(id)}
                                    </Badge>
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Page 2: Security config */}
                    {page === "security" && (
                        <div className="space-y-4">
                            <p className="text-sm text-muted-foreground">
                                Configure security limits for this rental.
                            </p>
                            <div className="space-y-3">
                                <div>
                                    <Label className="text-xs">Spending Cap (USD)</Label>
                                    <Input
                                        type="number"
                                        value={spendingCap}
                                        onChange={(e) => setSpendingCap(e.target.value)}
                                        placeholder="1000"
                                        className="mt-1"
                                    />
                                    <p className="text-[10px] text-muted-foreground mt-1">
                                        Maximum total spend before the agent pauses
                                    </p>
                                </div>
                                <div>
                                    <Label className="text-xs">Task Limit (per day)</Label>
                                    <Input
                                        type="number"
                                        value={taskLimit}
                                        onChange={(e) => setTaskLimit(e.target.value)}
                                        placeholder="100"
                                        className="mt-1"
                                    />
                                </div>
                                <div>
                                    <Label className="text-xs">Allowed Chains</Label>
                                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                                        {CHAIN_OPTIONS.map((chain) => (
                                            <button
                                                key={chain.id}
                                                onClick={() => toggleChain(chain.id)}
                                                className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                                                    allowedChains.includes(chain.id)
                                                        ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                                                        : "bg-muted/50 text-muted-foreground border border-transparent hover:border-border"
                                                }`}
                                            >
                                                {chain.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setPage("model")}
                                    className="h-8 text-xs"
                                >
                                    Back
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => setPage("confirm")}
                                    className="flex-1 h-8 text-xs bg-purple-600 hover:bg-purple-700 text-white"
                                >
                                    Continue
                                </Button>
                            </div>
                        </div>
                    )}

                    {/* Page 3: Confirm */}
                    {page === "confirm" && !done && (
                        <div className="space-y-4">
                            <p className="text-sm text-muted-foreground">Review rental configuration</p>

                            <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-2">
                                <div className="flex justify-between text-xs">
                                    <span className="text-muted-foreground">Agent</span>
                                    <span className="font-medium">{agentName}</span>
                                </div>
                                <div className="flex justify-between text-xs">
                                    <span className="text-muted-foreground">Model</span>
                                    <Badge className="text-[10px] bg-purple-500/10 text-purple-400 border-purple-500/20">
                                        {selectedModel ? getPriceForModel(selectedModel) : "—"}
                                    </Badge>
                                </div>
                                <div className="flex justify-between text-xs">
                                    <span className="text-muted-foreground">Spending Cap</span>
                                    <span>${spendingCap}</span>
                                </div>
                                <div className="flex justify-between text-xs">
                                    <span className="text-muted-foreground">Task Limit</span>
                                    <span>{taskLimit}/day</span>
                                </div>
                                <div className="flex justify-between text-xs">
                                    <span className="text-muted-foreground">Chains</span>
                                    <span>{allowedChains.length} allowed</span>
                                </div>
                            </div>

                            {error && (
                                <div className="p-2 rounded-lg border border-red-500/20 bg-red-500/5 flex items-center gap-2 text-xs text-red-400">
                                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                                    {error}
                                </div>
                            )}

                            <div className="flex items-center gap-2">
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setPage("security")}
                                    disabled={loading}
                                    className="h-8 text-xs"
                                >
                                    Back
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={handleConfirm}
                                    disabled={loading}
                                    className="flex-1 h-8 text-xs bg-purple-600 hover:bg-purple-700 text-white gap-1"
                                >
                                    {loading ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                        <Shield className="h-3 w-3" />
                                    )}
                                    Start Rental
                                </Button>
                            </div>
                        </div>
                    )}

                    {/* Done */}
                    {done && (
                        <div className="p-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 space-y-3">
                            <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
                                <CheckCircle2 className="h-4 w-4" />
                                Rental Activated
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {agentName} is now rented with {selectedModel} billing. Security limits are active.
                            </p>
                            <Button
                                size="sm"
                                onClick={handleClose}
                                className="w-full h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                            >
                                Done
                            </Button>
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
