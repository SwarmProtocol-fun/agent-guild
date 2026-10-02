/**
 * POST /api/v1/intents?agent=&sig=&ts=   signed `POST:/v1/intents:<sha256(body)>:<ts>`
 *   or `Authorization: Bearer agt_…` with the intents:submit scope
 * body: { walletId, type: "transfer", network, asset: "native"|"usdc", to, amount, memo? }
 *    or { walletId, type: "evm_call", network, to, data, value?, memo? }
 *
 * GET /api/v1/intents?agent=&sig=&ts=    signed `GET:/v1/intents:<ts>` — this agent's last 50 intents
 *
 * The agent asks; the server checks the wallet's policy, simulates, signs
 * with the custodial key it already holds, and broadcasts (lib/intents).
 */
import { NextRequest } from "next/server";
import crypto from "crypto";
import { adminDb } from "@/lib/firebase-admin";
import { requireAgentOrToken } from "@/lib/agent-request-auth";
import { submitIntent, IntentError } from "@/lib/intents/execute";
import { rateLimit } from "../rate-limit";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const limited = await rateLimit(`intents:${request.nextUrl.searchParams.get("agent") || "token"}`);
  if (limited) return limited;
  const rawBody = await request.text();
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const auth = await requireAgentOrToken(request, `POST:/v1/intents:${bodyHash}`, "intents:submit");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.agent.orgId) return Response.json({ error: "Agent has no organization" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.walletId) return Response.json({ error: "walletId is required" }, { status: 400 });

  try {
    const result = await submitIntent(auth.agent, String(body.walletId), body);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof IntentError) return Response.json({ error: err.message }, { status: err.status });
    console.error("[intents] submit failed:", err);
    return Response.json({ error: "Intent failed" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const limited = await rateLimit(`intents:${request.nextUrl.searchParams.get("agent") || "token"}`);
  if (limited) return limited;
  const auth = await requireAgentOrToken(request, "GET:/v1/intents", "intents:submit");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const snap = await adminDb().collection("intents").where("agentId", "==", auth.agent.agentId).orderBy("createdAt", "desc").limit(50).get();
  return Response.json({
    intents: snap.docs.map((d) => {
      const x = d.data();
      return { id: d.id, walletId: x.walletId, request: x.request, status: x.status, error: x.error ?? null, txHash: x.txHash ?? null, explorerUrl: x.explorerUrl ?? null, createdAt: x.createdAt?.toMillis?.() ?? null };
    }),
  });
}
