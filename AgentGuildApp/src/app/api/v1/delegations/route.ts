/**
 * POST /api/v1/delegations - Grant another agent scoped, time-limited authority
 * GET  /api/v1/delegations - List grants you're a party to
 *
 * The Delegation Protocol primitive: "agent B may do {permissions} on my
 * behalf, spending at most {maxSpendUsdc}, for {durationMs}" — revocable at
 * any time via POST /:id/revoke. See lib/delegation.ts for the model and
 * POST /v1/jobs/:jobId/claim's `onBehalfOf` param for the one place this is
 * actually enforced today.
 *
 * Authentication: Ed25519 signature required. The caller is always the
 * principal on create — an agent can only grant away its own authority,
 * never someone else's.
 *
 * POST body:
 *   delegateAgentId — (required) the agent receiving authority
 *   permissions     — (required) non-empty array of scope strings, e.g. ["jobs:claim"]
 *   maxSpendUsdc    — (optional) spend cap in USDC
 *   durationMs      — (required) grant lifetime in milliseconds from now
 *
 * GET query params:
 *   role — "principal" (grants you've given, default) or "delegate" (grants given to you)
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getAgent } from "@/lib/firestore-admin";
import { createDelegation, getDelegationsForAgent } from "@/lib/delegation";

async function authenticate(req: NextRequest, method: string, path: string) {
  const url = req.nextUrl;
  const agentParam = url.searchParams.get("agent");
  const sig = url.searchParams.get("sig");
  const ts = url.searchParams.get("ts");
  if (!agentParam || !sig || !ts) {
    return { error: Response.json({ error: "Missing required parameters: agent, sig, ts" }, { status: 400 }) };
  }
  const tsNum = parseInt(ts, 10);
  if (!isTimestampFresh(tsNum)) {
    return { error: Response.json({ error: "Stale timestamp" }, { status: 401 }) };
  }
  const verified = await verifyAgentRequest(agentParam, `${method}:${path}:${ts}`, sig);
  if (!verified) {
    return { error: Response.json({ error: "Invalid signature" }, { status: 401 }) };
  }
  return { verified };
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request, "POST", "/v1/delegations");
    if (auth.error) return auth.error;
    const verified = auth.verified!;

    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    const body = await request.json().catch(() => ({}));
    const delegateAgentId = typeof body.delegateAgentId === "string" ? body.delegateAgentId : null;
    const permissions = Array.isArray(body.permissions) ? body.permissions.filter((p: unknown) => typeof p === "string") : [];
    const maxSpendUsdc = typeof body.maxSpendUsdc === "number" ? body.maxSpendUsdc : undefined;
    const durationMs = typeof body.durationMs === "number" ? body.durationMs : null;

    if (!delegateAgentId) {
      return Response.json({ error: "delegateAgentId is required" }, { status: 400 });
    }
    if (permissions.length === 0) {
      return Response.json({ error: "permissions must be a non-empty array of scope strings" }, { status: 400 });
    }
    if (!durationMs || durationMs <= 0) {
      return Response.json({ error: "durationMs must be a positive number" }, { status: 400 });
    }

    const delegate = await getAgent(delegateAgentId);
    if (!delegate || delegate.orgId !== verified.orgId) {
      return Response.json({ error: "Delegate agent not found in your organization" }, { status: 404 });
    }

    const grant = await createDelegation({
      orgId: verified.orgId,
      principalAgentId: verified.agentId,
      principalAgentName: verified.agentName,
      delegateAgentId,
      delegateAgentName: delegate.name,
      permissions,
      maxSpendUsdc,
      durationMs,
    });

    return Response.json({ grant });
  } catch (err: any) {
    console.error("Create delegation error:", err);
    return Response.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request, "GET", "/v1/delegations");
    if (auth.error) return auth.error;
    const verified = auth.verified!;

    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    const roleParam = request.nextUrl.searchParams.get("role");
    const role = roleParam === "delegate" ? "delegate" : "principal";

    const grants = await getDelegationsForAgent(verified.agentId, role);
    return Response.json({ role, count: grants.length, grants });
  } catch (err: any) {
    console.error("List delegations error:", err);
    return Response.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
