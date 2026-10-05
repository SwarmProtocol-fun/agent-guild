/**
 * GET /api/agents/:id/soul
 * PUT /api/agents/:id/soul
 *
 * Manage SOUL configuration for an agent.
 */

import { NextRequest } from "next/server";
import { getDefaultSOUL } from "@/lib/soul";
import { updateAgentSOUL } from "@/lib/firestore-admin";
import { adminDb } from "@/lib/firebase-admin";
import type { Agent } from "@/lib/firestore";
import { getWalletAddress, requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getClientIp } from "@/lib/client-ip";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: agentId } = await params;
  const ip = getClientIp(request);
  const limited = await rateLimit(`soul:${ip}`);
  if (limited) return limited;

  // Auth: require wallet address — agent must belong to caller's org
  const wallet = getWalletAddress(request);
  if (!wallet) {
    return unauthorized("Authentication required");
  }

  try {
    const agentDoc = await adminDb().collection("agents").doc(agentId).get();
    if (!agentDoc.exists) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    const agent = { id: agentDoc.id, ...agentDoc.data() } as Agent;

    // Verify caller is a member of the agent's org — for a saved SOUL too,
    // not only the generated default.
    const auth = await requireOrgMember(request, agent.orgId);
    if (!auth.ok) {
      return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);
    }

    if (!agent.soulConfig) {
      return Response.json({
        ok: true,
        soulConfig: getDefaultSOUL(agent.name, agent.type),
        isDefault: true,
      });
    }

    return Response.json({
      ok: true,
      soulConfig: agent.soulConfig,
      isDefault: false,
    });
  } catch (err) {
    console.error("Get SOUL error:", err);
    return Response.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to get SOUL configuration",
      },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: agentId } = await params;
  const ip = getClientIp(request);
  const limited = await rateLimit(`soul:${ip}`);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { orgId, soulConfig } = body;

  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  // Auth: caller must be a member of the org
  const auth = await requireOrgMember(request, orgId as string);
  if (!auth.ok) {
    return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);
  }

  if (!soulConfig || typeof soulConfig !== "string") {
    return Response.json(
      { error: "soulConfig (YAML string) is required" },
      { status: 400 }
    );
  }

  try {
    await updateAgentSOUL(orgId as string, agentId, soulConfig as string);

    return Response.json({
      ok: true,
      message: "SOUL configuration updated successfully",
    });
  } catch (err) {
    console.error("Update SOUL error:", err);
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to update SOUL configuration",
      },
      { status: 500 }
    );
  }
}
