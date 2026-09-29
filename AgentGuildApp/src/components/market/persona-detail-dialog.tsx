"use client";

import { useState, useEffect } from "react";
import {
    Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Star, Download, DollarSign, User, Bot, Shield, Zap,
    Brain, MessageSquare, ChevronDown, ChevronRight, Wrench,
} from "lucide-react";
import type { AgentPackage, AgentRating } from "@/lib/skills";
import { getAgentRatings } from "@/lib/skills";
import type { SOULConfig } from "@/lib/soul";
import { identityToSOUL } from "@/lib/personas";

interface PersonaDetailDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    persona: AgentPackage | null;
    onApply: (persona: AgentPackage) => void;
}

export function PersonaDetailDialog({ open, onOpenChange, persona, onApply }: PersonaDetailDialogProps) {
    const [ratings, setRatings] = useState<AgentRating[]>([]);
    const [showTraits, setShowTraits] = useState(false);
    const [showEthics, setShowEthics] = useState(false);
    const [showWorkflows, setShowWorkflows] = useState(false);

    useEffect(() => {
        if (persona && open) {
            getAgentRatings(persona.id).then(setRatings).catch(() => setRatings([]));
        }
    }, [persona, open]);

    if (!persona) return null;

    const soul: SOULConfig = persona.soulTemplate || identityToSOUL(persona.identity, persona.name);
    const price = persona.pricing.configPurchase;
    const isFree = !price || price === 0;
    const currency = persona.pricing.currency || "USD";
    const currencySymbol = currency === "HBAR" ? "ℏ" : "$";
    const allSkills = [...(persona.requiredSkills || []), ...(persona.requiredMods || [])];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-3">
                        <div className="text-4xl w-14 h-14 flex items-center justify-center rounded-xl bg-gradient-to-br from-purple-500/10 to-cyan-500/10">
                            {persona.icon}
                        </div>
                        <div className="flex-1">
                            <div className="flex items-center gap-2">
                                <span className="text-xl font-bold">{persona.name}</span>
                                <Badge variant="outline" className="text-[10px]">v{persona.version}</Badge>
                                {isFree ? (
                                    <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">Free</Badge>
                                ) : (
                                    <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-xs">
                                        {currencySymbol}{price}
                                    </Badge>
                                )}
                            </div>
                            <p className="text-sm text-purple-400 font-normal">{persona.identity.agentType}</p>
                        </div>
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-5 mt-2">
                    {/* Stats bar */}
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                            <Download className="h-3 w-3" /> {persona.installCount} installs
                        </span>
                        {persona.avgRating > 0 && (
                            <span className="flex items-center gap-1">
                                <Star className="h-3 w-3 text-amber-400 fill-amber-400" />
                                {persona.avgRating.toFixed(1)} ({persona.ratingCount} reviews)
                            </span>
                        )}
                        <span className="flex items-center gap-1">
                            <User className="h-3 w-3" /> {persona.author}
                        </span>
                    </div>

                    {/* Description */}
                    <p className="text-sm text-muted-foreground leading-relaxed">
                        {persona.longDescription || persona.description}
                    </p>

                    {/* Personality Profile */}
                    <section className="space-y-3">
                        <h3 className="text-sm font-semibold flex items-center gap-2">
                            <Brain className="h-4 w-4 text-purple-400" /> Personality Profile
                        </h3>
                        <div className="grid grid-cols-2 gap-2">
                            <Card className="p-3 bg-muted/20 border-border">
                                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Communication</p>
                                <p className="text-sm font-medium capitalize">{soul.personality.communicationStyle}</p>
                            </Card>
                            <Card className="p-3 bg-muted/20 border-border">
                                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Decision Making</p>
                                <p className="text-sm font-medium capitalize">{soul.behavior.decisionMaking}</p>
                            </Card>
                            <Card className="p-3 bg-muted/20 border-border">
                                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Risk Tolerance</p>
                                <p className="text-sm font-medium capitalize">{soul.behavior.riskTolerance}</p>
                            </Card>
                            <Card className="p-3 bg-muted/20 border-border">
                                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Humor</p>
                                <p className="text-sm font-medium capitalize">{soul.personality.humor}</p>
                            </Card>
                        </div>
                    </section>

                    {/* Greeting Preview */}
                    <section className="space-y-2">
                        <h3 className="text-sm font-semibold flex items-center gap-2">
                            <MessageSquare className="h-4 w-4 text-cyan-400" /> Greeting Preview
                        </h3>
                        <Card className="p-3 bg-purple-500/5 border-purple-500/20">
                            <p className="text-sm italic text-purple-300">
                                &ldquo;{soul.interactions.greetingStyle}&rdquo;
                            </p>
                        </Card>
                    </section>

                    {/* Traits (expandable) */}
                    <section>
                        <button
                            onClick={() => setShowTraits(!showTraits)}
                            className="flex items-center gap-2 text-sm font-semibold w-full text-left hover:text-purple-400 transition-colors"
                        >
                            {showTraits ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            <Shield className="h-4 w-4 text-purple-400" /> Traits & Rules
                        </button>
                        {showTraits && (
                            <div className="mt-2 space-y-2 pl-6">
                                <div>
                                    <p className="text-[10px] text-muted-foreground uppercase mb-1">Personality Traits</p>
                                    <div className="flex flex-wrap gap-1">
                                        {soul.personality.traits.map((trait) => (
                                            <Badge key={trait} variant="outline" className="text-[10px] border-purple-500/20 text-purple-400">
                                                {trait}
                                            </Badge>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <p className="text-[10px] text-muted-foreground uppercase mb-1">Principles</p>
                                    <ul className="text-xs text-muted-foreground space-y-0.5">
                                        {soul.ethics.principles.map((p) => (
                                            <li key={p} className="flex items-start gap-1.5">
                                                <span className="text-purple-400 mt-0.5">-</span> {p}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                                <div>
                                    <p className="text-[10px] text-muted-foreground uppercase mb-1">Boundaries</p>
                                    <ul className="text-xs text-muted-foreground space-y-0.5">
                                        {soul.ethics.boundaries.map((b) => (
                                            <li key={b} className="flex items-start gap-1.5">
                                                <span className="text-red-400 mt-0.5">-</span> {b}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </div>
                        )}
                    </section>

                    {/* Ethics (expandable) */}
                    <section>
                        <button
                            onClick={() => setShowEthics(!showEthics)}
                            className="flex items-center gap-2 text-sm font-semibold w-full text-left hover:text-purple-400 transition-colors"
                        >
                            {showEthics ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            <Zap className="h-4 w-4 text-cyan-400" /> Capabilities
                        </button>
                        {showEthics && (
                            <div className="mt-2 space-y-2 pl-6">
                                <div>
                                    <p className="text-[10px] text-muted-foreground uppercase mb-1">Skills</p>
                                    <div className="flex flex-wrap gap-1">
                                        {(soul.capabilities.skills || []).map((skill) => (
                                            <Badge key={skill} variant="outline" className="text-[10px] border-cyan-500/20 text-cyan-400">
                                                {skill}
                                            </Badge>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <p className="text-[10px] text-muted-foreground uppercase mb-1">Domains</p>
                                    <div className="flex flex-wrap gap-1">
                                        {(soul.capabilities.domains || []).map((domain) => (
                                            <Badge key={domain} variant="outline" className="text-[10px]">
                                                {domain}
                                            </Badge>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}
                    </section>

                    {/* Workflows */}
                    {persona.workflows && persona.workflows.length > 0 && (
                        <section>
                            <button
                                onClick={() => setShowWorkflows(!showWorkflows)}
                                className="flex items-center gap-2 text-sm font-semibold w-full text-left hover:text-purple-400 transition-colors"
                            >
                                {showWorkflows ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                <Wrench className="h-4 w-4 text-amber-400" /> Workflows ({persona.workflows.length})
                            </button>
                            {showWorkflows && (
                                <div className="mt-2 space-y-2 pl-6">
                                    {persona.workflows.map((wf) => (
                                        <Card key={wf.id} className="p-3 bg-muted/20 border-border">
                                            <p className="text-sm font-medium">{wf.name}</p>
                                            <p className="text-xs text-muted-foreground">{wf.description}</p>
                                            <div className="flex items-center gap-2 mt-1">
                                                <Badge variant="outline" className="text-[10px]">{wf.trigger}</Badge>
                                                <span className="text-[10px] text-muted-foreground">{wf.steps.length} steps</span>
                                            </div>
                                        </Card>
                                    ))}
                                </div>
                            )}
                        </section>
                    )}

                    {/* Required Mods/Skills */}
                    {allSkills.length > 0 && (
                        <section className="space-y-2">
                            <h3 className="text-sm font-semibold flex items-center gap-2">
                                <Wrench className="h-4 w-4 text-amber-400" /> Requirements
                            </h3>
                            <div className="flex flex-wrap gap-1">
                                {allSkills.map((s) => (
                                    <Badge key={s} variant="outline" className="text-[10px] border-amber-500/20 text-amber-400">
                                        {s}
                                    </Badge>
                                ))}
                            </div>
                        </section>
                    )}

                    {/* Reviews */}
                    {ratings.length > 0 && (
                        <section className="space-y-2">
                            <h3 className="text-sm font-semibold">Reviews</h3>
                            <div className="space-y-2 max-h-40 overflow-y-auto">
                                {ratings.slice(0, 5).map((r) => (
                                    <Card key={r.id} className="p-3 bg-muted/20 border-border">
                                        <div className="flex items-center gap-2 mb-1">
                                            <div className="flex items-center gap-0.5">
                                                {Array.from({ length: 5 }, (_, i) => (
                                                    <Star
                                                        key={i}
                                                        className={`h-3 w-3 ${i < r.rating ? "text-amber-400 fill-amber-400" : "text-muted-foreground/30"}`}
                                                    />
                                                ))}
                                            </div>
                                            <span className="text-[10px] text-muted-foreground font-mono">
                                                {r.reviewerWallet.slice(0, 6)}...{r.reviewerWallet.slice(-4)}
                                            </span>
                                        </div>
                                        {r.review && <p className="text-xs text-muted-foreground">{r.review}</p>}
                                    </Card>
                                ))}
                            </div>
                        </section>
                    )}

                    {/* Tags */}
                    <div className="flex flex-wrap gap-1">
                        {persona.tags.map((tag) => (
                            <Badge key={tag} variant="outline" className="text-[10px] text-muted-foreground">
                                {tag}
                            </Badge>
                        ))}
                    </div>

                    {/* Apply Button */}
                    <Button
                        className="w-full bg-purple-600 hover:bg-purple-700 text-white gap-2 h-10"
                        onClick={() => onApply(persona)}
                    >
                        <Bot className="h-4 w-4" />
                        {isFree ? "Apply to Agent" : `Buy & Apply — ${currencySymbol}${price}`}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
