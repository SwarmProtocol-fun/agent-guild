/**
 * Run an agent's request through a binding: the agent names the binding and
 * describes the call; the server checks policy, decrypts the secret, injects
 * it, makes the call, scrubs the secret out of the response, and records the
 * call in the org's audit chain. The secret never reaches the agent.
 */

import { agentMayUse, auditUrl, buildUpstreamRequest, filterResponseHeaders, redact, type ExecuteRequest } from "./policy";
import { sendUpstream } from "./egress";
import { auditQuietly, getBindingByName, reserveCall, useSecretValue, VaultError } from "./store";

export interface CallingAgent {
  agentId: string;
  agentName: string;
  orgId: string;
  /** Set when the caller used a token restricted to specific bindings. */
  allowedBindings?: string[];
}

export interface ExecuteResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  durationMs: number;
}

export async function executeBinding(agent: CallingAgent, req: ExecuteRequest): Promise<ExecuteResult> {
  const denied = (target: string, reason: string, status = 403): never => {
    auditQuietly({ orgId: agent.orgId, action: "binding.denied", actorType: "agent", actorId: agent.agentId, target, detail: { reason } });
    throw new VaultError(reason, status);
  };

  const name = String(req.binding || "");
  if (agent.allowedBindings && !agent.allowedBindings.includes(name)) {
    return denied(name, `This token is not valid for binding "${name}"`);
  }
  const b = await getBindingByName(agent.orgId, name);
  if (!b) return denied(name, `No binding named "${name}" in this org`, 404);
  if (!agentMayUse(b, agent.agentId)) {
    return denied(name, b.revoked ? `Binding "${name}" is revoked` : `This agent is not allowed to use binding "${name}"`);
  }

  // Validate the request shape before touching the secret or the rate budget.
  const dryRun = buildUpstreamRequest(b, req, "x".repeat(32));
  if (!dryRun.ok) return denied(name, dryRun.error, 400);

  if (!(await reserveCall(b))) return denied(name, `Binding "${name}" hit its limit of ${b.maxCallsPerHour} calls/hour`, 429);

  const secret = await useSecretValue(b.orgId, b.secretId);
  const built = buildUpstreamRequest(b, req, secret);
  if (!built.ok) return denied(name, built.error, 400); // unreachable in practice — same checks as the dry run
  const upstream = built.value;

  const started = Date.now();
  try {
    const res = await sendUpstream(upstream);
    const durationMs = Date.now() - started;
    auditQuietly({
      orgId: b.orgId,
      action: "binding.executed",
      actorType: "agent",
      actorId: agent.agentId,
      target: b.name,
      detail: { method: upstream.method, url: auditUrl(upstream.url, b.auth), status: res.status, durationMs },
    });
    return {
      status: res.status,
      headers: filterResponseHeaders(res.headers, secret),
      body: redact(res.body, secret),
      truncated: res.truncated,
      durationMs,
    };
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err), secret);
    auditQuietly({
      orgId: b.orgId,
      action: "binding.executed",
      actorType: "agent",
      actorId: agent.agentId,
      target: b.name,
      detail: { method: upstream.method, url: auditUrl(upstream.url, b.auth), status: 0, error: message.slice(0, 200) },
    });
    throw new VaultError(`Upstream request failed: ${message}`, 502);
  }
}
