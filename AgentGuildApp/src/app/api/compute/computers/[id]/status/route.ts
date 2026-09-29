/**
 * GET /api/compute/computers/[id]/status — Get detailed instance status
 *
 * Returns comprehensive state information for debugging stuck instances
 */
import { NextRequest } from "next/server";
import { getWalletAddress } from "@/lib/auth-guard";
import { getComputer } from "@/lib/compute/firestore";
import { probeInstanceHealth } from "@/lib/compute/health";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const computer = await getComputer(id);
  if (!computer) return Response.json({ error: "Computer not found" }, { status: 404 });

  // Calculate time in current state
  const lastUpdated = computer.updatedAt ? new Date(computer.updatedAt) : null;
  const lastActive = computer.lastActiveAt ? new Date(computer.lastActiveAt) : null;
  const now = new Date();

  const timeInState = lastUpdated
    ? Math.round((now.getTime() - lastUpdated.getTime()) / 1000)
    : null;

  const timeSinceActive = lastActive
    ? Math.round((now.getTime() - lastActive.getTime()) / 1000)
    : null;

  // Determine if stuck
  const isStuck =
    (computer.status === "starting" && timeInState && timeInState > 600) || // > 10 min
    (computer.status === "stopping" && timeInState && timeInState > 300) || // > 5 min
    (computer.status === "provisioning" && timeInState && timeInState > 900); // > 15 min

  // Suggested action
  let suggestedAction = null;
  if (isStuck) {
    suggestedAction = {
      action: "force_reset",
      description: `Instance stuck in "${computer.status}" for ${Math.round(timeInState! / 60)} minutes`,
      endpoint: `/api/compute/computers/${id}/force-reset`,
      method: "POST",
    };
  } else if (computer.status === "running" && timeSinceActive && timeSinceActive > computer.autoStopMinutes * 60) {
    suggestedAction = {
      action: "auto_stop_pending",
      description: `Instance idle for ${Math.round(timeSinceActive / 60)} minutes (auto-stop: ${computer.autoStopMinutes} min)`,
      endpoint: `/api/compute/computers/${id}/stop`,
      method: "POST",
    };
  }

  // Live health probe for running/starting instances (opt-in via ?probe=true)
  const doProbe = req.nextUrl.searchParams.get("probe") === "true";
  let healthProbe = null;
  if (doProbe && computer.providerInstanceId && (computer.status === "running" || computer.status === "starting")) {
    healthProbe = await probeInstanceHealth(computer);
  }

  return Response.json({
    id: computer.id,
    name: computer.name,
    status: computer.status,
    provider: computer.provider,
    providerInstanceId: computer.providerInstanceId,
    providerMetadata: computer.providerMetadata,

    timing: {
      createdAt: computer.createdAt,
      updatedAt: computer.updatedAt,
      lastActiveAt: computer.lastActiveAt,
      timeInCurrentState: timeInState ? `${Math.round(timeInState / 60)}m ${timeInState % 60}s` : null,
      timeSinceLastActive: timeSinceActive ? `${Math.round(timeSinceActive / 60)}m ${timeSinceActive % 60}s` : null,
    },

    health: {
      isStuck,
      canStart: computer.status === "stopped" || computer.status === "error",
      canStop: computer.status === "running",
      canRestart: computer.status === "running",
      suggestedAction,
      ...(healthProbe && {
        probe: {
          healthy: healthProbe.healthy,
          providerState: healthProbe.providerState,
          vncReachable: healthProbe.vncReachable,
          sshReachable: healthProbe.sshReachable,
          probeMs: healthProbe.durationMs,
        },
      }),
    },

    resources: {
      sizeKey: computer.sizeKey,
      cpuCores: computer.cpuCores,
      ramMb: computer.ramMb,
      diskGb: computer.diskGb,
      region: computer.region,
    },

    config: {
      autoStopMinutes: computer.autoStopMinutes,
      persistenceEnabled: computer.persistenceEnabled,
      staticIpEnabled: computer.staticIpEnabled,
      controllerType: computer.controllerType,
    },
  });
}
