/**
 * POST /api/v1/marketplace/appeal
 *
 * Appeal a rejected submission. Moves the item back into the pipeline
 * at the product_review stage for a second look.
 *
 * Rules:
 * - Only the original submitter can appeal
 * - Only rejected items can be appealed
 * - 1 appeal per rejection (no infinite loops)
 *
 * Auth: x-wallet-address header
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { getWalletAddress } from "@/lib/auth-guard";
import type { ReviewEntry } from "@/lib/submission-protocol";

const COLLECTIONS = {
    community: "communityMarketItems",
    agents: "marketplaceAgents",
} as const;

export async function POST(req: NextRequest) {
    const wallet = getWalletAddress(req);
    if (!wallet) {
        return Response.json({ error: "Missing x-wallet-address header" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const itemId = body.itemId as string | undefined;
    const comment = (body.comment as string)?.trim().slice(0, 2000);
    const collectionKey = body.collection === "agents" ? "agents" as const : "community" as const;

    if (!itemId || !comment) {
        return Response.json({ error: "itemId and comment are required" }, { status: 400 });
    }

    const collectionName = COLLECTIONS[collectionKey];
    const ref = adminDb().collection(collectionName).doc(itemId);
    const snap = await ref.get();

    if (!snap.exists) {
        return Response.json({ error: "Submission not found" }, { status: 404 });
    }

    const data = snap.data()!;

    // Verify ownership
    const ownerField = collectionKey === "agents" ? "authorWallet" : "submittedBy";
    if (data[ownerField]?.toLowerCase() !== wallet) {
        return Response.json({ error: "You can only appeal your own submissions" }, { status: 403 });
    }

    // Verify rejected status
    if (data.status !== "rejected") {
        return Response.json(
            { error: `Cannot appeal — item status is "${data.status}", must be "rejected"` },
            { status: 400 },
        );
    }

    // Check no prior appeal
    if (data.appealedAt) {
        return Response.json(
            { error: "This item has already been appealed. Only one appeal per rejection is allowed." },
            { status: 409 },
        );
    }

    // Build appeal review entry
    const reviewHistory: ReviewEntry[] = Array.isArray(data.reviewHistory) ? data.reviewHistory : [];
    reviewHistory.push({
        stage: "product_review",
        result: "passed",
        reviewedBy: wallet,
        reviewedAt: new Date().toISOString(),
        comment: `Appeal: ${comment}`,
    });

    // Re-enter pipeline at product_review
    const newStatus = collectionKey === "agents" ? "review" : "pending";

    await ref.update({
        status: newStatus,
        stage: "product_review",
        appealComment: comment,
        appealedAt: FieldValue.serverTimestamp(),
        reviewHistory,
    });

    return Response.json({
        appealed: true,
        itemId,
        collection: collectionKey,
        stage: "product_review",
    });
}
