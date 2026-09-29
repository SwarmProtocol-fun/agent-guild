/**
 * GET /api/platforms/connections?orgId=xxx
 *
 * Lists active platform connections for an org (metadata only, no credentials).
 */
import { NextRequest } from "next/server";
import { listPlatformConnections } from "@/lib/platform-bridge";

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId");
  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  try {
    const connections = await listPlatformConnections(orgId);
    return Response.json({ ok: true, connections });
  } catch (err) {
    console.error("Failed to list connections:", err);
    return Response.json({ error: "Failed to list connections" }, { status: 500 });
  }
}
