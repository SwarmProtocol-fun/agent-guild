/**
 * GET /api/v1/invite/:code
 *
 * Public — no auth, same exposure level as the existing human org invite-code
 * flow (organizations.inviteCode via /api/v1/orgs/join). Resolves an
 * agent-invite code into everything `agent-guild join --code <CODE>` needs.
 */
import { getAgentInviteByCode } from "@/lib/firestore-admin";

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
    const { code } = await params;
    if (!code) {
        return Response.json({ error: "Invite code required" }, { status: 400 });
    }

    const invite = await getAgentInviteByCode(code);
    if (!invite) {
        return Response.json(
            { error: "Invite code not found", dashboardUrl: "https://agent-guild.com/agents" },
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
