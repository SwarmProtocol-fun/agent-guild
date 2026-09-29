/**
 * Agent Guild Compute — Usage Metering & Billing
 *
 * Cost estimation, usage recording, summary aggregation,
 * and markup-aware pricing with ledger tracking.
 */

import type {
  SizeKey,
  Region,
  ProviderKey,
  UsageSummary,
  ProfitabilitySummary,
  BillingLedgerEntry,
} from "./types";
import {
  recordUsage,
  getUsage,
  createLedgerEntry,
  getAllLedgerEntries,
  getPricingSettings,
} from "./firestore";
import { resolveMarkupPercent, calculateCustomerPrice, estimateProviderHourlyCost } from "./pricing";

// ═══════════════════════════════════════════════════════════════
// Provider Cost Lookup (raw cost in cents per hour, per provider)
// ═══════════════════════════════════════════════════════════════

const STORAGE_COST_PER_GB_MONTH = 5; // $0.05/GB/month raw

// ═══════════════════════════════════════════════════════════════
// Recording (with ledger entry)
// ═══════════════════════════════════════════════════════════════

export async function recordComputeHours(
  workspaceId: string,
  computerId: string,
  hours: number,
  sizeKey: SizeKey,
  opts?: {
    orgId?: string;
    sessionId?: string;
    provider?: string;
    region?: Region;
  },
): Promise<void> {
  const settings = await getPricingSettings();
  const provider = opts?.provider || "stub";
  const region = opts?.region || "us-east";
  const providerCostCents = Math.ceil(hours * estimateProviderHourlyCost(sizeKey, provider as ProviderKey));
  const markup = resolveMarkupPercent(settings, sizeKey, region, provider);
  const { customerPriceCents, platformProfitCents } = calculateCustomerPrice(
    providerCostCents,
    markup,
    settings.minimumPriceFloorCents,
  );

  // Record to usage collection (customer-facing)
  await recordUsage({
    workspaceId,
    computerId,
    metricType: "compute_hours",
    quantity: hours,
    periodStart: new Date(),
    periodEnd: new Date(),
    estimatedCostCents: customerPriceCents,
  });

  // Record to billing ledger (admin cost-vs-revenue)
  if (opts?.orgId) {
    await createLedgerEntry({
      orgId: opts.orgId,
      workspaceId,
      computerId,
      sessionId: opts.sessionId || null,
      provider,
      sizeKey,
      region,
      unitType: "compute_hour",
      quantity: hours,
      providerCostCents,
      markupPercent: markup,
      customerPriceCents,
      platformProfitCents,
    });
  }
}

export async function recordStorageUsage(
  workspaceId: string,
  sizeGb: number,
): Promise<void> {
  const providerCostCents = Math.ceil(sizeGb * STORAGE_COST_PER_GB_MONTH);
  const settings = await getPricingSettings();
  const markup = settings.defaultMarkupPercent;
  const { customerPriceCents } = calculateCustomerPrice(
    providerCostCents,
    markup,
    settings.minimumPriceFloorCents,
  );

  await recordUsage({
    workspaceId,
    computerId: null,
    metricType: "storage_gb",
    quantity: sizeGb,
    periodStart: new Date(),
    periodEnd: new Date(),
    estimatedCostCents: customerPriceCents,
  });
}

// ═══════════════════════════════════════════════════════════════
// Customer Summary
// ═══════════════════════════════════════════════════════════════

export async function getMonthlyUsageSummary(workspaceId: string): Promise<UsageSummary> {
  const records = await getUsage(workspaceId, { limit: 1000 });

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonth = records.filter(
    (r) => r.createdAt && r.createdAt.getTime() >= monthStart.getTime(),
  );

  const summary: UsageSummary = {
    totalComputeHours: 0,
    totalStorageGb: 0,
    totalActions: 0,
    totalSessions: 0,
    estimatedCostCents: 0,
  };

  for (const r of thisMonth) {
    summary.estimatedCostCents += r.estimatedCostCents;
    switch (r.metricType) {
      case "compute_hours":
        summary.totalComputeHours += r.quantity;
        break;
      case "storage_gb":
        summary.totalStorageGb += r.quantity;
        break;
      case "actions":
        summary.totalActions += r.quantity;
        break;
      case "sessions":
        summary.totalSessions += r.quantity;
        break;
    }
  }

  return summary;
}

// ═══════════════════════════════════════════════════════════════
// Admin Profitability Summary
// ═══════════════════════════════════════════════════════════════

export async function getProfitabilitySummary(opts?: {
  limit?: number;
}): Promise<ProfitabilitySummary> {
  const entries = await getAllLedgerEntries(opts?.limit || 1000);

  // Filter to current month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonth = entries.filter(
    (e) => e.createdAt && e.createdAt.getTime() >= monthStart.getTime(),
  );

  const summary: ProfitabilitySummary = {
    totalProviderCostCents: 0,
    totalCustomerRevenueCents: 0,
    totalPlatformProfitCents: 0,
    marginPercent: 0,
    entriesByProvider: {},
    entriesBySize: {},
    entriesByOrg: {},
    totalEntries: thisMonth.length,
  };

  for (const e of thisMonth) {
    summary.totalProviderCostCents += e.providerCostCents;
    summary.totalCustomerRevenueCents += e.customerPriceCents;
    summary.totalPlatformProfitCents += e.platformProfitCents;

    // By provider
    if (!summary.entriesByProvider[e.provider]) {
      summary.entriesByProvider[e.provider] = { cost: 0, revenue: 0, profit: 0 };
    }
    summary.entriesByProvider[e.provider].cost += e.providerCostCents;
    summary.entriesByProvider[e.provider].revenue += e.customerPriceCents;
    summary.entriesByProvider[e.provider].profit += e.platformProfitCents;

    // By size
    if (!summary.entriesBySize[e.sizeKey]) {
      summary.entriesBySize[e.sizeKey] = { cost: 0, revenue: 0, profit: 0 };
    }
    summary.entriesBySize[e.sizeKey].cost += e.providerCostCents;
    summary.entriesBySize[e.sizeKey].revenue += e.customerPriceCents;
    summary.entriesBySize[e.sizeKey].profit += e.platformProfitCents;

    // By org
    if (!summary.entriesByOrg[e.orgId]) {
      summary.entriesByOrg[e.orgId] = { cost: 0, revenue: 0, profit: 0, orgId: e.orgId };
    }
    summary.entriesByOrg[e.orgId].cost += e.providerCostCents;
    summary.entriesByOrg[e.orgId].revenue += e.customerPriceCents;
    summary.entriesByOrg[e.orgId].profit += e.platformProfitCents;
  }

  if (summary.totalCustomerRevenueCents > 0) {
    summary.marginPercent = Math.round(
      (summary.totalPlatformProfitCents / summary.totalCustomerRevenueCents) * 100,
    );
  }

  return summary;
}
