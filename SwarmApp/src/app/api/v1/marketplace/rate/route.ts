/**
 * POST /api/v1/marketplace/rate
 *
 * Submit a rating for a marketplace item (agent or community).
 *
 * Body: { itemId, itemType: "agent" | "community", rating: 1-5, review?, orgId }
 * Auth: x-wallet-address header
 */
import { NextRequest } from "next/server";
import { getWalletAddress } from "@/lib/auth-guard";
import {
    submitAgentRating,
    submitCommunityItemRating,
} from "@/lib/firestore-admin";

export async function POST(req: NextRequest) {
    const wallet = getWalletAddress(req);
    if (!wallet) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const itemId = body.itemId as string | undefined;
    const itemType = body.itemType as "agent" | "community" | undefined;
    const rating = body.rating as number | undefined;
    const review = (body.review as string)?.trim().slice(0, 500) || undefined;
    const orgId = body.orgId as string | undefined;

    if (!itemId || !itemType || !rating || !orgId) {
        return Response.json({ error: "Required: itemId, itemType, rating, orgId" }, { status: 400 });
    }

    if (rating < 1 || rating > 5) {
        return Response.json({ error: "Rating must be between 1 and 5" }, { status: 400 });
    }

    if (itemType !== "agent" && itemType !== "community") {
        return Response.json({ error: "itemType must be 'agent' or 'community'" }, { status: 400 });
    }

    try {
        if (itemType === "agent") {
            await submitAgentRating(itemId, orgId, wallet, rating, review);
        } else {
            await submitCommunityItemRating(itemId, orgId, wallet, rating, review);
        }
        return Response.json({ ok: true });
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to submit rating" },
            { status: 500 },
        );
    }
}
