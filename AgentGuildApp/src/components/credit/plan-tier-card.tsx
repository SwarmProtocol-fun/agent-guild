/**
 * Plan Tier Card — Displays the org's current compute plan, credit balance,
 * quota usage, and upgrade path.
 */
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowRight, Zap, Clock, Cpu, CreditCard } from "lucide-react";
import type { ComputeEntitlement } from "@/lib/compute/types";
import { PLAN_LIMITS } from "@/lib/compute/types";

interface PlanTierCardProps {
  entitlement: ComputeEntitlement | null;
  runningCount: number;
}

const TIER_STYLES: Record<string, { badge: string; accent: string; glow: string }> = {
  free: {
    badge: "bg-zinc-100 text-zinc-600 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-600",
    accent: "text-zinc-400",
    glow: "",
  },
  starter: {
    badge: "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-700",
    accent: "text-blue-400",
    glow: "",
  },
  pro: {
    badge: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-700",
    accent: "text-amber-400",
    glow: "shadow-amber-500/10",
  },
  enterprise: {
    badge: "bg-violet-100 text-violet-700 border-violet-300 dark:bg-violet-950/50 dark:text-violet-300 dark:border-violet-700",
    accent: "text-violet-400",
    glow: "shadow-violet-500/10",
  },
};

const TIER_ORDER = ["free", "starter", "pro", "enterprise"] as const;

export function PlanTierCard({ entitlement, runningCount }: PlanTierCardProps) {
  const tier = entitlement?.planTier || "free";
  const limits = PLAN_LIMITS[tier];
  const style = TIER_STYLES[tier] || TIER_STYLES.free;

  const hoursUsed = entitlement?.hoursUsedThisPeriod || 0;
  const hoursQuota = entitlement?.monthlyHourQuota || limits.monthlyHours;
  const hoursPct = hoursQuota > 0 ? Math.min((hoursUsed / hoursQuota) * 100, 100) : 0;
  const hoursUnlimited = hoursQuota === 0;

  const creditBalance = entitlement?.creditBalanceCents || 0;
  const maxConcurrent = entitlement?.maxConcurrentComputers || limits.maxConcurrent;
  const concurrentPct = Math.min((runningCount / maxConcurrent) * 100, 100);

  const nextTierIdx = TIER_ORDER.indexOf(tier as typeof TIER_ORDER[number]) + 1;
  const nextTier = nextTierIdx < TIER_ORDER.length ? TIER_ORDER[nextTierIdx] : null;

  // Warning thresholds
  const hoursWarning = hoursPct >= 80;
  const hoursCritical = hoursPct >= 95;
  const concurrentWarning = concurrentPct >= 80;

  return (
    <Card className={`${style.glow}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className={`h-4 w-4 ${style.accent}`} />
            Compute Plan
          </CardTitle>
          <Badge className={style.badge}>{tier.charAt(0).toUpperCase() + tier.slice(1)}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Credit Balance */}
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Credit Balance</span>
            </div>
            <span className="text-lg font-bold font-mono">
              ${(creditBalance / 100).toFixed(2)}
            </span>
          </div>
          {creditBalance <= 0 && tier !== "enterprise" && (
            <p className="text-[10px] text-amber-500 mt-1">No credits remaining. Usage will be limited to plan quota.</p>
          )}
        </div>

        {/* Compute Hours */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Compute Hours</span>
            </div>
            <span className={`text-xs font-medium ${hoursCritical ? "text-red-500" : hoursWarning ? "text-amber-500" : ""}`}>
              {hoursUsed.toFixed(1)} / {hoursUnlimited ? "Unlimited" : `${hoursQuota}h`}
            </span>
          </div>
          {!hoursUnlimited && (
            <div className="h-2 rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${
                  hoursCritical ? "bg-red-500" : hoursWarning ? "bg-amber-500" : "bg-blue-500"
                }`}
                style={{ width: `${hoursPct}%` }}
              />
            </div>
          )}
          {hoursCritical && (
            <p className="text-[10px] text-red-500 mt-1">Quota nearly exhausted. Upgrade to continue using compute.</p>
          )}
          {hoursWarning && !hoursCritical && (
            <p className="text-[10px] text-amber-500 mt-1">{Math.round(hoursQuota - hoursUsed)}h remaining this period.</p>
          )}
        </div>

        {/* Concurrent Instances */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Running Instances</span>
            </div>
            <span className={`text-xs font-medium ${concurrentWarning ? "text-amber-500" : ""}`}>
              {runningCount} / {maxConcurrent}
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-all ${
                concurrentWarning ? "bg-amber-500" : "bg-emerald-500"
              }`}
              style={{ width: `${concurrentPct}%` }}
            />
          </div>
        </div>

        {/* Allowed Sizes */}
        <div>
          <span className="text-xs text-muted-foreground">Available Sizes</span>
          <div className="flex gap-1.5 mt-1">
            {(["small", "medium", "large", "xl"] as const).map((size) => {
              const allowed = (entitlement?.allowedSizes || limits.allowedSizes).includes(size);
              return (
                <Badge
                  key={size}
                  variant="outline"
                  className={`text-[10px] ${
                    allowed
                      ? "border-emerald-300 text-emerald-600 dark:border-emerald-700 dark:text-emerald-400"
                      : "border-border text-muted-foreground/40 line-through"
                  }`}
                >
                  {size.toUpperCase()}
                </Badge>
              );
            })}
          </div>
        </div>

        {/* Upgrade CTA */}
        {nextTier && (
          <div className="pt-2 border-t border-border">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium">
                  Upgrade to {nextTier.charAt(0).toUpperCase() + nextTier.slice(1)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {nextTier === "starter" && "50h/month, 3 instances, Medium size"}
                  {nextTier === "pro" && "200h/month, 10 instances, Large size"}
                  {nextTier === "enterprise" && "Unlimited hours, 50 instances, all sizes"}
                </p>
              </div>
              <Button variant="outline" size="sm" className="text-xs gap-1">
                Upgrade <ArrowRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
