/**
 * GET /api/compute/sessions?computerId=xxx — List sessions
 * GET /api/compute/sessions?workspaceId=xxx — List sessions by workspace
 */
import { NextRequest } from "next/server";
import { getWalletAddress } from "@/lib/auth-guard";
import { getSessions } from "@/lib/compute/firestore";

export async function GET(req: NextRequest) {
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const computerId = req.nextUrl.searchParams.get("computerId") || undefined;
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") || undefined;
  const rawLimit = parseInt(req.nextUrl.searchParams.get("limit") || "50", 10);
  const limit = isNaN(rawLimit) ? 50 : Math.max(1, Math.min(rawLimit, 200));

  if (!computerId && !workspaceId) {
    return Response.json({ error: "computerId or workspaceId required" }, { status: 400 });
  }

  const sessions = await getSessions({ computerId, workspaceId, limit });
  return Response.json({ ok: true, sessions });
}
