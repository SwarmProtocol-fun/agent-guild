"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ShieldAlert, Loader2, RefreshCw, CheckCircle, XCircle,
  Play, UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface QueueItem {
  id: string;
  agentId: string;
  asn: string;
  orgId: string;
  flagType: string;
  flagReason: string;
  flaggedBy: string;
  currentCreditScore: number;
  currentTrustScore: number;
  currentTier: string;
  status: string;
  priority: string;
  assignedTo?: string;
  flaggedAt?: { seconds: number };
}

const STATUS_OPTIONS = ["all", "pending", "in_review", "resolved", "dismissed"] as const;
const PRIORITY_OPTIONS = ["all", "critical", "high", "medium", "low"] as const;
const FLAG_TYPE_OPTIONS = ["all", "slashing", "anomaly", "fraud", "manual", "appeal_trigger"] as const;

const PRIORITY_COLORS: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400",
  high: "bg-amber-500/20 text-amber-400",
  medium: "bg-blue-500/20 text-blue-400",
  low: "bg-zinc-500/20 text-zinc-400",
};

const FLAG_TYPE_COLORS: Record<string, string> = {
  slashing: "bg-red-500/20 text-red-400",
  anomaly: "bg-purple-500/20 text-purple-400",
  fraud: "bg-red-600/20 text-red-500",
  manual: "bg-cyan-500/20 text-cyan-400",
  appeal_trigger: "bg-emerald-500/20 text-emerald-400",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-500/20 text-amber-400",
  in_review: "bg-blue-500/20 text-blue-400",
  resolved: "bg-emerald-500/20 text-emerald-400",
  dismissed: "bg-zinc-500/20 text-zinc-400",
};

export default function CreditOpsQueuePage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [flagTypeFilter, setFlagTypeFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (priorityFilter !== "all") params.set("priority", priorityFilter);
      if (flagTypeFilter !== "all") params.set("flagType", flagTypeFilter);
      params.set("sort", "newest");

      const res = await fetch(`/api/admin/credit-ops/queue?${params}`);
      if (res.ok) {
        const d = await res.json();
        setItems(d.items || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [statusFilter, priorityFilter, flagTypeFilter]);

  useEffect(() => {
    if (isAdmin) fetchQueue();
  }, [isAdmin, fetchQueue]);

  async function batchAction(action: string, itemIds: string[]) {
    const key = `${action}-${itemIds.join(",")}`;
    setActionLoading(key);
    try {
      await fetch("/api/admin/credit-ops/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, itemIds }),
      });
      setSelected(new Set());
      await fetchQueue();
    } finally {
      setActionLoading(null);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((i) => i.id)));
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

  return (
    <div className="space-y-6 p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Review Queue</h1>
          <p className="text-sm text-muted-foreground mt-1">Flagged agents awaiting credit review</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchQueue} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {/* Status filter */}
        <div className="flex gap-1 bg-muted/50 rounded-lg p-1">
          {STATUS_OPTIONS.map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? "default" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter(s)}
              className="text-xs"
            >
              {s === "all" ? "All" : s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
            </Button>
          ))}
        </div>

        {/* Priority filter */}
        <div className="flex gap-1 bg-muted/50 rounded-lg p-1">
          {PRIORITY_OPTIONS.map((p) => (
            <Button
              key={p}
              variant={priorityFilter === p ? "default" : "ghost"}
              size="sm"
              onClick={() => setPriorityFilter(p)}
              className="text-xs"
            >
              {p === "all" ? "Priority" : p.charAt(0).toUpperCase() + p.slice(1)}
            </Button>
          ))}
        </div>

        {/* Flag type filter */}
        <div className="flex gap-1 bg-muted/50 rounded-lg p-1">
          {FLAG_TYPE_OPTIONS.map((f) => (
            <Button
              key={f}
              variant={flagTypeFilter === f ? "default" : "ghost"}
              size="sm"
              onClick={() => setFlagTypeFilter(f)}
              className="text-xs"
            >
              {f === "all" ? "Flag Type" : f.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
            </Button>
          ))}
        </div>
      </div>

      {/* Batch action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            onClick={() => batchAction("start_review", [...selected])}
            disabled={!!actionLoading}
          >
            <Play className="h-3 w-3 mr-1" /> Start Review
          </Button>
          <Button
            size="sm"
            onClick={() => batchAction("resolve", [...selected])}
            disabled={!!actionLoading}
          >
            <CheckCircle className="h-3 w-3 mr-1" /> Resolve
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => batchAction("dismiss", [...selected])}
            disabled={!!actionLoading}
          >
            <XCircle className="h-3 w-3 mr-1" /> Dismiss
          </Button>
        </div>
      )}

      {/* Queue list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>Queue is empty</p>
        </div>
      ) : (
        <div className="space-y-1">
          {/* Header row */}
          <div className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground font-medium">
            <input
              type="checkbox"
              checked={selected.size === items.length && items.length > 0}
              onChange={toggleSelectAll}
              className="rounded"
            />
            <span className="flex-1">Agent</span>
            <span className="w-24">Flag Type</span>
            <span className="w-20">Priority</span>
            <span className="w-20">Status</span>
            <span className="w-28">Scores</span>
            <span className="w-24">Flagged</span>
            <span className="w-28">Actions</span>
          </div>

          {items.map((item) => (
            <div
              key={item.id}
              className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                selected.has(item.id) ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card/50"
              }`}
            >
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onChange={() => toggleSelect(item.id)}
                className="rounded"
              />
              <div className="flex-1 min-w-0">
                <Link
                  href={`/admin/credit-ops/queue/${item.id}`}
                  className="font-medium truncate block hover:text-cyan-400 transition-colors"
                >
                  {item.asn || item.agentId}
                </Link>
                <span className="text-xs text-muted-foreground truncate block">
                  {item.flagReason?.slice(0, 60)}{item.flagReason?.length > 60 ? "..." : ""}
                </span>
              </div>
              <span className="w-24">
                <span className={`text-xs px-1.5 py-0.5 rounded ${FLAG_TYPE_COLORS[item.flagType] || "bg-muted"}`}>
                  {item.flagType.replace(/_/g, " ")}
                </span>
              </span>
              <span className="w-20">
                <span className={`text-xs px-1.5 py-0.5 rounded ${PRIORITY_COLORS[item.priority] || "bg-muted"}`}>
                  {item.priority}
                </span>
              </span>
              <span className="w-20">
                <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[item.status] || "bg-muted"}`}>
                  {item.status.replace(/_/g, " ")}
                </span>
              </span>
              <span className="w-28">
                <span className="text-xs font-mono">
                  C:{item.currentCreditScore} T:{item.currentTrustScore}
                </span>
              </span>
              <span className="w-24 text-xs text-muted-foreground">
                {item.flaggedAt
                  ? new Date(item.flaggedAt.seconds * 1000).toLocaleDateString()
                  : "\u2014"}
              </span>
              <div className="w-28 flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => batchAction("start_review", [item.id])}
                  disabled={!!actionLoading || item.status !== "pending"}
                  title="Start Review"
                >
                  {actionLoading === `start_review-${item.id}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => batchAction("resolve", [item.id])}
                  disabled={!!actionLoading || item.status === "resolved"}
                  title="Resolve"
                >
                  {actionLoading === `resolve-${item.id}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <CheckCircle className="h-3 w-3 text-green-400" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => batchAction("dismiss", [item.id])}
                  disabled={!!actionLoading || item.status === "dismissed"}
                  title="Dismiss"
                >
                  {actionLoading === `dismiss-${item.id}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <XCircle className="h-3 w-3 text-red-400" />
                  )}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
