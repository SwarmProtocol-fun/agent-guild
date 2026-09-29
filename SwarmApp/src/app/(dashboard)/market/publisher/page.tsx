"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Store, Star, Download, Shield, Crown, Loader2, Clock,
    CheckCircle2, XCircle, AlertTriangle, MessageSquare, RefreshCw, Plus, Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useSession } from "@/contexts/SessionContext";
import { useWalletAccount } from "@/lib/wallet";
import { trackEvent } from "@/lib/posthog-client";
const trackMarketplaceEvent = (event: string, properties?: Record<string, unknown>) =>
    trackEvent(`marketplace.${event}`, properties);

const TIER_STYLES: Record<number, { label: string; color: string; icon: typeof Shield }> = {
    0: { label: "New Publisher", color: "border-zinc-500/30 text-zinc-400 bg-zinc-500/5", icon: Shield },
    1: { label: "Approved", color: "border-emerald-500/30 text-emerald-400 bg-emerald-500/5", icon: Shield },
    2: { label: "Trusted", color: "border-blue-500/30 text-blue-400 bg-blue-500/5", icon: Shield },
    3: { label: "Strategic Partner", color: "border-amber-500/30 text-amber-400 bg-amber-500/5", icon: Crown },
};

const STATUS_STYLES: Record<string, { label: string; color: string; icon: typeof Clock }> = {
    pending: { label: "Pending", color: "bg-amber-500/10 text-amber-400 border-amber-500/20", icon: Clock },
    approved: { label: "Approved", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20", icon: CheckCircle2 },
    rejected: { label: "Rejected", color: "bg-red-500/10 text-red-400 border-red-500/20", icon: XCircle },
    changes_requested: { label: "Changes Requested", color: "bg-orange-500/10 text-orange-400 border-orange-500/20", icon: AlertTriangle },
    suspended: { label: "Suspended", color: "bg-red-500/10 text-red-400 border-red-500/20", icon: AlertTriangle },
    review: { label: "In Review", color: "bg-blue-500/10 text-blue-400 border-blue-500/20", icon: Clock },
};

interface PublisherProfile {
    wallet: string;
    displayName: string;
    tier: number;
    tierName: string;
    stats: {
        totalSubmissions: number;
        approvedCount: number;
        rejectedCount: number;
        avgRating: number;
        totalInstalls: number;
    };
    quota: { maxPerWeek: number; cooldownMs: number };
    banned: boolean;
    memberSince: string | null;
}

interface PublisherItem {
    id: string;
    name: string;
    type: string;
    category: string;
    icon: string;
    description: string;
    version: string;
    status: string;
    submittedAt: string;
    pricing: { model: string };
    tags: string[];
    collection: "community" | "agents";
    installCount?: number;
    avgRating?: number;
    ratingCount?: number;
}

const STATUS_TABS = ["all", "pending", "approved", "rejected", "suspended"] as const;

export default function PublisherPage() {
    const account = useWalletAccount();
    const { address: sessionAddress, authenticated } = useSession();
    const address = account?.address?.toLowerCase() || sessionAddress?.toLowerCase() || "";

    const [profile, setProfile] = useState<PublisherProfile | null>(null);
    const [items, setItems] = useState<PublisherItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState<string>("all");
    const [appealItem, setAppealItem] = useState<PublisherItem | null>(null);
    const [appealComment, setAppealComment] = useState("");
    const [appealLoading, setAppealLoading] = useState(false);

    // Submission dialog state
    const [showSubmitDialog, setShowSubmitDialog] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [submitForm, setSubmitForm] = useState({
        name: "",
        type: "mod" as const,
        category: "",
        icon: "📦",
        description: "",
        version: "1.0.0",
        tags: "",
        demoUrl: "",
        repoUrl: "",
    });

    const fetchData = useCallback(async () => {
        if (!address) return;
        setLoading(true);
        try {
            const [profileRes, itemsRes] = await Promise.all([
                fetch(`/api/v1/marketplace/publisher/${address}`, {
                    headers: { "x-wallet-address": address },
                }),
                fetch(`/api/v1/marketplace/my-items${statusFilter !== "all" ? `?status=${statusFilter}` : ""}`, {
                    headers: { "x-wallet-address": address },
                }),
            ]);

            if (profileRes.ok) {
                setProfile(await profileRes.json());
            }
            if (itemsRes.ok) {
                const data = await itemsRes.json();
                setItems(data.items || []);
            }
        } catch {
            // silent
        } finally {
            setLoading(false);
        }
    }, [address, statusFilter]);

    useEffect(() => {
        if (address) {
            fetchData();
            trackMarketplaceEvent("publisher_viewed");
        }
    }, [address, fetchData]);

    async function submitAppeal() {
        if (!appealItem || !appealComment.trim()) return;
        setAppealLoading(true);
        try {
            await fetch("/api/v1/marketplace/appeal", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-wallet-address": address,
                },
                body: JSON.stringify({
                    itemId: appealItem.id,
                    comment: appealComment.trim(),
                    collection: appealItem.collection,
                }),
            });
            trackMarketplaceEvent("appeal_submitted", { itemId: appealItem.id });
            setAppealItem(null);
            setAppealComment("");
            fetchData();
        } finally {
            setAppealLoading(false);
        }
    }

    async function handleSubmitToMarketplace() {
        if (!submitForm.name.trim() || !submitForm.description.trim() || !submitForm.category.trim()) {
            return;
        }

        setSubmitting(true);
        try {
            const tags = submitForm.tags.split(",").map(t => t.trim()).filter(Boolean);
            const res = await fetch("/api/v1/marketplace/publish", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-wallet-address": address,
                },
                body: JSON.stringify({
                    name: submitForm.name.trim(),
                    type: submitForm.type,
                    category: submitForm.category.trim(),
                    icon: submitForm.icon,
                    description: submitForm.description.trim(),
                    version: submitForm.version.trim() || "1.0.0",
                    tags,
                    demoUrl: submitForm.demoUrl.trim() || undefined,
                    repoUrl: submitForm.repoUrl.trim() || undefined,
                    submissionType: "build",
                    submissionTrack: submitForm.repoUrl.trim() ? "open_repo" : "prd_only",
                }),
            });

            const data = await res.json();

            if (res.ok) {
                trackMarketplaceEvent("item_submitted", {
                    itemId: data.id,
                    type: submitForm.type,
                    status: data.status,
                });
                // Reset form
                setSubmitForm({
                    name: "",
                    type: "mod",
                    category: "",
                    icon: "📦",
                    description: "",
                    version: "1.0.0",
                    tags: "",
                    demoUrl: "",
                    repoUrl: "",
                });
                setShowSubmitDialog(false);
                // Refresh items list
                fetchData();
            } else {
                alert(`Submission failed: ${data.error || "Unknown error"}`);
            }
        } catch (err) {
            alert(`Submission failed: ${err instanceof Error ? err.message : "Network error"}`);
        } finally {
            setSubmitting(false);
        }
    }

    if (!authenticated) {
        return (
            <div className="flex items-center justify-center h-[60vh]">
                <p className="text-muted-foreground">Connect your wallet to view your publisher dashboard.</p>
            </div>
        );
    }

    return (
        <div className="space-y-6 p-6 max-w-5xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <Store className="h-6 w-6 text-amber-400" />
                    <h1 className="text-2xl font-bold">Publisher Dashboard</h1>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        variant="default"
                        size="sm"
                        onClick={() => setShowSubmitDialog(true)}
                        className="bg-amber-600 hover:bg-amber-700 text-white"
                    >
                        <Upload className="h-4 w-4 mr-2" />
                        Submit to Marketplace
                    </Button>
                    <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
                        <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
                        Refresh
                    </Button>
                </div>
            </div>

            {loading && !profile ? (
                <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
            ) : (
                <>
                    {/* Publisher Profile Card */}
                    {profile && (
                        <Card className="p-6 bg-card/50 border-border">
                            <div className="flex flex-col md:flex-row md:items-center gap-6">
                                <div className="flex items-center gap-4 flex-1">
                                    <div className="h-14 w-14 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                                        {(() => {
                                            const TierIcon = TIER_STYLES[profile.tier]?.icon || Shield;
                                            return <TierIcon className="h-7 w-7 text-amber-400" />;
                                        })()}
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2 mb-1">
                                            <h2 className="text-lg font-bold">{profile.displayName}</h2>
                                            <Badge className={`text-[10px] ${TIER_STYLES[profile.tier]?.color || ""}`}>
                                                T{profile.tier} {TIER_STYLES[profile.tier]?.label}
                                            </Badge>
                                        </div>
                                        <p className="text-xs text-muted-foreground font-mono">
                                            {profile.wallet.slice(0, 10)}...{profile.wallet.slice(-6)}
                                        </p>
                                        {profile.memberSince && (
                                            <p className="text-[10px] text-muted-foreground mt-0.5">
                                                Member since {new Date(profile.memberSince).toLocaleDateString()}
                                            </p>
                                        )}
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                                    <div className="rounded-lg border border-border bg-card/30 p-3 text-center">
                                        <p className="text-lg font-bold">{profile.stats.totalSubmissions}</p>
                                        <p className="text-[10px] text-muted-foreground">Submitted</p>
                                    </div>
                                    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-center">
                                        <p className="text-lg font-bold text-emerald-400">{profile.stats.approvedCount}</p>
                                        <p className="text-[10px] text-muted-foreground">Approved</p>
                                    </div>
                                    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-center">
                                        <p className="text-lg font-bold text-red-400">{profile.stats.rejectedCount}</p>
                                        <p className="text-[10px] text-muted-foreground">Rejected</p>
                                    </div>
                                    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-center">
                                        <p className="text-lg font-bold text-amber-400">
                                            {profile.stats.avgRating > 0 ? profile.stats.avgRating.toFixed(1) : "—"}
                                        </p>
                                        <p className="text-[10px] text-muted-foreground">Avg Rating</p>
                                    </div>
                                    <div className="rounded-lg border border-border bg-card/30 p-3 text-center">
                                        <p className="text-lg font-bold">{profile.stats.totalInstalls}</p>
                                        <p className="text-[10px] text-muted-foreground">Installs</p>
                                    </div>
                                </div>
                            </div>

                            {/* Quota bar */}
                            <div className="mt-4 pt-4 border-t border-border flex items-center gap-4 text-xs text-muted-foreground">
                                <span>Weekly quota: <strong className="text-foreground">{profile.quota.maxPerWeek}</strong>/week</span>
                                {profile.quota.cooldownMs > 0 && (
                                    <span>Cooldown: <strong className="text-foreground">{Math.round(profile.quota.cooldownMs / 3600000)}h</strong></span>
                                )}
                                {profile.banned && (
                                    <Badge className="bg-red-500/10 text-red-400 border-red-500/20 text-[10px]">
                                        <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> Banned
                                    </Badge>
                                )}
                            </div>
                        </Card>
                    )}

                    {/* Status Filter Tabs */}
                    <div className="flex items-center gap-1">
                        {STATUS_TABS.map((s) => (
                            <button
                                key={s}
                                onClick={() => setStatusFilter(s)}
                                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                                    statusFilter === s
                                        ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                                        : "bg-muted/50 text-muted-foreground hover:bg-muted border border-transparent"
                                }`}
                            >
                                {s === "all" ? "All Items" : s.charAt(0).toUpperCase() + s.slice(1).replace("_", " ")}
                            </button>
                        ))}
                    </div>

                    {/* Items Grid */}
                    {items.length === 0 ? (
                        <Card className="p-12 text-center bg-card border-border border-dashed">
                            <Store className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                            <h3 className="text-lg font-semibold mb-2">No items found</h3>
                            <p className="text-sm text-muted-foreground">
                                {statusFilter === "all"
                                    ? "You haven't published any marketplace items yet."
                                    : `No items with status "${statusFilter}".`}
                            </p>
                        </Card>
                    ) : (
                        <div className="space-y-2">
                            {items.map((item) => {
                                const statusStyle = STATUS_STYLES[item.status] || STATUS_STYLES.pending;
                                const StatusIcon = statusStyle.icon;
                                return (
                                    <Card key={item.id} className="p-4 bg-card/50 border-border hover:border-border/80 transition-colors">
                                        <div className="flex items-start gap-4">
                                            <div className="text-2xl shrink-0 w-10 h-10 flex items-center justify-center rounded-lg bg-muted/50">
                                                {item.icon}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <h3 className="font-semibold text-sm truncate">{item.name}</h3>
                                                    <span className="text-[10px] text-muted-foreground">v{item.version}</span>
                                                    <Badge className={`text-[10px] ${statusStyle.color}`}>
                                                        <StatusIcon className="h-2.5 w-2.5 mr-0.5" />
                                                        {statusStyle.label}
                                                    </Badge>
                                                    <Badge variant="outline" className="text-[10px] capitalize">{item.type}</Badge>
                                                </div>
                                                <p className="text-xs text-muted-foreground line-clamp-1 mb-2">{item.description}</p>
                                                <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                                                    {item.submittedAt && (
                                                        <span className="flex items-center gap-0.5">
                                                            <Clock className="h-2.5 w-2.5" />
                                                            {new Date(item.submittedAt).toLocaleDateString()}
                                                        </span>
                                                    )}
                                                    {item.installCount != null && (
                                                        <span className="flex items-center gap-0.5">
                                                            <Download className="h-2.5 w-2.5" />
                                                            {item.installCount} installs
                                                        </span>
                                                    )}
                                                    {(item.avgRating ?? 0) > 0 && (
                                                        <span className="flex items-center gap-0.5">
                                                            <Star className="h-2.5 w-2.5 text-amber-400 fill-amber-400" />
                                                            {item.avgRating!.toFixed(1)} ({item.ratingCount ?? 0})
                                                        </span>
                                                    )}
                                                    <Badge variant="outline" className="text-[10px]">{item.category}</Badge>
                                                    {item.pricing?.model !== "free" && (
                                                        <Badge variant="outline" className="text-[10px] border-amber-500/20 text-amber-400 capitalize">
                                                            {item.pricing?.model}
                                                        </Badge>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="shrink-0 flex gap-1">
                                                {(item.status === "rejected" || item.status === "suspended") && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => { setAppealItem(item); setAppealComment(""); }}
                                                        className="text-xs gap-1"
                                                    >
                                                        <MessageSquare className="h-3 w-3" />
                                                        Appeal
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    </Card>
                                );
                            })}
                        </div>
                    )}
                </>
            )}

            {/* Appeal Dialog */}
            <Dialog open={!!appealItem} onOpenChange={(open) => { if (!open) setAppealItem(null); }}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Appeal: {appealItem?.name}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                            Explain why this item should be reconsidered. Your appeal will be reviewed by the marketplace team.
                        </p>
                        <textarea
                            placeholder="Describe your appeal (required)"
                            value={appealComment}
                            onChange={(e) => setAppealComment(e.target.value.slice(0, 1000))}
                            className="w-full h-28 rounded-lg border border-border bg-muted/30 p-3 text-sm resize-none"
                        />
                        <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => setAppealItem(null)}>Cancel</Button>
                            <Button
                                size="sm"
                                onClick={submitAppeal}
                                disabled={!appealComment.trim() || appealLoading}
                                className="bg-amber-600 hover:bg-amber-700 text-white gap-1"
                            >
                                {appealLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />}
                                Submit Appeal
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Submit to Marketplace Dialog */}
            <Dialog open={showSubmitDialog} onOpenChange={setShowSubmitDialog}>
                <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>Submit to Marketplace</DialogTitle>
                        <DialogDescription>
                            Submit a new mod, plugin, skill, skin, or agent to the Swarm marketplace.
                            All submissions are reviewed before approval.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        {/* Name */}
                        <div className="space-y-2">
                            <Label htmlFor="name">Name *</Label>
                            <Input
                                id="name"
                                placeholder="My Awesome Mod"
                                value={submitForm.name}
                                onChange={(e) => setSubmitForm({ ...submitForm, name: e.target.value.slice(0, 100) })}
                                maxLength={100}
                            />
                        </div>

                        {/* Type & Category */}
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="type">Type *</Label>
                                <Select
                                    value={submitForm.type}
                                    onValueChange={(value) => setSubmitForm({ ...submitForm, type: value as typeof submitForm.type })}
                                >
                                    <SelectTrigger id="type">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="mod">Mod</SelectItem>
                                        <SelectItem value="plugin">Plugin</SelectItem>
                                        <SelectItem value="skill">Skill</SelectItem>
                                        <SelectItem value="skin">Skin</SelectItem>
                                        <SelectItem value="agent">Agent</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="category">Category *</Label>
                                <Input
                                    id="category"
                                    placeholder="Productivity, Security, etc."
                                    value={submitForm.category}
                                    onChange={(e) => setSubmitForm({ ...submitForm, category: e.target.value.slice(0, 50) })}
                                    maxLength={50}
                                />
                            </div>
                        </div>

                        {/* Icon & Version */}
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="icon">Icon (emoji)</Label>
                                <Input
                                    id="icon"
                                    placeholder="📦"
                                    value={submitForm.icon}
                                    onChange={(e) => setSubmitForm({ ...submitForm, icon: e.target.value.slice(0, 10) })}
                                    maxLength={10}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="version">Version</Label>
                                <Input
                                    id="version"
                                    placeholder="1.0.0"
                                    value={submitForm.version}
                                    onChange={(e) => setSubmitForm({ ...submitForm, version: e.target.value.slice(0, 20) })}
                                    maxLength={20}
                                />
                            </div>
                        </div>

                        {/* Description */}
                        <div className="space-y-2">
                            <Label htmlFor="description">Description *</Label>
                            <Textarea
                                id="description"
                                placeholder="A detailed description of your submission..."
                                value={submitForm.description}
                                onChange={(e) => setSubmitForm({ ...submitForm, description: e.target.value.slice(0, 2000) })}
                                className="h-24 resize-none"
                                maxLength={2000}
                            />
                            <p className="text-xs text-muted-foreground">
                                {submitForm.description.length}/2000 characters
                            </p>
                        </div>

                        {/* Tags */}
                        <div className="space-y-2">
                            <Label htmlFor="tags">Tags (comma-separated)</Label>
                            <Input
                                id="tags"
                                placeholder="automation, productivity, ai"
                                value={submitForm.tags}
                                onChange={(e) => setSubmitForm({ ...submitForm, tags: e.target.value })}
                            />
                        </div>

                        {/* URLs */}
                        <div className="space-y-2">
                            <Label htmlFor="demoUrl">Demo URL (recommended)</Label>
                            <Input
                                id="demoUrl"
                                type="url"
                                placeholder="https://example.com/demo"
                                value={submitForm.demoUrl}
                                onChange={(e) => setSubmitForm({ ...submitForm, demoUrl: e.target.value.slice(0, 500) })}
                                maxLength={500}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="repoUrl">Repository URL (for open source)</Label>
                            <Input
                                id="repoUrl"
                                type="url"
                                placeholder="https://github.com/user/repo"
                                value={submitForm.repoUrl}
                                onChange={(e) => setSubmitForm({ ...submitForm, repoUrl: e.target.value.slice(0, 500) })}
                                maxLength={500}
                            />
                        </div>

                        {/* Submit Actions */}
                        <div className="flex justify-end gap-2 pt-4 border-t border-border">
                            <Button variant="outline" onClick={() => setShowSubmitDialog(false)} disabled={submitting}>
                                Cancel
                            </Button>
                            <Button
                                onClick={handleSubmitToMarketplace}
                                disabled={!submitForm.name.trim() || !submitForm.description.trim() || !submitForm.category.trim() || submitting}
                                className="bg-amber-600 hover:bg-amber-700 text-white"
                            >
                                {submitting ? (
                                    <>
                                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                        Submitting...
                                    </>
                                ) : (
                                    <>
                                        <Upload className="h-4 w-4 mr-2" />
                                        Submit for Review
                                    </>
                                )}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
