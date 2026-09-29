/**
 * Credit Dashboard — Combined view of agent credit scores, compute plan status,
 * quota usage, credit balance, and tier improvement recommendations.
 *
 * Route: /analytics/credit
 */
"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2, ArrowUpDown, TrendingUp, TrendingDown,
  AlertTriangle, Zap, BarChart3, ShieldCheck, Target
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/analytics/stat-card";
import { TierBadgeTooltip } from "@/components/credit/tier-badge-tooltip";
import { ConfidenceIndicator } from "@/components/credit/confidence-indicator";
import { PlanTierCard } from "@/components/credit/plan-tier-card";
import { UsageChart } from "@/components/compute/usage-chart";
import { useOrg } from "@/contexts/OrgContext";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Agent } from "@/lib/firestore";
import type { ComputeEntitlement, UsageSummary } from "@/lib/compute/types";
import {
  CREDIT_TIERS,
  getTierForScore,
  getNextTier,
  pointsToNextTier,
  getConfidenceInfo,
  CREDIT_SCORE_DEFAULT,
  TRUST_SCORE_DEFAULT,
  type TierName,
} from "@/lib/credit-tiers";

interface AgentCreditRow {
  id: string;
  name: string;
  type: string;
  status: string;
  credit: number;
  trust: number;
  tierName: TierName;
  eventCount: number;
  asn?: string;
}

type SortKey = "name" | "credit" | "trust" | "tierName";

const TREND_ICON = {
  up: <TrendingUp className="h-3 w-3 text-emerald-500" />,
  down: <TrendingDown className="h-3 w-3 text-red-500" />,
};

export default function OrgCreditDashboardPage() {
  const { currentOrg } = useOrg();
  const router = useRouter();

  const [agents, setAgents] = useState<AgentCreditRow[]>([]);
  const [entitlement, setEntitlement] = useState<ComputeEntitlement | null>(null);
  const [usage, setUsage] = useState<UsageSummary>({
    totalComputeHours: 0,
    totalStorageGb: 0,
    totalActions: 0,
    totalSessions: 0,
    estimatedCostCents: 0,
  });
  const [runningCount, setRunningCount] = useState(0);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [loadingCompute, setLoadingCompute] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("credit");
  const [sortAsc, setSortAsc] = useState(false);
  const [activeTab, setActiveTab] = useState<"agents" | "compute">("agents");

  // Load agent credit data
  useEffect(() => {
    if (!currentOrg?.id) return;
    const load = async () => {
      setLoadingAgents(true);
      try {
        const q = query(collection(db, "agents"), where("orgId", "==", currentOrg.id));
        const snapshot = await getDocs(q);
        const rows: AgentCreditRow[] = snapshot.docs.map((d) => {
          const data = d.data() as Agent;
          const credit = data.creditScore ?? CREDIT_SCORE_DEFAULT;
          const tier = getTierForScore(credit);
          return {
            id: d.id,
            name: data.name,
            type: data.type,
            status: data.status,
            credit,
            trust: data.trustScore ?? TRUST_SCORE_DEFAULT,
            tierName: tier.name,
            eventCount: (data as unknown as Record<string, unknown>).scoreEventCount as number || 0,
            asn: data.asn,
          };
        });
        setAgents(rows);
      } catch (err) {
        console.error("Failed to load agents:", err);
      } finally {
        setLoadingAgents(false);
      }
    };
    load();
  }, [currentOrg]);

  // Load compute entitlement + usage
  useEffect(() => {
    if (!currentOrg?.id) return;
    const load = async () => {
      setLoadingCompute(true);
      try {
        // Entitlement
        const entRes = await fetch(`/api/compute/admin/analytics?orgId=${currentOrg.id}`);
        if (entRes.ok) {
          const data = await entRes.json();
          if (data.entitlement) setEntitlement(data.entitlement);
        }

        // Running computers count
        const compRes = await fetch(`/api/compute/computers?orgId=${currentOrg.id}&status=running`);
        if (compRes.ok) {
          const data = await compRes.json();
          setRunningCount(data.computers?.length || 0);
        }

        // Usage summary — needs a workspaceId, use first workspace
        const wsRes = await fetch(`/api/compute/workspaces?orgId=${currentOrg.id}`);
        if (wsRes.ok) {
          const wsData = await wsRes.json();
          const workspaces = wsData.workspaces || [];
          if (workspaces.length > 0) {
            const usRes = await fetch(`/api/compute/usage?workspaceId=${workspaces[0].id}`);
            if (usRes.ok) {
              const usData = await usRes.json();
              if (usData.summary) setUsage(usData.summary);
            }
          }
        }
      } catch (err) {
        console.error("Failed to load compute data:", err);
      } finally {
        setLoadingCompute(false);
      }
    };
    load();
  }, [currentOrg]);

  // Derived stats
  const sorted = [...agents].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "name": cmp = a.name.localeCompare(b.name); break;
      case "credit": cmp = a.credit - b.credit; break;
      case "trust": cmp = a.trust - b.trust; break;
      case "tierName": {
        const order: Record<TierName, number> = { Bronze: 0, Silver: 1, Gold: 2, Platinum: 3 };
        cmp = order[a.tierName] - order[b.tierName];
        break;
      }
    }
    return sortAsc ? cmp : -cmp;
  });

  const avgCredit = agents.length
    ? Math.round(agents.reduce((s, a) => s + a.credit, 0) / agents.length)
    : 0;
  const avgTrust = agents.length
    ? Math.round(agents.reduce((s, a) => s + a.trust, 0) / agents.length)
    : 0;

  const tierCounts: Record<TierName, number> = { Bronze: 0, Silver: 0, Gold: 0, Platinum: 0 };
  for (const a of agents) tierCounts[a.tierName]++;

  const atRiskAgents = agents.filter((a) => a.credit < 550 && a.status === "online");
  const topPerformers = agents.filter((a) => a.credit >= 700).sort((a, b) => b.credit - a.credit).slice(0, 3);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  };

  if (!currentOrg) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Credit Dashboard</h1>
        <p className="text-muted-foreground">No organization selected</p>
      </div>
    );
  }

  const loading = loadingAgents && loadingCompute;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold">Credit Dashboard</h1>
          <p className="text-muted-foreground mt-1">
            Agent reputation scores, compute quota, and platform standing
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[40vh]">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* ── Top stats row ── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard title="Avg Credit Score" value={String(avgCredit)} icon="📊" />
            <StatCard title="Avg Trust Score" value={String(avgTrust)} icon="🛡️" />
            <StatCard title="Gold+ Agents" value={String(tierCounts.Gold + tierCounts.Platinum)} icon="⭐" />
            <StatCard
              title="Compute Balance"
              value={`$${(entitlement?.creditBalanceCents ? entitlement.creditBalanceCents / 100 : 0).toFixed(2)}`}
              icon="💳"
            />
          </div>

          {/* ── Tabs ── */}
          <div className="flex gap-1 border-b border-border">
            {([
              { key: "agents", label: "Agent Credit", icon: ShieldCheck },
              { key: "compute", label: "Compute & Billing", icon: Zap },
            ] as const).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === key
                    ? "border-amber-500 text-amber-600 dark:text-amber-400"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>

          {/* ═══════════════════════════════════════
              AGENT CREDIT TAB
          ═══════════════════════════════════════ */}
          {activeTab === "agents" && (
            <div className="space-y-5">
              {/* Tier Distribution */}
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-muted-foreground" />
                      Tier Distribution
                    </CardTitle>
                    <span className="text-xs text-muted-foreground">{agents.length} agents total</span>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-4 gap-4">
                    {CREDIT_TIERS.slice().reverse().map((tier) => {
                      const count = tierCounts[tier.name];
                      const pct = agents.length ? Math.round((count / agents.length) * 100) : 0;
                      return (
                        <div key={tier.name} className="text-center">
                          <div className="mx-auto mb-2 rounded-lg h-20 flex items-end justify-center">
                            <div
                              className="rounded-t-md w-10 transition-all duration-500"
                              style={{
                                height: `${Math.max(6, pct)}%`,
                                backgroundColor: tier.chartColor,
                                opacity: 0.85,
                              }}
                            />
                          </div>
                          <Badge className={`${tier.badgeClass} text-[10px]`}>{tier.name}</Badge>
                          <p className="text-base font-bold mt-1">{count}</p>
                          <p className="text-[10px] text-muted-foreground">{pct}%</p>
                        </div>
                      );
                    })}
                  </div>

                  {/* Horizontal breakdown bar */}
                  {agents.length > 0 && (
                    <div className="mt-4 flex h-2 rounded-full overflow-hidden gap-0.5">
                      {CREDIT_TIERS.slice().reverse().map((tier) => {
                        const pct = (tierCounts[tier.name] / agents.length) * 100;
                        if (pct === 0) return null;
                        return (
                          <div
                            key={tier.name}
                            className="h-full transition-all"
                            style={{ width: `${pct}%`, backgroundColor: tier.chartColor }}
                          />
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              <div className="grid lg:grid-cols-3 gap-4">
                {/* At-Risk Agents */}
                <Card className="border-red-200 dark:border-red-900/40">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2 text-red-600 dark:text-red-400">
                      <AlertTriangle className="h-4 w-4" />
                      At Risk
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Online agents below Silver tier
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {atRiskAgents.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No at-risk agents — good standing.</p>
                    ) : (
                      <div className="space-y-2">
                        {atRiskAgents.slice(0, 5).map((a) => {
                          const toNext = pointsToNextTier(a.credit);
                          return (
                            <div
                              key={a.id}
                              className="flex items-center justify-between cursor-pointer hover:opacity-80"
                              onClick={() => router.push(`/agents/${a.id}/credit`)}
                            >
                              <div>
                                <p className="text-xs font-medium">{a.name}</p>
                                {toNext > 0 && (
                                  <p className="text-[10px] text-muted-foreground">+{toNext} pts to Silver</p>
                                )}
                              </div>
                              <span className="text-sm font-mono font-bold text-red-500">{a.credit}</span>
                            </div>
                          );
                        })}
                        {atRiskAgents.length > 5 && (
                          <p className="text-[10px] text-muted-foreground">+{atRiskAgents.length - 5} more</p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Top Performers */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2 text-amber-600 dark:text-amber-400">
                      <Target className="h-4 w-4" />
                      Top Performers
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Highest credit scores in your org
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {topPerformers.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No Gold+ agents yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {topPerformers.map((a, i) => (
                          <div
                            key={a.id}
                            className="flex items-center justify-between cursor-pointer hover:opacity-80"
                            onClick={() => router.push(`/agents/${a.id}/credit`)}
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground w-4">#{i + 1}</span>
                              <div>
                                <p className="text-xs font-medium">{a.name}</p>
                                <TierBadgeTooltip creditScore={a.credit} size="sm" />
                              </div>
                            </div>
                            <span className="text-sm font-mono font-bold text-amber-500">{a.credit}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Score Improvement Tips */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-muted-foreground" />
                      How to Improve
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Actions that boost credit score
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2.5">
                      {[
                        { weight: "35%", label: "Complete assigned tasks on time", icon: "✅" },
                        { weight: "25%", label: "Avoid errors and penalties", icon: "🛡️" },
                        { weight: "15%", label: "Expand skill diversity", icon: "🧠" },
                        { weight: "15%", label: "Stay consistently active", icon: "⚡" },
                        { weight: "10%", label: "Earn bonuses and rewards", icon: "🎯" },
                      ].map((tip) => (
                        <div key={tip.label} className="flex items-start gap-2">
                          <span className="text-base leading-none mt-0.5">{tip.icon}</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs leading-snug">{tip.label}</p>
                            <span className="text-[10px] text-amber-500 font-medium">{tip.weight} weight</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Full Agent Table */}
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">All Agents</CardTitle>
                    <CardDescription>Click any agent to view full credit breakdown</CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  {agents.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      No agents in this organization
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border">
                            {[
                              { key: "name" as SortKey, label: "Agent" },
                              { key: "credit" as SortKey, label: "Credit" },
                              { key: "trust" as SortKey, label: "Trust" },
                              { key: "tierName" as SortKey, label: "Tier" },
                            ].map(({ key, label }) => (
                              <th key={key} className="text-left py-2 px-2">
                                <button
                                  onClick={() => handleSort(key)}
                                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                                >
                                  {label}
                                  <ArrowUpDown className="h-3 w-3" />
                                  {sortKey === key && (
                                    <span className="text-amber-500">{sortAsc ? "↑" : "↓"}</span>
                                  )}
                                </button>
                              </th>
                            ))}
                            <th className="text-left py-2 px-2 text-xs font-medium text-muted-foreground">Confidence</th>
                            <th className="text-left py-2 px-2 text-xs font-medium text-muted-foreground">Status</th>
                            <th className="text-left py-2 px-2 text-xs font-medium text-muted-foreground">Next Tier</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sorted.map((a) => {
                            const next = getNextTier(a.credit);
                            const toNext = pointsToNextTier(a.credit);
                            return (
                              <tr
                                key={a.id}
                                className="border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer"
                                onClick={() => router.push(`/agents/${a.id}/credit`)}
                              >
                                <td className="py-2.5 px-2">
                                  <div>
                                    <span className="font-medium">{a.name}</span>
                                    <span className="text-xs text-muted-foreground ml-2">{a.type}</span>
                                  </div>
                                </td>
                                <td className="py-2.5 px-2">
                                  <span className="font-mono font-bold text-amber-600 dark:text-amber-400">{a.credit}</span>
                                </td>
                                <td className="py-2.5 px-2">
                                  <span className="font-mono text-blue-600 dark:text-blue-400">{a.trust}</span>
                                </td>
                                <td className="py-2.5 px-2">
                                  <TierBadgeTooltip creditScore={a.credit} size="sm" />
                                </td>
                                <td className="py-2.5 px-2">
                                  <ConfidenceIndicator confidence={getConfidenceInfo(a.eventCount)} />
                                </td>
                                <td className="py-2.5 px-2">
                                  <Badge
                                    variant="outline"
                                    className={`text-[10px] ${
                                      a.status === "online"
                                        ? "text-emerald-600 border-emerald-300 dark:text-emerald-400 dark:border-emerald-800"
                                        : "text-muted-foreground"
                                    }`}
                                  >
                                    {a.status}
                                  </Badge>
                                </td>
                                <td className="py-2.5 px-2">
                                  {next ? (
                                    <span className="text-xs text-muted-foreground">
                                      +{toNext} → <span className="font-medium">{next.name}</span>
                                    </span>
                                  ) : (
                                    <span className="text-xs text-violet-500 font-medium">Max tier ✦</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* ═══════════════════════════════════════
              COMPUTE & BILLING TAB
          ═══════════════════════════════════════ */}
          {activeTab === "compute" && (
            <div className="space-y-5">
              <div className="grid lg:grid-cols-3 gap-5">
                {/* Left: plan card */}
                <div>
                  {loadingCompute ? (
                    <Card className="h-full flex items-center justify-center min-h-[200px]">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </Card>
                  ) : (
                    <PlanTierCard entitlement={entitlement} runningCount={runningCount} />
                  )}
                </div>

                {/* Right: usage chart */}
                <div className="lg:col-span-2">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base">Usage This Period</CardTitle>
                      <CardDescription>
                        Compute hours, storage, actions, and sessions
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {loadingCompute ? (
                        <div className="flex items-center justify-center h-32">
                          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        </div>
                      ) : (
                        <UsageChart summary={usage} entitlement={entitlement} />
                      )}
                    </CardContent>
                  </Card>
                </div>
              </div>

              {/* Pricing rates */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Pricing Reference</CardTitle>
                  <CardDescription>
                    Per-instance hourly rates — billed at actual usage
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {(["small", "medium", "large", "xl"] as const).map((key) => {
                      const tierAllowed = (entitlement?.allowedSizes || ["small"]).includes(key);
                      return (
                        <div
                          key={key}
                          className={`rounded-lg border p-4 transition-opacity ${
                            !tierAllowed ? "opacity-40 border-border" : "border-border"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-sm font-medium capitalize">{key}</p>
                            {!tierAllowed && (
                              <Badge variant="outline" className="text-[9px] px-1">Plan required</Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {key === "small" && "2 CPU · 4 GB · 20 GB"}
                            {key === "medium" && "4 CPU · 8 GB · 50 GB"}
                            {key === "large" && "8 CPU · 16 GB · 100 GB"}
                            {key === "xl" && "16 CPU · 32 GB · 200 GB"}
                          </p>
                          <div className="mt-3 space-y-1">
                            <div className="flex justify-between text-xs">
                              <span className="text-muted-foreground">Per hour</span>
                              <span className="font-medium font-mono">
                                ${({ small: 0.08, medium: 0.22, large: 0.52, xl: 1.03 }[key]).toFixed(2)}
                              </span>
                            </div>
                            <div className="flex justify-between text-xs">
                              <span className="text-muted-foreground">8h/day, 30 days</span>
                              <span className="font-medium font-mono text-muted-foreground">
                                ${({ small: 19.20, medium: 52.80, large: 124.80, xl: 247.20 }[key]).toFixed(2)}/mo
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
}
