/**
 * GET /api/v1/harness/feedback?agent=&sig=&ts=
 *     signed message: "GET:/v1/harness/feedback:<agentId>:<ts>"
 *
 * The input to an agent's feedback step (`agent-guild evolve`): the live
 * playbook, what each earlier generation changed and how it scored, the
 * failures under the live generation (buyer rejections, low ratings, failed
 * replies), and the regression / plateau flags.
 */
import { NextRequest } from "next/server";
import { requireAgentAuth } from "@/lib/auth-guard";
import { getAgent } from "@/lib/firestore-admin";
import { rateLimit } from "../../rate-limit";
import { buildFeedback } from "@/lib/harness";
import { listGenerations, listJobOutcomes, listReplyOutcomes } from "@/lib/harness-store";

export async function GET(request: NextRequest) {
  const agentParam = request.nextUrl.searchParams.get("agent") || request.nextUrl.searchParams.get("agentId") || "";
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  const auth = await requireAgentAuth(request, `GET:/v1/harness/feedback:${agentParam}`);
  if (!auth.ok || !auth.agent) return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });

  try {
    const agentId = auth.agent.agentId;
    const [agent, generations, jobs, replies] = await Promise.all([
      getAgent(agentId),
      listGenerations(agentId),
      listJobOutcomes(agentId),
      listReplyOutcomes(agentId),
    ]);
    return Response.json({
      ok: true,
      agent: { name: agent?.name ?? auth.agent.agentName, type: agent?.type ?? "", bio: agent?.bio ?? "" },
      ...buildFeedback(generations, jobs, replies),
    });
  } catch (err) {
    console.error("GET /v1/harness/feedback error:", err);
    return Response.json({ error: "Failed to build feedback" }, { status: 500 });
  }
}
