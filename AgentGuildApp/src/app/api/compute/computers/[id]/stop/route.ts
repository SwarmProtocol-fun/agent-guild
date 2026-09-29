/**
 * POST /api/compute/computers/[id]/stop — Stop a running computer
 */
import { NextRequest } from "next/server";
import { requireOrgMember } from "@/lib/auth-guard";
import { getComputer, updateComputer, getSessions } from "@/lib/compute/firestore";
import { getComputeProvider } from "@/lib/compute/provider";
import { endComputeSession } from "@/lib/compute/sessions";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const computer = await getComputer(id);
  if (!computer) return Response.json({ error: "Computer not found" }, { status: 404 });

  const auth = await requireOrgMember(req, computer.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  if (computer.status !== "running" && computer.status !== "starting") {
    return Response.json(
      { error: `Cannot stop computer in "${computer.status}" state` },
      { status: 409 },
    );
  }

  await updateComputer(id, { status: "stopping" });

  const provider = getComputeProvider(computer.provider);
  try {
    if (computer.providerInstanceId) {
      await provider.stopInstance(computer.providerInstanceId);
    }

    // End all active sessions — use allSettled so one failure doesn't block the stop
    const sessions = await getSessions({ computerId: id, limit: 50 });
    const activeSessions = sessions.filter((s) => !s.endedAt);
    await Promise.allSettled(activeSessions.map((s) => endComputeSession(s.id)));

    await updateComputer(id, { status: "stopped" });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[compute/stop] Failed:", err);
    await updateComputer(id, { status: "error" });
    return Response.json({ error: "Failed to stop computer" }, { status: 500 });
  }
}
