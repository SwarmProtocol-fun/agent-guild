/**
 * POST /api/v1/solana/wallet/generate
 *
 * Backfills an agent's Solana address from its existing Ed25519 identity
 * key (a Solana pubkey IS a raw Ed25519 public key — no new keypair is
 * generated, the agent already holds the private key). For agents that
 * registered before this field existed, or were never reconnected via the
 * CLI to trigger the backfill in /api/v1/register.
 *
 * Body: { agentId, orgId }
 */
import { NextRequest } from "next/server";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { getAgent, updateAgent } from "@/lib/firestore-admin";
import { solanaAddressFromEd25519Pem } from "@/lib/solana/client";

export async function POST(request: NextRequest) {
    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const agentId = body.agentId as string | undefined;
    const orgId = body.orgId as string | undefined;
    if (!agentId || !orgId) {
        return Response.json({ error: "agentId and orgId are required" }, { status: 400 });
    }

    const auth = await requireOrgMember(request, orgId);
    if (!auth.ok) return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);

    const agent = await getAgent(agentId);
    if (!agent) {
        return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    if (agent.orgId !== orgId) {
        return Response.json({ error: "Agent does not belong to this organization" }, { status: 403 });
    }
    // `publicKey` (the agent's Ed25519 identity key, PEM) isn't in the Agent
    // type yet, but register/route.ts always writes it — read it loosely.
    const publicKeyPem = (agent as unknown as { publicKey?: string }).publicKey;
    if (!publicKeyPem) {
        return Response.json(
            { error: "Agent has no Ed25519 identity key on file — reconnect it via the CLI first" },
            { status: 400 },
        );
    }

    const solanaAddress = solanaAddressFromEd25519Pem(publicKeyPem);
    await updateAgent(agentId, {
        solanaAddress,
        ...(agent.walletAddress ? {} : { walletAddress: solanaAddress }),
    });

    return Response.json({ solanaAddress });
}
