/**
 * MPP Fetch Executor — Consumes a Machine Payments Protocol (MPP)-gated HTTP
 * resource on the agent's own behalf: request → 402 challenge → pay (only if
 * within the task's spend cap) → retry → response, in one task. MPP
 * (https://mpp.dev) is Stripe/Tempo's open standard for inline HTTP
 * payments — see mods/tempo-settlement's GET /paid/ping in AgentGuildApp for
 * the server side of the same protocol.
 *
 * Not a base dependency — gateway-agent is deliberately zero-dependency (see
 * package.json). Run `npm install mppx viem` inside GatewayAgent/ before
 * using the "mpp-fetch" task type; this executor fails with a clear message
 * if those packages aren't installed, rather than forcing the weight onto
 * every install.
 *
 * Requires TEMPO_MPP_CLIENT_PRIVATE_KEY — a DEDICATED wallet key, funded
 * only with whatever micropayment budget you're comfortable letting task
 * payloads spend. Deliberately separate from the platform's settlement key
 * (which pays agents, not the other way around): task payloads are
 * submittable by any org member (see safe-env.mjs), so a malicious or
 * buggy url/maxAmountUsdc can only drain this wallet's balance, never the
 * funds that pay agents for completed work. The *_PRIVATE_KEY suffix also
 * ensures safeSubprocessEnv strips it from any subprocess env (shell/docker
 * tasks can't read it even if chained after this one).
 *
 * Payload fields:
 *   url: string                      — the MPP-gated resource to fetch
 *   method?: string                   — default "GET"
 *   headers?: Record<string, string>
 *   body?: string
 *   maxAmountUsdc: number             — REQUIRED hard cap in USDC base units
 *                                       (6 decimals); a 402 challenge asking
 *                                       for more is declined, not paid
 *   allowedCurrency?: string          — expected payment-token address;
 *                                       defaults to TEMPO_USDC_ADDRESS env
 *                                       when set. A challenge quoting a
 *                                       different token is declined.
 *
 * Common Executor Interface:
 *   execute(task, logCallback) → { data, artifacts, executionTimeMs, exitCode }
 *   cancel() → void
 *   getStatus() → { running }
 */

let running = false;

export async function execute(task, logCallback) {
  const { payload } = task;
  const { url, method = "GET", headers = {}, body, maxAmountUsdc, allowedCurrency } = payload;

  if (!url) throw new Error("mpp-fetch task missing 'url' in payload");
  if (maxAmountUsdc == null) throw new Error("mpp-fetch task missing 'maxAmountUsdc' — a spend cap is required");

  const privateKey = process.env.TEMPO_MPP_CLIENT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("TEMPO_MPP_CLIENT_PRIVATE_KEY not configured — set a dedicated, separately-funded wallet key for MPP payments");
  }

  let Fetch, tempoMethod, privateKeyToAccount;
  try {
    ({ Fetch, tempo: tempoMethod } = await import("mppx/client"));
    ({ privateKeyToAccount } = await import("viem/accounts"));
  } catch {
    throw new Error("mpp-fetch requires 'mppx' and 'viem' — run `npm install mppx viem` inside GatewayAgent/");
  }

  const expectedCurrency = (allowedCurrency ?? process.env.TEMPO_USDC_ADDRESS)?.toLowerCase();
  const maxAmountBaseUnits = BigInt(Math.round(maxAmountUsdc * 1_000_000)); // USDC-style, 6 decimals
  const account = privateKeyToAccount(privateKey);

  const log = (line) => logCallback?.([`[mpp-fetch] ${line}`]);

  const payFetch = Fetch.from({
    // tempoMethod({account}) already returns an array (charge/session/
    // subscription intents bundled together) — do not re-wrap it in `[...]`,
    // which would nest the array and break mppx's internal method lookup.
    methods: tempoMethod({ account }),
    onChallenge: async (challenge, { createCredential }) => {
      const amount = BigInt(challenge.request?.amount ?? "0");
      const currency = String(challenge.request?.currency ?? "").toLowerCase();

      log(`402 challenge: ${challenge.request?.amount} of ${challenge.request?.currency}`);

      if (expectedCurrency && currency !== expectedCurrency) {
        log(`declined — currency ${currency} does not match expected ${expectedCurrency}`);
        return undefined;
      }
      if (amount > maxAmountBaseUnits) {
        log(`declined — amount ${amount} exceeds maxAmountUsdc cap (${maxAmountBaseUnits} base units)`);
        return undefined;
      }
      return createCredential();
    },
  });

  const startTime = Date.now();
  running = true;

  try {
    const res = await payFetch(url, { method, headers, ...(body != null ? { body } : {}) });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    return {
      data: { status: res.status, body: parsed },
      artifacts: [],
      executionTimeMs: Date.now() - startTime,
      exitCode: res.ok ? 0 : 1,
    };
  } finally {
    running = false;
  }
}

export function cancel() {
  // No in-flight abort — the gateway's own task timeout bounds this.
}

export function getStatus() {
  return { running };
}
