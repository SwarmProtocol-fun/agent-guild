/**
 * GET  /api/v1/harness?agent=&sig=&ts=   — this agent's live playbook (SIA-style harness)
 *      signed message: "GET:/v1/harness:<agentId>:<ts>"
 * POST /api/v1/harness?agent=&sig=&ts=   — propose the next generation
 *      signed message: "POST:/v1/harness:<sha256(body)>:<ts>"
 *      body: { playbook, improvement, parentGeneration? }
 *
 * The daemon reads GET on a timer and injects the playbook into every reply.
 * A proposal never goes live by itself: it waits for the org owner to
 * approve it on the agent's Harness tab (/api/agents/:id/harness).
 */
import { NextRequest } from "next/server";
import crypto from "crypto";
import { requireAgentAuth } from "@/lib/auth-guard";
import { rateLimit } from "../rate-limit";
import { parseProposal } from "@/lib/harness";
import { getActiveGeneration, HarnessError, listGenerations, proposeGeneration } from "@/lib/harness-store";

export async function GET(request: NextRequest) {
  const agentParam = request.nextUrl.searchParams.get("agent") || request.nextUrl.searchParams.get("agentId") || "";
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  const auth = await requireAgentAuth(request, `GET:/v1/harness:${agentParam}`);
  if (!auth.ok || !auth.agent) return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });

  try {
    const [active, generations] = await Promise.all([
      getActiveGeneration(auth.agent.agentId),
      listGenerations(auth.agent.agentId),
    ]);
    const pending = generations.find((g) => g.status === "proposed");
    return Response.json({
      ok: true,
      active: active ? { generation: active.generation, playbook: active.playbook, activatedAt: active.activatedAt } : null,
      pendingGeneration: pending?.generation ?? null,
    });
  } catch (err) {
    console.error("GET /v1/harness error:", err);
    return Response.json({ error: "Failed to load harness" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const agentParam = request.nextUrl.searchParams.get("agent") || "";
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  // The signature covers the body, so a captured signature can't carry a
  // different playbook.
  const rawBody = await request.text();
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const auth = await requireAgentAuth(request, `POST:/v1/harness:${bodyHash}`);
  if (!auth.ok || !auth.agent) return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });
  if (!auth.agent.orgId) return Response.json({ error: "Agent has no organization" }, { status: 403 });

  let body: unknown;
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseProposal(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  try {
    const generation = await proposeGeneration(
      { agentId: auth.agent.agentId, orgId: auth.agent.orgId },
      parsed,
      "agent",
    );
    return Response.json(
      { ok: true, generation: generation.generation, status: generation.status, parentGeneration: generation.parentGeneration },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof HarnessError) return Response.json({ error: err.message }, { status: err.status });
    console.error("POST /v1/harness error:", err);
    return Response.json({ error: "Failed to propose generation" }, { status: 500 });
  }
}
