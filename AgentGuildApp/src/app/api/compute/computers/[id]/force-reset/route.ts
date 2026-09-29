/**
 * POST /api/compute/computers/[id]/force-reset — Force reset stuck instance
 *
 * Use this to recover from stuck transitional states (starting, stopping, provisioning)
 * This is a destructive operation that should only be used after manual verification
 */
import { NextRequest } from "next/server";
import { requireOrgMember, getWalletAddress } from "@/lib/auth-guard";
import { getComputer, updateComputer } from "@/lib/compute/firestore";

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

  // Only allow reset for transitional states
  const allowedStates = ["starting", "stopping", "provisioning", "snapshotting"];
  if (!allowedStates.includes(computer.status)) {
    return Response.json(
      {
        error: `Cannot force reset instance in "${computer.status}" state`,
        message: "Force reset is only allowed for stuck transitional states",
        allowedStates,
      },
      { status: 400 },
    );
  }

  // Check if actually stuck (> 10 minutes in transitional state)
  const lastUpdated = computer.updatedAt ? new Date(computer.updatedAt) : new Date();
  const timeInState = Date.now() - lastUpdated.getTime();
  const timeInStateMinutes = Math.round(timeInState / 60000);

  if (timeInState < 5 * 60 * 1000) {
    return Response.json(
      {
        error: "Instance not stuck yet",
        message: `Instance has only been in "${computer.status}" state for ${timeInStateMinutes} minutes. Please wait at least 5 minutes before force-resetting.`,
        timeInStateMinutes,
      },
      { status: 400 },
    );
  }

  console.warn(`[compute/force-reset] Force resetting ${id} from "${computer.status}" state (stuck for ${timeInStateMinutes} min)`);

  // Reset to error state
  await updateComputer(id, {
    status: "error",
    providerMetadata: {
      ...computer.providerMetadata,
      forceResetAt: new Date().toISOString(),
      forceResetReason: `Stuck in "${computer.status}" for ${timeInStateMinutes} minutes`,
      previousStatus: computer.status,
    },
  });

  return Response.json({
    ok: true,
    message: `Instance reset to "error" state. You can now retry starting it.`,
    previousStatus: computer.status,
    timeInStateMinutes,
  });
}
