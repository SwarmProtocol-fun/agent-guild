/**
 * Privacy settings — per-org / per-agent visibility of public profile data.
 *
 * Restored from hedera-privacy.ts, which was removed with the Hedera mods.
 * This part is plain Firestore and has no Hedera dependency. Server-only
 * (Firebase Admin SDK). Defaults to PRIVATE when no settings doc exists.
 */

import { adminDb } from "@/lib/firebase-admin";

export interface PrivacySettings {
    orgId: string;
    agentId?: string;
    privacyLevel: "private" | "organization" | "public";
    allowPublicProfile: boolean;
    allowPublicScores: boolean;
    allowPublicHistory: boolean;
    encryptionEnabled: boolean;
    createdAt: unknown;
    updatedAt: unknown;
}

export async function getPrivacySettings(orgId: string, agentId?: string): Promise<PrivacySettings> {
    const snap = await adminDb().collection("privacySettings").doc(agentId || orgId).get();

    if (snap.exists) {
        return snap.data() as PrivacySettings;
    }

    // Default to PRIVATE
    return {
        orgId,
        agentId,
        privacyLevel: "private",
        allowPublicProfile: false,
        allowPublicScores: false,
        allowPublicHistory: false,
        encryptionEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
}
