/**
 * Agent identity NFTs on Metaplex Core — server-only (signs with the
 * platform keypair). Never import this from client-facing code.
 *
 * Each agent gets one identity, minted as three soulbound copies:
 *
 *   collection  — the identity itself: name/uri + MasterEdition (maxSupply 3)
 *                 + PermanentFreezeDelegate(frozen), which freezes every
 *                 asset in the collection so no copy can ever be transferred
 *   #1 platform — held by the platform keypair
 *   #2 owner    — held by the org owner's Solana wallet (minted later if the
 *                 owner hasn't linked one yet)
 *   #3 agent    — held by the agent's own Solana address (its Ed25519 key)
 *
 * The platform keypair is the collection's update authority (and the freeze
 * delegate's authority), so metadata stays updatable and a copy can be
 * thawed/burned for recovery, but holders can't move them.
 */
import { generateSigner, keypairIdentity, publicKey, type Umi } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import { create, createCollection, fetchAsset, fetchCollection, mplCore } from "@metaplex-foundation/mpl-core";

import { SOLANA_RPC_URL } from "./client";
import { getPlatformKeypair } from "./platform";

export const IDENTITY_EDITIONS = { platform: 1, owner: 2, agent: 3 } as const;
export type IdentityCopy = keyof typeof IDENTITY_EDITIONS;

const MAX_NAME_LENGTH = 32;

function getUmi(): Umi | null {
    const keypair = getPlatformKeypair();
    if (!keypair) return null;
    return createUmi(SOLANA_RPC_URL, "confirmed")
        .use(mplCore())
        .use(keypairIdentity(fromWeb3JsKeypair(keypair)));
}

function truncateName(name: string): string {
    return name.length <= MAX_NAME_LENGTH ? name : `${name.slice(0, MAX_NAME_LENGTH - 1)}…`;
}

/** Platform keypair's address — the holder of copy #1. */
export function platformIdentityHolder(): string | null {
    return getPlatformKeypair()?.publicKey.toBase58() ?? null;
}

/** Creates the identity collection (the master). Throws when the platform keypair isn't configured. */
export async function createIdentityCollection(args: { name: string; uri: string }): Promise<string> {
    const umi = getUmi();
    if (!umi) throw new Error("SOLANA_PLATFORM_KEYPAIR not configured");

    const collection = generateSigner(umi);
    await createCollection(umi, {
        collection,
        name: truncateName(args.name),
        uri: args.uri,
        plugins: [
            { type: "MasterEdition", maxSupply: Object.keys(IDENTITY_EDITIONS).length },
            { type: "PermanentFreezeDelegate", frozen: true, authority: { type: "UpdateAuthority" } },
        ],
    }).sendAndConfirm(umi);
    return collection.publicKey.toString();
}

/** Mints one numbered copy of an identity collection to `owner`. Throws on failure. */
export async function mintIdentityCopy(args: {
    collection: string;
    copy: IdentityCopy;
    owner: string;
    name: string;
    uri: string;
}): Promise<string> {
    const umi = getUmi();
    if (!umi) throw new Error("SOLANA_PLATFORM_KEYPAIR not configured");

    const collection = await fetchCollection(umi, publicKey(args.collection));
    const asset = generateSigner(umi);
    await create(umi, {
        asset,
        collection,
        owner: publicKey(args.owner),
        name: truncateName(args.name),
        uri: args.uri,
        plugins: [{ type: "Edition", number: IDENTITY_EDITIONS[args.copy] }],
    }).sendAndConfirm(umi);
    return asset.publicKey.toString();
}

/** Current on-chain holder of an identity copy, or null if the asset doesn't exist. */
export async function fetchIdentityCopyOwner(asset: string): Promise<string | null> {
    const umi = getUmi() ?? createUmi(SOLANA_RPC_URL, "confirmed").use(mplCore());
    try {
        const account = await fetchAsset(umi, publicKey(asset));
        return account.owner.toString();
    } catch {
        return null;
    }
}
