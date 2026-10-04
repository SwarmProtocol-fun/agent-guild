/**
 * GET    /api/v1/identity-vault/:slot?agent=&sig=&ts=
 *        signed message: "GET:/v1/identity-vault/<slot>:<agentId>:<ts>"
 * PUT    /api/v1/identity-vault/:slot?agent=&sig=&ts=
 *        signed message: "PUT:/v1/identity-vault/<slot>:<sha256(body)>:<ts>"
 *        body: { v:2, ciphertext, nonce, wraps:{ protocol, agent, user } }
 * DELETE /api/v1/identity-vault/:slot?agent=&sig=&ts=
 *        signed message: "DELETE:/v1/identity-vault/<slot>:<agentId>:<ts>"
 *
 * The hub stores the three wraps and does not decrypt. Protocol, agent,
 * and user copies have to still sit with their holders or these routes refuse.
 */
import crypto from "crypto";
import { NextRequest } from "next/server";
import { requireAgentAuth } from "@/lib/auth-guard";
import {
  deleteIdentityVault, getIdentityVault, parseVaultSlot, putIdentityVault, unlockIdentityVault, VaultError,
} from "@/lib/identity-vault";
import { rateLimit } from "../../rate-limit";

async function authed(req: NextRequest, slot: string, prefix: string) {
  const agentParam = req.nextUrl.searchParams.get("agent") || req.nextUrl.searchParams.get("agentId") || "";
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return { response: limited };
  const name = parseVaultSlot(slot);
  const auth = await requireAgentAuth(req, prefix);
  if (!auth.ok || !auth.agent) return { response: Response.json({ error: auth.error || "Unauthorized" }, { status: 401 }) };
  const unlocked = await unlockIdentityVault(auth.agent.agentId);
  return { name, agentId: auth.agent.agentId, orgId: unlocked.orgId, recipients: unlocked.recipients };
}

function failed(err: unknown): Response {
  if (err instanceof VaultError) return Response.json({ error: err.message }, { status: err.status });
  console.error("identity-vault error:", err);
  return Response.json({ error: "Identity vault request failed" }, { status: 500 });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ slot: string }> }) {
  try {
    const { slot } = await params;
    const agentParam = req.nextUrl.searchParams.get("agent") || "";
    const gate = await authed(req, slot, `GET:/v1/identity-vault/${slot}:${agentParam}`);
    if ("response" in gate && gate.response) return gate.response;
    const box = await getIdentityVault(gate.agentId!, gate.name!);
    if (!box) return Response.json({ error: "No entry in that slot" }, { status: 404 });
    return Response.json(box);
  } catch (err) {
    return failed(err);
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ slot: string }> }) {
  try {
    const { slot } = await params;
    const raw = await req.text();
    const bodyHash = crypto.createHash("sha256").update(raw).digest("hex");
    const gate = await authed(req, slot, `PUT:/v1/identity-vault/${slot}:${bodyHash}`);
    if ("response" in gate && gate.response) return gate.response;
    const body = JSON.parse(raw || "{}");
    await putIdentityVault(gate.agentId!, gate.orgId!, gate.name!, body, gate.recipients!);
    return Response.json({ ok: true, slot: gate.name });
  } catch (err) {
    if (err instanceof SyntaxError) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    return failed(err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ slot: string }> }) {
  try {
    const { slot } = await params;
    const agentParam = req.nextUrl.searchParams.get("agent") || "";
    const gate = await authed(req, slot, `DELETE:/v1/identity-vault/${slot}:${agentParam}`);
    if ("response" in gate && gate.response) return gate.response;
    const removed = await deleteIdentityVault(gate.agentId!, gate.name!);
    if (!removed) return Response.json({ error: "No entry in that slot" }, { status: 404 });
    return Response.json({ ok: true, slot: gate.name });
  } catch (err) {
    return failed(err);
  }
}
