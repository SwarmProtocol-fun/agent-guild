/**
 * POST /api/v1/compute/purchase
 *
 * Purchase a new compute instance with an OpenClaw variant.
 * Validates entitlements, deducts credits, creates the Computer document,
 * and provisions via the selected provider.
 */
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, forbidden } from "@/lib/auth-guard";
import {
  createComputer,
  getEntitlement,
  deductCredits,
  getComputers,
  createLedgerEntry,
} from "@/lib/compute/firestore";
import {
  OPENCLAW_VARIANTS,
  SIZE_PRESETS,
  PROVIDER_HOURLY_COSTS,
  DEFAULT_RESOLUTION,
  DEFAULT_AUTO_STOP_MINUTES,
  type OpenClawVariant,
  type SizeKey,
  type ProviderKey,
  type Region,
} from "@/lib/compute/types";

export async function POST(req: NextRequest) {
  try {
    // --- Auth: require wallet session ---
    const wallet = req.headers.get("x-wallet-address");
    const orgId = req.headers.get("x-org-id");
    if (!wallet || !orgId) return unauthorized("Wallet and org required");

    const body = await req.json();
    const {
      variant,
      name,
      sizeKey = null,
      provider = "azure" as ProviderKey,
      region = "us-east" as Region,
      workspaceId,
    } = body as {
      variant: OpenClawVariant;
      name: string;
      sizeKey?: SizeKey | null;
      provider?: ProviderKey;
      region?: Region;
      workspaceId: string;
    };

    // --- Validate variant ---
    const variantInfo = OPENCLAW_VARIANTS[variant];
    if (!variantInfo) {
      return NextResponse.json(
        { error: `Invalid variant: ${variant}. Valid: ${Object.keys(OPENCLAW_VARIANTS).join(", ")}` },
        { status: 400 },
      );
    }

    // --- Resolve size ---
    const resolvedSize: SizeKey = sizeKey || variantInfo.defaultSize;
    const sizeSpec = SIZE_PRESETS[resolvedSize];
    if (!sizeSpec) {
      return NextResponse.json({ error: `Invalid size: ${resolvedSize}` }, { status: 400 });
    }

    // --- Check entitlements ---
    const entitlement = await getEntitlement(orgId);
    if (!entitlement) {
      return forbidden("No compute entitlement. Upgrade your plan.");
    }

    if (!entitlement.allowedSizes.includes(resolvedSize)) {
      return forbidden(
        `Your ${entitlement.planTier} plan doesn't allow ${resolvedSize} instances. Upgrade to unlock.`,
      );
    }

    // Check concurrent limit
    const existing = await getComputers(orgId, { status: "running" });
    if (existing.length >= entitlement.maxConcurrentComputers) {
      return forbidden(
        `Concurrent limit reached (${entitlement.maxConcurrentComputers}). Stop an instance or upgrade.`,
      );
    }

    // --- Size-based pricing with 30% markup (same for all variants) ---
    const MARKUP = 0.30;
    const providerCostPerHour = PROVIDER_HOURLY_COSTS[provider]?.[resolvedSize] ?? PROVIDER_HOURLY_COSTS.e2b[resolvedSize];
    const customerPricePerHour = Math.ceil(providerCostPerHour * (1 + MARKUP));
    // Estimate first month deposit (730 hours)
    const estimatedMonthlyCents = customerPricePerHour * 730;

    // Check credit balance (deduct first hour as deposit)
    if (entitlement.creditBalanceCents < customerPricePerHour) {
      return NextResponse.json(
        {
          error: "Insufficient credits",
          required: customerPricePerHour,
          available: entitlement.creditBalanceCents,
          hourlyRate: customerPricePerHour,
        },
        { status: 402 },
      );
    }

    // --- Deduct first hour as deposit ---
    const deducted = await deductCredits(orgId, customerPricePerHour);
    if (!deducted) {
      return NextResponse.json({ error: "Credit deduction failed" }, { status: 402 });
    }

    // --- Create the Computer doc ---
    const computerId = await createComputer({
      workspaceId,
      orgId,
      name: name || `${variantInfo.label} Agent`,
      status: "provisioning",
      provider,
      providerInstanceId: null,
      providerInstanceType: null,
      providerRegion: null,
      providerImage: variantInfo.baseImage,
      providerMetadata: {},
      templateId: null,
      sizeKey: resolvedSize,
      cpuCores: sizeSpec.cpu,
      ramMb: sizeSpec.ram,
      diskGb: sizeSpec.disk,
      resolutionWidth: DEFAULT_RESOLUTION.width,
      resolutionHeight: DEFAULT_RESOLUTION.height,
      region,
      persistenceEnabled: true,
      staticIpEnabled: false,
      autoStopMinutes: DEFAULT_AUTO_STOP_MINUTES,
      controllerType: "hybrid",
      modelKey: null,
      openclawVariant: variant,
      ownerWallet: wallet,
      ownerOrgId: orgId,
      transferable: true,
      listedForSale: false,
      listingPriceCents: null,
      listingDescription: null,
      createdByUserId: wallet,
    });

    // --- Billing ledger entry ---
    await createLedgerEntry({
      orgId,
      workspaceId,
      computerId,
      sessionId: null,
      provider,
      sizeKey: resolvedSize,
      region,
      unitType: "compute_hour",
      quantity: 1,
      providerCostCents: providerCostPerHour,
      markupPercent: 30,
      customerPriceCents: customerPricePerHour,
      platformProfitCents: customerPricePerHour - providerCostPerHour,
    });

    return NextResponse.json({
      ok: true,
      computerId,
      variant,
      variantLabel: variantInfo.label,
      sizeKey: resolvedSize,
      hourlyRateCents: customerPricePerHour,
      estimatedMonthlyCents,
      message: `${variantInfo.label} instance is provisioning. It will be ready shortly.`,
    });
  } catch (err) {
    console.error("[compute/purchase] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Purchase failed" },
      { status: 500 },
    );
  }
}
