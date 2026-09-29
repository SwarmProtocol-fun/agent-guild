/**
 * Verified Registry — Firestore-backed marketplace items
 *
 * Mirrors the static SKILL_REGISTRY but is admin-editable.
 * SKILL_REGISTRY serves as seed data and backward-compat fallback.
 *
 * Collection: `verifiedMarketItems`
 */

import { adminDb } from "./firebase-admin";
import { Timestamp, FieldValue, type Query } from "firebase-admin/firestore";
import { SKILL_REGISTRY, type Skill, type MarketItemType, type MarketPricing } from "./skills";

// ═══════════════════════════════════════════════════════════════
// Collection
// ═══════════════════════════════════════════════════════════════

const COLLECTION = "verifiedMarketItems";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface VerifiedItem {
    id: string;
    name: string;
    description: string;
    type: MarketItemType;
    category: string;
    icon: string;
    version: string;
    author: string;
    tags: string[];
    pricing: MarketPricing;
    requiredKeys?: string[];
    requires?: string[];
    featured: boolean;
    enabled: boolean;
    installCount: number;
    avgRating: number;
    ratingCount: number;
    createdAt: Date | null;
    updatedAt: Date | null;
}

/** Fields admins are allowed to update */
export type VerifiedItemUpdatable = Partial<
    Pick<
        VerifiedItem,
        | "name"
        | "description"
        | "version"
        | "icon"
        | "category"
        | "tags"
        | "pricing"
        | "featured"
        | "enabled"
    >
>;

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function toDate(val: unknown): Date | null {
    if (!val) return null;
    if (val instanceof Timestamp) return val.toDate();
    if (val instanceof Date) return val;
    return null;
}

function docToVerifiedItem(id: string, data: Record<string, unknown>): VerifiedItem {
    return {
        id,
        name: (data.name as string) || "Untitled",
        description: (data.description as string) || "",
        type: (data.type as MarketItemType) || "mod",
        category: (data.category as string) || "general",
        icon: (data.icon as string) || "",
        version: (data.version as string) || "1.0.0",
        author: (data.author as string) || "Agent Guild Core",
        tags: Array.isArray(data.tags) ? data.tags : [],
        pricing: (data.pricing as MarketPricing) || { model: "free" },
        requiredKeys: Array.isArray(data.requiredKeys) ? data.requiredKeys : undefined,
        requires: Array.isArray(data.requires) ? data.requires : undefined,
        featured: (data.featured as boolean) ?? false,
        enabled: (data.enabled as boolean) ?? true,
        installCount: (data.installCount as number) ?? 0,
        avgRating: (data.avgRating as number) ?? 0,
        ratingCount: (data.ratingCount as number) ?? 0,
        createdAt: toDate(data.createdAt),
        updatedAt: toDate(data.updatedAt),
    };
}

function skillToVerifiedItem(skill: Skill): VerifiedItem {
    return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        type: skill.type,
        category: skill.category,
        icon: skill.icon,
        version: skill.version,
        author: skill.author,
        tags: skill.tags,
        pricing: skill.pricing,
        requiredKeys: skill.requiredKeys,
        requires: skill.requires,
        featured: false,
        enabled: true,
        installCount: 0,
        avgRating: 0,
        ratingCount: 0,
        createdAt: null,
        updatedAt: null,
    };
}

// ═══════════════════════════════════════════════════════════════
// Seed
// ═══════════════════════════════════════════════════════════════

/**
 * Seed SKILL_REGISTRY items into Firestore.
 * Uses `setDoc` without merge so existing docs are NOT overwritten
 * (preserving any admin edits). Returns { seeded, skipped }.
 */
export async function seedVerifiedItems(): Promise<{ seeded: number; skipped: number }> {
    let seeded = 0;
    let skipped = 0;

    for (const skill of SKILL_REGISTRY) {
        const ref = adminDb().collection(COLLECTION).doc(skill.id);
        const snap = await ref.get();

        if (snap.exists) {
            skipped++;
            continue;
        }

        await ref.set({
            name: skill.name,
            description: skill.description,
            type: skill.type,
            category: skill.category,
            icon: skill.icon,
            version: skill.version,
            author: skill.author,
            tags: skill.tags,
            pricing: skill.pricing,
            requiredKeys: skill.requiredKeys || null,
            requires: skill.requires || null,
            featured: false,
            enabled: true,
            installCount: 0,
            avgRating: 0,
            ratingCount: 0,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
        });

        seeded++;
    }

    return { seeded, skipped };
}

// ═══════════════════════════════════════════════════════════════
// Read
// ═══════════════════════════════════════════════════════════════

export interface VerifiedItemFilters {
    type?: string | null;
    category?: string | null;
    featured?: boolean;
}

// Track whether auto-seed has been triggered this process lifetime
let autoSeedTriggered = false;

/**
 * Get all verified items from Firestore.
 *
 * If the collection is empty (not yet seeded), returns SKILL_REGISTRY items
 * as a temporary fallback and triggers a background auto-seed so subsequent
 * calls hit Firestore directly. This fallback is deprecated and will be
 * removed once all environments have been seeded.
 */
export async function getVerifiedItems(filters?: VerifiedItemFilters): Promise<VerifiedItem[]> {
    let q: Query = adminDb().collection(COLLECTION);
    if (filters?.type) q = q.where("type", "==", filters.type);
    if (filters?.featured) q = q.where("featured", "==", true);

    const snap = await q.get();

    // DEPRECATED FALLBACK: Return static data while auto-seeding Firestore.
    // This path should only fire on fresh environments that haven't been seeded yet.
    if (snap.empty) {
        console.warn(
            "[verified-registry] Firestore collection is empty — returning static SKILL_REGISTRY fallback. " +
            "This is deprecated and will be removed in a future release. " +
            "Run seedVerifiedItems() or call the admin seed endpoint to populate Firestore."
        );

        // Auto-seed in the background so subsequent requests hit Firestore
        if (!autoSeedTriggered) {
            autoSeedTriggered = true;
            seedVerifiedItems()
                .then(({ seeded }) => {
                    if (seeded > 0) {
                        console.info(`[verified-registry] Auto-seeded ${seeded} items into Firestore.`);
                    }
                })
                .catch((err) => {
                    console.error("[verified-registry] Auto-seed failed:", err);
                    autoSeedTriggered = false; // Allow retry on next request
                });
        }

        let items = SKILL_REGISTRY.map(skillToVerifiedItem);
        if (filters?.type) items = items.filter((i) => i.type === filters.type);
        if (filters?.category) items = items.filter((i) => i.category === filters.category);
        if (filters?.featured) items = items.filter((i) => i.featured);
        return items;
    }

    let items = snap.docs.map((d) => docToVerifiedItem(d.id, d.data()));

    // In-memory category filter (avoids composite index requirement)
    if (filters?.category) {
        items = items.filter((i) => i.category === filters.category);
    }

    // Only return enabled items for non-admin reads
    items = items.filter((i) => i.enabled);

    return items;
}

/**
 * Get all verified items including disabled ones (for admin).
 */
export async function getAllVerifiedItems(): Promise<VerifiedItem[]> {
    const snap = await adminDb().collection(COLLECTION).get();

    if (snap.empty) {
        console.warn("[verified-registry] getAllVerifiedItems: Firestore empty — using static fallback (deprecated).");
        return SKILL_REGISTRY.map(skillToVerifiedItem);
    }

    return snap.docs.map((d) => docToVerifiedItem(d.id, d.data()));
}

/**
 * Get a single verified item by ID.
 * Falls back to SKILL_REGISTRY if not found in Firestore.
 */
export async function getVerifiedItem(id: string): Promise<VerifiedItem | null> {
    const ref = adminDb().collection(COLLECTION).doc(id);
    const snap = await ref.get();

    if (snap.exists) {
        return docToVerifiedItem(snap.id, snap.data()!);
    }

    // Deprecated fallback to static registry
    const staticItem = SKILL_REGISTRY.find((s) => s.id === id);
    if (staticItem) {
        console.warn(`[verified-registry] getVerifiedItem("${id}"): not in Firestore — using static fallback (deprecated).`);
    }
    return staticItem ? skillToVerifiedItem(staticItem) : null;
}

// ═══════════════════════════════════════════════════════════════
// Update
// ═══════════════════════════════════════════════════════════════

/**
 * Update allowed fields on a verified item.
 */
export async function updateVerifiedItem(
    id: string,
    updates: VerifiedItemUpdatable,
): Promise<void> {
    const ref = adminDb().collection(COLLECTION).doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
        throw new Error(`Verified item "${id}" not found in Firestore. Seed the registry first.`);
    }

    // Only allow safe fields
    const safe: Record<string, unknown> = {};
    if (updates.name !== undefined) safe.name = updates.name;
    if (updates.description !== undefined) safe.description = updates.description;
    if (updates.version !== undefined) safe.version = updates.version;
    if (updates.icon !== undefined) safe.icon = updates.icon;
    if (updates.category !== undefined) safe.category = updates.category;
    if (updates.tags !== undefined) safe.tags = updates.tags;
    if (updates.pricing !== undefined) safe.pricing = updates.pricing;
    if (updates.featured !== undefined) safe.featured = updates.featured;
    if (updates.enabled !== undefined) safe.enabled = updates.enabled;

    safe.updatedAt = FieldValue.serverTimestamp();

    await ref.update(safe);
}

// ═══════════════════════════════════════════════════════════════
// Delete
// ═══════════════════════════════════════════════════════════════

/**
 * Remove a verified item from Firestore.
 * Can be re-seeded later from SKILL_REGISTRY.
 */
export async function deleteVerifiedItem(id: string): Promise<void> {
    await adminDb().collection(COLLECTION).doc(id).delete();
}

// ═══════════════════════════════════════════════════════════════
// Create (manual addition beyond seed)
// ═══════════════════════════════════════════════════════════════

export interface CreateVerifiedItemInput {
    id: string;
    name: string;
    description: string;
    type: MarketItemType;
    category: string;
    icon: string;
    version: string;
    author: string;
    tags: string[];
    pricing: MarketPricing;
    requiredKeys?: string[];
    requires?: string[];
}

/**
 * Create a new verified item in Firestore (not from SKILL_REGISTRY seed).
 */
export async function createVerifiedItem(input: CreateVerifiedItemInput): Promise<void> {
    const ref = adminDb().collection(COLLECTION).doc(input.id);
    const snap = await ref.get();

    if (snap.exists) {
        throw new Error(`Verified item "${input.id}" already exists`);
    }

    await ref.set({
        name: input.name,
        description: input.description,
        type: input.type,
        category: input.category,
        icon: input.icon,
        version: input.version,
        author: input.author,
        tags: input.tags,
        pricing: input.pricing,
        requiredKeys: input.requiredKeys || null,
        requires: input.requires || null,
        featured: false,
        enabled: true,
        installCount: 0,
        avgRating: 0,
        ratingCount: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
    });
}
