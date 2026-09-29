/**
 * /api/v1/mods/review
 *
 * Admin review endpoint for community submissions and agent packages.
 * Supports multi-stage pipeline: intake → security_scan → sandbox → product_review → decision.
 *
 * GET  ?status=pending&collection=community|agents&stage=security_scan
 * POST { itemId, action: "advance"|"approve"|"reject"|"request_changes", collection?, reviewComment?, skipTo? }
 *
 * Auth: Platform admin only
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { requirePlatformAdmin, unauthorized } from "@/lib/auth-guard";
import {
    getNextStage,
    updatePublisherStats,
    type ReviewEntry,
    type SubmissionStage,
} from "@/lib/submission-protocol";
import { recordAuditEntry } from "@/lib/audit-log";

const COLLECTIONS = {
    community: "communityMarketItems",
    agents: "marketplaceAgents",
} as const;

type CollectionKey = keyof typeof COLLECTIONS;

function resolveCollection(value: string | null): CollectionKey {
    if (value === "agents") return "agents";
    return "community";
}

/** Pending status field differs: community uses "pending", agents use "review" */
function pendingStatus(col: CollectionKey): string {
    return col === "agents" ? "review" : "pending";
}

const VALID_STAGES: SubmissionStage[] = ["intake", "security_scan", "sandbox", "product_review", "decision"];

/**
 * GET /api/v1/mods/review — List pending submissions
 */
export async function GET(req: NextRequest) {
    const admin = requirePlatformAdmin(req);
    if (!admin.ok) return unauthorized(admin.error);

    const col = resolveCollection(req.nextUrl.searchParams.get("collection"));
    const status = req.nextUrl.searchParams.get("status") || pendingStatus(col);
    const stageFilter = req.nextUrl.searchParams.get("stage");

    const snap = await adminDb().collection(COLLECTIONS[col]).where("status", "==", status).get();
    let items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Filter by pipeline stage if requested
    if (stageFilter && VALID_STAGES.includes(stageFilter as SubmissionStage)) {
        items = items.filter((item) => (item as Record<string, unknown>).stage === stageFilter);
    }

    return Response.json({ collection: col, count: items.length, items });
}

/**
 * POST /api/v1/mods/review — Review a submission (multi-stage pipeline)
 */
export async function POST(req: NextRequest) {
    const admin = requirePlatformAdmin(req);
    if (!admin.ok) return unauthorized(admin.error);

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const itemId = body.itemId as string | undefined;
    const action = body.action as string | undefined;
    const reviewComment = (body.reviewComment as string) || "";
    const col = resolveCollection((body.collection as string) || null);
    const skipTo = body.skipTo as string | undefined;

    if (!itemId || !action) {
        return Response.json(
            { error: "itemId and action are required" },
            { status: 400 },
        );
    }

    const validActions = ["advance", "approve", "reject", "request_changes"];
    if (!validActions.includes(action)) {
        return Response.json(
            { error: `action must be one of: ${validActions.join(", ")}` },
            { status: 400 },
        );
    }

    const ref = adminDb().collection(COLLECTIONS[col]).doc(itemId);
    const snap = await ref.get();

    if (!snap.exists) {
        return Response.json({ error: "Submission not found" }, { status: 404 });
    }

    const current = snap.data()!;
    const currentStage = (current.stage as SubmissionStage) || "intake";
    const reviewHistory: ReviewEntry[] = Array.isArray(current.reviewHistory) ? current.reviewHistory : [];

    // Build new review entry
    const newEntry: ReviewEntry = {
        stage: currentStage,
        result: action === "reject" || action === "request_changes" ? "failed" : "passed",
        reviewedBy: "platform-admin",
        reviewedAt: new Date().toISOString(),
        comment: reviewComment || undefined,
    };

    let newStatus: string;
    let newStage: SubmissionStage | string = currentStage;

    switch (action) {
        case "advance": {
            // Move to next stage (or skip to a specific stage)
            if (skipTo && VALID_STAGES.includes(skipTo as SubmissionStage)) {
                newStage = skipTo as SubmissionStage;
            } else {
                const next = getNextStage(currentStage);
                if (!next) {
                    return Response.json(
                        { error: `Cannot advance past ${currentStage}` },
                        { status: 400 },
                    );
                }
                newStage = next;
            }
            newStatus = current.status; // Keep current status (pending/review)
            newEntry.result = "passed";
            break;
        }

        case "approve": {
            newStatus = "approved";
            newStage = "decision";
            newEntry.stage = currentStage;
            newEntry.result = "passed";

            // Auto-upgrade publisher tier
            const publisherWallet = current.submittedBy || current.authorWallet;
            if (publisherWallet && publisherWallet !== "platform-admin") {
                try {
                    await updatePublisherStats(publisherWallet);
                } catch {
                    // Non-blocking — tier upgrade is best-effort
                }
            }
            break;
        }

        case "reject": {
            newStatus = "rejected";
            newEntry.result = "failed";
            break;
        }

        case "request_changes": {
            newStatus = "changes_requested";
            newEntry.result = "failed";
            break;
        }

        default:
            newStatus = current.status;
    }

    reviewHistory.push(newEntry);

    await ref.update({
        status: newStatus,
        stage: newStage,
        reviewHistory,
        reviewedAt: FieldValue.serverTimestamp(),
        reviewComment,
    });

    await recordAuditEntry({
        action: `submission.${action}`,
        performedBy: "platform-admin",
        targetType: "submission",
        targetId: itemId,
        metadata: { collection: col, stage: newStage, comment: reviewComment },
    }).catch(() => {}); // non-blocking

    return Response.json({
        reviewed: true,
        collection: col,
        itemId,
        action,
        status: newStatus,
        stage: newStage,
        reviewComment: reviewComment || undefined,
    });
}
