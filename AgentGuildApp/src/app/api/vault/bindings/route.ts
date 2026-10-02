/**
 * GET  /api/vault/bindings?orgId=  — list bindings
 * POST /api/vault/bindings         — { orgId, name, secretId, baseUrl, auth, allowedMethods?, allowedPaths?, agentIds, maxCallsPerHour?, description? } (org owner)
 */
import { NextRequest } from "next/server";
import { createBinding, listBindings, appendAudit } from "@/lib/vault/store";
import { validateBindingInput } from "@/lib/vault/policy";
import { insecureEgressAllowed } from "@/lib/vault/egress";
import { vaultAuth, vaultErrorResponse, readJson } from "@/lib/vault/http";

export async function GET(req: NextRequest) {
  const auth = await vaultAuth(req, req.nextUrl.searchParams.get("orgId"), "member");
  if (!auth.ok) return auth.response;
  try {
    return Response.json({ bindings: await listBindings(auth.orgId) });
  } catch (err) {
    return vaultErrorResponse(err, "list bindings");
  }
}

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  const auth = await vaultAuth(req, body.orgId as string, "admin");
  if (!auth.ok) return auth.response;
  const parsed = validateBindingInput(body, insecureEgressAllowed());
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  try {
    const id = await createBinding(auth.orgId, parsed.value, auth.actor);
    await appendAudit({
      orgId: auth.orgId, action: "binding.created", actorType: "user", actorId: auth.actor, target: parsed.value.name,
      detail: { baseUrl: parsed.value.baseUrl, methods: parsed.value.allowedMethods.join(","), agents: parsed.value.agentIds.join(",") },
    });
    return Response.json({ ok: true, id }, { status: 201 });
  } catch (err) {
    return vaultErrorResponse(err, "create binding");
  }
}
