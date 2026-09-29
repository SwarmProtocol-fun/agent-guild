/**
 * POST /api/v1/register
 *
 * Register an agent's Ed25519 public key with the hub.
 * No API keys, no tokens — the public key IS the credential.
 *
 * Body: { publicKey, agentName, agentType, orgId, skills?, bio? }
 *   skills — optional array of { id, name, type, version? } the agent self-reports
 *   bio    — optional short self-description the agent writes about itself
 * Returns: { agentId, asn, registered: true }
 */
import { NextRequest } from "next/server";
import { ethers } from "ethers";
import crypto from "crypto";
import { PLATFORM_BRIEFING } from "../briefing";
import { getAgentAvatarUrl } from "@/lib/agent-avatar";
import { agentCheckIn, getOrganization } from "@/lib/firestore-admin";
import type { Agent } from "@/lib/firestore";
import { generateASN } from "@/lib/credit-scoring";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { checkAndRestoreASN } from "@/lib/asn-auto-restore";
import { emitSkillReport, createPrivateMemoryTopic, postPrivateMemory, issueAgentIdentity } from "@/lib/mod-stubs";
import { getWalletAddress } from "@/lib/auth-guard";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { mintIdentityOnChains, reissueIdentityOnChains, supportedIdentityChains, type IdentityMintReceipt } from "@/lib/identity/registry";

/** Chains the caller can mint the agent's ASN identity NFT on at birth — defaults to all of them. */
function resolveChainChoice(body: Record<string, unknown>): string[] {
    const supported = supportedIdentityChains();
    const raw = body.chainChoice;
    const requested = Array.isArray(raw)
        ? raw.filter((c): c is string => typeof c === "string")
        : typeof raw === "string" && raw !== "both"
            ? [raw]
            : supported;
    const chosen = requested.filter((c) => supported.includes(c));
    return chosen.length > 0 ? chosen : supported;
}

/** Applies a mintIdentityOnChains() result to an agent's Firestore doc fields. */
function identityUpdateFields(receipts: IdentityMintReceipt[]): Record<string, unknown> {
    if (receipts.length === 0) return {};
    const identityMints = Object.fromEntries(
        receipts.map((r) => [r.chain, { txSig: r.txSig, tokenId: r.tokenId ?? null, explorerUrl: r.explorerUrl }]),
    );
    return {
        identityMints,
        onChainRegistered: true,
        onChainTxHash: receipts[0].txSig,
    };
}

/**
 * Derive a deterministic Ethereum address from an Ed25519 public key.
 * This ensures each agent gets a unique on-chain identity.
 */
function deriveAgentAddress(publicKeyPem: string): string {
    // Extract the raw key bytes from PEM format
    const pemContent = publicKeyPem
        .replace(/-----BEGIN PUBLIC KEY-----/, '')
        .replace(/-----END PUBLIC KEY-----/, '')
        .replace(/\s/g, '');
    const keyBytes = Buffer.from(pemContent, 'base64');

    // Hash the public key with keccak256
    const hash = ethers.keccak256(keyBytes);

    // Take last 20 bytes as Ethereum address
    return ethers.getAddress('0x' + hash.slice(-40));
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

export async function POST(request: NextRequest) {
    // Registration mints a real on-chain agent identity (NFT + registry tx
    // paid by the platform wallet) — rate limit per source IP to bound abuse.
    const rateLimit = await checkRateLimit(`register:${getClientIp(request)}`, {
        max: 10,
        windowMs: 60_000,
    });
    if (!rateLimit.allowed) {
        return Response.json({ error: "Too many registration attempts, try again shortly" }, { status: 429 });
    }

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
    const inviteCode = body.inviteCode as string | undefined;
    const skills = sanitizeSkills(body.skills);
    const bio = typeof body.bio === "string" ? body.bio.slice(0, 500) : undefined;
    // X25519 public key (SwarmConnect's vault keypair) — optional so older
    // clients keep working; an agent that omits it simply has no vault
    // encryption capability recorded yet (backfillable on a later register).
    const vaultPublicKey = typeof body.vaultPublicKey === "string" && body.vaultPublicKey.includes("BEGIN PUBLIC KEY")
        ? body.vaultPublicKey
        : null;

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

    // Registering an agent into an org requires proof of org membership —
    // either the org's invite code (the same credential a human uses to join
    // via /api/v1/orgs/join), or a session-authenticated wallet that's
    // already an owner/member. Previously any caller who knew/enumerated an
    // orgId could register agents into it with no proof at all.
    const codeMatches = !!org.inviteCode && inviteCode?.toUpperCase() === org.inviteCode.toUpperCase();
    if (!codeMatches) {
        const wallet = getWalletAddress(request);
        const isMember = !!wallet && (
            org.ownerAddress?.toLowerCase() === wallet ||
            org.members?.some((m) => m.toLowerCase() === wallet)
        );
        if (!isMember) {
            return Response.json(
                { error: "Registering into this organization requires its invite code or an authenticated member session" },
                { status: 403 }
            );
        }
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

    // Which chain(s) to mint this agent's ASN identity NFT on at birth — caller's choice, defaults to all.
    const chosenChains = resolveChainChoice(body);

    try {
        // Check if this public key is already registered
        const existing = await adminDb().collection("agents").where("publicKey", "==", publicKey).get();

        if (!existing.empty) {
            // Update existing agent (same key reconnecting)
            const existingDoc = existing.docs[0];
            const existingData = existingDoc.data();

            // Backfill ASN if agent doesn't have one yet
            const existingAsn = existingData.asn || generateASN();

            // Enforce ASN uniqueness — reject if another agent is active with this ASN
            const asnCheck = await validateASNNotActive(existingAsn, existingDoc.id);
            if (asnCheck.conflict) {
                return Response.json({
                    error: `ASN ${existingAsn} is already active on agent "${asnCheck.agentName}" (${asnCheck.agentId}). Suspend that agent first before reconnecting.`,
                    code: "ASN_CONFLICT",
                    conflictAgentId: asnCheck.agentId,
                    conflictAgentName: asnCheck.agentName,
                }, { status: 409 });
            }

            // Derive agent address from public key (or backfill if missing)
            const agentAddress = existingData.walletAddress || deriveAgentAddress(publicKey);

            const updates: Record<string, unknown> = {
                status: "online",
                lastSeen: FieldValue.serverTimestamp(),
                connectionType: "ed25519",
                ...(skills.length > 0 ? { reportedSkills: skills } : {}),
                ...(bio ? { bio } : {}),
            };
            if (!existingData.asn) {
                updates.asn = existingAsn;
                updates.creditScore = existingData.creditScore ?? 680;
                updates.trustScore = existingData.trustScore ?? 50;
            }
            if (!existingData.walletAddress) {
                updates.walletAddress = agentAddress;
            }
            await adminDb().collection("agents").doc(existingDoc.id).update(updates);

            // Check for ASN backup and auto-restore
            const restoreResult = await checkAndRestoreASN(existingAsn);
            if (restoreResult.restored && restoreResult.reputation) {
                // Update credit scores from restored backup
                await adminDb().collection("agents").doc(existingDoc.id).update({
                    creditScore: restoreResult.reputation.creditScore,
                    trustScore: restoreResult.reputation.trustScore,
                    restoredFromBackup: true,
                    restoredAt: FieldValue.serverTimestamp(),
                });
            }

            // Mint the ASN identity NFT on the chosen chain(s) if not yet minted (non-blocking)
            if (!existingData.onChainRegistered) {
                mintIdentityOnChains(chosenChains, {
                    agentAddress,
                    asn: existingAsn,
                    agentName: existingData.name || agentName,
                    creditScore: existingData.creditScore ?? 680,
                    trustScore: existingData.trustScore ?? 50,
                }).then(async ({ receipts }) => {
                    const fields = identityUpdateFields(receipts);
                    if (Object.keys(fields).length > 0) {
                        await adminDb().collection("agents").doc(existingDoc.id).update(fields);
                    }
                }).catch(() => {});
            }

            // Post check-in greeting to Agent Hub
            const agent = { id: existingDoc.id, ...existingData } as Agent;
            agentCheckIn(agent, agent.orgId || orgId, skills.length > 0 ? skills : undefined, bio).catch(() => {});

            // Emit skill report score event to HCS (if skills were reported)
            if (skills.length > 0 && existingAsn && agentAddress) {
                emitSkillReport(existingAsn, agentAddress, skills.map(s => s.name)).catch(() => {});
            }

            // Issue (or refresh) the core-native identity credential
            // synchronously — this is what gates vault access, independent
            // of whether the chain-specific NFT mints above ever land.
            const existingIdentity = await issueAgentIdentity(existingDoc.id, agentAddress, existingAsn, vaultPublicKey);

            return Response.json({
                agentId: existingDoc.id,
                agentName: existingData.name || agentName,
                agentAddress,
                asn: existingAsn,
                registered: true,
                existing: true,
                reportedSkills: skills.length,
                chains: existingData.onChainRegistered ? undefined : chosenChains,
                identity: { tokenId: existingIdentity.tokenId, vaultPublicKey: existingIdentity.vaultPublicKey },
                briefing: PLATFORM_BRIEFING,
                ...(restoreResult.restored ? {
                    restored: true,
                    backup: restoreResult.backup,
                    reputation: restoreResult.reputation,
                    restoreMessage: restoreResult.message,
                } : {}),
            });
        }

        // Fallback: check by orgId + name to prevent duplicates when
        // the agent regenerates its keypair (e.g., deleted keys/ folder)
        const nameMatch = await adminDb().collection("agents")
            .where("orgId", "==", orgId)
            .where("name", "==", agentName)
            .get();

        if (!nameMatch.empty) {
            // Same org + name → update existing agent with new key
            const matchedDoc = nameMatch.docs[0];
            const matchedData = matchedDoc.data();

            // Backfill ASN if agent doesn't have one yet
            const matchedAsn = matchedData.asn || generateASN();

            // Enforce ASN uniqueness — reject if another agent is active with this ASN
            const asnNameCheck = await validateASNNotActive(matchedAsn, matchedDoc.id);
            if (asnNameCheck.conflict) {
                return Response.json({
                    error: `ASN ${matchedAsn} is already active on agent "${asnNameCheck.agentName}" (${asnNameCheck.agentId}). Suspend that agent first before reconnecting.`,
                    code: "ASN_CONFLICT",
                    conflictAgentId: asnNameCheck.agentId,
                    conflictAgentName: asnNameCheck.agentName,
                }, { status: 409 });
            }

            // Derive new agent address from updated public key — a reinstall
            // that lost its keypair (no publicKey match above) but keeps the
            // same orgId+agentName lands here with a *different* address
            // than the one already on file.
            const agentAddress = deriveAgentAddress(publicKey);
            const oldAgentAddress = matchedData.agentAddress as string | undefined;
            const addressChanged = !!oldAgentAddress && oldAgentAddress !== agentAddress;

            const nameUpdates: Record<string, unknown> = {
                publicKey,
                agentAddress, // Update address when key changes
                status: "online",
                lastSeen: FieldValue.serverTimestamp(),
                connectionType: "ed25519",
                ...(skills.length > 0 ? { reportedSkills: skills } : {}),
                ...(bio ? { bio } : {}),
            };
            if (!matchedData.asn) {
                nameUpdates.asn = matchedAsn;
                nameUpdates.creditScore = matchedData.creditScore ?? 680;
                nameUpdates.trustScore = matchedData.trustScore ?? 50;
            }
            await adminDb().collection("agents").doc(matchedDoc.id).update(nameUpdates);

            // Check for ASN backup and auto-restore
            const restoreResult = await checkAndRestoreASN(matchedAsn);
            if (restoreResult.restored && restoreResult.reputation) {
                // Update credit scores from restored backup
                await adminDb().collection("agents").doc(matchedDoc.id).update({
                    creditScore: restoreResult.reputation.creditScore,
                    trustScore: restoreResult.reputation.trustScore,
                    restoredFromBackup: true,
                    restoredAt: FieldValue.serverTimestamp(),
                });
            }

            // Reissue the ASN identity NFT onto the new wallet if this is a
            // reinstall with a fresh keypair, otherwise mint it for the
            // first time if it's never been minted (both non-blocking).
            if (addressChanged) {
                reissueIdentityOnChains(chosenChains, oldAgentAddress!, {
                    agentAddress,
                    asn: matchedAsn,
                    agentName: matchedData.name || agentName,
                    creditScore: matchedData.creditScore ?? 680,
                    trustScore: matchedData.trustScore ?? 50,
                }).then(async ({ receipts }) => {
                    const fields = identityUpdateFields(receipts);
                    if (Object.keys(fields).length > 0) {
                        await adminDb().collection("agents").doc(matchedDoc.id).update(fields);
                    }
                }).catch(() => {});
            } else if (!matchedData.onChainRegistered) {
                mintIdentityOnChains(chosenChains, {
                    agentAddress,
                    asn: matchedAsn,
                    agentName: matchedData.name || agentName,
                    creditScore: matchedData.creditScore ?? 680,
                    trustScore: matchedData.trustScore ?? 50,
                }).then(async ({ receipts }) => {
                    const fields = identityUpdateFields(receipts);
                    if (Object.keys(fields).length > 0) {
                        await adminDb().collection("agents").doc(matchedDoc.id).update(fields);
                    }
                }).catch(() => {});
            }

            // Post check-in greeting to Agent Hub
            const agent = { id: matchedDoc.id, ...matchedData } as Agent;
            agentCheckIn(agent, agent.orgId || orgId, skills.length > 0 ? skills : undefined, bio).catch(() => {});

            // Emit skill report score event to HCS (if skills were reported)
            if (skills.length > 0 && matchedAsn && agentAddress) {
                emitSkillReport(matchedAsn, agentAddress, skills.map(s => s.name)).catch(() => {});
            }

            const matchedIdentity = await issueAgentIdentity(matchedDoc.id, agentAddress, matchedAsn, vaultPublicKey);

            return Response.json({
                agentId: matchedDoc.id,
                agentName: matchedData.name || agentName,
                agentAddress,
                asn: matchedAsn,
                registered: true,
                existing: true,
                reportedSkills: skills.length,
                chains: matchedData.onChainRegistered ? undefined : chosenChains,
                identity: { tokenId: matchedIdentity.tokenId, vaultPublicKey: matchedIdentity.vaultPublicKey },
                briefing: PLATFORM_BRIEFING,
                ...(restoreResult.restored ? {
                    restored: true,
                    backup: restoreResult.backup,
                    reputation: restoreResult.reputation,
                    restoreMessage: restoreResult.message,
                } : {}),
            });
        }

        // Register new agent — generate unique ASN identity
        let asn = generateASN();
        // Ensure ASN doesn't collide with an active agent (retry up to 5 times)
        for (let attempt = 0; attempt < 5; attempt++) {
            const newAsnCheck = await validateASNNotActive(asn);
            if (!newAsnCheck.conflict) break;
            console.warn(`ASN collision on ${asn}, regenerating (attempt ${attempt + 1})`);
            asn = generateASN();
        }
        // Derive unique on-chain address from public key
        const agentAddress = deriveAgentAddress(publicKey);

        // Check for ASN backup before creating new agent (in case ASN collision or manual ASN reuse)
        const preRestoreResult = await checkAndRestoreASN(asn);
        const initialCreditScore = preRestoreResult.restored && preRestoreResult.reputation
            ? preRestoreResult.reputation.creditScore
            : 680;
        const initialTrustScore = preRestoreResult.restored && preRestoreResult.reputation
            ? preRestoreResult.reputation.trustScore
            : 50;

        const ref = await adminDb().collection("agents").add({
            name: agentName,
            type: agentType || "agent",
            orgId,
            organizationId: orgId,
            publicKey,
            agentAddress, // Derived Ethereum address for on-chain identity
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
            lastSeen: FieldValue.serverTimestamp(),
            createdAt: FieldValue.serverTimestamp(),
        });

        // Mint the agent's ASN Soulbound Identity NFT on the chosen chain(s) at
        // birth — non-blocking, platform-sponsored.
        mintIdentityOnChains(chosenChains, {
            agentAddress,
            asn,
            agentName,
            creditScore: initialCreditScore,
            trustScore: initialTrustScore,
        }).then(async ({ receipts }) => {
            const fields = identityUpdateFields(receipts);
            if (Object.keys(fields).length > 0) {
                await adminDb().collection("agents").doc(ref.id).update(fields);
            }
        }).catch(() => {});

        // Create private HCS memory topic + deposit first memory backup (non-blocking)
        (async () => {
            try {
                const memoryConfig = await createPrivateMemoryTopic(ref.id, asn);
                await adminDb().collection("agents").doc(ref.id).update({
                    hederaMemoryTopicId: memoryConfig.memoryTopicId,
                    hederaMemoryEnabled: true,
                    hederaMemoryCreatedAt: new Date(),
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
                console.log(`[Register] First memory deposited on Hedera HCS for ${asn}`);
            } catch (err) {
                console.warn("[Register] Memory topic creation failed (non-fatal):", err);
            }
        })();

        // Post check-in greeting to Agent Hub
        const newAgent = { id: ref.id, name: agentName, type: agentType || "agent", orgId } as Agent;
        agentCheckIn(newAgent, orgId, skills.length > 0 ? skills : undefined, bio).catch(() => {});

        // Emit skill report score event to HCS (if skills were reported)
        if (skills.length > 0 && asn && agentAddress) {
            emitSkillReport(asn, agentAddress, skills.map(s => s.name)).catch(() => {});
        }

        // Core-native identity credential — synchronous, zero-config, the
        // actual gate `requireAgentIdentity` checks. The chain-specific NFT
        // mints above are a best-effort bonus, not a prerequisite.
        const identity = await issueAgentIdentity(ref.id, agentAddress, asn, vaultPublicKey);

        return Response.json({
            agentId: ref.id,
            agentName,
            agentAddress,
            asn,
            registered: true,
            existing: false,
            reportedSkills: skills.length,
            chains: chosenChains,
            identity: { tokenId: identity.tokenId, vaultPublicKey: identity.vaultPublicKey },
            briefing: PLATFORM_BRIEFING,
            ...(preRestoreResult.restored ? {
                restored: true,
                backup: preRestoreResult.backup,
                reputation: preRestoreResult.reputation,
                restoreMessage: preRestoreResult.message,
            } : {}),
        });
    } catch (err) {
        console.error("v1/register error:", err);
        return Response.json(
            { error: "Internal server error" },
            { status: 500 }
        );
    }
}
