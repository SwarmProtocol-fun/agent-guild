/**
 * POST /api/v1/memory/append?agent=&sig=&ts=   (or ?agentId=&apiKey=)
 * body: { entry, section? }
 *
 * Agent-signed append to long-term memory (MEMORY.md).
 */
import { NextRequest } from "next/server";
import crypto from "crypto";
import { requireAgentAuthOrIdentityNftWallet } from "@/lib/auth-guard";
import { rateLimit } from "../../rate-limit";
import { appendMemoryMd, isAllowedSection, ALLOWED_SECTIONS } from "@/lib/agent-memory-server";

export async function POST(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const agentParam = sp.get("agent") || sp.get("agentId") || "";
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  const rawBody = await request.text();
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");

  const auth = await requireAgentAuthOrIdentityNftWallet(request, `POST:/v1/memory/append:${bodyHash}`, agentParam);
  if (!auth.ok || !auth.agent) {
    return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });
  }
  if (!auth.agent.orgId) {
    return Response.json({ error: "Agent has no organization" }, { status: 403 });
  }

  let body: { entry?: string; section?: string };
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.entry) {
    return Response.json({ error: "entry is required" }, { status: 400 });
  }
  if (body.section && !isAllowedSection("memory_md", body.section)) {
    return Response.json(
      { error: `Invalid section. Must be one of: ${ALLOWED_SECTIONS.memory_md.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const doc = await appendMemoryMd(auth.agent, body.entry, body.section);
    return Response.json({ ok: true, id: doc.id, content: doc.content, appended: true });
  } catch (err) {
    console.error("POST /v1/memory/append error:", err);
    return Response.json({ error: "Failed to append to memory" }, { status: 500 });
  }
}
