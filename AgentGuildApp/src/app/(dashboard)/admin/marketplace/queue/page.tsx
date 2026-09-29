"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ShieldAlert, Loader2, RefreshCw, CheckCircle, XCircle, ArrowRight,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface QueueItem {
  id: string;
  source: string;
  name: string;
  submittedBy: string;
  stage: string;
  publisherTier: number;
  submittedAt?: { seconds: number };
  type: string;
}

const STAGES = ["all", "security_scan", "sandbox", "product_review"] as const;
const STAGE_LABELS: Record<string, string> = {
  all: "All",
  security_scan: "Security Scan",
  sandbox: "Sandbox",
  product_review: "Product Review",
};

const TIER_LABELS: Record<number, string> = { 0: "New", 1: "Approved", 2: "Trusted", 3: "Strategic" };
const TIER_COLORS: Record<number, string> = {
  0: "bg-zinc-500/20 text-zinc-400",
  1: "bg-blue-500/20 text-blue-400",
  2: "bg-amber-500/20 text-amber-400",
  3: "bg-purple-500/20 text-purple-400",
};

export default function QueuePage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState<string>("all");
  const [colFilter, setColFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (stageFilter !== "all") params.set("stage", stageFilter);
      if (colFilter !== "all") params.set("collection", colFilter);
      params.set("sort", "oldest");

      const res = await fetch(`/api/admin/marketplace/queue?${params}`);
      if (res.ok) {
        const d = await res.json();
        setItems(d.items || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [stageFilter, colFilter]);

  useEffect(() => {
    if (isAdmin) fetchQueue();
  }, [isAdmin, fetchQueue]);

  async function reviewAction(action: string, itemIds: string[], collection?: string) {
    const key = `${action}-${itemIds.join(",")}`;
    setActionLoading(key);
    try {
      await fetch("/api/admin/marketplace/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          itemIds,
          collection: collection || "community",
        }),
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
        <h1 className="text-2xl font-bold">Review Queue</h1>
        <Button variant="outline" size="sm" onClick={fetchQueue} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {/* Stage filter */}
        <div className="flex gap-1 bg-muted/50 rounded-lg p-1">
          {STAGES.map((s) => (
            <Button
              key={s}
              variant={stageFilter === s ? "default" : "ghost"}
              size="sm"
              onClick={() => setStageFilter(s)}
              className="text-xs"
            >
              {STAGE_LABELS[s]}
            </Button>
          ))}
        </div>

        {/* Collection filter */}
        <div className="flex gap-1 bg-muted/50 rounded-lg p-1">
          {(["all", "community", "agents"] as const).map((c) => (
            <Button
              key={c}
              variant={colFilter === c ? "default" : "ghost"}
              size="sm"
              onClick={() => setColFilter(c)}
              className="text-xs"
            >
              {c === "all" ? "All" : c.charAt(0).toUpperCase() + c.slice(1)}
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
            onClick={() => reviewAction("advance", [...selected])}
            disabled={!!actionLoading}
          >
            <ArrowRight className="h-3 w-3 mr-1" /> Advance
          </Button>
          <Button
            size="sm"
            onClick={() => reviewAction("approve", [...selected])}
            disabled={!!actionLoading}
          >
            <CheckCircle className="h-3 w-3 mr-1" /> Approve
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => reviewAction("reject", [...selected])}
            disabled={!!actionLoading}
          >
            <XCircle className="h-3 w-3 mr-1" /> Reject
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
              checked={selected.size === items.length}
              onChange={toggleSelectAll}
              className="rounded"
            />
            <span className="flex-1">Name</span>
            <span className="w-24">Source</span>
            <span className="w-28">Stage</span>
            <span className="w-20">Tier</span>
            <span className="w-24">Submitted</span>
            <span className="w-36">Actions</span>
          </div>

          {items.map((item) => (
            <div
              key={`${item.source}-${item.id}`}
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
                  href={`/admin/marketplace/queue/${item.id}?source=${item.source}`}
                  className="font-medium truncate block hover:text-amber-400 transition-colors"
                >
                  {item.name}
                </Link>
                <span className="text-xs text-muted-foreground">
                  by {item.submittedBy?.slice(0, 10)}...
                </span>
              </div>
              <span className="w-24">
                <span className="text-xs px-1.5 py-0.5 rounded bg-muted font-mono">{item.source}</span>
              </span>
              <span className="w-28">
                <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">
                  {item.stage.replace(/_/g, " ")}
                </span>
              </span>
              <span className="w-20">
                <span className={`text-xs px-1.5 py-0.5 rounded ${TIER_COLORS[item.publisherTier] || TIER_COLORS[0]}`}>
                  T{item.publisherTier} {TIER_LABELS[item.publisherTier]}
                </span>
              </span>
              <span className="w-24 text-xs text-muted-foreground">
                {item.submittedAt
                  ? new Date(item.submittedAt.seconds * 1000).toLocaleDateString()
                  : "—"}
              </span>
              <div className="w-36 flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => reviewAction("advance", [item.id], item.source)}
                  disabled={!!actionLoading}
                  title="Advance to next stage"
                >
                  {actionLoading === `advance-${item.id}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ArrowRight className="h-3 w-3" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => reviewAction("approve", [item.id], item.source)}
                  disabled={!!actionLoading}
                  title="Approve"
                >
                  {actionLoading === `approve-${item.id}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <CheckCircle className="h-3 w-3 text-green-400" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => reviewAction("reject", [item.id], item.source)}
                  disabled={!!actionLoading}
                  title="Reject"
                >
                  {actionLoading === `reject-${item.id}` ? (
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
