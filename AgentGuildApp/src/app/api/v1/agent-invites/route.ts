/**
 * POST /api/v1/agent-invites
 *
 * Org-admin-only. Creates a single-use agent invite (7-day expiry): an 8-char code
 * that `agent-guild join --code <CODE>` resolves into org id, agent name,
 * type, skills, and greeting — collapsing the old "copy this whole runbook
 * and edit --org/--name/--skills yourself" flow into one command.
 *
 * Body: { orgId, agentName, agentType, skills?, greeting? }
 * Auth: x-wallet-address header, must be the org owner (requireOrgAdmin).
 */
import { NextRequest } from "next/server";
import { randomInt } from "node:crypto";
import { INVITE_CODE_TTL_MS } from "@/lib/agent-registration-grants";
import { requireOrgAdmin } from "@/lib/auth-guard";
import { getOrganization, createAgentInvite } from "@/lib/firestore-admin";

interface SkillPayload {
    id: string;
    name: string;
    type: "skill" | "plugin";
    version?: string;
}

function sanitizeSkills(raw: unknown): SkillPayload[] {
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

// The code is also the registration authorization (consumed by
// /api/v1/register), so it's crypto-random: 32^8 ≈ 1.1e12, no 0/O/1/I.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(): string {
    let code = "";
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return code;
}

export async function POST(req: NextRequest) {
    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const orgId = body.orgId as string | undefined;
    const agentName = body.agentName as string | undefined;
    const agentType = typeof body.agentType === "string" ? body.agentType : "agent";
    const skills = sanitizeSkills(body.skills);
    const greeting = typeof body.greeting === "string" ? body.greeting.slice(0, 500) : undefined;

    if (!orgId || !agentName) {
        return Response.json({ error: "orgId and agentName are required" }, { status: 400 });
    }

    const auth = await requireOrgAdmin(req, orgId);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

    const org = await getOrganization(orgId);
    if (!org) return Response.json({ error: "Organization not found" }, { status: 404 });

    const code = generateCode();
    const id = await createAgentInvite({
        code,
        orgId,
        orgName: org.name || orgId,
        agentName,
        agentType,
        skills,
        greeting,
        createdBy: auth.walletAddress!,
        expiresAt: Date.now() + INVITE_CODE_TTL_MS,
        usedAt: null,
    });

    return Response.json({
        id,
        code,
        joinCommand: `agent-guild join --code ${code} --hub https://agent-guild.com`,
    });
}
