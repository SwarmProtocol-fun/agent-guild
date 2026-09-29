/**
 * GET /api/compute/computers/[id]/terminal-token — Get terminal URL for a running computer
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
      { error: "Computer must be running to get terminal access" },
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
    const url = await provider.getTerminalUrl(computer.providerInstanceId);
    return Response.json({ ok: true, url });
  } catch (err) {
    console.error("[compute/terminal-token] Failed:", err);
    return Response.json({ error: "Failed to get terminal URL" }, { status: 500 });
  }
}
