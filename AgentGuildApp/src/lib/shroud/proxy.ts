/**
 * Shroud — the LLM proxy. Agents point an Anthropic or OpenAI SDK at
 *   https://agent-guild.com/api/v1/shroud/anthropic      (Messages API)
 *   https://agent-guild.com/api/v1/shroud/openai/v1      (Chat Completions)
 * with an agt_ token (llm:proxy scope) as the API key. Shroud enforces the
 * org's policy, inspects and redacts the request, swaps in the org's real
 * provider key from the vault, forwards to the fixed provider host, and
 * cleans the response.
 *
 * Streaming responses are passed through as they arrive (usage is still
 * counted); response *content* inspection applies to non-streaming calls only.
 * Prompt and completion text is never stored — only scores, signal names and
 * token counts.
 */

import { bearerToken, verifyAgentToken, TOKEN_PREFIX } from "@/lib/agent-tokens";
import { useSecretValue, auditQuietly } from "@/lib/vault/store";
import { inspectRequest, inspectResponseText, type Provider, type Signal } from "./inspect";
import { getShroudConfig, tokensUsedToday, addTokensUsed, recordShroudEvent } from "./config";

const UPSTREAM: Record<Provider, string> = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
};

/** Errors in each provider's own shape, so SDKs surface the message properly. */
function providerError(provider: Provider, status: number, message: string, type = "invalid_request_error") {
  const body = provider === "anthropic"
    ? { type: "error", error: { type, message } }
    : { error: { message, type, code: null, param: null } };
  return Response.json(body, { status });
}

function tokenFrom(req: Request): string | null {
  const viaHeader = req.headers.get("x-api-key");
  if (viaHeader?.startsWith(TOKEN_PREFIX)) return viaHeader;
  return bearerToken(req.headers);
}

const signalNames = (s: Signal[]) => [...new Set(s.map((x) => `${x.kind}:${x.detail}`))].slice(0, 20);

/** HTTP header values must be ASCII; signal details can echo hostnames or text from the model. */
const headerSafe = (v: string) => v.replace(/[^\x20-\x7e]/g, "?").slice(0, 500);

export async function handleShroud(provider: Provider, req: Request): Promise<Response> {
  const started = Date.now();

  const token = tokenFrom(req);
  if (!token) return providerError(provider, 401, "Use an Agent Guild token (agt_…) with the llm:proxy scope as the API key", "authentication_error");
  const claims = await verifyAgentToken(token);
  if (!claims) return providerError(provider, 401, "Invalid, expired or revoked Agent Guild token", "authentication_error");
  if (!claims.scopes.includes("llm:proxy")) return providerError(provider, 403, "This token lacks the llm:proxy scope", "permission_error");

  const config = await getShroudConfig(claims.orgId);
  if (!config.enabled) return providerError(provider, 403, "The LLM proxy is turned off for this organization", "permission_error");
  const secretId = config.providerSecrets[provider];
  if (!secretId) return providerError(provider, 400, `No ${provider} key is configured for the LLM proxy`);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return providerError(provider, 400, "Request body must be JSON");
  }
  const model = String(body.model || "");
  if (config.allowedModels.length && !config.allowedModels.includes(model)) {
    return providerError(provider, 403, `Model ${model || "(none)"} is not allowed. Allowed: ${config.allowedModels.join(", ")}`, "permission_error");
  }

  if (config.maxTokensPerRequest) {
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      if (typeof body[key] === "number" && (body[key] as number) > config.maxTokensPerRequest) body[key] = config.maxTokensPerRequest;
    }
    if (provider === "anthropic" && body.max_tokens === undefined) body.max_tokens = config.maxTokensPerRequest;
  }

  if (config.dailyTokenBudgetPerAgent && (await tokensUsedToday(claims.agentId)) >= config.dailyTokenBudgetPerAgent) {
    return providerError(provider, 429, `Daily token budget of ${config.dailyTokenBudgetPerAgent} reached for this agent`, "rate_limit_error");
  }

  const stream = body.stream === true;
  if (stream && provider === "openai") {
    body.stream_options = { ...((body.stream_options as object) || {}), include_usage: true };
  }

  const inspection = inspectRequest(provider, body, config.blockedDomains);
  const event = {
    orgId: claims.orgId,
    agentId: claims.agentId,
    provider,
    model,
    stream,
    score: inspection.score,
    signals: signalNames(inspection.signals),
    redactions: inspection.redactions,
    responseSignals: [] as string[],
    blocked: false,
    status: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
  };

  if (inspection.score >= config.injectionThreshold && config.injectionAction === "block") {
    recordShroudEvent({ ...event, blocked: true, status: 400, latencyMs: Date.now() - started });
    auditQuietly({
      orgId: claims.orgId, action: "shroud.blocked", actorType: "agent", actorId: claims.agentId, target: provider,
      detail: { score: inspection.score, signals: event.signals.join(" | ").slice(0, 300) },
    });
    return providerError(provider, 400, `Blocked by Agent Guild Shroud (risk score ${inspection.score}): ${inspection.signals.map((s) => s.detail).join("; ")}`);
  }

  const apiKey = await useSecretValue(claims.orgId, secretId);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = req.headers.get("anthropic-version") || "2023-06-01";
    const beta = req.headers.get("anthropic-beta");
    if (beta) headers["anthropic-beta"] = beta;
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM[provider], { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" });
  } catch (err) {
    recordShroudEvent({ ...event, status: 502, latencyMs: Date.now() - started });
    return providerError(provider, 502, `Upstream ${provider} request failed: ${err instanceof Error ? err.message : String(err)}`, "api_error");
  }

  const flagHeader = {
    "x-agent-guild-shroud": `score=${inspection.score}; redactions=${inspection.redactions.length}${inspection.score >= config.injectionThreshold ? "; flagged" : ""}`,
  };

  // ── streaming: pass bytes through, count usage on the way ──
  if (stream && upstream.ok && upstream.body) {
    const usage = { input: 0, output: 0 };
    const decoder = new TextDecoder();
    let buffered = "";
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() || "";
        for (const line of lines) countUsage(provider, line, usage);
      },
      flush() {
        if (buffered) countUsage(provider, buffered, usage);
        addTokensUsed(claims.orgId, claims.agentId, usage.input + usage.output).catch(() => {});
        recordShroudEvent({ ...event, status: upstream.status, inputTokens: usage.input, outputTokens: usage.output, latencyMs: Date.now() - started });
      },
    });
    return new Response(upstream.body.pipeThrough(counter), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") || "text/event-stream", "cache-control": "no-cache", ...flagHeader },
    });
  }

  // ── non-streaming: inspect and clean the response ──
  const raw = await upstream.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw);
  } catch {
    recordShroudEvent({ ...event, status: upstream.status, latencyMs: Date.now() - started });
    return new Response(raw, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") || "text/plain", ...flagHeader } });
  }

  const responseSignals: Signal[] = [];
  for (const holder of responseTextHolders(provider, json)) {
    const cleaned = inspectResponseText(holder.get(), config.blockedDomains);
    if (cleaned.signals.length) {
      responseSignals.push(...cleaned.signals);
      holder.set(cleaned.text);
    }
  }

  const usage = (json.usage || {}) as Record<string, number>;
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  if (upstream.ok) addTokensUsed(claims.orgId, claims.agentId, inputTokens + outputTokens).catch(() => {});
  recordShroudEvent({
    ...event,
    responseSignals: signalNames(responseSignals),
    status: upstream.status,
    inputTokens,
    outputTokens,
    latencyMs: Date.now() - started,
  });
  return Response.json(json, {
    status: upstream.status,
    headers: { ...flagHeader, ...(responseSignals.length ? { "x-agent-guild-shroud-response": headerSafe(signalNames(responseSignals).join(" | ")) } : {}) },
  });
}

/** Text fields in a provider response that the agent will read. */
function responseTextHolders(provider: Provider, json: Record<string, unknown>) {
  const holders: { get: () => string; set: (v: string) => void }[] = [];
  if (provider === "anthropic") {
    for (const block of (Array.isArray(json.content) ? json.content : []) as Record<string, unknown>[]) {
      if (block && typeof block.text === "string") holders.push({ get: () => block.text as string, set: (v) => { block.text = v; } });
    }
  } else {
    for (const choice of (Array.isArray(json.choices) ? json.choices : []) as Record<string, unknown>[]) {
      const msg = choice?.message as Record<string, unknown> | undefined;
      if (msg && typeof msg.content === "string") holders.push({ get: () => msg.content as string, set: (v) => { msg.content = v; } });
    }
  }
  return holders;
}

/** Pull token counts out of one SSE line. */
export function countUsage(provider: Provider, line: string, usage: { input: number; output: number }) {
  if (!line.startsWith("data:")) return;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return;
  try {
    const evt = JSON.parse(data);
    if (provider === "anthropic") {
      if (evt.type === "message_start") usage.input += evt.message?.usage?.input_tokens || 0;
      if (evt.type === "message_delta") usage.output = evt.usage?.output_tokens || usage.output;
    } else if (evt.usage) {
      usage.input = evt.usage.prompt_tokens || usage.input;
      usage.output = evt.usage.completion_tokens || usage.output;
    }
  } catch {
    /* partial or non-JSON line — ignore */
  }
}
