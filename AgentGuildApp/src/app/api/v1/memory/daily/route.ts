/**
 * GET  /api/v1/memory/daily?agent=&sig=&ts=&date=YYYY-MM-DD   (date optional, defaults to today UTC)
 * POST /api/v1/memory/daily?agent=&sig=&ts=   body: { entry, section?, date? }
 *
 * Agent-signed daily journal. GET is get-or-create for the given date;
 * POST appends an entry to that date's note.
 */
import { NextRequest } from "next/server";
import crypto from "crypto";
import { requireAgentAuthOrIdentityNftWallet } from "@/lib/auth-guard";
import { rateLimit } from "../../rate-limit";
import { getOrCreateDailyNote, appendDailyNote, isAllowedSection, ALLOWED_SECTIONS } from "@/lib/agent-memory-server";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const agentParam = sp.get("agent") || sp.get("agentId") || "";
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  const date = sp.get("date") || todayUTC();
  if (!DATE_RE.test(date)) {
    return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }

  const auth = await requireAgentAuthOrIdentityNftWallet(request, `GET:/v1/memory/daily:${agentParam}:${date}`, agentParam);
  if (!auth.ok || !auth.agent) {
    return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });
  }
  if (!auth.agent.orgId) {
    return Response.json({ error: "Agent has no organization" }, { status: 403 });
  }

  try {
    const doc = await getOrCreateDailyNote(auth.agent, date);
    return Response.json({ ok: true, content: doc.content, id: doc.id, date });
  } catch (err) {
    console.error("GET /v1/memory/daily error:", err);
    return Response.json({ error: "Failed to get daily note" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const agentParam = sp.get("agent") || sp.get("agentId") || "";
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  const rawBody = await request.text();
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");

  const auth = await requireAgentAuthOrIdentityNftWallet(request, `POST:/v1/memory/daily:${bodyHash}`, agentParam);
  if (!auth.ok || !auth.agent) {
    return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });
  }
  if (!auth.agent.orgId) {
    return Response.json({ error: "Agent has no organization" }, { status: 403 });
  }

  let body: { entry?: string; section?: string; date?: string };
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const date = body.date || todayUTC();
  if (!DATE_RE.test(date)) {
    return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  if (!body.entry) {
    return Response.json({ error: "entry is required" }, { status: 400 });
  }
  if (body.section && !isAllowedSection("daily_note", body.section)) {
    return Response.json(
      { error: `Invalid section. Must be one of: ${ALLOWED_SECTIONS.daily_note.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const doc = await appendDailyNote(auth.agent, date, body.entry, body.section);
    return Response.json({ ok: true, id: doc.id, content: doc.content, date, appended: true });
  } catch (err) {
    console.error("POST /v1/memory/daily error:", err);
    return Response.json({ error: "Failed to append to daily note" }, { status: 500 });
  }
}
