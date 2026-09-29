/**
 * GET /api/v1/marketplace/public-profile?asn=ASN-SWM-2026-XXXX-XXXX-XX
 *
 * Get public profile for an agent (respects privacy settings).
 * Only returns data if agent has opted into public visibility.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { getPrivacySettings } from "@/lib/privacy-settings";
// [agent-guild-core] Hedera integration removed — install agent-guild-hedera mod
import type { Agent } from "@/lib/firestore";

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const asn = searchParams.get("asn");
        const agentId = searchParams.get("agentId");

        if (!asn && !agentId) {
            return NextResponse.json(
                { error: "Missing asn or agentId parameter" },
                { status: 400 },
            );
        }

        // Find agent
        const agentsRef = adminDb().collection("agents");
        const agentSnapshot = asn
            ? await agentsRef.where("asn", "==", asn).get()
            : await agentsRef.where("id", "==", agentId).get();

        if (agentSnapshot.empty) {
            return NextResponse.json(
                { error: "Agent not found" },
                { status: 404 },
            );
        }

        const agent = { id: agentSnapshot.docs[0].id, ...agentSnapshot.docs[0].data() } as Agent;

        // Check privacy settings
        const privacy = await getPrivacySettings(agent.orgId, agent.id);

        // If private, return minimal info
        if (privacy.privacyLevel === "private") {
            return NextResponse.json({
                asn: agent.asn,
                isPublic: false,
                message: "This agent's profile is private",
            });
        }

        // Build public profile based on allowed fields
        const profile: any = {
            asn: agent.asn,
            isPublic: true,
            privacyLevel: privacy.privacyLevel,
        };

        // Profile data (if allowed)
        if (privacy.allowPublicProfile) {
            profile.name = agent.name;
            profile.type = agent.type;
            profile.bio = agent.bio;
            profile.avatarUrl = agent.avatarUrl;
            profile.reportedSkills = agent.reportedSkills || [];
        }

        // Reputation scores (if allowed)
        if (privacy.allowPublicScores) {
            const creditScore = agent.creditScore || 680;
            const trustScore = agent.trustScore || 50;

            profile.creditScore = creditScore;
            profile.trustScore = trustScore;
            profile.tier = creditScore >= 850 ? "Platinum"
                : creditScore >= 700 ? "Gold"
                : creditScore >= 550 ? "Silver"
                : "Bronze";
        }

        // Stats (if public)
        if (privacy.privacyLevel === "public") {
            profile.stats = {
                tasksCompleted: agent.tasksCompleted || 0,
                projectIds: (agent.projectIds || []).length,
                status: agent.status,
            };
        }

        return NextResponse.json(profile);
    } catch (error) {
        console.error("Get public profile error:", error);
        return NextResponse.json(
            {
                error: "Failed to get public profile",
                details: error instanceof Error ? error.message : "Unknown error",
            },
            { status: 500 },
        );
    }
}
