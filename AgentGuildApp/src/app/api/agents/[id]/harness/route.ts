/**
 * GET  /api/agents/:id/harness — the agent's playbook lineage with scores (org members)
 * POST /api/agents/:id/harness — owner decisions (org owner only)
 *      { action: "approve" | "rollback", generation }   make that generation live
 *      { action: "reject", generation }                  discard a proposal
 *      { action: "disable" }                             back to the runtime's default prompt
 *      { action: "edit", playbook, improvement }         file the owner's own generation (still needs approve)
 *
 * Auth: session (x-wallet-address, set by middleware from the session cookie).
 */
import { NextRequest } from "next/server";
import { requireOrgAdmin, requireOrgMember } from "@/lib/auth-guard";
import { getAgent } from "@/lib/firestore-admin";
import { analyzeLineage, parseProposal } from "@/lib/harness";
import {
  activateGeneration,
  deactivate,
  HarnessError,
  listGenerations,
  listJobOutcomes,
  listReplyOutcomes,
  proposeGeneration,
  rejectGeneration,
} from "@/lib/harness-store";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
  const auth = await requireOrgMember(req, agent.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status ?? 403 });

  try {
    const [generations, jobs, replies] = await Promise.all([
      listGenerations(id),
      listJobOutcomes(id),
      listReplyOutcomes(id),
    ]);
    const isOwner = (await requireOrgAdmin(req, agent.orgId)).ok;
    return Response.json({ ok: true, generations, analysis: analyzeLineage(generations, jobs, replies), isOwner });
  } catch (err) {
    console.error("GET /api/agents/[id]/harness error:", err);
    return Response.json({ error: "Failed to load harness" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
  const auth = await requireOrgAdmin(req, agent.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status ?? 403 });
  const owner = auth.walletAddress!;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = body?.action;
  const generation = body?.generation;
  const needsGeneration = action === "approve" || action === "rollback" || action === "reject";
  if (needsGeneration && !(typeof generation === "number" && Number.isInteger(generation))) {
    return Response.json({ error: "generation is required" }, { status: 400 });
  }

  try {
    if (action === "approve" || action === "rollback") {
      await activateGeneration(id, generation as number, owner);
    } else if (action === "reject") {
      await rejectGeneration(id, generation as number, owner);
    } else if (action === "disable") {
      await deactivate(id);
    } else if (action === "edit") {
      const parsed = parseProposal(body);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
      const g = await proposeGeneration({ agentId: id, orgId: agent.orgId }, parsed, "owner", owner);
      return Response.json({ ok: true, generation: g.generation }, { status: 201 });
    } else {
      return Response.json({ error: "action must be approve, rollback, reject, disable, or edit" }, { status: 400 });
    }
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof HarnessError) return Response.json({ error: err.message }, { status: err.status });
    console.error("POST /api/agents/[id]/harness error:", err);
    return Response.json({ error: "Failed to update harness" }, { status: 500 });
  }
}
