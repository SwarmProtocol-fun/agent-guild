"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, Star, Search, Package,
  Ban, CheckCircle, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface Listing {
  id: string;
  source: string;
  name: string;
  type: string;
  submittedBy: string;
  status: string;
  installs: number;
  avgRating: number;
  ratingCount: number;
  rankingScore: number;
  featured: boolean;
  submittedAt?: { seconds: number };
}

const STATUS_TABS = ["all", "approved", "suspended", "rejected"] as const;
const STATUS_COLORS: Record<string, string> = {
  approved: "bg-green-500/20 text-green-400",
  suspended: "bg-red-500/20 text-red-400",
  rejected: "bg-red-500/20 text-red-400",
  pending: "bg-amber-500/20 text-amber-400",
  review: "bg-amber-500/20 text-amber-400",
};

export default function ListingsPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [items, setItems] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<string>("newest");

  const fetchListings = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter) params.set("type", typeFilter);
      if (sortBy) params.set("sort", sortBy);
      if (searchQuery) params.set("q", searchQuery);

      const res = await fetch(`/api/admin/marketplace/listings?${params}`);
      if (res.ok) {
        const d = await res.json();
        setItems(d.items || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter, sortBy, searchQuery]);

  useEffect(() => {
    if (isAdmin) fetchListings();
  }, [isAdmin, fetchListings]);

  async function listingAction(action: string, itemId: string, collection: string) {
    setActionLoading(`${action}-${itemId}`);
    try {
      await fetch("/api/admin/marketplace/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, itemId, collection }),
      });
      await fetchListings();
    } finally {
      setActionLoading(null);
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
        <h1 className="text-2xl font-bold">Listings</h1>
        <Button variant="outline" size="sm" onClick={fetchListings} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Status tabs */}
        <div className="flex gap-1 bg-muted/50 rounded-lg p-1">
          {STATUS_TABS.map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? "default" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter(s)}
              className="text-xs"
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </Button>
          ))}
        </div>

        {/* Type filter */}
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
        >
          <option value="">All types</option>
          <option value="plugin">Plugin</option>
          <option value="skill">Skill</option>
          <option value="skin">Skin</option>
          <option value="agent">Agent</option>
        </select>

        {/* Sort */}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
        >
          <option value="newest">Newest</option>
          <option value="ranking">Ranking Score</option>
          <option value="installs">Most Installs</option>
        </select>

        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search listings..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchListings()}
            className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-background text-sm"
          />
        </div>
      </div>

      {/* Listings table */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>No listings found</p>
        </div>
      ) : (
        <div className="space-y-1">
          {/* Header */}
          <div className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground font-medium">
            <span className="flex-1">Name</span>
            <span className="w-16">Type</span>
            <span className="w-20">Status</span>
            <span className="w-16 text-right">Installs</span>
            <span className="w-16 text-right">Rating</span>
            <span className="w-16 text-right">Score</span>
            <span className="w-40">Actions</span>
          </div>

          {items.map((item) => (
            <div
              key={`${item.source}-${item.id}`}
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card/50"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {item.featured && <Sparkles className="h-3 w-3 text-amber-400 shrink-0" />}
                  <span className="font-medium truncate">{item.name}</span>
                  <span className="text-xs text-muted-foreground font-mono">{item.source}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  by {item.submittedBy?.slice(0, 10)}...
                </span>
              </div>
              <span className="w-16">
                <span className="text-xs px-1.5 py-0.5 rounded bg-muted">{item.type}</span>
              </span>
              <span className="w-20">
                <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[item.status] || "bg-muted text-muted-foreground"}`}>
                  {item.status}
                </span>
              </span>
              <span className="w-16 text-right text-sm">{item.installs}</span>
              <span className="w-16 text-right text-sm flex items-center justify-end gap-1">
                <Star className="h-3 w-3 text-amber-400" />
                {item.avgRating?.toFixed(1) || "0.0"}
              </span>
              <span className="w-16 text-right text-sm font-mono">{item.rankingScore}</span>
              <div className="w-40 flex items-center gap-1">
                {item.status === "approved" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => listingAction("suspend", item.id, item.source)}
                    disabled={!!actionLoading}
                    title="Suspend"
                  >
                    {actionLoading === `suspend-${item.id}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Ban className="h-3 w-3 text-red-400" />
                    )}
                  </Button>
                ) : item.status === "suspended" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => listingAction("unsuspend", item.id, item.source)}
                    disabled={!!actionLoading}
                    title="Unsuspend"
                  >
                    {actionLoading === `unsuspend-${item.id}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <CheckCircle className="h-3 w-3 text-green-400" />
                    )}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => listingAction(item.featured ? "unfeature" : "feature", item.id, item.source)}
                  disabled={!!actionLoading}
                  title={item.featured ? "Remove from featured" : "Feature"}
                >
                  {actionLoading?.startsWith("feature-" + item.id) || actionLoading?.startsWith("unfeature-" + item.id) ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className={`h-3 w-3 ${item.featured ? "text-amber-400" : "text-muted-foreground"}`} />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => listingAction("recalculate_rank", item.id, item.source)}
                  disabled={!!actionLoading}
                  title="Recalculate ranking score"
                >
                  {actionLoading === `recalculate_rank-${item.id}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Package className="h-3 w-3" />
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
