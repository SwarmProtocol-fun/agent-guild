/**
 * GET /api/v1/invite/:code
 *
 * Public — no auth, same exposure level as the existing human org invite-code
 * flow (organizations.inviteCode via /api/v1/orgs/join). Resolves an
 * agent-invite code into everything `agent-guild join --code <CODE>` needs.
 */
import { getAgentInviteByCode, getOrganizationByInviteCode } from "@/lib/firestore-admin";

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
    const { code } = await params;
    if (!code) {
        return Response.json({ error: "Invite code required" }, { status: 400 });
    }

    const invite = await getAgentInviteByCode(code);
    if (!invite) {
        // The two invite-code types live in different collections and are
        // easy to mix up: an org's human-member code (organizations.inviteCode,
        // used by /api/v1/orgs/join) looks the same as an agent invite code to
        // whoever is copying it, but only agent invites resolve here.
        const org = await getOrganizationByInviteCode(code);
        if (org) {
            return Response.json(
                {
                    error: "This is an organization invite code, not an agent invite code — it can't be used with `agent-guild join --code`.",
                    codeType: "organization",
                    dashboardUrl: "https://agent-guild.com/agents",
                },
                { status: 404 }
            );
        }
        return Response.json(
            { error: "Invite code not found", codeType: "unknown", dashboardUrl: "https://agent-guild.com/agents" },
            { status: 404 }
        );
    }

    return Response.json({
        orgId: invite.orgId,
        orgName: invite.orgName,
        agentName: invite.agentName,
        agentType: invite.agentType,
        skills: invite.skills,
        greeting: invite.greeting,
    });
}
