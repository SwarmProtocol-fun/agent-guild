/**
 * GET    /api/compute/computers/[id]  — Get computer details
 * PATCH  /api/compute/computers/[id]  — Update computer settings
 * DELETE /api/compute/computers/[id]  — Delete computer
 */
import { NextRequest } from "next/server";
import { requireOrgMember, requireOrgAdmin } from "@/lib/auth-guard";
import { getComputer, updateComputer, deleteComputer } from "@/lib/compute/firestore";
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

  return Response.json({ ok: true, computer });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const computer = await getComputer(id);
  if (!computer) return Response.json({ error: "Computer not found" }, { status: 404 });

  const auth = await requireOrgMember(req, computer.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  const body = await req.json();
  const allowed = [
    "name", "resolutionWidth", "resolutionHeight",
    "autoStopMinutes", "persistenceEnabled", "staticIpEnabled",
    "controllerType", "modelKey",
  ];
  const update: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) update[key] = body[key];
  }

  await updateComputer(id, update);
  return Response.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const computer = await getComputer(id);
  if (!computer) return Response.json({ error: "Computer not found" }, { status: 404 });

  const auth = await requireOrgAdmin(req, computer.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  // Stop provider instance if running
  if (computer.providerInstanceId && computer.status !== "stopped") {
    const provider = getComputeProvider(computer.provider);
    try {
      await provider.deleteInstance(computer.providerInstanceId);
    } catch (err) {
      console.error("[compute/delete] Provider cleanup failed:", err);
    }
  }

  await deleteComputer(id);
  return Response.json({ ok: true });
}
