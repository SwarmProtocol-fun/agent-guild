/**
 * POST /api/v1/delegations/:id/revoke - Revoke a delegation grant
 *
 * Only the principal who created the grant can revoke it. Revoking doesn't
 * undo anything already done under it (e.g. a job already claimed
 * on-behalf-of) — it only stops the delegate from passing
 * getActiveDelegation() on any future action.
 *
 * Authentication: Ed25519 signature required
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getDelegationsForAgent, revokeDelegation } from "@/lib/delegation";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = request.nextUrl;

    const agentParam = url.searchParams.get("agent");
    const sig = url.searchParams.get("sig");
    const ts = url.searchParams.get("ts");
    if (!agentParam || !sig || !ts) {
      return Response.json({ error: "Missing required parameters: agent, sig, ts" }, { status: 400 });
    }
    const tsNum = parseInt(ts, 10);
    if (!isTimestampFresh(tsNum)) {
      return Response.json({ error: "Stale timestamp" }, { status: 401 });
    }
    const verified = await verifyAgentRequest(agentParam, `POST:/v1/delegations/${id}/revoke:${ts}`, sig);
    if (!verified) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    const ownGrants = await getDelegationsForAgent(verified.agentId, "principal");
    const grant = ownGrants.find((g) => g.id === id);
    if (!grant) {
      return Response.json({ error: "Delegation grant not found, or you are not its principal" }, { status: 404 });
    }
    if (grant.revokedAt) {
      return Response.json({ error: "Delegation grant is already revoked" }, { status: 409 });
    }

    await revokeDelegation(id, verified.agentId);
    return Response.json({ id, revoked: true });
  } catch (err: any) {
    console.error("Revoke delegation error:", err);
    return Response.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
