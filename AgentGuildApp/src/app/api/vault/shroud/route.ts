/**
 * GET  /api/vault/shroud?orgId=   — LLM proxy settings, recent events, halted agents (org member)
 * PUT  /api/vault/shroud          — { orgId, ...ShroudConfig } (org owner)
 * POST /api/vault/shroud          — kill switch: { orgId, action: "halt" | "resume", agentId, reason? } (org admin)
 */
import { NextRequest } from "next/server";
import {
  getShroudConfig, saveShroudConfig, validateShroudConfig, listShroudEvents, listHalts, haltAgent, resumeAgent,
} from "@/lib/shroud/config";
import { getAgent } from "@/lib/firestore-admin";
import { listSecrets, appendAudit } from "@/lib/vault/store";
import { vaultAuth, vaultErrorResponse, readJson } from "@/lib/vault/http";

export async function GET(req: NextRequest) {
  const auth = await vaultAuth(req, req.nextUrl.searchParams.get("orgId"), "member");
  if (!auth.ok) return auth.response;
  try {
    const [config, events, halts] = await Promise.all([getShroudConfig(auth.orgId), listShroudEvents(auth.orgId, 100), listHalts(auth.orgId)]);
    return Response.json({ config, events, halts });
  } catch (err) {
    return vaultErrorResponse(err, "get shroud");
  }
}

export async function PUT(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  const auth = await vaultAuth(req, body.orgId as string, "admin");
  if (!auth.ok) return auth.response;
  const config = validateShroudConfig(body);
  if (typeof config === "string") return Response.json({ error: config }, { status: 400 });
  try {
    const ownSecrets = new Set((await listSecrets(auth.orgId)).map((s) => s.id));
    for (const [provider, id] of Object.entries(config.providerSecrets)) {
      if (!ownSecrets.has(id!)) return Response.json({ error: `The ${provider} key must be a secret in this org's vault` }, { status: 400 });
    }
    if (config.enabled && !Object.keys(config.providerSecrets).length) {
      return Response.json({ error: "Pick at least one provider key before turning the proxy on" }, { status: 400 });
    }
    await saveShroudConfig(auth.orgId, config, auth.actor);
    await appendAudit({
      orgId: auth.orgId, action: "shroud.configured", actorType: "user", actorId: auth.actor, target: "llm-proxy",
      detail: { enabled: config.enabled, action: config.injectionAction, threshold: config.injectionThreshold },
    });
    return Response.json({ ok: true, config });
  } catch (err) {
    return vaultErrorResponse(err, "save shroud");
  }
}

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  const auth = await vaultAuth(req, body.orgId as string, "admin");
  if (!auth.ok) return auth.response;
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (!agentId) return Response.json({ error: "agentId is required" }, { status: 400 });
  try {
    if (body.action === "halt") {
      const agent = await getAgent(agentId);
      if (!agent || agent.orgId !== auth.orgId) return Response.json({ error: "Agent not found in this organization" }, { status: 404 });
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "halted by an org admin";
      const halt = await haltAgent(auth.orgId, agentId, reason, auth.actor);
      await appendAudit({ orgId: auth.orgId, action: "shroud.halted", actorType: "user", actorId: auth.actor, target: agentId, detail: { reason: halt.reason } });
      return Response.json({ ok: true, halt });
    }
    if (body.action === "resume") {
      if (!(await resumeAgent(auth.orgId, agentId))) return Response.json({ error: "That agent is not halted" }, { status: 404 });
      await appendAudit({ orgId: auth.orgId, action: "shroud.resumed", actorType: "user", actorId: auth.actor, target: agentId });
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'action must be "halt" or "resume"' }, { status: 400 });
  } catch (err) {
    return vaultErrorResponse(err, "shroud kill switch");
  }
}
