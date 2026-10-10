/**
 * POST /api/v1/orgs/:orgId/agent-registrations
 *
 * Org-owner-only. Mints a single-use, 24h setup token authorizing one agent
 * key binding (see lib/agent-registration-grants.ts) — the dashboard puts it
 * in the setup prompt as `--token`.
 *
 * Body: { agentId }   — bind to an agent the dashboard already reserved
 *     | { agentName } — mint a brand-new identity with this name
 * Returns: { token, expiresAt, agentId?, agentName }
 */
import { NextRequest } from "next/server";
import { requireOrgAdmin } from "@/lib/auth-guard";
import { adminDb } from "@/lib/firebase-admin";
import { issueSetupToken } from "@/lib/agent-registration-grants";

export async function POST(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
    const { orgId } = await params;
    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const auth = await requireOrgAdmin(req, orgId);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

    const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : undefined;
    let agentName = typeof body.agentName === "string" ? body.agentName.trim() : "";

    if (agentId) {
        const snap = await adminDb().collection("agents").doc(agentId).get();
        const data = snap.data();
        if (!snap.exists || (data!.orgId !== orgId && data!.organizationId !== orgId)) {
            return Response.json({ error: "Agent not found in this organization" }, { status: 404 });
        }
        if (data!.retiredAt != null) {
            return Response.json({ error: "This agent is retired", code: "AGENT_RETIRED" }, { status: 409 });
        }
        agentName = data!.name;
    }
    if (!agentName) return Response.json({ error: "agentId or agentName is required" }, { status: 400 });

    const { token, expiresAt } = await issueSetupToken({ orgId, agentName, agentId, issuedBy: auth.walletAddress! });
    return Response.json({ token, expiresAt, agentId, agentName });
}
