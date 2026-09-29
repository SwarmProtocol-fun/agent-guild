/**
 * POST /api/compute/computers/[id]/snapshot — Create a snapshot of a computer
 *
 * Creates a provider-backed snapshot of the instance's disk state.
 * Requires an actual running VM/container - cannot snapshot metadata-only instances.
 */
import { NextRequest } from "next/server";
import { requireOrgMember } from "@/lib/auth-guard";
import { getComputer, updateComputer, createSnapshot } from "@/lib/compute/firestore";
import { getComputeProvider } from "@/lib/compute/provider";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const computer = await getComputer(id);
  if (!computer) return Response.json({ error: "Computer not found" }, { status: 404 });

  const auth = await requireOrgMember(req, computer.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  // ── Validation: Must have provider instance ──
  if (!computer.providerInstanceId) {
    return Response.json(
      {
        error: "Cannot snapshot: No provider instance attached",
        message: "This computer has never been started, so there's no actual VM/container to snapshot. Start it first, then create a snapshot.",
        provider: computer.provider,
      },
      { status: 400 },
    );
  }

  // ── Validation: Must be in stable state ──
  if (computer.status !== "running" && computer.status !== "stopped") {
    return Response.json(
      {
        error: `Cannot snapshot computer in "${computer.status}" state`,
        message: "Snapshots can only be created from running or stopped instances.",
      },
      { status: 409 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const label = (body as Record<string, string>).label || `Snapshot ${new Date().toISOString()}`;

  const prevStatus = computer.status;
  await updateComputer(id, { status: "snapshotting" });

  const provider = getComputeProvider(
    computer.provider,
    computer.providerMetadata?.azureProduct as string | undefined
  );

  try {
    // ── Actually create snapshot at provider ──
    console.log(`[compute/snapshot] Creating snapshot of ${computer.providerInstanceId}: ${label}`);
    const providerSnapshotId = await provider.createSnapshot(computer.providerInstanceId, label);

    // ── Record snapshot in Firestore ──
    const snapshotId = await createSnapshot({
      computerId: id,
      providerSnapshotId,
      label,
    });

    await updateComputer(id, { status: prevStatus });

    return Response.json({
      ok: true,
      snapshotId,
      providerSnapshotId,
      message: `Snapshot "${label}" created successfully`,
    }, { status: 201 });

  } catch (err) {
    console.error("[compute/snapshot] Failed:", err);
    await updateComputer(id, { status: prevStatus });

    // Check if provider doesn't support snapshots
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes("not supported") || errorMsg.includes("Snapshot")) {
      return Response.json(
        {
          error: "Provider does not support snapshots",
          message: `The ${computer.provider} provider does not support snapshots for this instance type.`,
          provider: computer.provider,
        },
        { status: 501 }, // Not Implemented
      );
    }

    return Response.json(
      {
        error: "Failed to create snapshot",
        message: errorMsg,
      },
      { status: 500 },
    );
  }
}
