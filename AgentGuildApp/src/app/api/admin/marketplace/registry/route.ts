/**
 * GET/POST/PATCH/DELETE /api/admin/marketplace/registry
 *
 * Admin CRUD for the verified marketplace registry (Firestore-backed).
 * Replaces direct SKILL_REGISTRY management with editable Firestore docs.
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";
import {
    seedVerifiedItems,
    getAllVerifiedItems,
    updateVerifiedItem,
    deleteVerifiedItem,
    createVerifiedItem,
    type CreateVerifiedItemInput,
    type VerifiedItemUpdatable,
} from "@/lib/verified-registry";

// ── GET — List all verified items (including disabled) ─────

export async function GET(req: NextRequest) {
    const auth = requirePlatformAdmin(req);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

    const typeFilter = req.nextUrl.searchParams.get("type");
    const categoryFilter = req.nextUrl.searchParams.get("category");

    try {
        let items = await getAllVerifiedItems();

        if (typeFilter) items = items.filter((i) => i.type === typeFilter);
        if (categoryFilter) items = items.filter((i) => i.category === categoryFilter);

        items.sort((a, b) => a.name.localeCompare(b.name));

        return Response.json({
            ok: true,
            items,
            total: items.length,
        });
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to fetch registry" },
            { status: 500 },
        );
    }
}

// ── POST — Seed or create ──────────────────────────────────

export async function POST(req: NextRequest) {
    const auth = requirePlatformAdmin(req);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

    const body = await req.json();
    const { action } = body as { action: string };

    try {
        if (action === "seed") {
            const result = await seedVerifiedItems();

            await recordAuditEntry({
                action: "registry.seed",
                performedBy: "platform-admin",
                targetType: "settings",
                targetId: "verified-registry",
                metadata: result,
            }).catch(() => {});

            return Response.json({
                ok: true,
                ...result,
                message: `Seeded ${result.seeded} items (${result.skipped} already existed)`,
            });
        }

        if (action === "create") {
            const input = body as { action: string } & CreateVerifiedItemInput;

            if (!input.id || !input.name || !input.type) {
                return Response.json(
                    { error: "id, name, and type are required" },
                    { status: 400 },
                );
            }

            await createVerifiedItem(input);

            await recordAuditEntry({
                action: "registry.create",
                performedBy: "platform-admin",
                targetType: "listing",
                targetId: input.id,
                metadata: { name: input.name, type: input.type },
            }).catch(() => {});

            return Response.json({ ok: true, id: input.id });
        }

        return Response.json({ error: "Invalid action. Use 'seed' or 'create'" }, { status: 400 });
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : "Operation failed" },
            { status: 500 },
        );
    }
}

// ── PATCH — Update item fields ─────────────────────────────

export async function PATCH(req: NextRequest) {
    const auth = requirePlatformAdmin(req);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

    const body = await req.json();
    const { id, updates } = body as { id: string; updates: VerifiedItemUpdatable };

    if (!id) {
        return Response.json({ error: "id is required" }, { status: 400 });
    }

    if (!updates || typeof updates !== "object" || Object.keys(updates).length === 0) {
        return Response.json({ error: "updates object is required" }, { status: 400 });
    }

    try {
        await updateVerifiedItem(id, updates);

        await recordAuditEntry({
            action: "registry.update",
            performedBy: "platform-admin",
            targetType: "listing",
            targetId: id,
            metadata: { fields: Object.keys(updates) },
        }).catch(() => {});

        return Response.json({ ok: true, id });
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : "Update failed" },
            { status: 500 },
        );
    }
}

// ── DELETE — Remove verified item ──────────────────────────

export async function DELETE(req: NextRequest) {
    const auth = requirePlatformAdmin(req);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

    const body = await req.json();
    const { id } = body as { id: string };

    if (!id) {
        return Response.json({ error: "id is required" }, { status: 400 });
    }

    try {
        await deleteVerifiedItem(id);

        await recordAuditEntry({
            action: "registry.delete",
            performedBy: "platform-admin",
            targetType: "listing",
            targetId: id,
        }).catch(() => {});

        return Response.json({ ok: true, id });
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : "Delete failed" },
            { status: 500 },
        );
    }
}
