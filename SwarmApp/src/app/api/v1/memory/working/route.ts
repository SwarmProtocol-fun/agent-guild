/**
 * GET  /api/v1/memory/working?agent=&sig=&ts=   (or ?agentId=&apiKey=)
 * PUT  /api/v1/memory/working?agent=&sig=&ts=   body: { content, section? }
 *
 * Agent-signed working memory (WORKING.md). The agent's identity comes
 * entirely from requireAgentAuth (Ed25519 or API key) — there is no
 * agentId path param, so there's no separate "does this agent own this
 * memory" check to get wrong.
 */
import { NextRequest } from "next/server";
import crypto from "crypto";
import { requireAgentAuth } from "@/lib/auth-guard";
import { rateLimit } from "../../rate-limit";
import { getOrCreateWorkingMd, updateWorkingMd, isAllowedSection, ALLOWED_SECTIONS } from "@/lib/agent-memory-server";

function agentParamOf(request: NextRequest): string {
  const sp = request.nextUrl.searchParams;
  return sp.get("agent") || sp.get("agentId") || "";
}

export async function GET(request: NextRequest) {
  const agentParam = agentParamOf(request);
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  const auth = await requireAgentAuth(request, `GET:/v1/memory/working:${agentParam}`);
  if (!auth.ok || !auth.agent) {
    return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });
  }
  if (!auth.agent.orgId) {
    return Response.json({ error: "Agent has no organization" }, { status: 403 });
  }

  try {
    const doc = await getOrCreateWorkingMd(auth.agent);
    return Response.json({ ok: true, content: doc.content, id: doc.id, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error("GET /v1/memory/working error:", err);
    return Response.json({ error: "Failed to get working memory" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const agentParam = agentParamOf(request);
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  const rawBody = await request.text();
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");

  const auth = await requireAgentAuth(request, `PUT:/v1/memory/working:${bodyHash}`);
  if (!auth.ok || !auth.agent) {
    return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });
  }
  if (!auth.agent.orgId) {
    return Response.json({ error: "Agent has no organization" }, { status: 403 });
  }

  let body: { content?: string; section?: string };
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.content) {
    return Response.json({ error: "content is required" }, { status: 400 });
  }
  if (body.section && !isAllowedSection("working_md", body.section)) {
    return Response.json(
      { error: `Invalid section. Must be one of: ${ALLOWED_SECTIONS.working_md.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const doc = await updateWorkingMd(auth.agent, body.content, body.section);
    return Response.json({ ok: true, content: doc.content });
  } catch (err) {
    console.error("PUT /v1/memory/working error:", err);
    return Response.json({ error: "Failed to update working memory" }, { status: 500 });
  }
}
