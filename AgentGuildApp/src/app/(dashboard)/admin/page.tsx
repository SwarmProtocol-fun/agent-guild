"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ShieldAlert, Users, Flag, Server, Package, TrendingUp,
  Ban, CheckCircle, XCircle, Loader2, RefreshCw, ChevronDown,
  AlertTriangle, Globe, Clock, Star, Scale, ArrowRight,
  Wallet, Fuel, ExternalLink, Copy,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

// ── Types ──

interface OverviewStats {
  organizations: number;
  agents: number;
  communityItems: number;
  marketplaceAgents: number;
  subscriptions: number;
  reports: number;
  publishers: number;
  modServices: number;
  pendingReviews: number;
}

interface Publisher {
  wallet: string;
  displayName?: string;
  tier: number;
  totalSubmissions: number;
  approvedCount: number;
  rejectedCount: number;
  avgRating: number;
  totalInstalls: number;
  banned: boolean;
  banReason?: string;
  createdAt?: string;
}

interface Report {
  id: string;
  itemId: string;
  collection: string;
  reportedBy: string;
  reason: string;
  comment?: string;
  createdAt?: { seconds: number };
  resolution?: string;
}

interface ModService {
  slug: string;
  name: string;
  version: string;
  vendor: string;
  status: string;
  serviceUrl: string;
  lastHealthCheck?: string;
}

interface Submission {
  source: string;
  id: string;
  name?: string;
  title?: string;
  status: string;
  submittedBy?: string;
  submittedAt?: { seconds: number };
  pipelineStage?: string;
}

interface GasSponsor {
  address: string;
  balanceHbar: number;
  totalSponsored: number;
  estimatedRemaining: number;
  avgCostHbar: number;
  explorerUrl: string;
}

const TIER_NAMES: Record<number, string> = { 0: "New", 1: "Approved", 2: "Trusted", 3: "Strategic" };
const TIER_COLORS: Record<number, string> = {
  0: "bg-zinc-500/20 text-zinc-400",
  1: "bg-blue-500/20 text-blue-400",
  2: "bg-amber-500/20 text-amber-400",
  3: "bg-purple-500/20 text-purple-400",
};

export default function AdminPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [publishers, setPublishers] = useState<Publisher[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [modServices, setModServices] = useState<ModService[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [gasSponsor, setGasSponsor] = useState<GasSponsor | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [subFilter, setSubFilter] = useState<"pending" | "approved" | "rejected">("pending");

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [overviewRes, pubRes, repRes, modRes, subRes, gasRes] = await Promise.all([
        fetch("/api/admin/overview"),
        fetch("/api/admin/publishers"),
        fetch("/api/admin/reports"),
        fetch("/api/admin/mod-services"),
        fetch(`/api/admin/submissions?status=${subFilter}`),
        fetch("/api/admin/gas-sponsor"),
      ]);

      if (overviewRes.ok) {
        const d = await overviewRes.json();
        setStats(d.stats);
      }
      if (pubRes.ok) {
        const d = await pubRes.json();
        setPublishers(d.publishers || []);
      }
      if (repRes.ok) {
        const d = await repRes.json();
        setReports(d.reports || []);
      }
      if (modRes.ok) {
        const d = await modRes.json();
        setModServices(d.services || []);
      }
      if (subRes.ok) {
        const d = await subRes.json();
        setSubmissions(d.submissions || []);
      }
      if (gasRes.ok) {
        const d = await gasRes.json();
        setGasSponsor(d);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [subFilter]);

  useEffect(() => {
    if (isAdmin) fetchAll();
  }, [isAdmin, fetchAll]);

  // Re-fetch submissions when filter changes
  useEffect(() => {
    if (!isAdmin) return;
    fetch(`/api/admin/submissions?status=${subFilter}`)
      .then((r) => r.json())
      .then((d) => setSubmissions(d.submissions || []))
      .catch(() => {});
  }, [subFilter, isAdmin]);

  // ── Admin actions ──

  async function publisherAction(action: "ban" | "unban" | "set-tier", wallet: string, tier?: number) {
    setActionLoading(`${action}-${wallet}`);
    try {
      await fetch("/api/admin/publishers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, wallet, tier, reason: "Admin action" }),
      });
      await fetchAll();
    } finally {
      setActionLoading(null);
    }
  }

  async function reportAction(action: "dismiss" | "action-taken", reportId: string, suspendItem?: boolean) {
    setActionLoading(`${action}-${reportId}`);
    try {
      await fetch("/api/admin/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reportId, suspendItem }),
      });
      await fetchAll();
    } finally {
      setActionLoading(null);
    }
  }

  async function modServiceAction(action: "remove" | "set-status", slug: string, status?: string) {
    setActionLoading(`${action}-${slug}`);
    try {
      await fetch("/api/admin/mod-services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, slug, status }),
      });
      await fetchAll();
    } finally {
      setActionLoading(null);
    }
  }

  // ── Guards ──

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
          <ShieldAlert className="h-6 w-6 text-amber-400" />
          <h1 className="text-2xl font-bold">Platform Admin</h1>
        </div>
        <Button variant="outline" size="sm" onClick={fetchAll} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Overview Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatCard icon={Users} label="Organizations" value={stats.organizations} />
          <StatCard icon={Users} label="Agents" value={stats.agents} />
          <StatCard icon={Package} label="Market Items" value={stats.communityItems + stats.marketplaceAgents} />
          <StatCard icon={TrendingUp} label="Subscriptions" value={stats.subscriptions} />
          <StatCard
            icon={AlertTriangle}
            label="Pending Reviews"
            value={stats.pendingReviews}
            alert={stats.pendingReviews > 0}
          />
          <StatCard icon={Flag} label="Reports" value={stats.reports} alert={stats.reports > 0} />
          <StatCard icon={Star} label="Publishers" value={stats.publishers} />
          <StatCard icon={Server} label="Mod Services" value={stats.modServices} />
        </div>
      )}

      {/* Gas Sponsor Wallet */}
      {gasSponsor && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Fuel className="h-5 w-5 text-emerald-400" />
              <h3 className="font-semibold">Gas Sponsor Wallet</h3>
              <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400">
                Hedera Testnet
              </span>
            </div>
            <a
              href={gasSponsor.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-emerald-400 flex items-center gap-1 transition-colors"
            >
              HashScan <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          {/* Wallet address */}
          <div className="flex items-center gap-2 bg-black/20 rounded-lg px-3 py-2">
            <Wallet className="h-4 w-4 text-muted-foreground shrink-0" />
            <code className="text-xs font-mono text-foreground flex-1 truncate">
              {gasSponsor.address}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(gasSponsor.address)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Copy address"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg border border-border bg-card/50 p-3">
              <p className="text-xs text-muted-foreground">Balance</p>
              <p className={`text-xl font-bold ${gasSponsor.balanceHbar < 5 ? "text-red-400" : gasSponsor.balanceHbar < 20 ? "text-amber-400" : "text-emerald-400"}`}>
                {gasSponsor.balanceHbar.toLocaleString()} <span className="text-sm font-normal">HBAR</span>
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card/50 p-3">
              <p className="text-xs text-muted-foreground">Agents Sponsored</p>
              <p className="text-xl font-bold">{gasSponsor.totalSponsored}</p>
            </div>
            <div className="rounded-lg border border-border bg-card/50 p-3">
              <p className="text-xs text-muted-foreground">Est. Remaining</p>
              <p className={`text-xl font-bold ${gasSponsor.estimatedRemaining < 10 ? "text-amber-400" : ""}`}>
                ~{gasSponsor.estimatedRemaining} <span className="text-sm font-normal">agents</span>
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card/50 p-3">
              <p className="text-xs text-muted-foreground">Cost per Agent</p>
              <p className="text-xl font-bold">
                ~{gasSponsor.avgCostHbar} <span className="text-sm font-normal">HBAR</span>
              </p>
            </div>
          </div>

          {/* Low balance warning */}
          {gasSponsor.balanceHbar < 10 && (
            <div className="flex items-center gap-2 text-amber-400 bg-amber-500/10 rounded-lg px-3 py-2 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>Low balance — send HBAR to the address above to continue sponsoring agent registrations.</span>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            This wallet pays gas fees so every agent that registers gets their ASN on-chain automatically.
            Send HBAR to the address above to refill.
          </p>
        </div>
      )}

      {/* Credit Ops Quick Link */}
      <Link
        href="/admin/credit-ops"
        className="flex items-center justify-between p-4 rounded-xl border border-cyan-500/30 bg-cyan-500/5 hover:bg-cyan-500/10 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Scale className="h-5 w-5 text-cyan-400" />
          <div>
            <p className="font-medium">Credit Operations</p>
            <p className="text-xs text-muted-foreground">
              Review queue, overrides, policies, appeals & monitoring
            </p>
          </div>
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground" />
      </Link>

      {/* Tabs */}
      <Tabs defaultValue="submissions">
        <TabsList className="bg-muted/50">
          <TabsTrigger value="submissions">
            Submissions {stats?.pendingReviews ? `(${stats.pendingReviews})` : ""}
          </TabsTrigger>
          <TabsTrigger value="reports">
            Reports {stats?.reports ? `(${stats.reports})` : ""}
          </TabsTrigger>
          <TabsTrigger value="publishers">Publishers</TabsTrigger>
          <TabsTrigger value="mod-services">Mod Services</TabsTrigger>
        </TabsList>

        {/* ── Submissions ── */}
        <TabsContent value="submissions" className="space-y-4">
          <div className="flex gap-2">
            {(["pending", "approved", "rejected"] as const).map((s) => (
              <Button
                key={s}
                variant={subFilter === s ? "default" : "outline"}
                size="sm"
                onClick={() => setSubFilter(s)}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </Button>
            ))}
          </div>

          {loading ? (
            <LoadingState />
          ) : submissions.length === 0 ? (
            <EmptyState message={`No ${subFilter} submissions`} />
          ) : (
            <div className="space-y-2">
              {submissions.map((sub) => (
                <div
                  key={`${sub.source}-${sub.id}`}
                  className="flex items-center justify-between p-3 rounded-lg border border-border bg-card/50"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted font-mono">
                        {sub.source}
                      </span>
                      <span className="font-medium truncate">{sub.name || sub.title || sub.id}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                      {sub.submittedBy && <span>by {sub.submittedBy.slice(0, 8)}...</span>}
                      {sub.pipelineStage && (
                        <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">
                          {sub.pipelineStage}
                        </span>
                      )}
                      {sub.submittedAt && (
                        <span>{new Date(sub.submittedAt.seconds * 1000).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={sub.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Reports ── */}
        <TabsContent value="reports" className="space-y-4">
          {loading ? (
            <LoadingState />
          ) : reports.length === 0 ? (
            <EmptyState message="No reports" />
          ) : (
            <div className="space-y-2">
              {reports.map((report) => (
                <div
                  key={report.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-border bg-card/50"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Flag className="h-4 w-4 text-red-400 shrink-0" />
                      <span className="font-medium">{report.reason}</span>
                      <span className="text-xs text-muted-foreground font-mono">
                        {report.itemId?.slice(0, 12)}...
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {report.comment && <span className="mr-2">"{report.comment}"</span>}
                      by {report.reportedBy?.slice(0, 8)}...
                      {report.createdAt && (
                        <span className="ml-2">
                          {new Date(report.createdAt.seconds * 1000).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {report.resolution ? (
                      <span className="text-xs px-2 py-1 rounded bg-green-500/20 text-green-400">
                        {report.resolution}
                      </span>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => reportAction("dismiss", report.id)}
                          disabled={actionLoading === `dismiss-${report.id}`}
                        >
                          {actionLoading === `dismiss-${report.id}` ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            "Dismiss"
                          )}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => reportAction("action-taken", report.id, true)}
                          disabled={actionLoading === `action-taken-${report.id}`}
                        >
                          {actionLoading === `action-taken-${report.id}` ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            "Suspend Item"
                          )}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Publishers ── */}
        <TabsContent value="publishers" className="space-y-4">
          {loading ? (
            <LoadingState />
          ) : publishers.length === 0 ? (
            <EmptyState message="No publishers registered" />
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
                        {pub.displayName || pub.wallet.slice(0, 10) + "..."}
                      </span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${TIER_COLORS[pub.tier] || TIER_COLORS[0]}`}>
                        T{pub.tier} {TIER_NAMES[pub.tier]}
                      </span>
                      {pub.banned && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">
                          BANNED
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-3">
                      <span>{pub.totalSubmissions} submitted</span>
                      <span>{pub.approvedCount} approved</span>
                      <span>{pub.rejectedCount} rejected</span>
                      <span>{pub.avgRating?.toFixed(1) || "0"} avg rating</span>
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
        </TabsContent>

        {/* ── Mod Services ── */}
        <TabsContent value="mod-services" className="space-y-4">
          {loading ? (
            <LoadingState />
          ) : modServices.length === 0 ? (
            <EmptyState message="No mod services registered" />
          ) : (
            <div className="space-y-2">
              {modServices.map((svc) => (
                <div
                  key={svc.slug}
                  className="flex items-center justify-between p-3 rounded-lg border border-border bg-card/50"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4 text-cyan-400 shrink-0" />
                      <span className="font-medium">{svc.name}</span>
                      <span className="text-xs text-muted-foreground font-mono">{svc.slug}</span>
                      <span className="text-xs text-muted-foreground">v{svc.version}</span>
                      <ServiceStatus status={svc.status} />
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                      <span>{svc.vendor}</span>
                      <span className="font-mono">{svc.serviceUrl}</span>
                      {svc.lastHealthCheck && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {new Date(svc.lastHealthCheck).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        modServiceAction(
                          "set-status",
                          svc.slug,
                          svc.status === "active" ? "offline" : "active",
                        )
                      }
                      disabled={actionLoading === `set-status-${svc.slug}`}
                    >
                      {actionLoading === `set-status-${svc.slug}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : svc.status === "active" ? (
                        "Disable"
                      ) : (
                        "Enable"
                      )}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => modServiceAction("remove", svc.slug)}
                      disabled={actionLoading === `remove-${svc.slug}`}
                    >
                      {actionLoading === `remove-${svc.slug}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <XCircle className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Sub-components ──

function StatCard({
  icon: Icon,
  label,
  value,
  alert,
}: {
  icon: typeof Users;
  label: string;
  value: number;
  alert?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-3 ${alert ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card/50"}`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${alert ? "text-amber-400" : "text-muted-foreground"}`} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={`text-2xl font-bold mt-1 ${alert ? "text-amber-400" : ""}`}>{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-amber-500/20 text-amber-400",
    review: "bg-amber-500/20 text-amber-400",
    approved: "bg-green-500/20 text-green-400",
    rejected: "bg-red-500/20 text-red-400",
    suspended: "bg-red-500/20 text-red-400",
    changes_requested: "bg-blue-500/20 text-blue-400",
  };

  return (
    <span className={`text-xs px-2 py-0.5 rounded ${colors[status] || "bg-muted text-muted-foreground"}`}>
      {status}
    </span>
  );
}

function ServiceStatus({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-green-500",
    degraded: "bg-amber-500",
    offline: "bg-red-500",
  };

  return (
    <span className="flex items-center gap-1">
      <span className={`h-2 w-2 rounded-full ${colors[status] || "bg-zinc-500"}`} />
      <span className="text-xs text-muted-foreground">{status}</span>
    </span>
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

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-center py-12 text-muted-foreground">
      <p>{message}</p>
    </div>
  );
}
