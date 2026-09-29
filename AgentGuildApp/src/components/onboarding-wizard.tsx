/** Onboarding Wizard — 4-step setup flow: connect wallet → create org → create project → connect agent. */
"use client";

import { useState } from "react";
import { Rocket, Check, ChevronRight, Wallet, Building2, FolderKanban, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// ═══════════════════════════════════════════════════════════════
// Onboarding Steps
// ═══════════════════════════════════════════════════════════════

interface OnboardingStep {
    id: string;
    title: string;
    description: string;
    icon: typeof Wallet;
    action?: string;
    href?: string;
}

const STEPS: OnboardingStep[] = [
    {
        id: "wallet",
        title: "Connect Your Wallet",
        description: "Link your wallet to authenticate and access all features",
        icon: Wallet,
    },
    {
        id: "org",
        title: "Create Organization",
        description: "Set up your organization to manage teams and projects",
        icon: Building2,
        href: "/settings",
    },
    {
        id: "project",
        title: "Create First Project",
        description: "Projects organize your agents, tasks, and boards",
        icon: FolderKanban,
        href: "/swarms",
    },
    {
        id: "agent",
        title: "Connect an Agent",
        description: "Add your first AI agent using SwarmConnect",
        icon: Users,
        href: "/agents",
    },
];

// ═══════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════

export function OnboardingWizard({
    completedSteps = [],
    onStepClick,
    onDismiss,
}: {
    completedSteps?: string[];
    onStepClick?: (stepId: string, href?: string) => void;
    onDismiss?: () => void;
}) {
    const [dismissed, setDismissed] = useState(false);

    if (dismissed) return null;

    const allDone = STEPS.every(s => completedSteps.includes(s.id));
    const progress = Math.round((completedSteps.length / STEPS.length) * 100);

    return (
        <Card className="p-5 bg-card/80 border-border mb-6 relative overflow-hidden">
            {/* Progress gradient bar at top */}
            <div className="absolute top-0 left-0 right-0 h-1 bg-muted/20">
                <div
                    className="h-full bg-gradient-to-r from-amber-500 to-emerald-500 transition-all duration-500"
                    style={{ width: `${progress}%` }}
                />
            </div>

            <div className="flex items-center justify-between mb-4 mt-1">
                <div className="flex items-center gap-2">
                    <Rocket className="h-5 w-5 text-amber-400" />
                    <h3 className="text-sm font-semibold">
                        {allDone ? "Setup Complete! 🎉" : "Getting Started"}
                    </h3>
                    <span className="text-[10px] text-muted-foreground">
                        {completedSteps.length}/{STEPS.length} steps
                    </span>
                </div>
                <button
                    onClick={() => { setDismissed(true); onDismiss?.(); }}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                    Dismiss
                </button>
            </div>

            <div className="space-y-2">
                {STEPS.map((step, i) => {
                    const done = completedSteps.includes(step.id);
                    const Icon = step.icon;
                    return (
                        <button
                            key={step.id}
                            onClick={() => !done && onStepClick?.(step.id, step.href)}
                            disabled={done}
                            className={`w-full text-left flex items-center gap-3 p-3 rounded-lg transition-colors ${done
                                    ? "bg-emerald-500/5 border border-emerald-500/10"
                                    : "bg-muted/10 border border-border hover:border-amber-500/20 hover:bg-amber-500/5"
                                }`}
                        >
                            <div className={`p-1.5 rounded-lg shrink-0 ${done ? "bg-emerald-500/10" : "bg-muted/20"
                                }`}>
                                {done ? (
                                    <Check className="h-4 w-4 text-emerald-400" />
                                ) : (
                                    <Icon className="h-4 w-4 text-muted-foreground" />
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className={`text-sm font-medium ${done ? "text-muted-foreground line-through" : ""}`}>
                                    {step.title}
                                </p>
                                <p className="text-[10px] text-muted-foreground">{step.description}</p>
                            </div>
                            {!done && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                        </button>
                    );
                })}
            </div>
        </Card>
    );
}
