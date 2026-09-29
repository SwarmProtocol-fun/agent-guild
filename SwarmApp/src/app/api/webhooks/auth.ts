/**
 * Shared webhook auth helper.
 * Validates agent credentials (agentId + apiKey) against Firestore.
 * Rejects agents whose access has been revoked (tokenRevokedAt is set).
 *
 * API keys are stored as SHA-256 hashes in Firestore (`apiKeyHash` field).
 * For backward compatibility, plaintext `apiKey` fields are also checked
 * and auto-migrated to hashed format on successful auth.
 */
import crypto from "crypto";
import { db } from "@/lib/firebase";
import { doc, getDoc, updateDoc } from "firebase/firestore";

export interface AuthResult {
    agentId: string;
    orgId: string;
    agentName: string;
    agentType: string;
}

/**
 * Hash an API key with SHA-256 for storage.
 * SHA-256 is appropriate here because API keys are high-entropy random UUIDs,
 * making brute-force infeasible even without a slow hash like bcrypt.
 */
export function hashApiKey(apiKey: string): string {
    return crypto.createHash("sha256").update(apiKey, "utf-8").digest("hex");
}

/**
 * Timing-safe comparison of two strings to prevent timing attacks.
 */
function timingSafeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
        return false;
    }
}

/**
 * Authenticate an agent by ID + API key.
 * Returns agent info on success, or null on failure.
 * Also rejects if the agent's access has been revoked.
 *
 * Supports both hashed (apiKeyHash) and legacy plaintext (apiKey) fields.
 * On successful plaintext auth, auto-migrates to hashed format.
 */
export async function authenticateAgent(
    agentId: string | null | undefined,
    apiKey: string | null | undefined
): Promise<AuthResult | null> {
    if (!agentId || !apiKey) return null;

    try {
        const agentRef = doc(db, "agents", agentId);
        const agentSnap = await getDoc(agentRef);
        if (!agentSnap.exists()) return null;

        const data = agentSnap.data();

        // Reject if access has been revoked
        if (data.tokenRevokedAt) return null;

        const incomingHash = hashApiKey(apiKey);
        let authenticated = false;

        // Prefer hashed comparison
        if (data.apiKeyHash) {
            authenticated = timingSafeCompare(incomingHash, data.apiKeyHash);
        } else if (data.apiKey) {
            // Legacy plaintext comparison — migrate on success
            authenticated = timingSafeCompare(apiKey, data.apiKey);
            if (authenticated) {
                // Auto-migrate: store hash, remove plaintext
                try {
                    await updateDoc(agentRef, {
                        apiKeyHash: incomingHash,
                        apiKey: null,
                    });
                } catch {
                    // Migration failure is non-fatal — auth still succeeds
                }
            }
        }

        if (!authenticated) return null;

        return {
            agentId,
            orgId: data.orgId || data.organizationId || "",
            agentName: data.name || agentId,
            agentType: data.type || "agent",
        };
    } catch {
        return null;
    }
}

/**
 * Standard 401 JSON response.
 */
export function unauthorized(message = "Invalid credentials") {
    return Response.json({ error: message }, { status: 401 });
}
