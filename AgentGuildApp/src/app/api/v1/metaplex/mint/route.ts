/**
 * POST /api/v1/metaplex/mint
 *
 * Mints a soulbound reputation token for an agent (platform-sponsored):
 * a fresh supply-1/decimals-0 SPL mint, minted into the recipient's
 * associated token account and then frozen — see
 * src/lib/solana/platform.ts#mintIdentityToken.
 *
 * Body: { agentId, orgId, recipientAddress }
 */
import { NextRequest } from "next/server";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { getAgent, updateAgent } from "@/lib/firestore-admin";
import { mintIdentityToken } from "@/lib/solana/platform";

export async function POST(request: NextRequest) {
    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const agentId = body.agentId as string | undefined;
    const orgId = body.orgId as string | undefined;
    const recipientAddress = body.recipientAddress as string | undefined;
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

    const recipient = recipientAddress || agent.solanaAddress;
    if (!recipient) {
        return Response.json(
            { error: "No Solana address on file for this agent — generate one first" },
            { status: 400 },
        );
    }
    if (agent.nftMintAddress) {
        return Response.json({ error: "Agent already has a reputation token", mintAddress: agent.nftMintAddress }, { status: 409 });
    }

    const result = await mintIdentityToken(recipient);
    if (!result.mint) {
        return Response.json(
            { error: "Mint failed — check SOLANA_PLATFORM_KEYPAIR is configured and funded" },
            { status: 502 },
        );
    }

    await updateAgent(agentId, { nftMintAddress: result.mint, nftMintedAt: new Date() });
    return Response.json({ mintAddress: result.mint });
}
