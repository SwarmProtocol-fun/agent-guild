/** Approvals — Governance queue for sensitive actions requiring human approval. */
"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Shield, CheckCircle2, XCircle, Clock, AlertTriangle,
    Loader2, MessageSquare, ChevronDown, ChevronUp, Filter,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useOrg } from "@/contexts/OrgContext";
import { useAuthAddress } from "@/hooks/useAuthAddress";
import {
    type Approval, type ApprovalStatus,
    APPROVAL_TYPE_CONFIG,
    getApprovals, reviewApproval, getPendingCount,
} from "@/lib/approvals";

// ═══════════════════════════════════════════════════════════════
// Approval Card
// ═══════════════════════════════════════════════════════════════

function ApprovalCard({
    approval, onReview, busy,
}: {
    approval: Approval;
    onReview: (id: string, status: "approved" | "rejected", comment?: string) => Promise<void>;
    busy: boolean;
}) {
    const [expanded, setExpanded] = useState(false);
    const [comment, setComment] = useState("");
    const [reviewing, setReviewing] = useState(false);
    const config = APPROVAL_TYPE_CONFIG[approval.type] || APPROVAL_TYPE_CONFIG.agent_action;

    const handleReview = async (status: "approved" | "rejected") => {
        setReviewing(true);
        try {
            await onReview(approval.id, status, comment || undefined);
        } finally {
            setReviewing(false);
        }
    };

    const isPending = approval.status === "pending";
    const priorityColors = {
        critical: "border-red-500/30 text-red-400",
        high: "border-orange-500/30 text-orange-400",
        medium: "border-amber-500/30 text-amber-400",
        low: "border-emerald-500/30 text-emerald-400",
    };

    return (
        <Card className={`bg-card border-border transition-all ${isPending ? "hover:border-amber-500/20" : "opacity-70"
            }`}>
            <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className="text-xl shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-muted/50">
                            {config.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                                <h3 className="font-semibold text-sm">{approval.title}</h3>
                                <Badge variant="outline" className={`text-[10px] ${config.color}`}>
                                    {config.label}
                                </Badge>
                                {approval.priority && (
                                    <Badge variant="outline" className={`text-[10px] ${priorityColors[approval.priority]}`}>
                                        {approval.priority}
                                    </Badge>
                                )}
                                {approval.status === "approved" && (
                                    <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px]">
                                        <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" /> Approved
                                    </Badge>
                                )}
                                {approval.status === "rejected" && (
                                    <Badge className="bg-red-500/10 text-red-400 border-red-500/20 text-[10px]">
                                        <XCircle className="h-2.5 w-2.5 mr-0.5" /> Rejected
                                    </Badge>
                                )}
                                {isPending && (
                                    <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-[10px]">
                                        <Clock className="h-2.5 w-2.5 mr-0.5" /> Pending
                                    </Badge>
                                )}
                            </div>
                            <p className="text-xs text-muted-foreground line-clamp-2 mb-1">{approval.description}</p>
                            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                                <span>By: {approval.requestedByName || approval.requestedBy.slice(0, 8)}...</span>
                                {approval.confidence !== undefined && (
                                    <span className="flex items-center gap-0.5">
                                        Confidence: <span className={
                                            approval.confidence >= 0.8 ? "text-emerald-400" :
                                                approval.confidence >= 0.5 ? "text-amber-400" : "text-red-400"
                                        }>{(approval.confidence * 100).toFixed(0)}%</span>
                                    </span>
                                )}
                                {approval.createdAt && (
                                    <span>{approval.createdAt.toLocaleString()}</span>
                                )}
                            </div>
                        </div>
                    </div>

                    <button
                        onClick={() => setExpanded(!expanded)}
                        className="p-1 rounded text-muted-foreground hover:text-foreground shrink-0"
                    >
                        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                </div>

                {/* Expanded Details */}
                {expanded && (
                    <div className="mt-4 pt-4 border-t border-border space-y-3">
                        {approval.payload && (
                            <div>
                                <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Payload</label>
                                <pre className="text-xs bg-muted/30 rounded p-2 overflow-x-auto max-h-32">
                                    {JSON.stringify(approval.payload, null, 2)}
                                </pre>
                            </div>
                        )}

                        {approval.reviewComment && (
                            <div>
                                <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Review Comment</label>
                                <p className="text-xs text-muted-foreground bg-muted/30 rounded p-2">{approval.reviewComment}</p>
                            </div>
                        )}

                        {isPending && (
                            <div className="space-y-2">
                                <Textarea
                                    placeholder="Optional comment..."
                                    value={comment}
                                    onChange={(e) => setComment(e.target.value)}
                                    rows={2}
                                    className="text-xs"
                                />
                                <div className="flex gap-2">
                                    <Button
                                        size="sm"
                                        onClick={() => handleReview("approved")}
                                        disabled={reviewing || busy}
                                        className="bg-emerald-500 hover:bg-emerald-600 text-white gap-1 flex-1"
                                    >
                                        {reviewing ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                                        Approve
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => handleReview("rejected")}
                                        disabled={reviewing || busy}
                                        className="border-red-500/30 text-red-400 hover:bg-red-500/10 gap-1 flex-1"
                                    >
                                        {reviewing ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                                        Reject
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </Card>
    );
}

// ═══════════════════════════════════════════════════════════════
// Main Page
// ═══════════════════════════════════════════════════════════════

export default function ApprovalsPage() {
    const { currentOrg } = useOrg();
    const authAddress = useAuthAddress();
    const [approvals, setApprovals] = useState<Approval[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<ApprovalStatus | "all">("pending");
    const [busyId, setBusyId] = useState<string | null>(null);
    const [pendingCount, setPendingCount] = useState(0);

    const loadApprovals = useCallback(async () => {
        if (!currentOrg) return;
        try {
            setLoading(true);
            const status = filter === "all" ? undefined : filter;
            const [data, count] = await Promise.all([
                getApprovals(currentOrg.id, status),
                getPendingCount(currentOrg.id),
            ]);
            setApprovals(data);
            setPendingCount(count);
        } catch (err) {
            console.error("Failed to load approvals:", err);
        } finally {
            setLoading(false);
        }
    }, [currentOrg, filter]);

    useEffect(() => { loadApprovals(); }, [loadApprovals]);

    const handleReview = async (id: string, status: "approved" | "rejected", comment?: string) => {
        if (!authAddress) return;
        setBusyId(id);
        try {
            await reviewApproval(id, {
                status,
                reviewedBy: authAddress,
                reviewComment: comment,
            });
            await loadApprovals();
        } finally {
            setBusyId(null);
        }
    };

    if (!authAddress) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-muted-foreground">
                <Shield className="h-12 w-12 opacity-30" />
                <p>Connect your wallet to review approvals</p>
            </div>
        );
    }

    const statusFilters: { key: ApprovalStatus | "all"; label: string; icon: typeof Clock }[] = [
        { key: "pending", label: `Pending (${pendingCount})`, icon: Clock },
        { key: "approved", label: "Approved", icon: CheckCircle2 },
        { key: "rejected", label: "Rejected", icon: XCircle },
        { key: "all", label: "All", icon: Filter },
    ];

    return (
        <div className="max-w-5xl mx-auto px-6 py-8">
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20">
                            <Shield className="h-6 w-6 text-amber-500" />
                        </div>
                        Approvals
                    </h1>
                    <p className="text-sm text-muted-foreground mt-2">
                        Review and approve agent actions before they execute — human-in-the-loop governance
                    </p>
                </div>
                {pendingCount > 0 && (
                    <Badge className="bg-amber-500/10 text-amber-500 border-amber-500/20 text-sm animate-pulse">
                        <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                        {pendingCount} pending
                    </Badge>
                )}
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4 mb-6">
                <Card className="p-4 bg-card border-border">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-amber-500/10"><Clock className="h-4 w-4 text-amber-400" /></div>
                        <div>
                            <p className="text-2xl font-bold">{pendingCount}</p>
                            <p className="text-xs text-muted-foreground">Pending</p>
                        </div>
                    </div>
                </Card>
                <Card className="p-4 bg-card border-border">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-emerald-500/10"><CheckCircle2 className="h-4 w-4 text-emerald-400" /></div>
                        <div>
                            <p className="text-2xl font-bold">{approvals.filter(a => a.status === "approved").length}</p>
                            <p className="text-xs text-muted-foreground">Approved</p>
                        </div>
                    </div>
                </Card>
                <Card className="p-4 bg-card border-border">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-red-500/10"><XCircle className="h-4 w-4 text-red-400" /></div>
                        <div>
                            <p className="text-2xl font-bold">{approvals.filter(a => a.status === "rejected").length}</p>
                            <p className="text-xs text-muted-foreground">Rejected</p>
                        </div>
                    </div>
                </Card>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-1.5 mb-6">
                {statusFilters.map(({ key, label, icon: Icon }) => (
                    <button
                        key={key}
                        onClick={() => setFilter(key)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${filter === key
                                ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                                : "bg-muted/50 text-muted-foreground hover:bg-muted border border-transparent"
                            }`}
                    >
                        <Icon className="h-3 w-3" />
                        {label}
                    </button>
                ))}
            </div>

            {/* Approval List */}
            {loading ? (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
                </div>
            ) : approvals.length === 0 ? (
                <Card className="p-12 text-center bg-card border-border border-dashed">
                    <Shield className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                    <h3 className="text-lg font-semibold mb-2">
                        {filter === "pending" ? "No pending approvals" : "No approvals found"}
                    </h3>
                    <p className="text-sm text-muted-foreground max-w-md mx-auto">
                        {filter === "pending"
                            ? "All caught up! Agents will request approval when they need to perform sensitive actions."
                            : "No approvals match the current filter."}
                    </p>
                </Card>
            ) : (
                <div className="space-y-3">
                    {approvals.map((approval) => (
                        <ApprovalCard
                            key={approval.id}
                            approval={approval}
                            onReview={handleReview}
                            busy={busyId === approval.id}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
