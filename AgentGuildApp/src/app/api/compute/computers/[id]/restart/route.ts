/**
 * POST /api/compute/computers/[id]/restart — Restart a running computer
 */
import { NextRequest } from "next/server";
import { requireOrgMember } from "@/lib/auth-guard";
import { getComputer, updateComputer } from "@/lib/compute/firestore";
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

  if (computer.status !== "running" && computer.status !== "error") {
    return Response.json(
      { error: `Cannot restart computer in "${computer.status}" state` },
      { status: 409 },
    );
  }

  await updateComputer(id, { status: "starting" });

  const provider = getComputeProvider(computer.provider);
  try {
    if (computer.providerInstanceId) {
      await provider.restartInstance(computer.providerInstanceId);
    }
    await updateComputer(id, { status: "running", lastActiveAt: new Date() });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[compute/restart] Failed:", err);
    await updateComputer(id, { status: "error" });
    return Response.json({ error: "Failed to restart computer" }, { status: 500 });
  }
}
