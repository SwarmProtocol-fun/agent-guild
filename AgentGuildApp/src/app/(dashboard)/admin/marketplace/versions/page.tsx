"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, ChevronDown, History, ArrowRight,
  Package,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface VersionStats {
  totalWithVersions: number;
  pendingUpdates: number;
  totalVersionBumps: number;
}

interface VersionItem {
  id: string;
  source: string;
  name: string;
  version: string;
  previousVersion?: string;
  updateOf?: string;
  status: string;
  submittedBy: string;
  submittedAt?: { seconds: number };
  parentItem?: {
    id: string;
    name: string;
    version: string;
    status: string;
  };
}

const FILTER_TABS = ["all", "has_versions", "pending_update"] as const;
const FILTER_LABELS: Record<string, string> = {
  all: "All",
  has_versions: "Has Versions",
  pending_update: "Pending Updates",
};

const STATUS_COLORS: Record<string, string> = {
  approved: "bg-green-500/20 text-green-400",
  suspended: "bg-red-500/20 text-red-400",
  rejected: "bg-red-500/20 text-red-400",
  pending: "bg-amber-500/20 text-amber-400",
  review: "bg-amber-500/20 text-amber-400",
  reverted: "bg-zinc-500/20 text-zinc-400",
};

export default function VersionsPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [stats, setStats] = useState<VersionStats | null>(null);
  const [items, setItems] = useState<VersionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [bumpVersions, setBumpVersions] = useState<Record<string, string>>({});

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("filter", filter);

      const res = await fetch(`/api/admin/marketplace/versions?${params}`);
      if (res.ok) {
        const d = await res.json();
        setStats(d.stats);
        setItems(d.items || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    if (isAdmin) fetchData();
  }, [isAdmin, fetchData]);

  async function versionAction(action: string, itemId: string, collection: string, newVersion?: string) {
    setActionLoading(`${action}-${itemId}`);
    try {
      await fetch("/api/admin/marketplace/versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, itemId, collection, newVersion }),
      });
      await fetchData();
    } finally {
      setActionLoading(null);
    }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
        <div className="flex items-center gap-3">
          <History className="h-6 w-6 text-amber-400" />
          <h1 className="text-2xl font-bold">Versions</h1>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stat Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div className="rounded-xl border border-border bg-card/50 p-3">
            <span className="text-xs text-muted-foreground">Items with Versions</span>
            <p className="text-2xl font-bold mt-1">{stats.totalWithVersions}</p>
          </div>
          <div className={`rounded-xl border p-3 ${stats.pendingUpdates > 0 ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card/50"}`}>
            <span className="text-xs text-muted-foreground">Pending Updates</span>
            <p className={`text-2xl font-bold mt-1 ${stats.pendingUpdates > 0 ? "text-amber-400" : ""}`}>{stats.pendingUpdates}</p>
          </div>
          <div className="rounded-xl border border-border bg-card/50 p-3">
            <span className="text-xs text-muted-foreground">Total Version Bumps</span>
            <p className="text-2xl font-bold mt-1">{stats.totalVersionBumps}</p>
          </div>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="flex gap-1 bg-muted/50 rounded-lg p-1 w-fit">
        {FILTER_TABS.map((f) => (
          <Button
            key={f}
            variant={filter === f ? "default" : "ghost"}
            size="sm"
            onClick={() => setFilter(f)}
            className="text-xs"
          >
            {FILTER_LABELS[f]}
          </Button>
        ))}
      </div>

      {/* Items List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>No version data found</p>
        </div>
      ) : (
        <div className="space-y-1">
          {items.map((item) => (
            <div key={`${item.source}-${item.id}`} className="rounded-lg border border-border bg-card/50">
              <button
                onClick={() => toggleExpand(item.id)}
                className="w-full flex items-center gap-3 p-3 hover:bg-muted/50 transition-colors text-left"
              >
                <ChevronDown
                  className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform ${
                    expanded.has(item.id) ? "rotate-0" : "-rotate-90"
                  }`}
                />
                <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="font-medium flex-1 truncate">{item.name}</span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-muted font-mono">{item.source}</span>
                <span className="text-xs font-mono text-muted-foreground">
                  v{item.version}
                </span>
                {item.previousVersion && (
                  <>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs font-mono text-muted-foreground line-through">
                      v{item.previousVersion}
                    </span>
                  </>
                )}
                <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[item.status] || "bg-muted text-muted-foreground"}`}>
                  {item.status}
                </span>
              </button>

              {expanded.has(item.id) && (
                <div className="px-12 pb-3 space-y-3">
                  {/* Version info */}
                  <div className="text-sm space-y-1">
                    <div>
                      <span className="text-muted-foreground">Current: </span>
                      <span className="font-mono">v{item.version}</span>
                    </div>
                    {item.previousVersion && (
                      <div>
                        <span className="text-muted-foreground">Previous: </span>
                        <span className="font-mono">v{item.previousVersion}</span>
                      </div>
                    )}
                    <div>
                      <span className="text-muted-foreground">Submitter: </span>
                      <span className="font-mono text-xs">{item.submittedBy}</span>
                    </div>
                    {item.submittedAt && (
                      <div>
                        <span className="text-muted-foreground">Submitted: </span>
                        <span>{new Date(item.submittedAt.seconds * 1000).toLocaleDateString()}</span>
                      </div>
                    )}
                  </div>

                  {/* Parent item info */}
                  {item.parentItem && (
                    <div className="rounded-lg border border-border bg-muted/30 p-2 text-sm">
                      <span className="text-muted-foreground">Update of: </span>
                      <span className="font-medium">{item.parentItem.name}</span>
                      <span className="text-muted-foreground ml-2">v{item.parentItem.version}</span>
                      <span className={`text-xs ml-2 px-1.5 py-0.5 rounded ${STATUS_COLORS[item.parentItem.status] || "bg-muted"}`}>
                        {item.parentItem.status}
                      </span>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    {item.updateOf && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => versionAction("revert", item.id, item.source)}
                        disabled={!!actionLoading}
                      >
                        {actionLoading === `revert-${item.id}` ? (
                          <Loader2 className="h-3 w-3 animate-spin mr-1" />
                        ) : null}
                        Revert
                      </Button>
                    )}
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        placeholder="New version..."
                        value={bumpVersions[item.id] || ""}
                        onChange={(e) => setBumpVersions((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        className="h-7 w-28 px-2 rounded-md border border-border bg-background text-xs font-mono"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const v = bumpVersions[item.id];
                          if (v) {
                            versionAction("force_bump", item.id, item.source, v);
                            setBumpVersions((prev) => ({ ...prev, [item.id]: "" }));
                          }
                        }}
                        disabled={!bumpVersions[item.id] || !!actionLoading}
                      >
                        {actionLoading === `force_bump-${item.id}` ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          "Bump"
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
