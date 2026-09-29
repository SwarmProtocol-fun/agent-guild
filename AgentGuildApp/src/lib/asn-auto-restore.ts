/**
 * ASN Auto-Restore Helper
 *
 * Server-side helper for automatically restoring agent memory during registration.
 * Checks if an ASN has a backup and returns restoration data without requiring auth.
 */

import { adminDb } from "@/lib/firebase-admin";
// [agent-guild-core] Storage and Hedera removed
const retrieveContent = async (_cid: string): Promise<Response> => {
    throw new Error("Storage mod not installed");
};
const isStorageConfigured = () => false;
const getAgentNFTIdentity = async (
    _walletAddress: string,
): Promise<{
    creditScore?: number;
    trustScore?: number;
    tier?: "Bronze" | "Silver" | "Gold" | "Platinum";
    hasNFT?: boolean;
} | null> => null;

export interface AutoRestoreResult {
    restored: boolean;
    asn: string;
    backup?: {
        cid: string;
        sizeBytes: number;
        messageCount: number;
        lastBackup: string | null;
    };
    reputation?: {
        creditScore: number;
        trustScore: number;
        tier: "Bronze" | "Silver" | "Gold" | "Platinum";
        hasNFT: boolean;
    };
    memoryData?: any;
    message?: string;
}

/**
 * Check if ASN has a backup and restore it automatically.
 * Called during agent registration to provide seamless memory restoration.
 */
export async function checkAndRestoreASN(asn: string): Promise<AutoRestoreResult> {
    try {
        // Look up ASN backup in Firestore
        const asnMemoryRef = adminDb().collection("asnMemoryBackups").doc(asn);
        const asnDoc = await asnMemoryRef.get();

        if (!asnDoc.exists) {
            return {
                restored: false,
                asn,
                message: "No backup found for this ASN",
            };
        }

        const backupData = asnDoc.data()!;
        const { cid, sizeBytes, createdAt, lastBackup, walletAddress, messageCount } = backupData;

        // Download memory from storage provider
        let memoryData: any;

        if (isStorageConfigured()) {
            try {
                const response = await retrieveContent(cid);
                const text = await response.text();
                memoryData = JSON.parse(text);
            } catch (error) {
                console.error("Failed to download from storage provider during auto-restore:", error);
                return {
                    restored: false,
                    asn,
                    message: "Backup exists but download failed",
                };
            }
        } else {
            // Fallback if storage provider not configured (dev mode)
            console.warn("storage provider not configured - auto-restore returning metadata only");
            memoryData = null;
        }

        // Get current NFT identity (credit score may have changed since backup)
        let nftIdentity = null;
        if (walletAddress) {
            nftIdentity = await getAgentNFTIdentity(walletAddress);
        }

        const creditScore = nftIdentity?.creditScore || memoryData?.reputation?.creditScore || 680;
        const trustScore = nftIdentity?.trustScore || memoryData?.reputation?.trustScore || 50;
        const tier = nftIdentity?.tier || "Bronze";

        return {
            restored: true,
            asn,
            backup: {
                cid,
                sizeBytes,
                messageCount: messageCount || memoryData?.history?.totalMessages || 0,
                lastBackup: lastBackup?.toDate ? lastBackup.toDate().toISOString() : null,
            },
            reputation: {
                creditScore,
                trustScore,
                tier,
                hasNFT: nftIdentity?.hasNFT || false,
            },
            memoryData,
            message: `✅ Backup found! Agent will restore ${messageCount || 0} messages with ${tier} tier (credit: ${creditScore}).`,
        };
    } catch (error) {
        console.error("ASN auto-restore check error:", error);
        return {
            restored: false,
            asn,
            message: "Auto-restore check failed",
        };
    }
}
