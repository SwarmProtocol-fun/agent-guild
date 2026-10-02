/**
 * /api/v1/solana/link — the signed-in user's linked Solana wallet.
 *
 * Users who sign in with an EVM account still get a Solana account from the
 * wallet modal; linking it (proven by a signature from that Solana wallet)
 * is what lets the platform mint the org owner's identity NFT copy to it.
 *
 * GET  → { solanaAddress: string | null }
 * POST { solanaAddress, issuedAt, signature (base64) } → { solanaAddress }
 *      Also mints any owner copies waiting on this wallet (non-blocking).
 */
import { NextRequest } from "next/server";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { FieldValue } from "firebase-admin/firestore";
import { getWalletAddress, unauthorized } from "@/lib/auth-guard";
import { adminDb } from "@/lib/firebase-admin";
import {
    SOLANA_WALLET_LINKS_COLLECTION,
    isSolanaAddress,
    mintPendingOwnerCopies,
} from "@/lib/identity-nft-service";
import { WALLET_LINK_MAX_AGE_MS, walletLinkMessage } from "@/lib/solana/wallet-link";

export async function GET(request: NextRequest) {
    const account = getWalletAddress(request);
    if (!account) return unauthorized("Sign in first");

    // A Solana login is its own Solana wallet — nothing to link.
    if (isSolanaAddress(account)) return Response.json({ solanaAddress: account });

    const snap = await adminDb().collection(SOLANA_WALLET_LINKS_COLLECTION).doc(account).get();
    return Response.json({ solanaAddress: snap.data()?.solanaAddress ?? null });
}

export async function POST(request: NextRequest) {
    const account = getWalletAddress(request);
    if (!account) return unauthorized("Sign in first");

    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const solanaAddress = body.solanaAddress as string | undefined;
    const issuedAt = body.issuedAt as string | undefined;
    const signature = body.signature as string | undefined;
    if (!solanaAddress || !issuedAt || !signature) {
        return Response.json({ error: "solanaAddress, issuedAt and signature are required" }, { status: 400 });
    }
    if (!isSolanaAddress(solanaAddress)) {
        return Response.json({ error: "Invalid Solana address" }, { status: 400 });
    }

    const age = Date.now() - Date.parse(issuedAt);
    if (Number.isNaN(age) || age > WALLET_LINK_MAX_AGE_MS || age < -60_000) {
        return Response.json({ error: "Link message expired — sign again" }, { status: 400 });
    }

    const message = walletLinkMessage({ account, solanaAddress, issuedAt });
    let valid = false;
    try {
        valid = nacl.sign.detached.verify(
            new TextEncoder().encode(message),
            Buffer.from(signature, "base64"),
            bs58.decode(solanaAddress),
        );
    } catch { /* malformed signature */ }
    if (!valid) {
        return Response.json({ error: "Signature does not match the Solana wallet" }, { status: 401 });
    }

    await adminDb().collection(SOLANA_WALLET_LINKS_COLLECTION).doc(account).set({
        account,
        solanaAddress,
        linkedAt: FieldValue.serverTimestamp(),
    });

    mintPendingOwnerCopies(account).catch((err) =>
        console.error("[solana/link] minting pending owner copies failed:", err),
    );

    return Response.json({ solanaAddress });
}
