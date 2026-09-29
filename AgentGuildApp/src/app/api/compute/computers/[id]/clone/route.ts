/**
 * POST /api/compute/computers/[id]/clone — Clone a computer
 *
 * Actually clones the running VM/container at the provider level,
 * creating a complete duplicate with the same disk state and installed software.
 *
 * Requirements:
 * - Source instance must have a provider instance ID (actual VM/container)
 * - Provider must support cloning (not all do)
 * - Source instance should be stopped or running (not in transitional state)
 */
import { NextRequest } from "next/server";
import { requireOrgMember, getWalletAddress } from "@/lib/auth-guard";
import { getComputer, createComputer, updateComputer } from "@/lib/compute/firestore";
import { getComputeProvider } from "@/lib/compute/provider";

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

  // ── Validation: Must have provider instance ──
  if (!computer.providerInstanceId) {
    return Response.json(
      {
        error: "Cannot clone: No provider instance attached",
        message: "This computer has never been started, so there's no actual VM/container to clone. Start it first, then clone.",
      },
      { status: 400 },
    );
  }

  // ── Validation: Must not be in transitional state ──
  const transitionalStates = ["starting", "stopping", "provisioning", "snapshotting"];
  if (transitionalStates.includes(computer.status)) {
    return Response.json(
      {
        error: `Cannot clone: Instance is ${computer.status}`,
        message: "Wait for the instance to reach a stable state (stopped or running) before cloning.",
      },
      { status: 409 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const name = (body as Record<string, string>).name || `${computer.name} (clone)`;

  // ── Create placeholder computer record ──
  const cloneId = await createComputer({
    workspaceId: computer.workspaceId,
    orgId: computer.orgId,
    name,
    status: "provisioning",
    provider: computer.provider,
    providerInstanceId: null, // Will be set after provider clone
    providerInstanceType: computer.providerInstanceType,
    providerRegion: computer.providerRegion,
    providerImage: computer.providerImage,
    providerMetadata: {
      ...computer.providerMetadata,
      clonedFrom: computer.id,
      clonedFromInstanceId: computer.providerInstanceId,
    },
    templateId: computer.templateId,
    sizeKey: computer.sizeKey,
    cpuCores: computer.cpuCores,
    ramMb: computer.ramMb,
    diskGb: computer.diskGb,
    resolutionWidth: computer.resolutionWidth,
    resolutionHeight: computer.resolutionHeight,
    region: computer.region,
    persistenceEnabled: computer.persistenceEnabled,
    staticIpEnabled: computer.staticIpEnabled,
    autoStopMinutes: computer.autoStopMinutes,
    controllerType: computer.controllerType,
    modelKey: computer.modelKey,
    openclawVariant: computer.openclawVariant,
    ownerWallet: wallet,
    ownerOrgId: computer.orgId,
    transferable: computer.transferable,
    listedForSale: false,
    listingPriceCents: null,
    listingDescription: null,
    createdByUserId: wallet,
  });

  // ── Actually clone at provider level ──
  try {
    const provider = getComputeProvider(
      computer.provider,
      computer.providerMetadata?.azureProduct as string | undefined
    );

    console.log(`[compute/clone] Cloning ${computer.providerInstanceId} → ${name}`);
    const newProviderInstanceId = await provider.cloneInstance(computer.providerInstanceId, name);

    // ── Update clone record with real provider instance ──
    await updateComputer(cloneId, {
      providerInstanceId: newProviderInstanceId,
      status: "stopped", // Clones typically start in stopped state
      providerMetadata: {
        ...computer.providerMetadata,
        clonedFrom: computer.id,
        clonedFromInstanceId: computer.providerInstanceId,
        clonedAt: new Date().toISOString(),
      },
    });

    return Response.json({
      ok: true,
      id: cloneId,
      providerInstanceId: newProviderInstanceId,
      message: `Successfully cloned ${computer.name} → ${name}`,
    }, { status: 201 });

  } catch (err) {
    console.error(`[compute/clone] Failed to clone ${id}:`, err);

    // ── Mark clone as failed ──
    await updateComputer(cloneId, {
      status: "error",
      providerMetadata: {
        clonedFrom: computer.id,
        cloneError: err instanceof Error ? err.message : "Clone failed",
      },
    });

    // Check if provider doesn't support cloning
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes("not supported") || errorMsg.includes("Cloning")) {
      return Response.json(
        {
          error: "Provider does not support cloning",
          message: `The ${computer.provider} provider does not support VM cloning. Use snapshots instead.`,
          provider: computer.provider,
        },
        { status: 501 }, // Not Implemented
      );
    }

    return Response.json(
      {
        error: "Clone failed",
        message: errorMsg,
        cloneId, // Return ID so user can check error state
      },
      { status: 500 },
    );
  }
}
