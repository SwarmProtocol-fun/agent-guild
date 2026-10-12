/**
 * Agent credit view — org-wide credit/trust scores, tier distribution, at-risk
 * agents and improvement tips. Rendered as the "Credit" tab of /lending.
 */
"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ArrowUpDown, TrendingUp, AlertTriangle, BarChart3, Target } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/analytics/stat-card";
import { TierBadgeTooltip } from "@/components/credit/tier-badge-tooltip";
import { ConfidenceIndicator } from "@/components/credit/confidence-indicator";
import { useOrg } from "@/contexts/OrgContext";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Agent } from "@/lib/firestore";
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

export function AgentCreditPanel() {
  const { currentOrg } = useOrg();
  const router = useRouter();

  const [agents, setAgents] = useState<AgentCreditRow[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("credit");
  const [sortAsc, setSortAsc] = useState(false);

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
    return <p className="text-sm text-muted-foreground">Select an organization to see agent credit.</p>;
  }

  if (loadingAgents) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard title="Avg Credit Score" value={String(avgCredit)} icon="📊" />
        <StatCard title="Avg Trust Score" value={String(avgTrust)} icon="🛡️" />
        <StatCard title="Gold+ Agents" value={String(tierCounts.Gold + tierCounts.Platinum)} icon="⭐" />
      </div>

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
  );
}
