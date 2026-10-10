/** Market Item Detail — Full feature breakdown for a mod, plugin, or skill. */
"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useOrg } from "@/contexts/OrgContext";
import { useWalletAccount } from "@/lib/wallet";
import {
    type Skill, type OwnedItem,
    SKILL_REGISTRY, MOD_REGISTRY, getModCapabilities,
    acquireItem, removeFromInventory, getOwnedItems,
} from "@/lib/skills";
import { useSkin, SKINS } from "@/contexts/SkinContext";
import {
    ArrowLeft, Download, Trash2, Check, Loader2,
    ShieldCheck, Users, Shield, CreditCard,
    Wrench, Zap, BookOpen, Code2, Bot,
    ChevronDown, ChevronRight, Copy, CheckCircle2,
} from "lucide-react";

export default function MarketItemPage() {
    const params = useParams();
    const router = useRouter();
    const { currentOrg } = useOrg();
    const account = useWalletAccount();
    const itemId = params.id as string;

    const [inventory, setInventory] = useState<OwnedItem[]>([]);
    const [busyAction, setBusyAction] = useState<string | null>(null);
    const [expandedTool, setExpandedTool] = useState<string | null>(null);
    const [expandedWorkflow, setExpandedWorkflow] = useState<string | null>(null);
    const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
    const [expandedExample, setExpandedExample] = useState<string | null>(null);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const { skin, setSkin, refreshInstalled } = useSkin();

    // Find the item from registry
    const item: Skill | undefined = useMemo(
        () => SKILL_REGISTRY.find(s => s.id === itemId),
        [itemId],
    );

    const loadInventory = useCallback(async () => {
        if (!currentOrg) return;
        try {
            const data = await getOwnedItems(currentOrg.id);
            setInventory(data);
        } catch (err) {
            console.error("Failed to load inventory:", err);
        }
    }, [currentOrg]);

    useEffect(() => { loadInventory(); }, [loadInventory]);

    const owned = useMemo(
        () => inventory.find(i => i.skillId === itemId),
        [inventory, itemId],
    );

    const handleGet = async () => {
        if (!currentOrg || !account || !item) return;
        setBusyAction("get");
        try {
            await acquireItem(currentOrg.id, item.id, account.address);
            await loadInventory();
            window.dispatchEvent(new Event("agent-guild-inventory-changed"));
            // If this is a skin, refresh installed skins
            if (item.type === "skin") {
                const updated = await getOwnedItems(currentOrg.id);
                refreshInstalled(updated.filter(o => o.enabled).map(o => o.skillId));
            }
        } finally { setBusyAction(null); }
    };

    const handleRemove = async () => {
        if (!owned) return;
        setBusyAction("remove");
        try {
            await removeFromInventory(owned.id);
            await loadInventory();
            window.dispatchEvent(new Event("agent-guild-inventory-changed"));
            // If this is a skin, refresh installed skins
            if (item?.type === "skin") {
                const updated = await getOwnedItems(currentOrg!.id);
                refreshInstalled(updated.filter(o => o.enabled).map(o => o.skillId));
            }
        } finally { setBusyAction(null); }
    };

    const copyToClipboard = (text: string, id: string) => {
        navigator.clipboard.writeText(text);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    // 404
    if (!item) {
        return (
            <div className="max-w-4xl mx-auto px-6 py-16 text-center">
                <div className="text-6xl mb-4 opacity-30">🔍</div>
                <h1 className="text-2xl font-bold mb-2">Item Not Found</h1>
                <p className="text-muted-foreground mb-6">
                    This marketplace item doesn&apos;t exist or has been removed.
                </p>
                <Button asChild variant="outline">
                    <Link href="/market">
                        <ArrowLeft className="h-4 w-4 mr-2" />
                        Back to Market
                    </Link>
                </Button>
            </div>
        );
    }

    const manifest = item.modManifest;
    const isPaid = item.pricing.model === "subscription";
    const hasManifest = manifest && (
        manifest.tools.length > 0 ||
        manifest.workflows.length > 0 ||
        manifest.agentSkills.length > 0 ||
        manifest.examples.length > 0
    );

    return (
        <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
            {/* Back link */}
            <button
                onClick={() => router.back()}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
                <ArrowLeft className="h-4 w-4" />
                Back to Market
            </button>

            {/* ═══ Header ═══ */}
            <div className="flex items-start gap-5">
                <div className="text-4xl shrink-0 w-16 h-16 flex items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20">
                    {item.icon}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1">
                        <h1 className="text-2xl font-bold tracking-tight">{item.name}</h1>
                        <Badge variant="outline" className="text-xs">v{item.version}</Badge>
                        {isPaid ? (
                            <Badge className="text-xs bg-amber-500/10 text-amber-400 border-amber-500/20">
                                <CreditCard className="h-3 w-3 mr-1" />Paid
                            </Badge>
                        ) : (
                            <Badge variant="outline" className="text-xs border-emerald-500/20 text-emerald-400">Free</Badge>
                        )}
                    </div>
                    <p className="text-muted-foreground mb-3">{item.description}</p>
                    <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-[10px] capitalize">{item.type}</Badge>
                        <Badge variant="outline" className="text-[10px]">{item.category}</Badge>
                        {item.source === "verified" ? (
                            <Badge variant="outline" className="text-[10px] border-amber-500/20 text-amber-500">
                                <ShieldCheck className="h-2.5 w-2.5 mr-0.5" />Verified
                            </Badge>
                        ) : (
                            <Badge variant="outline" className="text-[10px] border-blue-500/20 text-blue-400">
                                <Users className="h-2.5 w-2.5 mr-0.5" />Community
                            </Badge>
                        )}
                        {item.requiredKeys?.map(k => (
                            <Badge key={k} variant="outline" className="text-[10px] border-amber-500/20 text-amber-500">
                                <Shield className="h-2.5 w-2.5 mr-0.5" />{k}
                            </Badge>
                        ))}
                        {item.tags.map(t => (
                            <Badge key={t} variant="outline" className="text-[10px] text-muted-foreground">{t}</Badge>
                        ))}
                    </div>
                </div>
                <div className="shrink-0">
                    {owned ? (
                        <div className="flex items-center gap-2">
                            <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                                <Check className="h-3 w-3 mr-1" />Installed
                            </Badge>
                            {item.type === "skin" && (() => {
                                const skinMeta = SKINS.find((s) => s.marketId === item.id);
                                const isApplied = skinMeta && skin === skinMeta.id;
                                return skinMeta && !isApplied ? (
                                    <Button size="sm" onClick={() => setSkin(skinMeta.id)} className="bg-primary hover:bg-primary/90 text-primary-foreground">
                                        Apply Skin
                                    </Button>
                                ) : isApplied ? (
                                    <Badge className="bg-primary/10 text-primary border-primary/20">Active</Badge>
                                ) : null;
                            })()}
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={handleRemove}
                                disabled={!!busyAction}
                                className="text-red-400 border-red-500/30 hover:bg-red-500/10"
                            >
                                {busyAction === "remove" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                    ) : (
                        <Button
                            onClick={handleGet}
                            disabled={!!busyAction}
                            className="bg-primary hover:bg-primary/90 text-primary-foreground gap-2"
                        >
                            {busyAction === "get" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                            Get {item.type === "mod" ? "Mod" : item.type === "plugin" ? "Plugin" : item.type === "skin" ? "Skin" : "Skill"}
                        </Button>
                    )}
                </div>
            </div>

            {/* ═══ Stats row ═══ */}
            {hasManifest && (
                <div className="grid grid-cols-4 gap-3">
                    {[
                        { label: "Tools", count: manifest!.tools.length, icon: Wrench, color: "text-amber-400" },
                        { label: "Workflows", count: manifest!.workflows.length, icon: Zap, color: "text-purple-400" },
                        { label: "Agent Skills", count: manifest!.agentSkills.length, icon: Bot, color: "text-cyan-400" },
                        { label: "Examples", count: manifest!.examples.length, icon: Code2, color: "text-emerald-400" },
                    ].map(s => (
                        <Card key={s.label} className="p-4 bg-card border-border text-center">
                            <s.icon className={`h-5 w-5 mx-auto mb-1.5 ${s.color}`} />
                            <p className="text-2xl font-bold">{s.count}</p>
                            <p className="text-xs text-muted-foreground">{s.label}</p>
                        </Card>
                    ))}
                </div>
            )}

            {/* ═══ Capabilities Section ═══ */}
            {(() => {
                const modEntry = MOD_REGISTRY.find((m) => m.legacySkillId === item.id);
                if (!modEntry || modEntry.capabilities.length <= 1) return null;
                const caps = getModCapabilities(modEntry.id);
                const SCOPE_COLORS: Record<string, string> = {
                    read: "border-blue-500/20 text-blue-400",
                    write: "border-orange-500/20 text-orange-400",
                    execute: "border-emerald-500/20 text-emerald-400",
                    external_api: "border-cyan-500/20 text-cyan-400",
                    wallet_access: "border-purple-500/20 text-purple-400",
                    webhook_access: "border-indigo-500/20 text-indigo-400",
                    cross_chain_message: "border-amber-500/20 text-amber-400",
                    sensitive_data_access: "border-red-500/20 text-red-400",
                };
                const TYPE_COLORS: Record<string, string> = {
                    skill: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
                    plugin: "bg-purple-500/10 text-purple-400 border-purple-500/20",
                    workflow: "bg-amber-500/10 text-amber-400 border-amber-500/20",
                    example: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
                    panel: "bg-blue-500/10 text-blue-400 border-blue-500/20",
                    policy: "bg-red-500/10 text-red-400 border-red-500/20",
                };
                return (
                    <section>
                        <div className="flex items-center gap-2 mb-4">
                            <ShieldCheck className="h-5 w-5 text-cyan-400" />
                            <h2 className="text-lg font-bold">Capabilities</h2>
                            <span className="text-xs text-muted-foreground">({caps.length} registered)</span>
                        </div>
                        <p className="text-sm text-muted-foreground mb-4">
                            These are the runtime capabilities this mod registers. Agents discover them via the capability resolver.
                        </p>
                        <div className="space-y-2">
                            {caps.map((cap) => (
                                <Card key={cap.id} className="p-3 bg-card border-border">
                                    <div className="flex items-start gap-3">
                                        <Badge className={`text-[10px] shrink-0 ${TYPE_COLORS[cap.type] || ""}`}>
                                            {cap.type}
                                        </Badge>
                                        <div className="flex-1 min-w-0">
                                            <code className="text-sm font-semibold text-cyan-400">{cap.key}</code>
                                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{cap.description}</p>
                                        </div>
                                        <div className="flex items-center gap-1 flex-wrap shrink-0">
                                            {cap.permissionScopes.map((scope) => (
                                                <Badge
                                                    key={scope}
                                                    variant="outline"
                                                    className={`text-[9px] ${SCOPE_COLORS[scope] || ""}`}
                                                >
                                                    {scope.replace(/_/g, " ")}
                                                </Badge>
                                            ))}
                                        </div>
                                    </div>
                                </Card>
                            ))}
                        </div>
                    </section>
                );
            })()}

            {/* ═══ Skin Preview ═══ */}
            {item.type === "skin" && (() => {
                const skinMeta = SKINS.find((s) => s.marketId === item.id);
                if (!skinMeta) return null;
                return (
                    <section>
                        <h2 className="text-lg font-bold mb-4">Skin Preview</h2>
                        <Card className="p-6 bg-card border-border space-y-4">
                            <div className="flex items-center gap-3">
                                <div className="flex items-center gap-2">
                                    {skinMeta.colors.map((color, i) => (
                                        <span key={i} className="w-8 h-8 rounded-lg border border-border/50" style={{ backgroundColor: color }} />
                                    ))}
                                </div>
                                <div>
                                    <p className="text-sm font-semibold">{skinMeta.name}</p>
                                    <p className="text-xs text-muted-foreground">{skinMeta.description}</p>
                                </div>
                            </div>
                            <div className="rounded-lg border border-border p-4 space-y-3" style={{ background: `linear-gradient(135deg, ${skinMeta.colors[0]}08, ${skinMeta.colors[1]}05, ${skinMeta.colors[2]}08)` }}>
                                <div className="flex items-center gap-3">
                                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: skinMeta.colors[0], boxShadow: `0 0 8px ${skinMeta.colors[0]}60` }} />
                                    <div className="h-2 rounded-full w-24" style={{ backgroundColor: `${skinMeta.colors[0]}30` }} />
                                    <div className="h-2 rounded-full w-16" style={{ backgroundColor: `${skinMeta.colors[1]}20` }} />
                                </div>
                                <div className="flex gap-2">
                                    <div className="rounded-md border p-2 flex-1" style={{ borderColor: `${skinMeta.colors[0]}20`, background: `${skinMeta.colors[0]}05` }}>
                                        <div className="h-2 rounded w-12 mb-1" style={{ backgroundColor: `${skinMeta.colors[0]}40` }} />
                                        <div className="h-1.5 rounded w-20" style={{ backgroundColor: `${skinMeta.colors[0]}15` }} />
                                    </div>
                                    <div className="rounded-md border p-2 flex-1" style={{ borderColor: `${skinMeta.colors[1]}20`, background: `${skinMeta.colors[1]}05` }}>
                                        <div className="h-2 rounded w-12 mb-1" style={{ backgroundColor: `${skinMeta.colors[1]}40` }} />
                                        <div className="h-1.5 rounded w-20" style={{ backgroundColor: `${skinMeta.colors[1]}15` }} />
                                    </div>
                                    <div className="rounded-md border p-2 flex-1" style={{ borderColor: `${skinMeta.colors[2]}20`, background: `${skinMeta.colors[2]}05` }}>
                                        <div className="h-2 rounded w-12 mb-1" style={{ backgroundColor: `${skinMeta.colors[2]}40` }} />
                                        <div className="h-1.5 rounded w-20" style={{ backgroundColor: `${skinMeta.colors[2]}15` }} />
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <div className="h-6 rounded-md px-3 flex items-center text-[10px] font-medium text-foreground" style={{ backgroundColor: skinMeta.colors[0] }}>
                                        Primary Button
                                    </div>
                                    <div className="h-6 rounded-md px-3 flex items-center text-[10px] font-medium border" style={{ borderColor: `${skinMeta.colors[0]}40`, color: skinMeta.colors[0] }}>
                                        Outline
                                    </div>
                                </div>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Transforms buttons, glows, gradients, sidebar accents, backgrounds, and all visual effects.
                                {skinMeta.id === "retro-terminal" && " Includes CRT scanlines and vignette overlay."}
                                {skinMeta.id === "hacker" && " Includes subtle scanline overlay."}
                                {skinMeta.id === "futuristic" && " Includes geometric corner frames and border flicker effects."}
                            </p>
                        </Card>
                    </section>
                );
            })()}

            {/* ═══ No manifest fallback ═══ */}
            {!hasManifest && item.type !== "skin" && (
                <Card className="p-8 bg-card border-border text-center">
                    <BookOpen className="h-10 w-10 mx-auto mb-3 text-muted-foreground/30" />
                    <h3 className="text-lg font-semibold mb-1">Simple {item.type}</h3>
                    <p className="text-sm text-muted-foreground max-w-md mx-auto">
                        This {item.type} provides its functionality directly to your agents once installed. No additional configuration needed.
                    </p>
                </Card>
            )}

            {/* ═══ Tools Section ═══ */}
            {manifest && manifest.tools.length > 0 && (
                <section>
                    <div className="flex items-center gap-2 mb-4">
                        <Wrench className="h-5 w-5 text-amber-400" />
                        <h2 className="text-lg font-bold">Tools</h2>
                        <span className="text-xs text-muted-foreground">({manifest.tools.length})</span>
                    </div>
                    <div className="space-y-2">
                        {manifest.tools.map(tool => {
                            const isExpanded = expandedTool === tool.id;
                            return (
                                <Card key={tool.id} className="bg-card border-border overflow-hidden">
                                    <button
                                        className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
                                        onClick={() => setExpandedTool(isExpanded ? null : tool.id)}
                                    >
                                        <div className="shrink-0 w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center text-sm">
                                            {tool.icon === "GitBranch" ? "🔀" : tool.icon === "ShieldCheck" ? "🛡️" : tool.icon === "CheckCircle" ? "✅" : tool.icon === "Globe" ? "🌐" : tool.icon === "AlertTriangle" ? "⚠️" : tool.icon === "Play" ? "▶️" : tool.icon === "Database" ? "📊" : tool.icon === "Zap" ? "⚡" : "🔧"}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-semibold">{tool.name}</span>
                                                <Badge variant="outline" className="text-[10px]">{tool.category}</Badge>
                                                {tool.status === "coming_soon" && (
                                                    <Badge className="text-[10px] bg-blue-500/10 text-blue-400 border-blue-500/20">Coming Soon</Badge>
                                                )}
                                            </div>
                                            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{tool.description}</p>
                                        </div>
                                        {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                                    </button>
                                    {isExpanded && (
                                        <div className="px-4 pb-4 border-t border-border pt-3 space-y-3">
                                            <p className="text-sm text-muted-foreground">{tool.description}</p>
                                            {tool.usageExample && (
                                                <div>
                                                    <div className="flex items-center justify-between mb-1.5">
                                                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Usage Example</span>
                                                        <button
                                                            onClick={() => copyToClipboard(tool.usageExample!, tool.id)}
                                                            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                                                        >
                                                            {copiedId === tool.id ? <CheckCircle2 className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                                                            {copiedId === tool.id ? "Copied" : "Copy"}
                                                        </button>
                                                    </div>
                                                    <pre className="text-xs bg-muted/50 border border-border rounded-lg p-3 overflow-x-auto">
                                                        <code>{tool.usageExample}</code>
                                                    </pre>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </Card>
                            );
                        })}
                    </div>
                </section>
            )}

            {/* ═══ Workflows Section ═══ */}
            {manifest && manifest.workflows.length > 0 && (
                <section>
                    <div className="flex items-center gap-2 mb-4">
                        <Zap className="h-5 w-5 text-purple-400" />
                        <h2 className="text-lg font-bold">Workflows</h2>
                        <span className="text-xs text-muted-foreground">({manifest.workflows.length})</span>
                    </div>
                    <div className="space-y-2">
                        {manifest.workflows.map(wf => {
                            const isExpanded = expandedWorkflow === wf.id;
                            return (
                                <Card key={wf.id} className="bg-card border-border overflow-hidden">
                                    <button
                                        className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
                                        onClick={() => setExpandedWorkflow(isExpanded ? null : wf.id)}
                                    >
                                        <div className="shrink-0 w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center text-sm">
                                            ⚡
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-semibold">{wf.name}</span>
                                                {wf.estimatedTime && (
                                                    <Badge variant="outline" className="text-[10px]">{wf.estimatedTime}</Badge>
                                                )}
                                                {wf.tags.map(t => (
                                                    <Badge key={t} variant="outline" className="text-[10px] text-muted-foreground">{t}</Badge>
                                                ))}
                                            </div>
                                            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{wf.description}</p>
                                        </div>
                                        <Badge variant="outline" className="text-[10px] shrink-0">{wf.steps.length} steps</Badge>
                                        {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                                    </button>
                                    {isExpanded && (
                                        <div className="px-4 pb-4 border-t border-border pt-3 space-y-3">
                                            <p className="text-sm text-muted-foreground">{wf.description}</p>
                                            <div>
                                                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 block">Steps</span>
                                                <ol className="space-y-2">
                                                    {wf.steps.map((step, i) => (
                                                        <li key={i} className="flex items-start gap-3 text-sm">
                                                            <span className="shrink-0 w-6 h-6 rounded-full bg-purple-500/10 text-purple-400 flex items-center justify-center text-xs font-bold">
                                                                {i + 1}
                                                            </span>
                                                            <span className="text-muted-foreground pt-0.5">{step}</span>
                                                        </li>
                                                    ))}
                                                </ol>
                                            </div>
                                        </div>
                                    )}
                                </Card>
                            );
                        })}
                    </div>
                </section>
            )}

            {/* ═══ Agent Skills Section ═══ */}
            {manifest && manifest.agentSkills.length > 0 && (
                <section>
                    <div className="flex items-center gap-2 mb-4">
                        <Bot className="h-5 w-5 text-cyan-400" />
                        <h2 className="text-lg font-bold">Agent Skills</h2>
                        <span className="text-xs text-muted-foreground">({manifest.agentSkills.length})</span>
                    </div>
                    <p className="text-sm text-muted-foreground mb-4">
                        These are the capabilities your agents gain when this {item.type} is installed. Agents can invoke these skills during task execution.
                    </p>
                    <div className="space-y-2">
                        {manifest.agentSkills.map(skill => {
                            const isExpanded = expandedSkill === skill.id;
                            return (
                                <Card key={skill.id} className="bg-card border-border overflow-hidden">
                                    <button
                                        className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
                                        onClick={() => setExpandedSkill(isExpanded ? null : skill.id)}
                                    >
                                        <div className="shrink-0 w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center text-sm">
                                            🤖
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <code className="text-sm font-semibold text-cyan-400">{skill.invocation}</code>
                                            </div>
                                            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{skill.description}</p>
                                        </div>
                                        {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                                    </button>
                                    {isExpanded && (
                                        <div className="px-4 pb-4 border-t border-border pt-3 space-y-3">
                                            <p className="text-sm text-muted-foreground">{skill.description}</p>
                                            {skill.exampleInput && (
                                                <div>
                                                    <div className="flex items-center justify-between mb-1.5">
                                                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Example Input</span>
                                                        <button
                                                            onClick={() => copyToClipboard(skill.exampleInput!, `${skill.id}-input`)}
                                                            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                                                        >
                                                            {copiedId === `${skill.id}-input` ? <CheckCircle2 className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                                                            {copiedId === `${skill.id}-input` ? "Copied" : "Copy"}
                                                        </button>
                                                    </div>
                                                    <pre className="text-xs bg-muted/50 border border-border rounded-lg p-3 overflow-x-auto">
                                                        <code>{skill.exampleInput}</code>
                                                    </pre>
                                                </div>
                                            )}
                                            {skill.exampleOutput && (
                                                <div>
                                                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">Example Output</span>
                                                    <pre className="text-xs bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-3 overflow-x-auto">
                                                        <code className="text-emerald-400">{skill.exampleOutput}</code>
                                                    </pre>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </Card>
                            );
                        })}
                    </div>
                </section>
            )}

            {/* ═══ Examples Section ═══ */}
            {manifest && manifest.examples.length > 0 && (
                <section>
                    <div className="flex items-center gap-2 mb-4">
                        <Code2 className="h-5 w-5 text-emerald-400" />
                        <h2 className="text-lg font-bold">Code Examples</h2>
                        <span className="text-xs text-muted-foreground">({manifest.examples.length})</span>
                    </div>
                    <div className="space-y-2">
                        {manifest.examples.map(ex => {
                            const isExpanded = expandedExample === ex.id;
                            return (
                                <Card key={ex.id} className="bg-card border-border overflow-hidden">
                                    <button
                                        className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
                                        onClick={() => setExpandedExample(isExpanded ? null : ex.id)}
                                    >
                                        <div className="shrink-0 w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-sm">
                                            📝
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-semibold">{ex.name}</span>
                                                {ex.language && (
                                                    <Badge variant="outline" className="text-[10px]">{ex.language}</Badge>
                                                )}
                                                {ex.tags.map(t => (
                                                    <Badge key={t} variant="outline" className="text-[10px] text-muted-foreground">{t}</Badge>
                                                ))}
                                            </div>
                                            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{ex.description}</p>
                                        </div>
                                        {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                                    </button>
                                    {isExpanded && ex.codeSnippet && (
                                        <div className="px-4 pb-4 border-t border-border pt-3">
                                            <div className="flex items-center justify-between mb-1.5">
                                                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                                    {ex.language || "Code"}
                                                </span>
                                                <button
                                                    onClick={() => copyToClipboard(ex.codeSnippet!, ex.id)}
                                                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                                                >
                                                    {copiedId === ex.id ? <CheckCircle2 className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                                                    {copiedId === ex.id ? "Copied" : "Copy"}
                                                </button>
                                            </div>
                                            <pre className="text-xs bg-muted/50 border border-border rounded-lg p-3 overflow-x-auto">
                                                <code>{ex.codeSnippet}</code>
                                            </pre>
                                        </div>
                                    )}
                                </Card>
                            );
                        })}
                    </div>
                </section>
            )}

            {/* ═══ Footer info ═══ */}
            <Card className="p-4 bg-muted/30 border-border">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <div className="flex items-center gap-4">
                        <span>Author: <strong className="text-foreground">{item.author}</strong></span>
                        <span>Version: {item.version}</span>
                        <span>Type: <span className="capitalize">{item.type}</span></span>
                    </div>
                    <Link href="/market" className="text-amber-400 hover:underline">
                        ← Back to Market
                    </Link>
                </div>
            </Card>
        </div>
    );
}
