/**
 * Mod Manifest Integrity — SHA-256 content hashing for mod verification.
 *
 * Computes a deterministic hash of a mod's manifest content so that
 * integrity can be verified at install time and during runtime audits.
 * Community/third-party mods can be signed by a Swarm review key after
 * approval, enabling trust-chain verification.
 */

import type { ModManifest, VendorMod } from "./skills";

/**
 * Compute a SHA-256 hex digest of a mod manifest's canonical JSON.
 * Deterministic — keys are sorted so the hash is stable across serializations.
 */
export async function hashManifest(manifest: ModManifest): Promise<string> {
    const canonical = JSON.stringify(manifest, Object.keys(manifest).sort());
    const encoded = new TextEncoder().encode(canonical);
    const buffer = await crypto.subtle.digest("SHA-256", encoded);
    return Array.from(new Uint8Array(buffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Compute a content hash for a full VendorMod entry (id + version + capabilities + manifest).
 * This captures enough to detect any tampering of the mod definition.
 */
export async function hashModEntry(mod: VendorMod, manifest?: ModManifest): Promise<string> {
    const payload = {
        id: mod.id,
        slug: mod.slug,
        version: mod.version,
        capabilities: mod.capabilities.sort(),
        manifest: manifest ?? null,
    };
    const canonical = JSON.stringify(payload);
    const encoded = new TextEncoder().encode(canonical);
    const buffer = await crypto.subtle.digest("SHA-256", encoded);
    return Array.from(new Uint8Array(buffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/** Integrity record stored alongside installations */
export interface ModIntegrityRecord {
    modId: string;
    version: string;
    contentHash: string;
    hashedAt: string; // ISO timestamp
    verifiedBy?: string; // "platform" | wallet address of reviewer
}

/**
 * Build an integrity record for a mod at its current version.
 * Store this in the ModInstallation document or a dedicated collection.
 */
export async function buildIntegrityRecord(
    mod: VendorMod,
    manifest?: ModManifest,
    verifiedBy?: string,
): Promise<ModIntegrityRecord> {
    const contentHash = await hashModEntry(mod, manifest);
    return {
        modId: mod.id,
        version: mod.version,
        contentHash,
        hashedAt: new Date().toISOString(),
        verifiedBy: verifiedBy ?? "platform",
    };
}

/**
 * Verify a mod's current content matches a previously recorded hash.
 * Returns true if the mod has not been tampered with.
 */
export async function verifyModIntegrity(
    mod: VendorMod,
    manifest: ModManifest | undefined,
    expectedHash: string,
): Promise<boolean> {
    const currentHash = await hashModEntry(mod, manifest);
    return currentHash === expectedHash;
}
