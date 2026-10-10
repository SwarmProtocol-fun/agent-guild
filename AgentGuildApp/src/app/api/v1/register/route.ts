/**
 * POST /api/v1/register
 *
 * Register an agent's Ed25519 public key with the hub. The public key is the
 * credential for every later call; a key that's already registered just
 * reconnects. Binding a key to a NEW identity — a new agent, a key takeover,
 * or a legacy migration — needs the org owner's single-use authorization
 * (registrationToken or inviteCode, see lib/agent-registration-grants.ts),
 * counts against the owner's agent quota, and starts the agent provisional
 * (lib/agent-standing.ts). Knowing an orgId alone no longer mints ASNs.
 *
 * Body: { publicKey, agentName, agentType, orgId, skills?, bio?, existingAgentId?,
 *         registrationToken?, inviteCode?, takeover? }
 *   skills          — optional array of { id, name, type, version? } the agent self-reports
 *   bio             — optional short self-description the agent writes about itself
 *   existingAgentId — optional legacy agent doc ID (sent by the CLI when migrating from
 *                     API-key auth) so the hub can reconnect to that identity even if the
 *                     agent's name changed and its public key is brand new
 * Returns: { agentId, asn, registered: true }
 */
import { NextRequest } from "next/server";
import crypto from "crypto";
import { PLATFORM_BRIEFING } from "../briefing";
import { getAgentAvatarUrl } from "@/lib/agent-avatar";
import { agentCheckIn, getOrganization, ensureAgentGroupChat } from "@/lib/firestore-admin";
import type { Agent } from "@/lib/firestore";
import { generateASN } from "@/lib/credit-scoring";
import { solanaAddressFromEd25519Pem } from "@/lib/solana/client";
import { registerAgentForOnChain } from "@/lib/solana/platform";
import { ensureAgentIdentityNfts, needsIdentityNfts } from "@/lib/identity-nft-service";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { checkAndRestoreASN } from "@/lib/asn-auto-restore";
import { emitSkillReport, createPrivateMemoryTopic, postPrivateMemory } from "@/lib/reputation-chain";
import { isAdminConfigError } from "../verify";
import { ingestCreditEvent, normalizeAgentRegistration } from "@/lib/credit-events/ingest";
import { recomputeAndSync } from "@/lib/scoring-engine";
import { readGrantInTxn, burnGrantInTxn, GrantError } from "@/lib/agent-registration-grants";
import { checkOwnerQuota } from "@/lib/agent-standing";
import { isOwnerHumanVerified } from "@/lib/human-verification";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";

/**
 * Read back the agent doc we just wrote, via the exact same Admin-SDK path
 * verify.ts uses to authenticate signed calls. Catches the class of bug where
 * register writes to one Firestore project/credential set and signed-call
 * verification reads from another — instead of shipping a "Ready" agent that
 * 401s on its very next call.
 */
async function selfTestAgentRead(agentId: string, expectedPublicKey: string): Promise<boolean> {
    try {
        const snap = await adminDb().collection("agents").doc(agentId).get();
        return snap.exists && snap.data()?.publicKey === expectedPublicKey;
    } catch {
        return false;
    }
}

/**
 * Derive the agent's Solana address from its Ed25519 identity key. Since a
 * Solana pubkey IS a raw Ed25519 public key, the agent already holds the
 * private key controlling this address — genuine self-custody, not a
 * platform-assigned identifier.
 */
function deriveAgentAddress(publicKeyPem: string): string {
    return solanaAddressFromEd25519Pem(publicKeyPem);
}

/** Platform-sponsored on-chain registration (Solana AgentGuild program) */
async function registerOnChain(
    agentName: string,
    asn: string,
    skills: string,
    publicKey: string,
): Promise<{ txHash: string } | null> {
    const agentAddress = deriveAgentAddress(publicKey);
    const result = await registerAgentForOnChain({
        agentAddress,
        name: `${agentName} | ${asn}`,
        skills,
        asn,
    });
    return result.txSignature ? { txHash: result.txSignature } : null;
}


/**
 * Validate that no other agent with this ASN is currently active (online/busy).
 * Returns the conflicting agent name if found, or null if ASN is available.
 */
async function validateASNNotActive(
    asn: string,
    currentAgentId?: string,
): Promise<{ conflict: false } | { conflict: true; agentName: string; agentId: string }> {
    if (!asn) return { conflict: false };
    const snap = await adminDb().collection("agents")
        .where("asn", "==", asn)
        .where("status", "in", ["online", "busy"])
        .get();
    for (const d of snap.docs) {
        if (currentAgentId && d.id === currentAgentId) continue; // skip self
        const data = d.data();
        return { conflict: true, agentName: data.name || "Unknown", agentId: d.id };
    }
    return { conflict: false };
}

interface ReportedSkillPayload {
    id: string;
    name: string;
    type: "skill" | "plugin";
    version?: string;
}

function sanitizeSkills(raw: unknown): ReportedSkillPayload[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((s): s is Record<string, unknown> =>
            typeof s === "object" && s !== null && typeof s.id === "string" && typeof s.name === "string"
        )
        .map(s => ({
            id: String(s.id),
            name: String(s.name),
            type: s.type === "plugin" ? "plugin" as const : "skill" as const,
            ...(s.version ? { version: String(s.version) } : {}),
        }));
}

/**
 * Reconnect an already-registered agent doc: refresh its status/ASN/key,
 * (re)sponsor on-chain registration + NFT mint if still pending, post a
 * check-in greeting, and emit the skill-report score event.
 *
 * `keyChanged` covers both the "same org + name" fallback match and the
 * legacy `existingAgentId` migration path, where the public key on file is
 * stale and must be overwritten along with the derived agent address.
 */
async function reconnectAgent(
    docId: string,
    data: FirebaseFirestore.DocumentData,
    opts: {
        publicKey: string;
        agentName: string;
        orgId: string;
        skills: ReportedSkillPayload[];
        bio?: string;
        keyChanged: boolean;
    },
): Promise<Response> {
    const { publicKey, agentName, orgId, skills, bio, keyChanged } = opts;

    if (data.retiredAt != null) {
        return Response.json({
            error: "This agent was retired (its bond was refunded) and can't reconnect. Register a new agent instead.",
            code: "AGENT_RETIRED",
            agentId: docId,
        }, { status: 409 });
    }

    // Backfill ASN if agent doesn't have one yet
    const asn = data.asn || generateASN();

    // Enforce ASN uniqueness — reject if another agent is active with this ASN
    const asnCheck = await validateASNNotActive(asn, docId);
    if (asnCheck.conflict) {
        return Response.json({
            error: `ASN ${asn} is already active on agent "${asnCheck.agentName}" (${asnCheck.agentId}). Suspend that agent first before reconnecting.`,
            code: "ASN_CONFLICT",
            conflictAgentId: asnCheck.agentId,
            conflictAgentName: asnCheck.agentName,
        }, { status: 409 });
    }

    // Derive agent address from public key (or backfill if missing)
    const agentAddress = keyChanged || !data.walletAddress
        ? deriveAgentAddress(publicKey)
        : data.walletAddress;

    const updates: Record<string, unknown> = {
        status: "online",
        lastSeen: FieldValue.serverTimestamp(),
        connectionType: "ed25519",
        ...(keyChanged ? { publicKey, agentAddress, solanaAddress: agentAddress } : {}),
        ...(skills.length > 0 ? { reportedSkills: skills } : {}),
        ...(bio ? { bio } : {}),
    };
    if (!data.asn) {
        updates.asn = asn;
        updates.creditScore = data.creditScore ?? 680;
        updates.trustScore = data.trustScore ?? 50;
    }
    if (!keyChanged && !data.walletAddress) {
        updates.walletAddress = agentAddress;
        updates.solanaAddress = agentAddress;
    }
    await adminDb().collection("agents").doc(docId).update(updates);

    // Check for ASN backup and auto-restore
    const restoreResult = await checkAndRestoreASN(asn);
    if (restoreResult.restored && restoreResult.reputation) {
        // Update credit scores from restored backup
        await adminDb().collection("agents").doc(docId).update({
            creditScore: restoreResult.reputation.creditScore,
            trustScore: restoreResult.reputation.trustScore,
            restoredFromBackup: true,
            restoredAt: FieldValue.serverTimestamp(),
        });
    }

    // If not yet on-chain, sponsor registration now
    if (!data.onChainRegistered) {
        const skillStr = (skills.length > 0 ? skills.map(s => s.name).join(",") : data.reportedSkills?.map((s: { name: string }) => s.name).join(",")) || "general";
        registerOnChain(data.name || agentName, asn, skillStr, publicKey).then(async (result) => {
            if (result) {
                await adminDb().collection("agents").doc(docId).update({
                    onChainTxHash: result.txHash,
                    onChainRegistered: true,
                    onChainError: FieldValue.delete(),
                });
            } else {
                // Chain call completed but returned nothing to write (e.g. sponsor
                // wallet unfunded, program not deployed on this cluster) — make that
                // visible on the doc instead of silently leaving onChainRegistered false.
                await adminDb().collection("agents").doc(docId).update({
                    onChainError: "On-chain registration skipped (no transaction signature returned)",
                }).catch(() => {});
            }
        }).catch(async (err) => {
            await adminDb().collection("agents").doc(docId).update({
                onChainError: err instanceof Error ? err.message : String(err),
            }).catch(() => {});
        });
    }

    // Mint any missing identity NFT copies — also migrates legacy SPL tokens
    // and picks up the owner copy once the org owner links a Solana wallet
    // (non-blocking; progress and errors are recorded on the agent doc).
    if (needsIdentityNfts(data) || !data.nftOwnerAssetAddress) {
        ensureAgentIdentityNfts(docId).catch(() => {});
    }

    // Self-test: confirm the write we just made is visible through the same
    // Admin-SDK read path signed calls will use, before telling the caller
    // it's safe to proceed.
    if (!(await selfTestAgentRead(docId, publicKey))) {
        return Response.json({
            error: "Registered but the self-test read failed — write and read may be hitting different Firestore projects/credentials.",
            code: "SELF_TEST_FAILED",
            agentId: docId,
        }, { status: 503 });
    }

    // Ensure the org-wide Agent Hub channel exists and hand its id back so
    // the caller doesn't need a second round trip just to find it.
    const hubChannel = await ensureAgentGroupChat(orgId);

    // Post check-in greeting to Agent Hub
    const agent = { id: docId, ...data } as Agent;
    agentCheckIn(agent, agent.orgId || orgId, skills.length > 0 ? skills : undefined, bio).catch(() => {});

    // Emit skill report score event to HCS (if skills were reported)
    if (skills.length > 0 && asn && agentAddress) {
        emitSkillReport(asn, agentAddress, skills.map(s => s.name)).catch(() => {});
    }

    return Response.json({
        agentId: docId,
        agentName: data.name || agentName,
        agentAddress,
        asn,
        registered: true,
        existing: true,
        keyUpdated: keyChanged,
        agentHubChannelId: hubChannel.id,
        reportedSkills: skills.length,
        chain: data.onChainRegistered ? undefined : "solana-devnet",
        briefing: PLATFORM_BRIEFING,
        ...(restoreResult.restored ? {
            restored: true,
            backup: restoreResult.backup,
            reputation: restoreResult.reputation,
            restoreMessage: restoreResult.message,
        } : {}),
    });
}

class RegisterError extends Error {
    constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
        super(message);
    }
}

/**
 * Fields that start a never-key-bound identity's provisional period and
 * charge it to the org owner. Applied when a key is first bound to a doc.
 */
function firstBindingFields(ownerWallet: string) {
    return {
        provisional: true,
        provisionalSince: FieldValue.serverTimestamp(),
        ownerWallet,
        keyBoundAt: Date.now(),
    };
}

export async function POST(request: NextRequest) {
    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const publicKey = body.publicKey as string | undefined;
    const agentName = body.agentName as string | undefined;
    const agentType = body.agentType as string | undefined;
    const orgId = body.orgId as string | undefined;
    const skills = sanitizeSkills(body.skills);
    const bio = typeof body.bio === "string" ? body.bio.slice(0, 500) : undefined;
    const existingAgentId = typeof body.existingAgentId === "string" ? body.existingAgentId : undefined;
    const takeover = body.takeover === true;
    const creds = {
        registrationToken: typeof body.registrationToken === "string" && body.registrationToken ? body.registrationToken : undefined,
        inviteCode: typeof body.inviteCode === "string" && body.inviteCode ? body.inviteCode : undefined,
    };

    if (!publicKey || !agentName || !orgId) {
        return Response.json(
            { error: "publicKey, agentName, and orgId are required" },
            { status: 400 }
        );
    }

    // Validate the target org exists
    const org = await getOrganization(orgId);
    if (!org) {
        return Response.json({ error: "Organization not found" }, { status: 404 });
    }
    // Note: agents can register to both public and private orgs.
    // The isPrivate flag controls public directory visibility, not agent connectivity.

    // Validate PEM format
    if (!publicKey.includes("BEGIN PUBLIC KEY")) {
        return Response.json(
            { error: "publicKey must be in PEM format (BEGIN PUBLIC KEY)" },
            { status: 400 }
        );
    }

    try {
        // Check if this public key is already registered
        const existing = await adminDb().collection("agents").where("publicKey", "==", publicKey).get();

        if (!existing.empty) {
            // Update existing agent (same key reconnecting)
            const existingDoc = existing.docs[0];
            return reconnectAgent(existingDoc.id, existingDoc.data(), {
                publicKey, agentName, orgId, skills, bio, keyChanged: false,
            });
        }

        // Every path below binds this key to an identity it isn't bound to
        // yet, so it needs the org owner's grant and counts against the owner's
        // quota. The grant is read, checked, and burned in the same transaction
        // as the write — a rejected attempt leaves it usable.
        const ownerWallet = org.ownerAddress ? canonicalizeWalletAddress(org.ownerAddress) : null;
        const humanVerified = ownerWallet ? await isOwnerHumanVerified(ownerWallet) : false;

        // New-identity values, computed up front (transactions can't run these lookups).
        let asn = generateASN();
        // Ensure ASN doesn't collide with an active agent (retry up to 5 times)
        for (let attempt = 0; attempt < 5; attempt++) {
            const newAsnCheck = await validateASNNotActive(asn);
            if (!newAsnCheck.conflict) break;
            console.warn(`ASN collision on ${asn}, regenerating (attempt ${attempt + 1})`);
            asn = generateASN();
        }
        const skillStr = skills.map(s => s.name).join(",") || "general";
        const agentAddress = deriveAgentAddress(publicKey);
        const preRestoreResult = await checkAndRestoreASN(asn);
        const initialCreditScore = preRestoreResult.restored && preRestoreResult.reputation
            ? preRestoreResult.reputation.creditScore
            : 680;
        const initialTrustScore = preRestoreResult.restored && preRestoreResult.reputation
            ? preRestoreResult.reputation.trustScore
            : 50;

        const agentsCol = adminDb().collection("agents");
        const newRef = agentsCol.doc();

        let bound: { kind: "existing"; id: string; data: FirebaseFirestore.DocumentData; keyChanged: boolean } | { kind: "new" };
        try {
            bound = await adminDb().runTransaction(async (txn) => {
                const { grant, ref: grantRef } = await readGrantInTxn(txn, creds, { orgId, agentName });
                const owner = ownerWallet ?? grant.issuedBy;

                // Which doc does this key bind to?
                let target: FirebaseFirestore.DocumentSnapshot | null = null;
                if (grant.agentId) {
                    // Dashboard-reserved agent: the grant names it exactly.
                    const snap = await txn.get(agentsCol.doc(grant.agentId));
                    if (!snap.exists || (snap.data()!.orgId !== orgId && snap.data()!.organizationId !== orgId)) {
                        throw new RegisterError(404, "RESERVED_AGENT_NOT_FOUND", "The agent this setup token was issued for no longer exists in this org");
                    }
                    target = snap;
                } else if (existingAgentId) {
                    // Legacy migration: the CLI sends the old agent's doc ID when it
                    // replaces API-key credentials with a fresh Ed25519 keypair.
                    const snap = await txn.get(agentsCol.doc(existingAgentId));
                    const d = snap.data();
                    if (snap.exists && (d!.orgId === orgId || d!.organizationId === orgId)) target = snap;
                }
                if (!target) {
                    // Same org + name → same identity (e.g. the agent lost its keys/
                    // folder). Replacing its key is a takeover and must be explicit.
                    const nameMatch = await txn.get(agentsCol.where("orgId", "==", orgId).where("name", "==", agentName).limit(1));
                    if (!nameMatch.empty) {
                        target = nameMatch.docs[0];
                        if (target.data()!.publicKey && target.data()!.publicKey !== publicKey && !takeover) {
                            throw new RegisterError(409, "KEY_TAKEOVER_REQUIRED",
                                `An agent named "${agentName}" is already registered in this org with a different key. Re-run with --takeover to replace it.`,
                                { agentId: target.id });
                        }
                    }
                }

                const targetData = target?.data();
                if (targetData?.retiredAt != null) {
                    throw new RegisterError(409, "AGENT_RETIRED", "This agent was retired and can't be re-bound. Register a new agent instead.", { agentId: target!.id });
                }

                // A doc that never had a key is a new identity for quota purposes.
                const firstBinding = !target || !targetData?.publicKey;
                if (firstBinding) {
                    const owned = await txn.get(agentsCol.where("ownerWallet", "==", owner));
                    const quota = checkOwnerQuota(owned.docs.map(d => d.data()), humanVerified);
                    if (!quota.ok) throw new RegisterError(429, quota.code, quota.reason);
                }

                burnGrantInTxn(txn, grantRef);

                if (target) {
                    if (firstBinding) txn.update(target.ref, firstBindingFields(owner));
                    return { kind: "existing" as const, id: target.id, data: targetData!, keyChanged: targetData!.publicKey !== publicKey };
                }

                txn.create(newRef, {
                    name: agentName,
                    type: agentType || "agent",
                    orgId,
                    organizationId: orgId,
                    publicKey,
                    agentAddress, // Solana address derived from the agent's Ed25519 identity key
                    walletAddress: agentAddress,
                    solanaAddress: agentAddress,
                    status: "online",
                    connectionType: "ed25519",
                    capabilities: [],
                    projectIds: [],
                    reportedSkills: skills,
                    bio: bio || "",
                    avatarUrl: getAgentAvatarUrl(agentName, agentType || "agent"),
                    description: `${agentType || "Agent"} connected via Ed25519`,
                    asn,
                    creditScore: initialCreditScore,
                    trustScore: initialTrustScore,
                    onChainRegistered: false,
                    restoredFromBackup: preRestoreResult.restored,
                    // 🔒 PRIVACY: All agents are PRIVATE by default
                    privacyLevel: "private",
                    allowPublicProfile: false,
                    allowPublicScores: false,
                    ...(preRestoreResult.restored ? { restoredAt: FieldValue.serverTimestamp() } : {}),
                    ...firstBindingFields(owner),
                    lastSeen: FieldValue.serverTimestamp(),
                    createdAt: FieldValue.serverTimestamp(),
                });
                return { kind: "new" as const };
            });
        } catch (err) {
            if (err instanceof GrantError) {
                return Response.json({ error: err.message, code: err.code }, { status: 403 });
            }
            if (err instanceof RegisterError) {
                return Response.json({ error: err.message, code: err.code, ...err.extra }, { status: err.status });
            }
            throw err;
        }

        if (bound.kind === "existing") {
            return reconnectAgent(bound.id, bound.data, {
                publicKey, agentName, orgId, skills, bio, keyChanged: bound.keyChanged,
            });
        }
        const ref = newRef;

        // Feed the canonical credit-events pipeline (non-blocking) — the Dynamic
        // Scoring Engine's trustNetwork sub-score reads registration events from here.
        ingestCreditEvent(normalizeAgentRegistration(ref.id, orgId, asn, agentAddress, false))
            .then(() => recomputeAndSync(ref.id, asn))
            .catch((err) => console.error("[register] Failed to ingest credit event:", err));

        // Attempt on-chain registration on Solana (non-blocking)
        registerOnChain(agentName, asn, skillStr, publicKey).then(async (result) => {
            if (result) {
                await adminDb().collection("agents").doc(ref.id).update({
                    onChainTxHash: result.txHash,
                    onChainRegistered: true,
                    onChainError: FieldValue.delete(),
                });
                ingestCreditEvent(normalizeAgentRegistration(ref.id, orgId, asn, agentAddress, true))
                    .then(() => recomputeAndSync(ref.id, asn))
                    .catch((err) => console.error("[register] Failed to ingest on-chain verification event:", err));
            } else {
                await adminDb().collection("agents").doc(ref.id).update({
                    onChainError: "On-chain registration skipped (no transaction signature returned)",
                }).catch(() => {});
            }
        }).catch(async (err) => {
            await adminDb().collection("agents").doc(ref.id).update({
                onChainError: err instanceof Error ? err.message : String(err),
            }).catch(() => {});
        });

        // Mint the soulbound identity NFTs — platform, org owner and agent
        // copies (non-blocking, platform-sponsored)
        ensureAgentIdentityNfts(ref.id).catch(() => {});

        // Create private memory topic + deposit first memory backup (non-blocking)
        (async () => {
            try {
                const memoryConfig = await createPrivateMemoryTopic(ref.id, asn);
                await adminDb().collection("agents").doc(ref.id).update({
                    memoryTopicId: memoryConfig.memoryTopicId,
                    memoryEnabled: true,
                    memoryCreatedAt: new Date(),
                });
                // Deposit first memory: registration event
                await postPrivateMemory(memoryConfig.memoryTopicId, asn, {
                    type: "context",
                    content: JSON.stringify({
                        event: "agent_registered",
                        agentName,
                        asn,
                        agentAddress,
                        orgId,
                        skills: skills.map(s => s.name),
                        bio: bio || "",
                        creditScore: initialCreditScore,
                        trustScore: initialTrustScore,
                        timestamp: Date.now(),
                    }),
                    metadata: { role: "system", timestamp: Date.now(), orgId },
                });
                console.log(`[Register] First memory deposited for ${asn}`);
            } catch (err) {
                console.warn("[Register] Memory topic creation failed (non-fatal):", err);
            }
        })();

        // Self-test: confirm the write is visible through the same Admin-SDK
        // read path signed calls will use before telling the caller it's safe.
        if (!(await selfTestAgentRead(ref.id, publicKey))) {
            return Response.json({
                error: "Registered but the self-test read failed — write and read may be hitting different Firestore projects/credentials.",
                code: "SELF_TEST_FAILED",
                agentId: ref.id,
            }, { status: 503 });
        }

        // Ensure the org-wide Agent Hub channel exists and hand its id back.
        const hubChannel = await ensureAgentGroupChat(orgId);

        // Post check-in greeting to Agent Hub
        const newAgent = { id: ref.id, name: agentName, type: agentType || "agent", orgId } as Agent;
        agentCheckIn(newAgent, orgId, skills.length > 0 ? skills : undefined, bio).catch(() => {});

        // Emit skill report score event to HCS (if skills were reported)
        if (skills.length > 0 && asn && agentAddress) {
            emitSkillReport(asn, agentAddress, skills.map(s => s.name)).catch(() => {});
        }

        return Response.json({
            agentId: ref.id,
            agentName,
            agentAddress,
            asn,
            registered: true,
            existing: false,
            keyUpdated: false,
            agentHubChannelId: hubChannel.id,
            reportedSkills: skills.length,
            chain: "solana-devnet",
            briefing: PLATFORM_BRIEFING,
            ...(preRestoreResult.restored ? {
                restored: true,
                backup: preRestoreResult.backup,
                reputation: preRestoreResult.reputation,
                restoreMessage: preRestoreResult.message,
            } : {}),
        });
    } catch (err) {
        if (isAdminConfigError(err)) {
            return Response.json(
                { error: "Firebase Admin SDK not configured on the server.", code: "ADMIN_NOT_CONFIGURED" },
                { status: 503 }
            );
        }
        console.error("v1/register error:", err);
        return Response.json(
            { error: "Internal server error" },
            { status: 500 }
        );
    }
}
