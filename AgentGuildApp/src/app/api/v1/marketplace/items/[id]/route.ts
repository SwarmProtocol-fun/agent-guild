/**
 * DELETE /api/v1/marketplace/items/:id
 *
 * Delete a marketplace submission.
 *
 * Rules:
 * - Only the original submitter can delete their own items
 * - Only pending/rejected/changes_requested/draft items can be deleted (non-admin)
 * - Platform admin can delete any item
 * - Searches both communityMarketItems and marketplaceAgents
 *
 * Auth: x-wallet-address header or platform admin secret
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { getWalletAddress, requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";

const COLLECTIONS = {
    community: "communityMarketItems",
    agents: "marketplaceAgents",
} as const;

const DELETABLE_STATUSES = ["pending", "rejected", "changes_requested", "draft"];

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const wallet = getWalletAddress(req);
    const admin = requirePlatformAdmin(req);

    if (!wallet && !admin.ok) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const { id: itemId } = await params;
    if (!itemId) {
        return Response.json({ error: "Item ID is required" }, { status: 400 });
    }

    // Try community collection first, then agents
    let collectionKey: "community" | "agents" = "community";
    let itemRef = adminDb().collection(COLLECTIONS.community).doc(itemId);
    let itemSnap = await itemRef.get();

    if (!itemSnap.exists) {
        collectionKey = "agents";
        itemRef = adminDb().collection(COLLECTIONS.agents).doc(itemId);
        itemSnap = await itemRef.get();
    }

    if (!itemSnap.exists) {
        return Response.json({ error: "Item not found" }, { status: 404 });
    }

    const data = itemSnap.data()!;

    // Authorization check
    if (!admin.ok) {
        const ownerField = collectionKey === "agents" ? "authorWallet" : "submittedBy";
        if (data[ownerField]?.toLowerCase() !== wallet) {
            return Response.json({ error: "You can only delete your own submissions" }, { status: 403 });
        }

        // Status check — only deletable statuses allowed for non-admins
        const status = data.status as string;
        if (!DELETABLE_STATUSES.includes(status)) {
            return Response.json(
                { error: `Cannot delete — item status is "${status}". Only pending, rejected, or draft items can be deleted.` },
                { status: 400 },
            );
        }
    }

    // Perform delete
    await itemRef.delete();

    // Record audit entry (non-blocking)
    try {
        await recordAuditEntry({
            action: "submission.deleted",
            performedBy: admin.ok ? "platform-admin" : (wallet || "unknown"),
            targetType: "submission",
            targetId: itemId,
            metadata: {
                collection: collectionKey,
                name: data.name,
                status: data.status,
                deletedByAdmin: admin.ok,
            },
        });
    } catch {
        // Non-blocking
    }

    return Response.json({ ok: true, deleted: itemId });
}
