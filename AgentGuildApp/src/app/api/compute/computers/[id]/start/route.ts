/**
 * POST /api/compute/computers/[id]/start — Start a stopped computer
 *
 * Enforces entitlements before starting:
 * - Hour quota not exceeded
 * - Instance size allowed on plan
 * - Concurrent computer limit not exceeded
 */
import { NextRequest } from "next/server";
import { requireOrgMember, getWalletAddress } from "@/lib/auth-guard";
import { getComputer, getComputers, updateComputer, getEntitlement } from "@/lib/compute/firestore";
import { getComputeProvider, ProviderCredentialError, checkProviderAvailability } from "@/lib/compute/provider";
import { startComputeSession } from "@/lib/compute/sessions";
import { pollUntilHealthy } from "@/lib/compute/health";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const computer = await getComputer(id);
  if (!computer) return Response.json({ error: "Computer not found" }, { status: 404 });

  const auth = await requireOrgMember(req, computer.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  // Check if already running
  if (computer.status === "running") {
    return Response.json(
      {
        error: "Computer is already running",
        currentStatus: computer.status,
        message: "The instance is already active. Refresh the page to see current status."
      },
      { status: 409 },
    );
  }

  // Auto-recover from stuck "starting" state (> 10 minutes old)
  if (computer.status === "starting") {
    const startingDuration = computer.lastActiveAt
      ? Date.now() - new Date(computer.lastActiveAt).getTime()
      : 0;

    if (startingDuration > 10 * 60 * 1000) {
      console.warn(`[compute/start] Recovering from stuck "starting" state for ${id} (stuck for ${Math.round(startingDuration / 1000)}s)`);
      await updateComputer(id, { status: "error" });
      // Allow retry immediately
    } else {
      return Response.json(
        {
          error: "Computer is currently starting",
          currentStatus: computer.status,
          message: "Please wait for the current startup to complete (usually 2-5 minutes)."
        },
        { status: 409 },
      );
    }
  }

  // Reject other transitional states
  if (computer.status !== "stopped" && computer.status !== "error") {
    return Response.json(
      {
        error: `Cannot start computer in "${computer.status}" state`,
        currentStatus: computer.status,
        message: `The instance is ${computer.status}. Wait for it to reach a stable state.`
      },
      { status: 409 },
    );
  }

  // ── Entitlement enforcement ──
  const entitlement = await getEntitlement(computer.orgId);
  if (entitlement) {
    // Check hour quota (0 = unlimited)
    if (entitlement.monthlyHourQuota > 0 && entitlement.hoursUsedThisPeriod >= entitlement.monthlyHourQuota) {
      return Response.json(
        { error: `Monthly compute hour quota exhausted (${entitlement.monthlyHourQuota}h). Upgrade your plan to continue.` },
        { status: 402 },
      );
    }

    // Check size allowance
    if (!entitlement.allowedSizes.includes(computer.sizeKey)) {
      return Response.json(
        { error: `Instance size "${computer.sizeKey}" is not available on your ${entitlement.planTier} plan.` },
        { status: 403 },
      );
    }

    // Check concurrent limit
    const allComputers = await getComputers(computer.orgId);
    const runningCount = allComputers.filter((c) => c.status === "running" || c.status === "starting").length;
    if (runningCount >= entitlement.maxConcurrentComputers) {
      return Response.json(
        { error: `Concurrent computer limit reached (${entitlement.maxConcurrentComputers}). Stop a running computer or upgrade your plan.` },
        { status: 402 },
      );
    }
  }

  // ── Provider availability check ──
  const availability = checkProviderAvailability(computer.provider);
  if (!availability.available) {
    return Response.json(
      {
        error: "Compute provider unavailable",
        provider: computer.provider,
        reason: availability.reason,
        message: `Cannot start — ${availability.reason}. Configure the required credentials or change the instance provider.`,
      },
      { status: 503 },
    );
  }

  await updateComputer(id, { status: "starting" });

  const provider = getComputeProvider(computer.provider);
  try {
    if (computer.providerInstanceId) {
      await provider.startInstance(computer.providerInstanceId);
    } else {
      const result = await provider.createInstance({
        name: computer.name,
        sizeKey: computer.sizeKey,
        cpuCores: computer.cpuCores,
        ramMb: computer.ramMb,
        diskGb: computer.diskGb,
        resolutionWidth: computer.resolutionWidth,
        resolutionHeight: computer.resolutionHeight,
        region: computer.region,
        baseImage: computer.providerImage || "ubuntu:22.04",
        persistenceEnabled: computer.persistenceEnabled,
        providerInstanceType: computer.providerInstanceType || undefined,
        providerRegion: computer.providerRegion || undefined,
        providerImage: computer.providerImage || undefined,
        providerMetadata: { orgId: computer.orgId, computerId: computer.id },
      });
      await updateComputer(id, {
        providerInstanceId: result.providerInstanceId,
        providerInstanceType: result.providerInstanceType || null,
        providerRegion: result.providerRegion || null,
        providerMetadata: result.metadata || {},
      });
    }

    // Don't mark as "running" yet — launch async health check polling.
    // The health check will poll the provider until the instance is truly
    // ready (PowerState/running + VNC/SSH reachable), then mark "running".
    // If it times out after 10 minutes, it marks "error".
    const sessionId = await startComputeSession(
      id,
      computer.workspaceId,
      computer.controllerType,
      wallet,
      computer.modelKey,
    );

    // Fire-and-forget: health check runs in the background
    pollUntilHealthy(id).catch((err) => {
      console.error(`[compute/start] Health check failed for ${id}:`, err);
    });

    return Response.json({
      ok: true,
      sessionId,
      status: "starting",
      message: "Instance is starting. Health checks will promote to 'running' once the provider confirms the instance is ready.",
    });
  } catch (err) {
    console.error("[compute/start] Failed:", err);

    const errorMessage = err instanceof Error ? err.message : String(err);

    console.error("[compute/start] Error details:", {
      message: errorMessage,
      stack: err instanceof Error ? err.stack : undefined,
      provider: computer.provider,
      hasInstanceId: !!computer.providerInstanceId,
    });

    await updateComputer(id, {
      status: "error",
      providerMetadata: {
        ...computer.providerMetadata,
        lastError: errorMessage,
        lastErrorAt: new Date().toISOString(),
      }
    });

    // Provide actionable error messages based on error type
    const isCredentialError = err instanceof ProviderCredentialError
      || errorMessage.includes("credentials")
      || errorMessage.includes("authentication");

    return Response.json({
      error: "Failed to start computer",
      details: errorMessage,
      provider: computer.provider,
      suggestion: isCredentialError
        ? "Check Azure credentials in environment variables"
        : errorMessage.includes("quota") || errorMessage.includes("limit")
        ? "Check Azure subscription quotas and limits"
        : "Check server logs for details"
    }, { status: 500 });
  }
}
