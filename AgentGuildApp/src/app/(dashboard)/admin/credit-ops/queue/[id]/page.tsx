"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ShieldAlert, Loader2, RefreshCw, ArrowLeft, CheckCircle,
  XCircle, Play, Clock, AlertTriangle, User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface ReviewItem {
  id: string;
  agentId: string;
  asn: string;
  agentAddress: string;
  orgId: string;
  flagType: string;
  flagReason: string;
  flaggedBy: string;
  sourceEventId?: string;
  currentCreditScore: number;
  currentTrustScore: number;
  currentTier: string;
  status: string;
  priority: string;
  assignedTo?: string;
  resolution?: string;
  resolutionComment?: string;
  reviewHistory: Array<{
    action: string;
    performedBy: string;
    performedAt: string;
    comment?: string;
  }>;
  flaggedAt?: { seconds: number };
  resolvedAt?: { seconds: number };
}

interface SlashingEvent {
  taskId: string;
  agentId: string;
  asn: string;
  reason: string;
  creditPenalty: number;
  trustPenalty: number;
  slashedAt?: { seconds: number };
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400 border-red-500/30",
  high: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  medium: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  low: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};

const TIER_COLORS: Record<string, string> = {
  Platinum: "text-purple-400",
  Gold: "text-amber-400",
  Silver: "text-zinc-300",
  Bronze: "text-orange-400",
};

export default function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [item, setItem] = useState<ReviewItem | null>(null);
  const [slashingHistory, setSlashingHistory] = useState<SlashingEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [comment, setComment] = useState("");
  const [resolution, setResolution] = useState("no_action");

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/credit-ops/queue/${id}`);
      if (res.ok) {
        const d = await res.json();
        setItem(d.item);
        setSlashingHistory(d.slashingHistory || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (isAdmin && id) fetchDetail();
  }, [isAdmin, id, fetchDetail]);

  async function performAction(action: string) {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/admin/credit-ops/queue/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          comment: comment || undefined,
          resolution: action === "resolve" ? resolution : undefined,
        }),
      });
      if (res.ok) {
        const d = await res.json();
        setItem(d.item);
        setComment("");
      }
    } finally {
      setActionLoading(false);
    }
  }

  if (!authenticated) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-muted-foreground">Connect your wallet to continue.</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
        <ShieldAlert className="h-12 w-12 text-red-400" />
        <h2 className="text-lg font-semibold">Access Denied</h2>
        <p className="text-sm text-muted-foreground">Platform admin wallet required.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
        <p className="text-muted-foreground">Review item not found.</p>
        <Link href="/admin/credit-ops/queue">
          <Button variant="outline" size="sm">
            <ArrowLeft className="h-4 w-4 mr-2" /> Back to Queue
          </Button>
        </Link>
      </div>
    );
  }

  const isActive = item.status === "pending" || item.status === "in_review";

  return (
    <div className="space-y-6 p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/admin/credit-ops/queue">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold">Review: {item.asn || item.agentId}</h1>
          <p className="text-sm text-muted-foreground">{item.flagReason}</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchDetail} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left column: Agent details + Flag info */}
        <div className="lg:col-span-2 space-y-4">
          {/* Agent Overview */}
          <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <User className="h-4 w-4" /> Agent Details
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-xs text-muted-foreground">ASN</span>
                <p className="font-mono text-sm">{item.asn || "N/A"}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Agent ID</span>
                <p className="font-mono text-sm truncate">{item.agentId}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Address</span>
                <p className="font-mono text-sm truncate">{item.agentAddress}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Org</span>
                <p className="font-mono text-sm truncate">{item.orgId}</p>
              </div>
            </div>

            {/* Scores */}
            <div className="flex gap-4 pt-2 border-t border-border">
              <div>
                <span className="text-xs text-muted-foreground">Credit Score</span>
                <p className="text-2xl font-bold">{item.currentCreditScore}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Trust Score</span>
                <p className="text-2xl font-bold">{item.currentTrustScore}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Tier</span>
                <p className={`text-2xl font-bold ${TIER_COLORS[item.currentTier] || ""}`}>
                  {item.currentTier}
                </p>
              </div>
            </div>
          </div>

          {/* Flag Details */}
          <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400" /> Flag Details
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-xs text-muted-foreground">Flag Type</span>
                <p className="text-sm">{item.flagType.replace(/_/g, " ")}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Flagged By</span>
                <p className="text-sm">{item.flaggedBy}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Priority</span>
                <span className={`text-xs px-2 py-1 rounded ${PRIORITY_COLORS[item.priority] || ""}`}>
                  {item.priority}
                </span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Status</span>
                <p className="text-sm">{item.status.replace(/_/g, " ")}</p>
              </div>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Reason</span>
              <p className="text-sm mt-1">{item.flagReason}</p>
            </div>
            {item.sourceEventId && (
              <div>
                <span className="text-xs text-muted-foreground">Source Event</span>
                <p className="font-mono text-xs mt-1">{item.sourceEventId}</p>
              </div>
            )}
          </div>

          {/* Slashing History */}
          {slashingHistory.length > 0 && (
            <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
              <h3 className="text-sm font-medium">Slashing History ({slashingHistory.length})</h3>
              <div className="space-y-2">
                {slashingHistory.map((event, i) => (
                  <div key={i} className="flex items-center gap-3 p-2 rounded-lg bg-muted/30">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm">{event.reason.replace(/_/g, " ")}</span>
                      <span className="text-xs text-muted-foreground ml-2">
                        Task: {event.taskId?.slice(0, 12)}...
                      </span>
                    </div>
                    <span className="text-xs text-red-400 font-mono">
                      {event.creditPenalty} credit
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column: Actions + Review Timeline */}
        <div className="space-y-4">
          {/* Actions */}
          {isActive && (
            <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
              <h3 className="text-sm font-medium">Actions</h3>

              <div>
                <label className="text-xs text-muted-foreground">Comment</label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Add review notes..."
                  className="w-full mt-1 px-3 py-2 rounded-lg border border-border bg-background text-sm resize-none h-20"
                />
              </div>

              {item.status === "pending" && (
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={() => performAction("start_review")}
                  disabled={actionLoading}
                >
                  <Play className="h-4 w-4 mr-2" />
                  Start Review
                </Button>
              )}

              <div>
                <label className="text-xs text-muted-foreground">Resolution</label>
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  className="w-full mt-1 px-3 py-2 rounded-lg border border-border bg-background text-sm"
                >
                  <option value="no_action">No Action</option>
                  <option value="override_applied">Override Applied</option>
                  <option value="penalty_increased">Penalty Increased</option>
                  <option value="penalty_reversed">Penalty Reversed</option>
                  <option value="appeal_granted">Appeal Granted</option>
                </select>
              </div>

              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  onClick={() => performAction("resolve")}
                  disabled={actionLoading}
                >
                  <CheckCircle className="h-4 w-4 mr-1" /> Resolve
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => performAction("dismiss")}
                  disabled={actionLoading}
                >
                  <XCircle className="h-4 w-4 mr-1" /> Dismiss
                </Button>
              </div>
            </div>
          )}

          {/* Resolution (if resolved) */}
          {item.resolution && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-2">
              <h3 className="text-sm font-medium text-emerald-400">Resolved</h3>
              <p className="text-sm">{item.resolution.replace(/_/g, " ")}</p>
              {item.resolutionComment && (
                <p className="text-xs text-muted-foreground">{item.resolutionComment}</p>
              )}
            </div>
          )}

          {/* Review Timeline */}
          <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4" /> Review Timeline
            </h3>
            {item.reviewHistory.length === 0 ? (
              <p className="text-xs text-muted-foreground">No review activity yet</p>
            ) : (
              <div className="space-y-2">
                {item.reviewHistory.map((entry, i) => (
                  <div key={i} className="flex gap-2 text-xs">
                    <div className="w-1 bg-border rounded-full shrink-0" />
                    <div>
                      <p className="font-medium">
                        {entry.action.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                      </p>
                      <p className="text-muted-foreground">
                        by {entry.performedBy} &middot;{" "}
                        {new Date(entry.performedAt).toLocaleString()}
                      </p>
                      {entry.comment && (
                        <p className="text-muted-foreground mt-0.5 italic">{entry.comment}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
