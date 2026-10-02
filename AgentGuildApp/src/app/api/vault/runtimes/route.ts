/**
 * GET  /api/vault/runtimes?orgId=   — connected runtimes
 * POST /api/vault/runtimes          — { orgId, computerId, agentId, scopes?, bindings? } (org owner)
 *
 * Connects a compute machine to the vault (see lib/vault/runtimes.ts). If the
 * machine is running, the install command is pushed through the provider's
 * bash action; the response always includes it too, for pasting by hand.
 */
import { NextRequest } from "next/server";
import { connectRuntime, listRuntimes, installCommand } from "@/lib/vault/runtimes";
import { parseScopes } from "@/lib/agent-tokens";
import { appendAudit } from "@/lib/vault/store";
import { vaultAuth, vaultErrorResponse, readJson } from "@/lib/vault/http";
import { getComputer } from "@/lib/compute/firestore";
import { getComputeProvider } from "@/lib/compute/provider";

function hubUrl(req: NextRequest) {
  return (process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin).replace(/\/+$/, "");
}

export async function GET(req: NextRequest) {
  const auth = await vaultAuth(req, req.nextUrl.searchParams.get("orgId"), "member");
  if (!auth.ok) return auth.response;
  try {
    return Response.json({ runtimes: await listRuntimes(auth.orgId) });
  } catch (err) {
    return vaultErrorResponse(err, "list runtimes");
  }
}

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  const auth = await vaultAuth(req, body.orgId as string, "admin");
  if (!auth.ok) return auth.response;

  const scopes = parseScopes(body.scopes);
  if (typeof scopes === "string") return Response.json({ error: scopes }, { status: 400 });
  const bindings = Array.isArray(body.bindings) ? body.bindings.map(String).filter(Boolean) : undefined;
  const computerId = String(body.computerId || "");
  const agentId = String(body.agentId || "");

  try {
    const { enrollCode } = await connectRuntime({ orgId: auth.orgId, computerId, agentId, scopes, bindings, createdBy: auth.actor });
    const command = installCommand(hubUrl(req), enrollCode);

    let pushed = false;
    let pushError: string | null = null;
    const computer = await getComputer(computerId);
    if (computer?.status === "running" && computer.providerInstanceId) {
      try {
        const result = await getComputeProvider(computer.provider).executeAction(computer.providerInstanceId, {
          actionType: "bash",
          targetComputerId: computerId,
          sessionId: "vault-runtime-connect",
          actorType: "system",
          actorId: auth.actor,
          payload: { command },
          timeoutMs: 120_000,
          idempotencyKey: `vault-runtime-${computerId}-${Date.now()}`,
        });
        pushed = result.success;
        if (!result.success) pushError = (result.error || "install command failed").slice(0, 300);
      } catch (err) {
        pushError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      }
    } else {
      pushError = "Computer isn't running — run the install command on it once it is.";
    }

    await appendAudit({
      orgId: auth.orgId, action: "runtime.connected", actorType: "user", actorId: auth.actor, target: computerId,
      detail: { agentId, scopes: scopes.join(","), bindings: bindings?.join(",") || "all", pushed },
    });
    return Response.json({ ok: true, pushed, pushError, installCommand: command }, { status: 201 });
  } catch (err) {
    return vaultErrorResponse(err, "connect runtime");
  }
}
