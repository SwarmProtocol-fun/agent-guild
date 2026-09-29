/**
 * POST /api/workflows/runs/recover
 *
 * Recover stale workflow runs that have been stuck in "running" state.
 * Finds active runs with updatedAt older than 5 minutes and attempts
 * to advance or timeout them.
 *
 * Body: { orgId: string }
 * Auth: org member (wallet session)
 */

import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { getActiveRuns } from "@/lib/workflow/store";
import { advanceRun } from "@/lib/workflow/executor";

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export async function POST(req: NextRequest) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  let body: { orgId: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  const orgAuth = await requireOrgMember(req, body.orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  try {
    const activeRuns = await getActiveRuns(body.orgId);
    const now = Date.now();
    let recovered = 0;
    let timedOut = 0;

    for (const run of activeRuns) {
      const updatedMs =
        typeof run.updatedAt === "number"
          ? run.updatedAt
          : (run.updatedAt as { toMillis?: () => number })?.toMillis?.() ?? now;

      if (now - updatedMs > STALE_THRESHOLD_MS) {
        try {
          const updated = await advanceRun(run.id);
          if (updated.status === "completed" || updated.status === "failed" || updated.status === "cancelled") {
            timedOut++;
          } else {
            recovered++;
          }
        } catch {
          timedOut++;
        }
      }
    }

    return Response.json({ ok: true, recovered, timedOut, checked: activeRuns.length });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Recovery failed" },
      { status: 500 },
    );
  }
}
