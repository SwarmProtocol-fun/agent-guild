/**
 * POST /api/v1/marketplace/report
 *
 * Report a marketplace item for spam, malicious behavior, or quality issues.
 * Auto-suspends items after 3+ reports.
 *
 * Auth: x-wallet-address header
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { getWalletAddress } from "@/lib/auth-guard";
import { checkRateLimit } from "@/lib/rate-limit-firestore";
import { getMarketplaceSettings } from "@/lib/marketplace-settings";

const REPORTS_COLLECTION = "marketplaceReports";
const VALID_REASONS = ["spam", "malicious", "broken", "inappropriate"] as const;

const COLLECTIONS = {
    community: "communityMarketItems",
    agents: "marketplaceAgents",
} as const;

export async function POST(req: NextRequest) {
    const wallet = getWalletAddress(req);
    if (!wallet) {
        return Response.json({ error: "Missing x-wallet-address header" }, { status: 401 });
    }

    // Rate limit: 5 reports/day per wallet
    const rateCheck = await checkRateLimit(`report:${wallet}`, { max: 5, windowMs: 24 * 60 * 60 * 1000 });
    if (!rateCheck.allowed) {
        return Response.json(
            { error: "Report limit reached (5/day). Try again later." },
            { status: 429 },
        );
    }

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const itemId = body.itemId as string | undefined;
    const reason = body.reason as string | undefined;
    const comment = (body.comment as string)?.trim().slice(0, 1000) || "";
    const collectionKey = body.collection === "agents" ? "agents" as const : "community" as const;

    if (!itemId || !reason) {
        return Response.json({ error: "itemId and reason are required" }, { status: 400 });
    }

    if (!VALID_REASONS.includes(reason as typeof VALID_REASONS[number])) {
        return Response.json(
            { error: `reason must be one of: ${VALID_REASONS.join(", ")}` },
            { status: 400 },
        );
    }

    // Verify item exists
    const collectionName = COLLECTIONS[collectionKey];
    const itemRef = adminDb().collection(collectionName).doc(itemId);
    const itemSnap = await itemRef.get();

    if (!itemSnap.exists) {
        return Response.json({ error: "Item not found" }, { status: 404 });
    }

    // Don't allow self-reporting
    const itemData = itemSnap.data()!;
    const ownerField = collectionKey === "agents" ? "authorWallet" : "submittedBy";
    if (itemData[ownerField]?.toLowerCase() === wallet) {
        return Response.json({ error: "Cannot report your own item" }, { status: 400 });
    }

    // Create report document
    await adminDb().collection(REPORTS_COLLECTION).add({
        itemId,
        collection: collectionKey,
        reportedBy: wallet,
        reason,
        comment,
        createdAt: FieldValue.serverTimestamp(),
    });

    // Increment report count on the item
    const currentReportCount = (itemData.reportCount || 0) + 1;
    const updates: Record<string, unknown> = {
        reportCount: FieldValue.increment(1),
    };

    // Auto-suspend if threshold reached (reads from platform settings)
    const settings = await getMarketplaceSettings();
    let autoSuspended = false;
    if (currentReportCount >= settings.autoSuspendReportCount && itemData.publicationStatus !== "suspended") {
        updates.publicationStatus = "suspended";
        updates.stage = "product_review"; // Flag for re-review
        autoSuspended = true;
    }

    await itemRef.update(updates);

    return Response.json({
        reported: true,
        itemId,
        reason,
        autoSuspended,
    });
}
