"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, Ban, CheckCircle, ChevronDown,
  Users, RefreshCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface Publisher {
  wallet: string;
  displayName?: string;
  walletAddress?: string;
  tier: number;
  totalSubmissions: number;
  approvedCount: number;
  rejectedCount: number;
  avgRating: number;
  totalInstalls: number;
  banned: boolean;
  banReason?: string;
}

const TIER_TABS = ["all", "0", "1", "2", "3"] as const;
const TIER_NAMES: Record<number, string> = { 0: "New", 1: "Approved", 2: "Trusted", 3: "Strategic" };
const TIER_COLORS: Record<number, string> = {
  0: "bg-zinc-500/20 text-zinc-400",
  1: "bg-blue-500/20 text-blue-400",
  2: "bg-amber-500/20 text-amber-400",
  3: "bg-purple-500/20 text-purple-400",
};

export default function PublishersPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [publishers, setPublishers] = useState<Publisher[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [bannedFilter, setBannedFilter] = useState(false);
  const [sortBy, setSortBy] = useState<string>("submissions");
  const [searchQuery, setSearchQuery] = useState("");

  const fetchPublishers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (tierFilter !== "all") params.set("tier", tierFilter);
      if (bannedFilter) params.set("banned", "true");
      if (sortBy) params.set("sort", sortBy);
      if (searchQuery) params.set("q", searchQuery);

      const res = await fetch(`/api/admin/marketplace/publishers?${params}`);
      if (res.ok) {
        const d = await res.json();
        setPublishers(d.publishers || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [tierFilter, bannedFilter, sortBy, searchQuery]);

  useEffect(() => {
    if (isAdmin) fetchPublishers();
  }, [isAdmin, fetchPublishers]);

  async function publisherAction(action: string, wallet: string, tier?: number) {
    setActionLoading(`${action}-${wallet}`);
    try {
      await fetch("/api/admin/marketplace/publishers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, wallet, tier, reason: "Admin action" }),
      });
      await fetchPublishers();
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
        <div className="flex items-center gap-3">
          <Users className="h-6 w-6 text-amber-400" />
          <h1 className="text-2xl font-bold">Publishers</h1>
          <span className="text-sm text-muted-foreground">({publishers.length})</span>
        </div>
        <Button variant="outline" size="sm" onClick={fetchPublishers} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Tier tabs */}
        <div className="flex gap-1 bg-muted/50 rounded-lg p-1">
          {TIER_TABS.map((t) => (
            <Button
              key={t}
              variant={tierFilter === t ? "default" : "ghost"}
              size="sm"
              onClick={() => setTierFilter(t)}
              className="text-xs"
            >
              {t === "all" ? "All" : `T${t} ${TIER_NAMES[Number(t)]}`}
            </Button>
          ))}
        </div>

        {/* Banned toggle */}
        <Button
          variant={bannedFilter ? "destructive" : "outline"}
          size="sm"
          onClick={() => setBannedFilter(!bannedFilter)}
          className="text-xs"
        >
          <Ban className="h-3 w-3 mr-1" />
          {bannedFilter ? "Showing Banned" : "Show Banned"}
        </Button>

        {/* Sort */}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
        >
          <option value="submissions">Most Submissions</option>
          <option value="installs">Most Installs</option>
          <option value="rating">Highest Rating</option>
        </select>

        {/* Search */}
        <input
          type="text"
          placeholder="Search publishers..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && fetchPublishers()}
          className="h-8 px-3 rounded-md border border-border bg-background text-sm flex-1 min-w-[180px]"
        />
      </div>

      {/* Publishers list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : publishers.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>No publishers found</p>
        </div>
      ) : (
        <div className="space-y-2">
          {publishers.map((pub) => (
            <div
              key={pub.wallet}
              className="flex items-center justify-between p-3 rounded-lg border border-border bg-card/50"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {pub.displayName || (pub.wallet || "").slice(0, 10) + "..."}
                  </span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${TIER_COLORS[pub.tier] || TIER_COLORS[0]}`}>
                    T{pub.tier} {TIER_NAMES[pub.tier]}
                  </span>
                  {pub.banned && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">
                      BANNED {pub.banReason ? `(${pub.banReason})` : ""}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-3">
                  <span className="font-mono">{(pub.wallet || "").slice(0, 16)}...</span>
                  <span>{pub.totalSubmissions} submitted</span>
                  <span>{pub.approvedCount} approved</span>
                  <span>{pub.rejectedCount} rejected</span>
                  <span>{pub.avgRating?.toFixed(1) || "0"} avg</span>
                  <span>{pub.totalInstalls || 0} installs</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {/* Tier selector */}
                <TierSelector
                  currentTier={pub.tier}
                  onSelect={(tier) => publisherAction("set-tier", pub.wallet, tier)}
                  loading={actionLoading?.startsWith("set-tier-" + pub.wallet)}
                />
                {/* Recalculate */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => publisherAction("recalculate", pub.wallet)}
                  disabled={!!actionLoading}
                  title="Recalculate stats"
                >
                  {actionLoading === `recalculate-${pub.wallet}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCcw className="h-3 w-3" />
                  )}
                </Button>
                {/* Ban / Unban */}
                {pub.banned ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => publisherAction("unban", pub.wallet)}
                    disabled={actionLoading === `unban-${pub.wallet}`}
                  >
                    {actionLoading === `unban-${pub.wallet}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <>
                        <CheckCircle className="h-3 w-3 mr-1" /> Unban
                      </>
                    )}
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => publisherAction("ban", pub.wallet)}
                    disabled={actionLoading === `ban-${pub.wallet}`}
                  >
                    {actionLoading === `ban-${pub.wallet}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <>
                        <Ban className="h-3 w-3 mr-1" /> Ban
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TierSelector({
  currentTier,
  onSelect,
  loading,
}: {
  currentTier: number;
  onSelect: (tier: number) => void;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(!open)}
        disabled={!!loading}
      >
        {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <>Tier <ChevronDown className="h-3 w-3 ml-1" /></>}
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg p-1 min-w-[120px]">
          {[0, 1, 2, 3].map((t) => (
            <button
              key={t}
              onClick={() => {
                onSelect(t);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-1.5 text-sm rounded hover:bg-muted ${t === currentTier ? "text-amber-400 font-medium" : "text-foreground"}`}
            >
              T{t} {TIER_NAMES[t]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
