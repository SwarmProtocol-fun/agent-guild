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
 * counted); response *content* inspection and PII restoration apply to
 * non-streaming calls only. Prompt and completion text is never stored —
 * only scores, signal names, token counts and estimated cost.
 *
 * Kill switch: a halted agent is refused outright; per-agent and per-org
 * daily spend caps refuse once the estimate (pricing.ts) is reached; the loop
 * guard halts an agent that floods the proxy or repeats one request.
 *
 * Every call is an OpenTelemetry span (gen_ai.* attributes; see telemetry.ts).
 */

import { createHash } from "crypto";
import { bearerToken, verifyAgentToken, TOKEN_PREFIX } from "@/lib/agent-tokens";
import { useSecretValue, auditQuietly } from "@/lib/vault/store";
import { withSpan, SpanStatusCode, type Span } from "@/lib/telemetry";
import { inspectRequest, inspectResponseText, maskRequestPii, walkText, type Provider, type Signal } from "./inspect";
import { costMicroUsd } from "./pricing";
import {
  getShroudConfig, tokensUsedToday, addTokensUsed, recordShroudEvent,
  getHalt, haltAgent, spendToday, checkLoop,
} from "./config";

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
  return withSpan("chat", { "gen_ai.operation.name": "chat", "gen_ai.system": provider }, async (span) => {
    const res = await proxy(provider, req, span);
    span.setAttribute("http.response.status_code", res.status);
    if (res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    return res;
  });
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

async function proxy(provider: Provider, req: Request, span: Span): Promise<Response> {
  const started = Date.now();

  const token = tokenFrom(req);
  if (!token) return providerError(provider, 401, "Use an Agent Guild token (agt_…) with the llm:proxy scope as the API key", "authentication_error");
  const claims = await verifyAgentToken(token);
  if (!claims) return providerError(provider, 401, "Invalid, expired or revoked Agent Guild token", "authentication_error");
  if (!claims.scopes.includes("llm:proxy")) return providerError(provider, 403, "This token lacks the llm:proxy scope", "permission_error");

  span.setAttributes({ "agent_guild.org_id": claims.orgId, "agent_guild.agent_id": claims.agentId });

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
  span.updateName(`chat ${model || "unknown"}`);
  span.setAttribute("gen_ai.request.model", model);
  if (config.allowedModels.length && !config.allowedModels.includes(model)) {
    return providerError(provider, 403, `Model ${model || "(none)"} is not allowed. Allowed: ${config.allowedModels.join(", ")}`, "permission_error");
  }

  if (config.maxTokensPerRequest) {
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      if (typeof body[key] === "number" && (body[key] as number) > config.maxTokensPerRequest) body[key] = config.maxTokensPerRequest;
    }
    if (provider === "anthropic" && body.max_tokens === undefined) body.max_tokens = config.maxTokensPerRequest;
  }

  // ── kill switch ──
  const capped = config.dailySpendCapUsdPerAgent || config.dailySpendCapUsdOrg;
  const [halt, used, spend] = await Promise.all([
    getHalt(claims.agentId),
    config.dailyTokenBudgetPerAgent ? tokensUsedToday(claims.agentId) : Promise.resolve(0),
    capped ? spendToday(claims.orgId, claims.agentId) : Promise.resolve({ agentMicroUsd: 0, orgMicroUsd: 0 }),
  ]);
  const refuse = (status: number, killSwitch: string, message: string, type: string) => {
    span.setAttribute("agent_guild.shroud.kill_switch", killSwitch);
    recordShroudEvent({
      orgId: claims.orgId, agentId: claims.agentId, provider, model, stream: body.stream === true, score: 0, signals: [], redactions: [],
      responseSignals: [], blocked: true, status, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started, killSwitch,
    });
    return providerError(provider, status, message, type);
  };
  if (halt) {
    return refuse(403, "halted", `This agent is halted by the Agent Guild kill switch (${halt.reason}). An org admin can resume it in Vault → LLM proxy.`, "permission_error");
  }
  if (config.dailyTokenBudgetPerAgent && used >= config.dailyTokenBudgetPerAgent) {
    return refuse(429, "token_budget", `Daily token budget of ${config.dailyTokenBudgetPerAgent} reached for this agent`, "rate_limit_error");
  }
  const agentCap = config.dailySpendCapUsdPerAgent * 1_000_000;
  if (agentCap && spend.agentMicroUsd >= agentCap) {
    return refuse(429, "agent_spend_cap", `Daily spend cap reached for this agent: ${usd(spend.agentMicroUsd)} of ${usd(agentCap)} (estimated). Resets at 00:00 UTC.`, "rate_limit_error");
  }
  const orgCap = config.dailySpendCapUsdOrg * 1_000_000;
  if (orgCap && spend.orgMicroUsd >= orgCap) {
    return refuse(429, "org_spend_cap", `Daily spend cap reached for this organization: ${usd(spend.orgMicroUsd)} of ${usd(orgCap)} (estimated). Resets at 00:00 UTC.`, "rate_limit_error");
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const loop = await checkLoop(claims.agentId, fingerprint, { perMinute: config.loopGuardPerMinute, repeats: config.loopGuardRepeats });
  if (loop) {
    await haltAgent(claims.orgId, claims.agentId, loop, "loop-guard");
    auditQuietly({ orgId: claims.orgId, action: "shroud.halted", actorType: "user", actorId: "loop-guard", target: claims.agentId, detail: { reason: loop } });
    return refuse(429, "loop_guard", `Agent halted by the Agent Guild loop guard: ${loop}. An org admin can resume it in Vault → LLM proxy.`, "rate_limit_error");
  }

  const stream = body.stream === true;
  if (stream && provider === "openai") {
    body.stream_options = { ...((body.stream_options as object) || {}), include_usage: true };
  }

  const inspection = inspectRequest(provider, body, config.blockedDomains);
  const pii = maskRequestPii(body, config.piiRedaction);
  const event = {
    orgId: claims.orgId,
    agentId: claims.agentId,
    provider,
    model,
    stream,
    score: inspection.score,
    signals: signalNames(inspection.signals),
    redactions: inspection.redactions,
    pii: pii.found,
    responseSignals: [] as string[],
    blocked: false,
    status: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
  };

  span.setAttributes({
    "agent_guild.shroud.score": inspection.score,
    "agent_guild.shroud.redactions": inspection.redactions.length,
    "agent_guild.shroud.pii_masked": pii.size,
    "gen_ai.request.stream": stream,
  });

  if (inspection.score >= config.injectionThreshold && config.injectionAction === "block") {
    span.setAttribute("agent_guild.shroud.blocked", true);
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
    "x-agent-guild-shroud": `score=${inspection.score}; redactions=${inspection.redactions.length}${pii.size ? `; pii=${pii.size}` : ""}${inspection.score >= config.injectionThreshold ? "; flagged" : ""}`,
  };
  // Cache writes bill at 1.25x input, cache reads at 0.1x — fold them into input for the estimate.
  const settle = (inputTokens: number, outputTokens: number, ok: boolean, cache = { read: 0, write: 0 }) => {
    const billedInput = inputTokens + Math.ceil(cache.write * 1.25 + cache.read * 0.1);
    const microUsd = ok ? costMicroUsd(model, billedInput, outputTokens, config.modelPrices) : 0;
    if (ok) addTokensUsed(claims.orgId, claims.agentId, inputTokens + outputTokens, microUsd).catch(() => {});
    span.setAttributes({ "gen_ai.usage.input_tokens": inputTokens, "gen_ai.usage.output_tokens": outputTokens, "agent_guild.cost_usd": microUsd / 1_000_000 });
    return microUsd;
  };

  // ── streaming: pass bytes through, count usage on the way ──
  if (stream && upstream.ok && upstream.body) {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
        const microUsd = settle(usage.input, usage.output, true, { read: usage.cacheRead, write: usage.cacheWrite });
        recordShroudEvent({ ...event, status: upstream.status, inputTokens: usage.input, outputTokens: usage.output, microUsd, latencyMs: Date.now() - started });
      },
    });
    return new Response(upstream.body.pipeThrough(counter), {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "text/event-stream",
        "cache-control": "no-cache",
        ...flagHeader,
        // Placeholders can split across SSE chunks, so streamed text keeps them.
        ...(pii.size ? { "x-agent-guild-shroud-pii": "masked; placeholders not restored in streaming responses" } : {}),
      },
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

  // Give the agent back the real values the model referred to by placeholder (text and tool inputs).
  if (pii.size) walkText(json, (s) => pii.restore(s));

  const usage = (json.usage || {}) as Record<string, number>;
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const microUsd = settle(inputTokens, outputTokens, upstream.ok, { read: usage.cache_read_input_tokens ?? 0, write: usage.cache_creation_input_tokens ?? 0 });
  if (typeof json.model === "string") span.setAttribute("gen_ai.response.model", json.model);
  recordShroudEvent({
    ...event,
    responseSignals: signalNames(responseSignals),
    status: upstream.status,
    inputTokens,
    outputTokens,
    microUsd,
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
export function countUsage(provider: Provider, line: string, usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) {
  if (!line.startsWith("data:")) return;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return;
  try {
    const evt = JSON.parse(data);
    if (provider === "anthropic") {
      if (evt.type === "message_start") {
        const u = evt.message?.usage || {};
        usage.input += u.input_tokens || 0;
        usage.cacheRead = (usage.cacheRead || 0) + (u.cache_read_input_tokens || 0);
        usage.cacheWrite = (usage.cacheWrite || 0) + (u.cache_creation_input_tokens || 0);
      }
      if (evt.type === "message_delta") usage.output = evt.usage?.output_tokens || usage.output;
    } else if (evt.usage) {
      usage.input = evt.usage.prompt_tokens || usage.input;
      usage.output = evt.usage.completion_tokens || usage.output;
    }
  } catch {
    /* partial or non-JSON line — ignore */
  }
}
