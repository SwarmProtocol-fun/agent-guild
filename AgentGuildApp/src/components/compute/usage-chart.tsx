"use client";

import { TrendingUp, AlertTriangle, CheckCircle } from "lucide-react";
import type { UsageSummary, ComputeEntitlement } from "@/lib/compute/types";
import { PLAN_LIMITS } from "@/lib/compute/types";

interface UsageChartProps {
  summary: UsageSummary;
  entitlement?: ComputeEntitlement | null;
}

export function UsageChart({ summary, entitlement }: UsageChartProps) {
  const tier = entitlement?.planTier || "free";
  const limits = PLAN_LIMITS[tier];
  const hoursQuota = entitlement?.monthlyHourQuota ?? limits.monthlyHours;
  const hoursUnlimited = hoursQuota === 0;

  // Period label
  const periodStart = entitlement?.periodStart;
  const periodLabel = periodStart
    ? `since ${new Date(periodStart).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : "this period";

  const metrics = [
    {
      label: "Compute Hours",
      value: summary.totalComputeHours.toFixed(1),
      unit: "hrs",
      current: summary.totalComputeHours,
      quota: hoursUnlimited ? null : hoursQuota,
      color: "bg-blue-500",
      warnColor: "bg-amber-500",
      critColor: "bg-red-500",
    },
    {
      label: "Storage",
      value: summary.totalStorageGb.toFixed(2),
      unit: "GB",
      current: summary.totalStorageGb,
      quota: null, // metered, no hard limit
      color: "bg-purple-500",
      warnColor: "bg-purple-500",
      critColor: "bg-purple-500",
    },
    {
      label: "Actions",
      value: summary.totalActions.toLocaleString(),
      unit: "",
      current: summary.totalActions,
      quota: null,
      color: "bg-emerald-500",
      warnColor: "bg-emerald-500",
      critColor: "bg-emerald-500",
    },
    {
      label: "Sessions",
      value: summary.totalSessions.toString(),
      unit: "",
      current: summary.totalSessions,
      quota: null,
      color: "bg-amber-500",
      warnColor: "bg-amber-500",
      critColor: "bg-amber-500",
    },
  ];

  const costDollars = summary.estimatedCostCents / 100;

  return (
    <div className="space-y-5">
      {/* Cost + period header */}
      <div className="flex items-end justify-between rounded-lg border border-border bg-card px-4 py-3">
        <div>
          <p className="text-xs text-muted-foreground">Estimated Cost ({periodLabel})</p>
          <p className="text-3xl font-bold mt-0.5 font-mono">
            ${costDollars.toFixed(2)}
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground pb-1">
          <TrendingUp className="h-3.5 w-3.5" />
          <span className="capitalize">{tier} plan</span>
        </div>
      </div>

      {/* Metric bars */}
      <div className="space-y-3">
        {metrics.map((m) => {
          const hasQuota = m.quota !== null && m.quota > 0;
          const pct = hasQuota
            ? Math.min((m.current / m.quota!) * 100, 100)
            : Math.min((m.current / Math.max(m.current * 1.5, 1)) * 100, 66); // aesthetic fill when no quota

          const warn = hasQuota && pct >= 80;
          const crit = hasQuota && pct >= 95;
          const barColor = crit ? m.critColor : warn ? m.warnColor : m.color;

          return (
            <div key={m.label}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-muted-foreground">{m.label}</span>
                  {crit && <AlertTriangle className="h-3 w-3 text-red-500" />}
                  {warn && !crit && <AlertTriangle className="h-3 w-3 text-amber-500" />}
                </div>
                <span className="text-sm font-medium font-mono">
                  {m.value}{m.unit ? ` ${m.unit}` : ""}
                  {hasQuota && (
                    <span className="text-muted-foreground font-normal">
                      {" "}/ {m.quota}{m.unit ? ` ${m.unit}` : ""}
                    </span>
                  )}
                  {m.label === "Compute Hours" && hoursUnlimited && (
                    <span className="text-muted-foreground font-normal"> / ∞</span>
                  )}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-muted">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                  style={{ width: `${Math.max(pct, m.current > 0 ? 2 : 0)}%` }}
                />
              </div>
              {crit && (
                <p className="text-[10px] text-red-500 mt-0.5">
                  Quota almost exhausted — upgrade your plan to avoid disruption
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* All-clear state */}
      {summary.totalComputeHours === 0 && summary.totalSessions === 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1">
          <CheckCircle className="h-4 w-4 text-emerald-500" />
          No compute usage recorded this period
        </div>
      )}
    </div>
  );
}