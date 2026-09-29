/**
 * GET /api/compute/computers/[id]/vnc-token — Get VNC/desktop URL for a running computer
 */
import { NextRequest } from "next/server";
import { requireOrgMember } from "@/lib/auth-guard";
import { getComputer } from "@/lib/compute/firestore";
import { getComputeProvider } from "@/lib/compute/provider";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const computer = await getComputer(id);
  if (!computer) return Response.json({ error: "Computer not found" }, { status: 404 });

  const auth = await requireOrgMember(req, computer.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  if (computer.status !== "running") {
    return Response.json(
      { error: "Computer must be running to get VNC access" },
      { status: 409 },
    );
  }

  if (!computer.providerInstanceId) {
    return Response.json(
      { error: "Computer has no provider instance — it may still be provisioning" },
      { status: 409 },
    );
  }

  const provider = getComputeProvider(computer.provider);
  try {
    const url = await provider.getVncUrl(computer.providerInstanceId);

    // Some providers (swarm-node, stub) don't support VNC
    if (!url) {
      return Response.json(
        { error: `VNC access is not supported for provider "${computer.provider}"` },
        { status: 501 },
      );
    }

    return Response.json({ ok: true, url });
  } catch (err) {
    // Extract detailed error message
    const errorMessage = err instanceof Error ? err.message : String(err);
    const stackTrace = err instanceof Error ? err.stack : undefined;

    console.error("[compute/vnc-token] Failed:", {
      error: errorMessage,
      stack: stackTrace,
      provider: computer.provider,
      providerInstanceId: computer.providerInstanceId,
      computerId: computer.id,
      computerStatus: computer.status,
    });

    return Response.json({
      error: "Failed to get VNC URL",
      details: errorMessage,
      provider: computer.provider,
      suggestion: errorMessage.includes("credentials") || errorMessage.includes("authentication")
        ? "Check Azure credentials in environment variables"
        : errorMessage.includes("not found") || errorMessage.includes("does not exist")
        ? "The VM may have been deleted or not yet created"
        : "Check server logs for details"
    }, { status: 500 });
  }
}
