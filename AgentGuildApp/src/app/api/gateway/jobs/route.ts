/**
 * GET /api/gateway/jobs?orgId=...&status=...&limit=...&offset=... — List gateway jobs
 *
 * Auth: org member (wallet session)
 */

import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { getOrgTasks } from "@/lib/gateway/store";
import type { QueuedTaskStatus } from "@/lib/gateway/types";

const VALID_STATUSES: QueuedTaskStatus[] = [
  "queued", "claimed", "running", "completed", "failed", "timeout", "cancelled",
];

export async function GET(req: NextRequest) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const orgId = req.nextUrl.searchParams.get("orgId");
  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  const orgAuth = await requireOrgMember(req, orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  const statusParam = req.nextUrl.searchParams.get("status") as QueuedTaskStatus | null;
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "50", 10), 100);
  const offset = Math.max(parseInt(req.nextUrl.searchParams.get("offset") || "0", 10), 0);

  if (statusParam && !VALID_STATUSES.includes(statusParam)) {
    return Response.json({ error: "Invalid status filter" }, { status: 400 });
  }

  try {
    const jobs = await getOrgTasks(orgId, statusParam || undefined, limit, offset);
    return Response.json({ ok: true, jobs, count: jobs.length });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to list jobs" },
      { status: 500 },
    );
  }
}
