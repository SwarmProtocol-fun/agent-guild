/**
 * POST /api/cron/[id]/pause
 *
 * Toggle pause state of a cron job.
 * Body: { paused: boolean }
 */

import { NextRequest } from "next/server";
import { getCronJob, updateCronJob } from "@/lib/firestore-admin";
import { getWalletAddress, requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getClientIp } from "@/lib/client-ip";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ip = getClientIp(request);
  const limited = await rateLimit(`cron:${ip}`);
  if (limited) return limited;

  // Auth: require authenticated user
  const wallet = getWalletAddress(request);
  if (!wallet) {
    return unauthorized("Authentication required");
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { paused } = body;

  if (typeof paused !== "boolean") {
    return Response.json(
      { error: "paused (boolean) is required" },
      { status: 400 }
    );
  }

  try {
    // Membership is checked against the job's own org, not a client-supplied orgId
    const job = await getCronJob(id);
    if (!job) {
      return Response.json({ error: "Cron job not found" }, { status: 404 });
    }
    const auth = await requireOrgMember(request, job.orgId);
    if (!auth.ok) {
      return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);
    }

    await updateCronJob(id, { paused });

    return Response.json({
      ok: true,
      message: paused ? `Cron job ${id} has been paused` : `Cron job ${id} has been resumed`,
      paused,
    });
  } catch (err) {
    console.error("Pause cron job error:", err);
    return Response.json(
      { error: "Failed to update cron job" },
      { status: 500 }
    );
  }
}
