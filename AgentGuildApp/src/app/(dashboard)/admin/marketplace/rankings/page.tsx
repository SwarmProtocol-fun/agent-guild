"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, TrendingUp, Sparkles, Star,
  Search, Package, Pencil, RotateCcw, RefreshCcw, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface RankingStats {
  highestScore: number;
  averageScore: number;
  featuredCount: number;
  zeroInstallCount: number;
}

interface ScoreBreakdown {
  installScore: number;
  ratingScore: number;
  freshnessScore: number;
  tierScore: number;
  volumeScore: number;
}

interface RankedItem {
  id: string;
  source: string;
  name: string;
  type: string;
  score: number;
  breakdown: ScoreBreakdown;
  installs: number;
  avgRating: number;
  ratingCount: number;
  featured: boolean;
  submittedBy: string;
  overrideScore?: number | null;
}

export default function RankingsPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [stats, setStats] = useState<RankingStats | null>(null);
  const [distribution, setDistribution] = useState<Record<string, number>>({});
  const [items, setItems] = useState<RankedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [overrideId, setOverrideId] = useState<string | null>(null);
  const [overrideCol, setOverrideCol] = useState<string>("");
  const [overrideValue, setOverrideValue] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set("type", typeFilter);
      if (sourceFilter) params.set("source", sourceFilter);
      if (searchQuery) params.set("q", searchQuery);

      const res = await fetch(`/api/admin/marketplace/rankings?${params}`);
      if (res.ok) {
        const d = await res.json();
        setStats(d.stats);
        setDistribution(d.distribution || {});
        setItems(d.items || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [typeFilter, sourceFilter, searchQuery]);

  useEffect(() => {
    if (isAdmin) fetchData();
  }, [isAdmin, fetchData]);

  async function rankingAction(action: string, itemId?: string, col?: string, score?: string) {
    setActionLoading(itemId ? `${action}-${itemId}` : action);
    try {
      await fetch("/api/admin/marketplace/rankings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          itemId,
          collection: col,
          score: score ? Number(score) : undefined,
        }),
      });
      await fetchData();
    } finally {
      setActionLoading(null);
      setOverrideId(null);
      setOverrideValue("");
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
          <TrendingUp className="h-6 w-6 text-amber-400" />
          <h1 className="text-2xl font-bold">Rankings</h1>
          <span className="text-sm text-muted-foreground">({items.length})</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => rankingAction("batch_recalculate")}
            disabled={!!actionLoading}
          >
            {actionLoading === "batch_recalculate" ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <RefreshCcw className="h-4 w-4 mr-2" />
            )}
            Recalculate All
          </Button>
        </div>
      </div>

      {/* Stat Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-xl border border-border bg-card/50 p-3">
            <span className="text-xs text-muted-foreground">Highest Score</span>
            <p className="text-2xl font-bold mt-1">{stats.highestScore}</p>
          </div>
          <div className="rounded-xl border border-border bg-card/50 p-3">
            <span className="text-xs text-muted-foreground">Average Score</span>
            <p className="text-2xl font-bold mt-1">{stats.averageScore}</p>
          </div>
          <div className="rounded-xl border border-border bg-card/50 p-3">
            <span className="text-xs text-muted-foreground">Featured</span>
            <p className="text-2xl font-bold mt-1">{stats.featuredCount}</p>
          </div>
          <div className={`rounded-xl border p-3 ${stats.zeroInstallCount > 10 ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card/50"}`}>
            <span className="text-xs text-muted-foreground">0 Installs</span>
            <p className={`text-2xl font-bold mt-1 ${stats.zeroInstallCount > 10 ? "text-amber-400" : ""}`}>
              {stats.zeroInstallCount}
            </p>
          </div>
        </div>
      )}

      {/* Score Distribution */}
      {Object.keys(distribution).length > 0 && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <h3 className="text-sm font-medium mb-3">Score Distribution</h3>
          <div className="space-y-2">
            {["0-20", "20-40", "40-60", "60-80", "80-100"].map((range) => {
              const count = distribution[range] || 0;
              const maxCount = Math.max(...Object.values(distribution), 1);
              const widthPercent = (count / maxCount) * 100;
              return (
                <div key={range} className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground w-12 text-right font-mono">{range}</span>
                  <div className="flex-1 h-6 bg-muted/30 rounded overflow-hidden">
                    <div
                      className="h-full bg-amber-500/60 rounded transition-all"
                      style={{ width: `${widthPercent}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono w-8 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
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
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
        >
          <option value="">All sources</option>
          <option value="community">Community</option>
          <option value="agents">Agents</option>
        </select>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search items..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchData()}
            className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-background text-sm"
          />
        </div>
      </div>

      {/* Rankings Table */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>No ranked items found</p>
        </div>
      ) : (
        <div className="space-y-1">
          {/* Header */}
          <div className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground font-medium">
            <span className="w-8">#</span>
            <span className="flex-1">Name</span>
            <span className="w-16">Type</span>
            <span className="w-20">Source</span>
            <span className="w-32">Score</span>
            <span className="w-16 text-right">Installs</span>
            <span className="w-16 text-right">Rating</span>
            <span className="w-8" />
            <span className="w-28">Actions</span>
          </div>

          {items.map((item, idx) => (
            <div key={`${item.source}-${item.id}`}>
              <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card/50">
                <span className="w-8 text-sm font-bold font-mono text-muted-foreground">
                  {idx + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{item.name}</span>
                    {item.overrideScore != null && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">
                        override
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    by {item.submittedBy?.slice(0, 10)}...
                  </span>
                </div>
                <span className="w-16">
                  <span className="text-xs px-1.5 py-0.5 rounded bg-muted">{item.type}</span>
                </span>
                <span className="w-20">
                  <span className="text-xs px-1.5 py-0.5 rounded bg-muted font-mono">{item.source}</span>
                </span>
                <div className="w-32 flex items-center gap-2">
                  <span className="text-sm font-bold font-mono w-8">{item.score}</span>
                  <div className="flex-1 h-2 bg-muted/30 rounded overflow-hidden">
                    <div
                      className={`h-full rounded ${item.overrideScore != null ? "bg-purple-500/60" : "bg-amber-500/60"}`}
                      style={{ width: `${item.score}%` }}
                    />
                  </div>
                </div>
                <span className="w-16 text-right text-sm">{item.installs}</span>
                <span className="w-16 text-right text-sm flex items-center justify-end gap-1">
                  <Star className="h-3 w-3 text-amber-400" />
                  {item.avgRating?.toFixed(1)}
                </span>
                <span className="w-8">
                  {item.featured && <Sparkles className="h-3 w-3 text-amber-400" />}
                </span>
                <div className="w-28 flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setOverrideId(item.id);
                      setOverrideCol(item.source);
                      setOverrideValue(String(item.score));
                    }}
                    title="Override score"
                    disabled={!!actionLoading}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  {item.overrideScore != null && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => rankingAction("reset_score", item.id, item.source)}
                      disabled={!!actionLoading}
                      title="Reset to organic score"
                    >
                      {actionLoading === `reset_score-${item.id}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3 w-3" />
                      )}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => rankingAction("override_score", item.id, item.source, String(
                      item.breakdown.installScore + item.breakdown.ratingScore +
                      item.breakdown.freshnessScore + item.breakdown.tierScore + item.breakdown.volumeScore
                    ))}
                    disabled={!!actionLoading}
                    title="Recalculate this item"
                    className="hidden"
                  >
                    <Package className="h-3 w-3" />
                  </Button>
                </div>
              </div>

              {/* Override inline form */}
              {overrideId === item.id && (
                <div className="flex items-center gap-2 px-12 py-2">
                  <span className="text-xs text-muted-foreground">Set score:</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={overrideValue}
                    onChange={(e) => setOverrideValue(e.target.value)}
                    className="h-7 w-20 px-2 rounded-md border border-border bg-background text-xs font-mono"
                  />
                  <Button
                    size="sm"
                    onClick={() => rankingAction("override_score", item.id, overrideCol, overrideValue)}
                    disabled={!overrideValue || !!actionLoading}
                  >
                    {actionLoading === `override_score-${item.id}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Apply"
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setOverrideId(null); setOverrideValue(""); }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                  <span className="text-[10px] text-muted-foreground ml-2">
                    Breakdown: Install {item.breakdown.installScore} | Rating {item.breakdown.ratingScore} | Fresh {item.breakdown.freshnessScore} | Tier {item.breakdown.tierScore} | Volume {item.breakdown.volumeScore}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
