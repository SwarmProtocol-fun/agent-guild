/**
 * POST /api/v1/metaplex/update
 *
 * Re-confirms an agent's identity NFTs on-chain. For Metaplex Core
 * identities, reports the current holder of each copy (platform, owner,
 * agent); the metadata itself is served live from /api/nft/agent/{address},
 * so there's nothing to rewrite on-chain. Agents still on the legacy bare
 * SPL token get that token's balance/frozen status instead.
 *
 * Body: { agentId, orgId }
 */
import { NextRequest } from "next/server";
import { getAssociatedTokenAddress, getAccount, TokenAccountNotFoundError } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { getAgent } from "@/lib/firestore-admin";
import { getConnection } from "@/lib/solana/client";
import { fetchIdentityCopyOwner } from "@/lib/solana/identity-nft";

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
    if (!agent.nftMintAddress || !agent.solanaAddress) {
        return Response.json({ error: "Agent has no minted reputation token on file" }, { status: 400 });
    }

    if (agent.nftStandard === "mpl-core") {
        const copies = {
            platform: agent.nftPlatformAssetAddress,
            owner: agent.nftOwnerAssetAddress,
            agent: agent.nftAgentAssetAddress,
        };
        const holders = Object.fromEntries(
            await Promise.all(
                Object.entries(copies).map(async ([copy, asset]) => [
                    copy,
                    asset ? { asset, holder: await fetchIdentityCopyOwner(asset) } : null,
                ]),
            ),
        );
        return Response.json({
            standard: "mpl-core",
            collection: agent.nftCollectionAddress,
            mintAddress: agent.nftMintAddress,
            copies: holders,
        });
    }

    try {
        const connection = getConnection();
        const mint = new PublicKey(agent.nftMintAddress);
        const owner = new PublicKey(agent.solanaAddress);
        const ata = await getAssociatedTokenAddress(mint, owner);
        const account = await getAccount(connection, ata);
        return Response.json({
            mintAddress: agent.nftMintAddress,
            owner: agent.solanaAddress,
            amount: account.amount.toString(),
            frozen: account.isFrozen,
        });
    } catch (err) {
        if (err instanceof TokenAccountNotFoundError) {
            return Response.json({ error: "Token account not found on-chain" }, { status: 404 });
        }
        console.error("[metaplex/update] status check failed:", err);
        return Response.json({ error: "Failed to read token status" }, { status: 502 });
    }
}
