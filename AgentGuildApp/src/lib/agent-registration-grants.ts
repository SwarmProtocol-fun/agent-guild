/**
 * Agent registration grants — the org owner's authorization to bind a key
 * to an agent identity. /api/v1/register requires one for every new
 * identity and every key change (takeover, legacy migration), so knowing an
 * orgId is no longer enough to mint ASNs into an org or hijack an agent's
 * key by name.
 *
 * Two forms, both single-use:
 *   - setup token  (`agr_…`, 24h): minted by the dashboard for the setup
 *     prompt; stored only as its SHA-256 in agentRegistrationGrants/{hash}.
 *   - invite code  (8 chars, 7d): agentInvites, for `agent-guild join --code`.
 *
 * Server-only (Admin SDK).
 */

import { createHash, randomBytes } from "node:crypto";
import { adminDb } from "@/lib/firebase-admin";
import { toMillis } from "@/lib/agent-standing";

const GRANTS = "agentRegistrationGrants";
const INVITES = "agentInvites";

export const SETUP_TOKEN_TTL_MS = 24 * 3600_000;
export const INVITE_CODE_TTL_MS = 7 * 24 * 3600_000;

export interface RegistrationGrant {
    orgId: string;
    agentName: string;
    /** Reserved agent doc this grant binds to; absent = mint a new identity. */
    agentId?: string;
    /** Wallet that issued the grant (org owner). */
    issuedBy: string;
    expiresAt: number;
    usedAt?: number | null;
}

export type GrantErrorCode =
    | "REGISTRATION_GRANT_REQUIRED"
    | "REGISTRATION_GRANT_INVALID"
    | "REGISTRATION_GRANT_EXPIRED"
    | "REGISTRATION_GRANT_USED"
    | "REGISTRATION_GRANT_MISMATCH";

export class GrantError extends Error {
    constructor(public code: GrantErrorCode, message: string) {
        super(message);
    }
}

export function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/** Pure validity check, shared by both grant forms. */
export function checkGrant(
    grant: RegistrationGrant | null,
    expect: { orgId: string; agentName: string },
    nowMs: number = Date.now(),
): GrantError | null {
    if (!grant) return new GrantError("REGISTRATION_GRANT_INVALID", "Registration token or invite code not recognized");
    if (grant.usedAt) return new GrantError("REGISTRATION_GRANT_USED", "This registration token/invite has already been used — ask the org owner for a new one");
    if (nowMs > grant.expiresAt) return new GrantError("REGISTRATION_GRANT_EXPIRED", "This registration token/invite has expired — ask the org owner for a new one");
    if (grant.orgId !== expect.orgId) return new GrantError("REGISTRATION_GRANT_MISMATCH", "This registration token/invite is for a different org");
    if (grant.agentName.trim().toLowerCase() !== expect.agentName.trim().toLowerCase()) {
        return new GrantError("REGISTRATION_GRANT_MISMATCH", `This registration token/invite is for agent "${grant.agentName}", not "${expect.agentName}"`);
    }
    return null;
}

export async function issueSetupToken(grant: Omit<RegistrationGrant, "expiresAt" | "usedAt">): Promise<{ token: string; expiresAt: number }> {
    const token = `agr_${randomBytes(24).toString("base64url")}`;
    const expiresAt = Date.now() + SETUP_TOKEN_TTL_MS;
    await adminDb().collection(GRANTS).doc(hashToken(token)).set({
        ...Object.fromEntries(Object.entries(grant).filter(([, v]) => v !== undefined)),
        expiresAt,
        usedAt: null,
        createdAt: Date.now(),
    });
    return { token, expiresAt };
}

function inviteToGrant(data: FirebaseFirestore.DocumentData): RegistrationGrant {
    // Invites created before expiry tracking: age them from createdAt.
    const expiresAt = typeof data.expiresAt === "number"
        ? data.expiresAt
        : (toMillis(data.createdAt) ?? 0) + INVITE_CODE_TTL_MS;
    return {
        orgId: data.orgId,
        agentName: data.agentName,
        issuedBy: data.createdBy,
        expiresAt,
        usedAt: data.usedAt ?? null,
    };
}

/**
 * Read and validate a grant inside the caller's transaction. Firestore
 * requires every read before any write, so this only reads — the caller does
 * its other reads, then calls burnGrantInTxn(), so the grant is consumed only
 * if the whole registration commits.
 */
export async function readGrantInTxn(
    txn: FirebaseFirestore.Transaction,
    creds: { registrationToken?: string; inviteCode?: string },
    expect: { orgId: string; agentName: string },
): Promise<{ grant: RegistrationGrant; ref: FirebaseFirestore.DocumentReference }> {
    let ref: FirebaseFirestore.DocumentReference;
    let grant: RegistrationGrant | null = null;

    if (creds.registrationToken) {
        ref = adminDb().collection(GRANTS).doc(hashToken(creds.registrationToken));
        const snap = await txn.get(ref);
        grant = snap.exists ? (snap.data() as RegistrationGrant) : null;
    } else if (creds.inviteCode) {
        const q = await txn.get(adminDb().collection(INVITES).where("code", "==", creds.inviteCode.toUpperCase()).limit(1));
        if (q.empty) throw new GrantError("REGISTRATION_GRANT_INVALID", "Invite code not recognized");
        ref = q.docs[0].ref;
        grant = inviteToGrant(q.docs[0].data());
    } else {
        throw new GrantError(
            "REGISTRATION_GRANT_REQUIRED",
            "Registering a new agent (or replacing an agent's key) needs the org owner's authorization: use the setup command from the dashboard (--token) or `agent-guild join --code <CODE>`.",
        );
    }

    const err = checkGrant(grant, expect);
    if (err) throw err;
    return { grant: grant!, ref };
}

export function burnGrantInTxn(txn: FirebaseFirestore.Transaction, ref: FirebaseFirestore.DocumentReference): void {
    txn.update(ref, { usedAt: Date.now() });
}
