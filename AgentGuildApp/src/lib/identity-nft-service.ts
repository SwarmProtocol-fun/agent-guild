/**
 * Agent identity NFT orchestration — server-only.
 *
 * Mints (or resumes minting) the three soulbound copies of an agent's
 * identity (see lib/solana/identity-nft.ts) and records them on the agent
 * doc. Idempotent: every step is persisted as it lands, so a failed or
 * interrupted run picks up where it stopped on the next call. Agents still
 * holding the legacy bare-SPL token are migrated (the old mint is kept in
 * `nftLegacyMintAddress`).
 *
 * The "owner" copy goes to the org owner's Solana wallet: their login
 * address when they signed in with a Solana wallet, otherwise the Solana
 * wallet they linked via /api/v1/wallet/solana/link. Until one exists that
 * copy is skipped and minted when the owner links.
 */
import { FieldValue } from "firebase-admin/firestore";
import { PublicKey } from "@solana/web3.js";

import { adminDb } from "./firebase-admin";
import { getOrganization, getOrganizationsByWalletAdmin } from "./firestore-admin";
import { canonicalizeWalletAddress } from "./wallet-address";
import {
    createIdentityCollection,
    mintIdentityCopy,
    platformIdentityHolder,
} from "./solana/identity-nft";

export const SOLANA_WALLET_LINKS_COLLECTION = "solanaWalletLinks";

/** Minting holds a lock on the agent doc for at most this long. */
const MINT_LOCK_MS = 5 * 60 * 1000;

export interface IdentityNftResult {
    collection?: string;
    platformAsset?: string;
    ownerAsset?: string;
    agentAsset?: string;
    /** Set when the owner copy is waiting on the org owner to link a Solana wallet. */
    ownerPending?: boolean;
    /** Another run holds the lock — nothing was minted by this call. */
    inProgress?: boolean;
    error?: string;
}

export function isSolanaAddress(address: string): boolean {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
    try {
        new PublicKey(address);
        return true;
    } catch {
        return false;
    }
}

function metadataUri(agentSolanaAddress: string): string {
    const base = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "https://agent-guild.com";
    return `${base.replace(/\/$/, "")}/api/nft/agent/${agentSolanaAddress}`;
}

/** The org owner's Solana wallet, or null when they haven't got one on file yet. */
export async function resolveOwnerSolanaAddress(orgId: string): Promise<string | null> {
    const org = await getOrganization(orgId);
    const owner = org?.ownerAddress;
    if (!owner) return null;
    if (isSolanaAddress(owner)) return owner;
    const link = await adminDb()
        .collection(SOLANA_WALLET_LINKS_COLLECTION)
        .doc(canonicalizeWalletAddress(owner))
        .get();
    const linked = link.data()?.solanaAddress;
    return typeof linked === "string" && isSolanaAddress(linked) ? linked : null;
}

async function claimMintLock(agentId: string): Promise<boolean> {
    const ref = adminDb().collection("agents").doc(agentId);
    return adminDb().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return false;
        const startedAt = snap.data()?.nftMintingAt?.toMillis?.() as number | undefined;
        if (startedAt && Date.now() - startedAt < MINT_LOCK_MS) return false;
        tx.update(ref, { nftMintingAt: FieldValue.serverTimestamp() });
        return true;
    });
}

/**
 * Mint whatever copies of the agent's identity are still missing. Never
 * throws — failures are returned and recorded in `nftMintError`.
 */
export async function ensureAgentIdentityNfts(agentId: string): Promise<IdentityNftResult> {
    const ref = adminDb().collection("agents").doc(agentId);
    const platformHolder = platformIdentityHolder();
    if (!platformHolder) return { error: "SOLANA_PLATFORM_KEYPAIR not configured" };

    try {
        if (!(await claimMintLock(agentId))) return { inProgress: true };
    } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
    }

    const result: IdentityNftResult = {};
    try {
        const agent = (await ref.get()).data();
        if (!agent) return { error: "Agent not found" };
        const agentAddress = agent.solanaAddress as string | undefined;
        if (!agentAddress) return { error: "Agent has no Solana address" };

        const isCore = agent.nftStandard === "mpl-core";
        result.collection = isCore ? agent.nftCollectionAddress : undefined;
        result.platformAsset = isCore ? agent.nftPlatformAssetAddress : undefined;
        result.ownerAsset = isCore ? agent.nftOwnerAssetAddress : undefined;
        result.agentAsset = isCore ? agent.nftAgentAssetAddress : undefined;

        const name = `${agent.name || "Agent"} Identity`;
        const uri = metadataUri(agentAddress);

        if (!result.collection) {
            result.collection = await createIdentityCollection({ name, uri });
            await ref.update({
                nftStandard: "mpl-core",
                nftCollectionAddress: result.collection,
                ...(agent.nftMintAddress && !isCore ? { nftLegacyMintAddress: agent.nftMintAddress } : {}),
                // A half-finished earlier collection is abandoned with the rest of its fields.
                nftPlatformAssetAddress: FieldValue.delete(),
                nftOwnerAssetAddress: FieldValue.delete(),
                nftOwnerSolanaAddress: FieldValue.delete(),
                nftAgentAssetAddress: FieldValue.delete(),
            });
        }
        const collection = result.collection;

        if (!result.platformAsset) {
            result.platformAsset = await mintIdentityCopy({ collection, copy: "platform", owner: platformHolder, name, uri });
            await ref.update({ nftPlatformAssetAddress: result.platformAsset });
        }

        if (!result.agentAsset) {
            result.agentAsset = await mintIdentityCopy({ collection, copy: "agent", owner: agentAddress, name, uri });
            // nftMintAddress stays the agent's own copy — auth-guard's
            // identity-NFT memory access and the UI key off it.
            await ref.update({
                nftAgentAssetAddress: result.agentAsset,
                nftMintAddress: result.agentAsset,
                nftMintedAt: new Date(),
            });
        }

        if (!result.ownerAsset) {
            const ownerSolana = agent.orgId ? await resolveOwnerSolanaAddress(agent.orgId) : null;
            if (ownerSolana) {
                result.ownerAsset = await mintIdentityCopy({ collection, copy: "owner", owner: ownerSolana, name, uri });
                await ref.update({ nftOwnerAssetAddress: result.ownerAsset, nftOwnerSolanaAddress: ownerSolana });
            } else {
                result.ownerPending = true;
            }
        }

        await ref.update({ nftMintError: FieldValue.delete() });
    } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
        console.error(`[identity-nft] minting for agent ${agentId} failed:`, err);
        await ref.update({ nftMintError: result.error }).catch(() => {});
    } finally {
        await ref.update({ nftMintingAt: FieldValue.delete() }).catch(() => {});
    }
    return result;
}

/** True when the agent is missing any identity copy that can be minted right now (owner copy aside). */
export function needsIdentityNfts(agent: FirebaseFirestore.DocumentData): boolean {
    return agent.nftStandard !== "mpl-core" || !agent.nftPlatformAssetAddress || !agent.nftAgentAssetAddress;
}

/**
 * After an org owner links a Solana wallet: mint the owner copy for every
 * agent in the orgs they own that's waiting on it.
 */
export async function mintPendingOwnerCopies(loginAddress: string): Promise<void> {
    const owner = canonicalizeWalletAddress(loginAddress);
    const orgs = (await getOrganizationsByWalletAdmin(loginAddress)).filter(
        (o) => o.ownerAddress != null && canonicalizeWalletAddress(o.ownerAddress) === owner,
    );
    for (const org of orgs) {
        const agents = await adminDb().collection("agents").where("orgId", "==", org.id).get();
        for (const doc of agents.docs) {
            if (doc.data().nftOwnerAssetAddress) continue;
            await ensureAgentIdentityNfts(doc.id);
        }
    }
}
