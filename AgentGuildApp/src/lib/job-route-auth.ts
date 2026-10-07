/**
 * Shared auth for the dashboard job routes (/api/jobs/:jobId/*), which act
 * for a signed-in person (wallet session) rather than a signed agent.
 *
 * A job has two sides. The buyer is job.orgId: it posts, edits, cancels,
 * hires and reviews. The seller does the work and delivers. For ordinary
 * jobs that's the same org; for gig orders it's job.sellerOrgId. Server-only.
 */
import type { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { getJob } from "@/lib/jobs-admin";
import { JobActionError } from "@/lib/job-lifecycle";
import type { Job } from "@/lib/firestore";

export type JobSide = "buyer" | "seller";

type Loaded = { ok: true; job: Job; wallet: string; sides: JobSide[] } | { ok: false; response: Response };

/**
 * Load a job and check the caller belongs to one of the allowed sides.
 * `sides` on success lists every side the caller is on (both, for an
 * ordinary job).
 */
export async function loadJobForMember(req: NextRequest, jobId: string, allowed: JobSide[]): Promise<Loaded> {
  const wallet = getWalletAddress(req);
  if (!wallet) return { ok: false, response: Response.json({ error: "Authentication required" }, { status: 401 }) };

  const job = await getJob(jobId);
  if (!job) return { ok: false, response: Response.json({ error: "Job not found" }, { status: 404 }) };

  const sides: JobSide[] = [];
  if ((await requireOrgMember(req, job.orgId)).ok) sides.push("buyer");
  const sellerOrgId = job.gigId && job.sellerOrgId ? job.sellerOrgId : job.orgId;
  if (sellerOrgId === job.orgId ? sides.includes("buyer") : (await requireOrgMember(req, sellerOrgId)).ok) {
    sides.push("seller");
  }

  if (!sides.some((s) => allowed.includes(s))) {
    // Outsiders get a 404, not a 403 — don't confirm the job exists.
    const insider = sides.length > 0;
    return {
      ok: false,
      response: Response.json(
        { error: insider ? `Only the ${allowed.join(" or ")} side can do this` : "Job not found" },
        { status: insider ? 403 : 404 },
      ),
    };
  }
  return { ok: true, job, wallet, sides };
}

/** Map an error thrown by a job helper to a response: JobActionErrors keep their status. */
export function jobErrorResponse(err: unknown, fallback = "Internal error"): Response {
  if (err instanceof JobActionError) return Response.json({ error: err.message }, { status: err.status });
  const message = err instanceof Error ? err.message : fallback;
  // claimJob throws plain Errors for credit-policy rejections — those are 403s.
  if (message.startsWith("Policy violation") || message.includes("requires manual approval")) {
    return Response.json({ error: message }, { status: 403 });
  }
  console.error(fallback, err);
  return Response.json({ error: fallback }, { status: 500 });
}

export async function readJson(req: NextRequest): Promise<unknown> {
  return req.json().catch(() => null);
}
