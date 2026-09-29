/**
 * POST /api/v1/report-skills
 *
 * Allow a connected agent to report (or update) its skills/plugins and bio at any time.
 * Supports both Ed25519 signature auth and API key auth.
 *
 * Body: { skills: [{ id, name, type, version? }], bio?: string }
 *
 * Ed25519 query params: agent, sig, ts
 * API key query params: agentId, apiKey
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh, unauthorized } from "../verify";
import { authenticateAgent, unauthorized as webhookUnauthorized } from "../../webhooks/auth";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

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

export async function POST(req: NextRequest) {
    const url = req.nextUrl;

    // Parse body
    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const skills = sanitizeSkills(body.skills);
    const bio = typeof body.bio === "string" ? body.bio.slice(0, 500) : undefined;

    // Authenticate — try Ed25519 first
    const agent = url.searchParams.get("agent");
    const sig = url.searchParams.get("sig");
    const ts = url.searchParams.get("ts");

    let agentId: string | null = null;

    if (agent && sig && ts) {
        const tsNum = parseInt(ts, 10);
        if (!isTimestampFresh(tsNum)) {
            return unauthorized("Stale timestamp");
        }

        const message = `POST:/v1/report-skills:${ts}`;
        const verified = await verifyAgentRequest(agent, message, sig);
        if (!verified) return unauthorized();
        agentId = verified.agentId;
    } else {
        // Fallback: API key auth
        const paramAgentId = url.searchParams.get("agentId");
        const apiKey = url.searchParams.get("apiKey");
        const auth = await authenticateAgent(paramAgentId, apiKey);
        if (!auth) return webhookUnauthorized();
        agentId = auth.agentId;
    }

    try {
        await adminDb().collection("agents").doc(agentId!).update({
            reportedSkills: skills,
            ...(bio ? { bio } : {}),
            lastSeen: FieldValue.serverTimestamp(),
        });

        return Response.json({
            ok: true,
            agentId,
            reportedSkills: skills.length,
        });
    } catch (err) {
        console.error("v1/report-skills error:", err);
        return Response.json(
            { error: "Internal server error" },
            { status: 500 }
        );
    }
}
