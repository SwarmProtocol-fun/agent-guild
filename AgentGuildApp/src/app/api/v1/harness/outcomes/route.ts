/**
 * POST /api/v1/harness/outcomes?agent=&sig=&ts=
 *      signed message: "POST:/v1/harness/outcomes:<sha256(body)>:<ts>"
 *      body: { outcomes: [{ generation, ok, detail? }] }   (at most 50)
 *
 * The daemon batches its reply results here (did the runtime produce a reply
 * that was delivered?). Self-reported, so they count for less than a buyer's
 * verdict when a generation is scored, and outcomes for generations that
 * were never live are dropped.
 */
import { NextRequest } from "next/server";
import crypto from "crypto";
import { requireAgentAuth } from "@/lib/auth-guard";
import { rateLimit } from "../../rate-limit";
import { parseOutcomes } from "@/lib/harness";
import { recordReplyOutcomes } from "@/lib/harness-store";

export async function POST(request: NextRequest) {
  const agentParam = request.nextUrl.searchParams.get("agent") || "";
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  const rawBody = await request.text();
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const auth = await requireAgentAuth(request, `POST:/v1/harness/outcomes:${bodyHash}`);
  if (!auth.ok || !auth.agent) return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseOutcomes(body, Date.now());
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  try {
    const recorded = await recordReplyOutcomes(auth.agent.agentId, parsed.outcomes);
    return Response.json({ ok: true, recorded, dropped: parsed.outcomes.length - recorded });
  } catch (err) {
    console.error("POST /v1/harness/outcomes error:", err);
    return Response.json({ error: "Failed to record outcomes" }, { status: 500 });
  }
}
