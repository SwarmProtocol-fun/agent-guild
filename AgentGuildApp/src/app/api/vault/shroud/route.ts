/**
 * GET /api/vault/shroud?orgId=   — LLM proxy settings + recent events (org member)
 * PUT /api/vault/shroud          — { orgId, ...ShroudConfig } (org owner)
 */
import { NextRequest } from "next/server";
import { getShroudConfig, saveShroudConfig, validateShroudConfig, listShroudEvents } from "@/lib/shroud/config";
import { listSecrets, appendAudit } from "@/lib/vault/store";
import { vaultAuth, vaultErrorResponse, readJson } from "@/lib/vault/http";

export async function GET(req: NextRequest) {
  const auth = await vaultAuth(req, req.nextUrl.searchParams.get("orgId"), "member");
  if (!auth.ok) return auth.response;
  try {
    const [config, events] = await Promise.all([getShroudConfig(auth.orgId), listShroudEvents(auth.orgId, 100)]);
    return Response.json({ config, events });
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
