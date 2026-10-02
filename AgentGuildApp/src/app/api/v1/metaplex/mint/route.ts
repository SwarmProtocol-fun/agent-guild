/**
 * POST /api/v1/metaplex/mint
 *
 * Mints (or finishes minting) an agent's soulbound identity NFTs on
 * Metaplex Core — one collection with three frozen copies: the platform's,
 * the org owner's and the agent's own. See lib/identity-nft-service.ts.
 * Safe to call repeatedly: only missing copies are minted, and agents still
 * holding the legacy SPL token are migrated.
 *
 * Body: { agentId, orgId }
 */
import { NextRequest } from "next/server";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { getAgent } from "@/lib/firestore-admin";
import { ensureAgentIdentityNfts } from "@/lib/identity-nft-service";

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

    if (!agent.solanaAddress) {
        return Response.json(
            { error: "No Solana address on file for this agent — generate one first" },
            { status: 400 },
        );
    }

    const result = await ensureAgentIdentityNfts(agentId);
    if (result.inProgress) {
        return Response.json({ error: "Minting already in progress for this agent" }, { status: 409 });
    }
    if (result.error) {
        return Response.json({ error: `Mint failed: ${result.error}`, ...result }, { status: 502 });
    }

    return Response.json({ mintAddress: result.agentAsset, ...result });
}
