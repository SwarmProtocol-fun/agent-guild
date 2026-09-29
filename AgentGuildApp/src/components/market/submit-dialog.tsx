/** Submit Market Item Dialog — Form for community submissions. */
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Loader2, Upload, X, Image as ImageIcon } from "lucide-react";
import { type MarketItemType, type PricingModel, type MarketPricing, AGENT_CATEGORIES } from "@/lib/skills";
const trackMarketplaceEvent = (..._args: unknown[]) => {}; // posthog removed
// [agent-guild-core] Storacha removed — artifact uploads disabled in core
const uploadArtifact = async (..._args: unknown[]) => ({ cid: "", url: "" });

interface UploadedScreenshot {
    cid: string;
    filename: string;
    gatewayUrl: string;
}

interface SubmitMarketItemDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    submitterAddress: string;
    orgId?: string;
    onSubmitted: () => void;
}

export function SubmitMarketItemDialog({
    open,
    onOpenChange,
    submitterAddress,
    orgId,
    onSubmitted,
}: SubmitMarketItemDialogProps) {
    const [name, setName] = useState("");
    const [type, setType] = useState<MarketItemType | "">("");
    const [category, setCategory] = useState("");
    const [icon, setIcon] = useState("");
    const [description, setDescription] = useState("");
    const [version, setVersion] = useState("1.0.0");
    const [tagsInput, setTagsInput] = useState("");
    const [requiredKeysInput, setRequiredKeysInput] = useState("");
    const [pricingModel, setPricingModel] = useState<PricingModel>("free");
    const [pricingCurrency, setPricingCurrency] = useState<"USD" | "HBAR">("HBAR");
    const [monthlyPrice, setMonthlyPrice] = useState("");
    const [yearlyPrice, setYearlyPrice] = useState("");
    const [lifetimePrice, setLifetimePrice] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errorDetails, setErrorDetails] = useState<string[] | null>(null);
    // Agent-specific fields
    const [agentType, setAgentType] = useState("");
    const [persona, setPersona] = useState("");
    const [personality, setPersonality] = useState("");
    const [rules, setRules] = useState("");
    const [agentCategory, setAgentCategory] = useState("");
    const [configPrice, setConfigPrice] = useState("");
    const [rentalMonthly, setRentalMonthly] = useState("");
    const [rentalUsage, setRentalUsage] = useState("");
    const [performanceShare, setPerformanceShare] = useState("");
    const [hirePerTask, setHirePerTask] = useState("");
    // SOUL template fields (agent)
    const [commStyle, setCommStyle] = useState("");
    const [decisionMaking, setDecisionMaking] = useState("");
    const [riskTolerance, setRiskTolerance] = useState("");
    const [humor, setHumor] = useState("");
    const [greeting, setGreeting] = useState("");
    const [systemPrompt, setSystemPrompt] = useState("");
    // Skin-specific fields
    const [skinPrimary, setSkinPrimary] = useState("");
    const [skinAccent, setSkinAccent] = useState("");
    const [skinBg, setSkinBg] = useState("");
    const [skinFeatures, setSkinFeatures] = useState("");
    // Compute-specific fields
    const [computeVcpu, setComputeVcpu] = useState("");
    const [computeRam, setComputeRam] = useState("");
    const [computeGpu, setComputeGpu] = useState("");
    const [computeRegion, setComputeRegion] = useState("");
    // Mod manifest fields
    const [modTools, setModTools] = useState("");
    const [modWorkflows, setModWorkflows] = useState("");
    const [modAgentSkills, setModAgentSkills] = useState("");
    // Submission Protocol v1 fields
    const [submissionType, setSubmissionType] = useState<"concept" | "build">("build");
    const [submissionTrack, setSubmissionTrack] = useState("");
    const [repoUrl, setRepoUrl] = useState("");
    const [demoUrl, setDemoUrl] = useState("");
    const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
    // Screenshot artifacts
    const [screenshots, setScreenshots] = useState<UploadedScreenshot[]>([]);
    const [uploadingScreenshot, setUploadingScreenshot] = useState(false);

    const resetForm = () => {
        setName("");
        setType("");
        setCategory("");
        setIcon("");
        setDescription("");
        setVersion("1.0.0");
        setTagsInput("");
        setRequiredKeysInput("");
        setPricingModel("free");
        setPricingCurrency("HBAR");
        setMonthlyPrice("");
        setYearlyPrice("");
        setLifetimePrice("");
        setError(null);
        setAgentType("");
        setPersona("");
        setPersonality("");
        setRules("");
        setAgentCategory("");
        setConfigPrice("");
        setRentalMonthly("");
        setRentalUsage("");
        setPerformanceShare("");
        setHirePerTask("");
        setCommStyle("");
        setDecisionMaking("");
        setRiskTolerance("");
        setHumor("");
        setGreeting("");
        setSystemPrompt("");
        setSkinPrimary("");
        setSkinAccent("");
        setSkinBg("");
        setSkinFeatures("");
        setComputeVcpu("");
        setComputeRam("");
        setComputeGpu("");
        setComputeRegion("");
        setModTools("");
        setModWorkflows("");
        setModAgentSkills("");
        setSubmissionType("build");
        setSubmissionTrack("");
        setRepoUrl("");
        setDemoUrl("");
        setSelectedPermissions([]);
        setScreenshots([]);
    };

    const handleSubmit = async () => {
        if (!name.trim() || !type || !icon.trim() || !description.trim()) return;
        if (type !== "agent" && !category.trim()) return;

        setSubmitting(true);
        setError(null);
        setErrorDetails(null);
        try {
            const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
            const requiredKeys = requiredKeysInput.split(",").map((k) => k.trim()).filter(Boolean);

            // Build the request body for the publish API
            const body: Record<string, unknown> = {
                name: name.trim(),
                type,
                category: type === "agent"
                    ? (agentCategory.toLowerCase().replace(/\s+/g, "-") || "general")
                    : category.trim(),
                icon: icon.trim(),
                description: description.trim(),
                version: version.trim() || "1.0.0",
                tags,
                requiredKeys: requiredKeys.length > 0 ? requiredKeys : undefined,
                submissionType,
                submissionTrack: submissionType === "build" && submissionTrack ? submissionTrack : undefined,
                repoUrl: repoUrl.trim() || undefined,
                demoUrl: demoUrl.trim() || undefined,
                permissionsRequired: selectedPermissions.length > 0 ? selectedPermissions : undefined,
                screenshotUrls: screenshots.length > 0 ? screenshots.map(s => s.gatewayUrl) : undefined,
            };

            if (type === "agent") {
                // Agent-specific fields
                const distributions: string[] = [];
                if (configPrice) distributions.push("config");
                if (rentalMonthly || rentalUsage || performanceShare) distributions.push("rental");
                if (hirePerTask) distributions.push("hire");
                if (distributions.length === 0) distributions.push("config");

                body.distributions = distributions;
                body.identity = {
                    agentType: agentType || "General",
                    persona: persona || description.trim(),
                    personality: personality ? personality.split(",").map(p => p.trim()).filter(Boolean) : undefined,
                    rules: rules ? rules.split("\n").map(r => r.trim()).filter(Boolean) : undefined,
                    systemPrompt: systemPrompt || undefined,
                };
                body.agentPricing = {
                    configPurchase: configPrice ? parseFloat(configPrice) : undefined,
                    rentalMonthly: rentalMonthly ? parseFloat(rentalMonthly) : undefined,
                    rentalUsage: rentalUsage ? parseFloat(rentalUsage) : undefined,
                    rentalPerformance: performanceShare ? parseFloat(performanceShare) : undefined,
                    hirePerTask: hirePerTask ? parseFloat(hirePerTask) : undefined,
                    currency: pricingCurrency,
                };

                // SOUL template
                const hasSoulFields = commStyle || decisionMaking || riskTolerance || humor || greeting || systemPrompt;
                if (hasSoulFields) {
                    const personalityTraits = personality ? personality.split(",").map(p => p.trim()).filter(Boolean) : ["helpful"];
                    body.soulTemplate = {
                        version: "1.0",
                        identity: { name: name.trim(), role: agentType || "General", purpose: persona || description.trim() },
                        personality: { traits: personalityTraits, communicationStyle: commStyle || "casual", emotionalRange: "balanced", humor: humor || "subtle" },
                        behavior: { decisionMaking: decisionMaking || "collaborative", riskTolerance: riskTolerance || "moderate", learningStyle: "interactive", responseSpeed: "considered" },
                        capabilities: { skills: personalityTraits },
                        ethics: { principles: ["Act in the user's best interest"], boundaries: ["Stay within defined scope"], priorities: ["Accuracy", "Helpfulness"] },
                        interactions: { greetingStyle: greeting || `Hello! I'm ${name.trim()}.`, farewellStyle: "Goodbye! Feel free to reach out anytime.", errorHandling: "solution-focused", feedbackPreference: "adaptive" },
                        ...(systemPrompt ? { customFields: { systemPrompt } } : {}),
                    };
                }
            } else {
                // Standard item: pricing, skinConfig, modManifest
                const pricing: MarketPricing = { model: pricingModel };
                if (pricingModel === "subscription") {
                    pricing.tiers = [];
                    if (monthlyPrice) pricing.tiers.push({ plan: "monthly", price: parseFloat(monthlyPrice), currency: pricingCurrency });
                    if (yearlyPrice) pricing.tiers.push({ plan: "yearly", price: parseFloat(yearlyPrice), currency: pricingCurrency });
                    if (lifetimePrice) pricing.tiers.push({ plan: "lifetime", price: parseFloat(lifetimePrice), currency: pricingCurrency });
                }
                body.pricing = pricing;

                if (type === "skin" && (skinPrimary || skinAccent || skinBg || skinFeatures)) {
                    body.skinConfig = {
                        colors: {
                            ...(skinPrimary ? { primary: skinPrimary.trim() } : {}),
                            ...(skinAccent ? { accent: skinAccent.trim() } : {}),
                            ...(skinBg ? { background: skinBg.trim() } : {}),
                        },
                        features: skinFeatures ? skinFeatures.split("\n").map(f => f.trim()).filter(Boolean) : [],
                    };
                }

                if (type === "compute" && (computeVcpu || computeRam || computeGpu || computeRegion)) {
                    body.computeConfig = {
                        vCpu: parseInt(computeVcpu) || 0,
                        ramGb: parseInt(computeRam) || 0,
                        gpu: computeGpu.trim() || undefined,
                        region: computeRegion.trim() || "global",
                    };
                }

                if (type === "mod" && (modTools || modWorkflows || modAgentSkills)) {
                    body.modManifest = {
                        tools: modTools ? modTools.split("\n").map(t => t.trim()).filter(Boolean) : [],
                        workflows: modWorkflows ? modWorkflows.split("\n").map(w => w.trim()).filter(Boolean) : [],
                        agentSkills: modAgentSkills ? modAgentSkills.split("\n").map(s => s.trim()).filter(Boolean) : [],
                    };
                }
            }

            // POST to the publish API — enforces intake validation, security scan, settings
            const res = await fetch("/api/v1/marketplace/publish", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-wallet-address": submitterAddress,
                },
                body: JSON.stringify(body),
            });

            const data = await res.json();

            if (!res.ok) {
                setError(data.error || "Submission failed");
                if (data.reasons) setErrorDetails(data.reasons);
                else if (data.findings) setErrorDetails(data.findings);
                trackMarketplaceEvent("submission_failed", { type, errorType: res.status === 429 ? "intake" : res.status === 400 ? "validation" : "server" });
                return;
            }

            trackMarketplaceEvent("submission_completed", { type, name: name.trim(), itemId: data.id, stage: data.stage });
            resetForm();
            onOpenChange(false);
            onSubmitted();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to submit");
        } finally {
            setSubmitting(false);
        }
    };

    const hasValidPricing = type === "agent" || pricingModel === "free" || (monthlyPrice || yearlyPrice || lifetimePrice);
    const isValid = name.trim() && type && (type === "agent" || category.trim()) && icon.trim() && description.trim() && hasValidPricing;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Submit to Market</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                    <div className="grid grid-cols-[1fr_auto] gap-3">
                        <div>
                            <label className="text-sm font-medium mb-1 block">Name *</label>
                            <Input
                                placeholder="My Awesome Skill"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="text-sm font-medium mb-1 block">Icon *</label>
                            <Input
                                placeholder="🚀"
                                value={icon}
                                onChange={(e) => setIcon(e.target.value)}
                                className="w-20 text-center text-lg"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-sm font-medium mb-1 block">Type *</label>
                            <Select value={type} onValueChange={(v) => setType(v as MarketItemType)}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Select type" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="agent">Agent</SelectItem>
                                    <SelectItem value="compute">Compute Node</SelectItem>
                                    <SelectItem value="mod">Mod</SelectItem>
                                    <SelectItem value="plugin">Plugin</SelectItem>
                                    <SelectItem value="skill">Skill</SelectItem>
                                    <SelectItem value="skin">Skin</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div>
                            <label className="text-sm font-medium mb-1 block">Category *</label>
                            <Input
                                placeholder="e.g. Developer, Safety"
                                value={category}
                                onChange={(e) => setCategory(e.target.value)}
                            />
                        </div>
                    </div>

                    {/* Submission Protocol — Type & Track */}
                    <div className="space-y-2 p-3 rounded-lg border border-border bg-muted/20">
                        <p className="text-xs font-medium text-muted-foreground">Submission Details</p>
                        <div className="flex gap-4">
                            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                                <input
                                    type="radio"
                                    checked={submissionType === "build"}
                                    onChange={() => setSubmissionType("build")}
                                    className="accent-amber-500"
                                />
                                Build (working code)
                            </label>
                            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                                <input
                                    type="radio"
                                    checked={submissionType === "concept"}
                                    onChange={() => setSubmissionType("concept")}
                                    className="accent-amber-500"
                                />
                                Concept (idea / PRD)
                            </label>
                        </div>
                        {submissionType === "build" && (
                            <div className="grid grid-cols-2 gap-2 mt-1">
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Track</label>
                                    <Select value={submissionTrack} onValueChange={setSubmissionTrack}>
                                        <SelectTrigger className="h-8 text-sm">
                                            <SelectValue placeholder="Select track" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="open_repo">Open Repo</SelectItem>
                                            <SelectItem value="private_repo">Private Repo</SelectItem>
                                            <SelectItem value="managed_partner">Managed Partner</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                {submissionTrack === "open_repo" && (
                                    <div>
                                        <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Repository URL</label>
                                        <Input
                                            placeholder="https://github.com/..."
                                            value={repoUrl}
                                            onChange={(e) => setRepoUrl(e.target.value)}
                                            className="h-8 text-sm"
                                        />
                                    </div>
                                )}
                            </div>
                        )}
                        {submissionType === "concept" && (
                            <p className="text-[10px] text-muted-foreground">Concept submissions are listed for community builders to pick up and develop.</p>
                        )}
                    </div>

                    <div>
                        <label className="text-sm font-medium mb-1 block">Description *</label>
                        <Textarea
                            placeholder="Describe what this does..."
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={3}
                        />
                    </div>

                    {/* Agent-specific fields */}
                    {type === "agent" && (
                        <div className="space-y-3 p-3 rounded-lg border border-cyan-500/20 bg-cyan-500/5">
                            <p className="text-xs font-medium text-cyan-400">Agent Identity</p>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Agent Type</label>
                                    <Select value={agentType} onValueChange={setAgentType}>
                                        <SelectTrigger className="h-8 text-sm">
                                            <SelectValue placeholder="Select type" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {["Research", "Trading", "Operations", "Support", "Analytics", "Security", "Creative", "Engineering"].map(t => (
                                                <SelectItem key={t} value={t}>{t}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Category</label>
                                    <Select value={agentCategory} onValueChange={setAgentCategory}>
                                        <SelectTrigger className="h-8 text-sm">
                                            <SelectValue placeholder="Select category" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {AGENT_CATEGORIES.filter(c => c !== "All").map(c => (
                                                <SelectItem key={c} value={c}>{c}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                            <div>
                                <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Persona</label>
                                <Textarea
                                    placeholder="Short persona description..."
                                    value={persona}
                                    onChange={(e) => setPersona(e.target.value)}
                                    rows={2}
                                    className="text-sm"
                                />
                            </div>
                            <div>
                                <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Personality Traits</label>
                                <Input
                                    placeholder="analytical, concise, thorough"
                                    value={personality}
                                    onChange={(e) => setPersonality(e.target.value)}
                                    className="h-8 text-sm"
                                />
                                <p className="text-[10px] text-muted-foreground mt-0.5">Comma-separated</p>
                            </div>
                            <div>
                                <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Rules</label>
                                <Textarea
                                    placeholder="One rule per line..."
                                    value={rules}
                                    onChange={(e) => setRules(e.target.value)}
                                    rows={2}
                                    className="text-sm"
                                />
                            </div>

                            {/* Agent pricing */}
                            <div className="flex items-center justify-between mt-2">
                                <p className="text-xs font-medium text-cyan-400">Distribution Pricing</p>
                                <Select value={pricingCurrency} onValueChange={(v: "USD" | "HBAR") => setPricingCurrency(v)}>
                                    <SelectTrigger className="h-6 text-[10px] w-20 border-cyan-500/30 text-cyan-500 bg-cyan-500/10">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="HBAR">HBAR (ℏ)</SelectItem>
                                        <SelectItem value="USD">USD ($)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Config Purchase ({pricingCurrency === "HBAR" ? "ℏ" : "$"})</label>
                                    <Input
                                        type="number" min="0" step="0.01"
                                        placeholder="39"
                                        value={configPrice}
                                        onChange={(e) => setConfigPrice(e.target.value)}
                                        className="h-8 text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Rental Monthly ({pricingCurrency === "HBAR" ? "ℏ" : "$"})</label>
                                    <Input
                                        type="number" min="0" step="0.01"
                                        placeholder="15"
                                        value={rentalMonthly}
                                        onChange={(e) => setRentalMonthly(e.target.value)}
                                        className="h-8 text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Per Request ({pricingCurrency === "HBAR" ? "ℏ" : "$"})</label>
                                    <Input
                                        type="number" min="0" step="0.01"
                                        placeholder="2"
                                        value={rentalUsage}
                                        onChange={(e) => setRentalUsage(e.target.value)}
                                        className="h-8 text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Hire Per Task ({pricingCurrency === "HBAR" ? "ℏ" : "$"})</label>
                                    <Input
                                        type="number" min="0" step="0.01"
                                        placeholder="5"
                                        value={hirePerTask}
                                        onChange={(e) => setHirePerTask(e.target.value)}
                                        className="h-8 text-sm"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Performance Share (%)</label>
                                <Input
                                    type="number" min="0" max="100" step="1"
                                    placeholder="20"
                                    value={performanceShare}
                                    onChange={(e) => setPerformanceShare(e.target.value)}
                                    className="h-8 text-sm w-24"
                                />
                            </div>
                            <p className="text-[10px] text-muted-foreground">Leave blank for fields you don&apos;t want to offer. Revenue split: Creator 85% / Platform 15% for sales, Creator 70% / Host 15% / Platform 15% for rentals.</p>

                            {/* SOUL Template */}
                            <p className="text-xs font-medium text-purple-400 mt-2">SOUL Template</p>
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Communication Style</label>
                                    <Select value={commStyle} onValueChange={setCommStyle}>
                                        <SelectTrigger className="h-8 text-sm">
                                            <SelectValue placeholder="Select style" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {["formal", "casual", "technical", "friendly", "direct"].map(s => (
                                                <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Decision Making</label>
                                    <Select value={decisionMaking} onValueChange={setDecisionMaking}>
                                        <SelectTrigger className="h-8 text-sm">
                                            <SelectValue placeholder="Select approach" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {["data-driven", "intuitive", "collaborative", "autonomous"].map(s => (
                                                <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Risk Tolerance</label>
                                    <Select value={riskTolerance} onValueChange={setRiskTolerance}>
                                        <SelectTrigger className="h-8 text-sm">
                                            <SelectValue placeholder="Select level" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {["conservative", "moderate", "aggressive"].map(s => (
                                                <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Humor</label>
                                    <Select value={humor} onValueChange={setHumor}>
                                        <SelectTrigger className="h-8 text-sm">
                                            <SelectValue placeholder="Select level" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {["none", "subtle", "moderate", "witty"].map(s => (
                                                <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                            <div>
                                <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Greeting</label>
                                <Input
                                    placeholder="Hello! I'm ready to help you..."
                                    value={greeting}
                                    onChange={(e) => setGreeting(e.target.value)}
                                    className="h-8 text-sm"
                                />
                            </div>
                            <div>
                                <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">System Prompt (optional)</label>
                                <Textarea
                                    placeholder="Custom system prompt for this persona..."
                                    value={systemPrompt}
                                    onChange={(e) => setSystemPrompt(e.target.value)}
                                    rows={2}
                                    className="text-sm"
                                />
                            </div>
                            <p className="text-[10px] text-muted-foreground">These fields build the SOUL config that defines your agent&apos;s personality and behavior.</p>
                        </div>
                    )}

                    {/* Skin-specific fields */}
                    {type === "skin" && (
                        <div className="space-y-3 p-3 rounded-lg border border-purple-500/20 bg-purple-500/5">
                            <p className="text-xs font-medium text-purple-400">Skin Configuration</p>
                            <div className="grid grid-cols-3 gap-2">
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Primary Color</label>
                                    <Input
                                        placeholder="#6366f1"
                                        value={skinPrimary}
                                        onChange={(e) => setSkinPrimary(e.target.value)}
                                        className="h-8 text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Accent Color</label>
                                    <Input
                                        placeholder="#22d3ee"
                                        value={skinAccent}
                                        onChange={(e) => setSkinAccent(e.target.value)}
                                        className="h-8 text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Background</label>
                                    <Input
                                        placeholder="#0a0a0a"
                                        value={skinBg}
                                        onChange={(e) => setSkinBg(e.target.value)}
                                        className="h-8 text-sm"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Features</label>
                                <Textarea
                                    placeholder="One per line: gradient backgrounds, rounded corners, ..."
                                    value={skinFeatures}
                                    onChange={(e) => setSkinFeatures(e.target.value)}
                                    rows={2}
                                    className="text-sm"
                                />
                            </div>
                        </div>
                    )}

                    {/* Compute-specific fields */}
                    {type === "compute" && (
                        <div className="space-y-3 p-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5">
                            <p className="text-xs font-medium text-emerald-400">Node Configuration</p>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">vCPUs</label>
                                    <Input
                                        type="number" min="1"
                                        placeholder="8"
                                        value={computeVcpu}
                                        onChange={(e) => setComputeVcpu(e.target.value)}
                                        className="h-8 text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">RAM (GB)</label>
                                    <Input
                                        type="number" min="1"
                                        placeholder="32"
                                        value={computeRam}
                                        onChange={(e) => setComputeRam(e.target.value)}
                                        className="h-8 text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">GPU (Optional)</label>
                                    <Input
                                        placeholder="1x RTX 4090"
                                        value={computeGpu}
                                        onChange={(e) => setComputeGpu(e.target.value)}
                                        className="h-8 text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Region / Location</label>
                                    <Input
                                        placeholder="US-East, EU-West..."
                                        value={computeRegion}
                                        onChange={(e) => setComputeRegion(e.target.value)}
                                        className="h-8 text-sm"
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Mod manifest fields */}
                    {type === "mod" && (
                        <div className="space-y-3 p-3 rounded-lg border border-amber-500/20 bg-amber-500/5">
                            <p className="text-xs font-medium text-amber-400">Mod Manifest</p>
                            <div>
                                <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Tools</label>
                                <Textarea
                                    placeholder="One per line: tool_name: description"
                                    value={modTools}
                                    onChange={(e) => setModTools(e.target.value)}
                                    rows={2}
                                    className="text-sm"
                                />
                            </div>
                            <div>
                                <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Workflows</label>
                                <Textarea
                                    placeholder="One per line: workflow name"
                                    value={modWorkflows}
                                    onChange={(e) => setModWorkflows(e.target.value)}
                                    rows={2}
                                    className="text-sm"
                                />
                            </div>
                            <div>
                                <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Agent Skills</label>
                                <Textarea
                                    placeholder="One per line: invocation: description"
                                    value={modAgentSkills}
                                    onChange={(e) => setModAgentSkills(e.target.value)}
                                    rows={2}
                                    className="text-sm"
                                />
                            </div>
                        </div>
                    )}

                    {/* Permissions (mod/plugin types) */}
                    {(type === "mod" || type === "plugin") && (
                        <div className="space-y-2 p-3 rounded-lg border border-orange-500/20 bg-orange-500/5">
                            <p className="text-xs font-medium text-orange-400">Required Permissions</p>
                            <div className="grid grid-cols-2 gap-1.5">
                                {(["read", "write", "execute", "external_api", "wallet_access", "webhook_access", "cross_chain_message", "sensitive_data_access"] as const).map(perm => (
                                    <label key={perm} className="flex items-center gap-1.5 text-[11px] cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={selectedPermissions.includes(perm)}
                                            onChange={(e) => {
                                                if (e.target.checked) {
                                                    setSelectedPermissions([...selectedPermissions, perm]);
                                                } else {
                                                    setSelectedPermissions(selectedPermissions.filter(p => p !== perm));
                                                }
                                            }}
                                            className="accent-orange-500"
                                        />
                                        {perm.replace(/_/g, " ")}
                                    </label>
                                ))}
                            </div>
                            <p className="text-[10px] text-muted-foreground">Users will be prompted to grant these permissions at install time.</p>
                        </div>
                    )}

                    {/* Demo URL */}
                    <div>
                        <label className="text-sm font-medium mb-1 block">Demo URL (optional)</label>
                        <Input
                            placeholder="https://demo.example.com"
                            value={demoUrl}
                            onChange={(e) => setDemoUrl(e.target.value)}
                        />
                    </div>

                    {/* Screenshots */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium mb-1 block">Screenshots (optional)</label>
                        {screenshots.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                                {screenshots.map(s => (
                                    <div key={s.cid} className="relative group">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img
                                            src={s.gatewayUrl}
                                            alt={s.filename}
                                            className="h-16 w-16 rounded-lg object-cover border border-border"
                                        />
                                        <button
                                            onClick={() => setScreenshots(screenshots.filter(x => x.cid !== s.cid))}
                                            className="absolute -top-1.5 -right-1.5 bg-red-500 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                                        >
                                            <X className="h-2.5 w-2.5 text-white" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                        <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed cursor-pointer transition-colors ${
                            uploadingScreenshot ? "border-purple-500/30 bg-purple-500/5" : "border-border hover:border-muted-foreground/30"
                        }`}>
                            <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                disabled={uploadingScreenshot || !orgId}
                                onChange={async (e) => {
                                    const file = e.target.files?.[0];
                                    if (!file || !orgId) return;
                                    e.target.value = "";
                                    setUploadingScreenshot(true);
                                    try {
                                        const result = await uploadArtifact(file, orgId, "screenshot", submitterAddress);
                                        setScreenshots(prev => [...prev, {
                                            cid: result.cid,
                                            filename: file.name,
                                            gatewayUrl: result.url,
                                        }]);
                                    } catch (err) {
                                        setError(err instanceof Error ? err.message : "Screenshot upload failed");
                                    } finally {
                                        setUploadingScreenshot(false);
                                    }
                                }}
                            />
                            {uploadingScreenshot ? (
                                <><Loader2 className="h-3.5 w-3.5 animate-spin text-purple-400" /><span className="text-xs text-muted-foreground">Uploading to IPFS...</span></>
                            ) : (
                                <><ImageIcon className="h-3.5 w-3.5 text-muted-foreground" /><span className="text-xs text-muted-foreground">{orgId ? "Add screenshot" : "Select an org to upload"}</span></>
                            )}
                        </label>
                        <p className="text-[10px] text-muted-foreground">Upload screenshots for reviewers. Images help reviewers evaluate your submission.</p>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-sm font-medium mb-1 block">Version</label>
                            <Input
                                placeholder="1.0.0"
                                value={version}
                                onChange={(e) => setVersion(e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="text-sm font-medium mb-1 block">Required Keys</label>
                            <Input
                                placeholder="API_KEY, SECRET"
                                value={requiredKeysInput}
                                onChange={(e) => setRequiredKeysInput(e.target.value)}
                            />
                            <p className="text-[10px] text-muted-foreground mt-0.5">Comma-separated</p>
                        </div>
                    </div>

                    {/* Pricing Model (non-agent types) */}
                    {type !== "agent" && <div className="space-y-3 p-3 rounded-lg border border-border bg-muted/30">
                        <div>
                            <label className="text-sm font-medium mb-1 block">Access Model</label>
                            <div className="flex gap-2">
                                <Select value={pricingModel} onValueChange={(v) => setPricingModel(v as PricingModel)}>
                                    <SelectTrigger className="flex-1">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="free">Free</SelectItem>
                                        <SelectItem value="subscription">Subscription (Paid)</SelectItem>
                                    </SelectContent>
                                </Select>
                                {pricingModel !== "free" && (
                                    <Select value={pricingCurrency} onValueChange={(v: "USD" | "HBAR") => setPricingCurrency(v)}>
                                        <SelectTrigger className="w-[100px] shrink-0 border-amber-500/30 text-amber-500 bg-amber-500/10">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="HBAR">HBAR</SelectItem>
                                            <SelectItem value="USD">USD</SelectItem>
                                        </SelectContent>
                                    </Select>
                                )}
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                                {pricingModel === "free" ? "Anyone can install and use this item" : "Users pay to access — you control the pricing tiers"}
                            </p>
                        </div>
                        {pricingModel === "subscription" && (
                            <div className="grid grid-cols-3 gap-2">
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Monthly ({pricingCurrency === "HBAR" ? "ℏ" : "$"})</label>
                                    <Input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        placeholder="9.99"
                                        value={monthlyPrice}
                                        onChange={(e) => setMonthlyPrice(e.target.value)}
                                        className="h-8 text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Yearly ({pricingCurrency === "HBAR" ? "ℏ" : "$"})</label>
                                    <Input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        placeholder="99.99"
                                        value={yearlyPrice}
                                        onChange={(e) => setYearlyPrice(e.target.value)}
                                        className="h-8 text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium mb-0.5 block text-muted-foreground">Lifetime ({pricingCurrency === "HBAR" ? "ℏ" : "$"})</label>
                                    <Input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        placeholder="299.99"
                                        value={lifetimePrice}
                                        onChange={(e) => setLifetimePrice(e.target.value)}
                                        className="h-8 text-sm"
                                    />
                                </div>
                                <p className="col-span-3 text-[10px] text-muted-foreground">
                                    Set at least one tier. Leave blank to skip a tier.
                                </p>
                            </div>
                        )}
                    </div>}

                    <div>
                        <label className="text-sm font-medium mb-1 block">Tags</label>
                        <Input
                            placeholder="search, api, integration"
                            value={tagsInput}
                            onChange={(e) => setTagsInput(e.target.value)}
                        />
                        <p className="text-[10px] text-muted-foreground mt-0.5">Comma-separated, used for search</p>
                    </div>

                    {error && (
                        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 text-sm text-red-600 dark:text-red-400 space-y-1">
                            <p className="font-medium">{error}</p>
                            {errorDetails && errorDetails.length > 0 && (
                                <ul className="text-xs space-y-0.5 ml-4 list-disc">
                                    {errorDetails.map((d, i) => <li key={i}>{d}</li>)}
                                </ul>
                            )}
                        </div>
                    )}

                    <div className="flex gap-2 justify-end">
                        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                            Cancel
                        </Button>
                        <Button
                            onClick={handleSubmit}
                            disabled={submitting || !isValid}
                            className="bg-amber-600 hover:bg-amber-700 text-black"
                        >
                            {submitting ? (
                                <>
                                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                    Submitting...
                                </>
                            ) : (
                                "Submit"
                            )}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
