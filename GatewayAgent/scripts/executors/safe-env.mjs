/**
 * Safe subprocess environment.
 *
 * Task executors spawn commands built from task payloads that any org
 * member (or, for shell/docker/node, the org owner) can submit. Spreading
 * the gateway process's own `process.env` wholesale into that subprocess
 * hands every task the gateway's own credentials — e.g. INTERNAL_SERVICE_SECRET,
 * which the gateway uses to authenticate itself to the hub as a trusted
 * internal service. A task doesn't even need a shell-injection bug to steal
 * it: `{"command":"printenv","args":["INTERNAL_SERVICE_SECRET"]}` reads it
 * straight out of the inherited environment. Strip credential-shaped keys
 * before spreading; everything else (PATH, HOME, etc.) still passes through
 * so normal commands keep working.
 */
const SECRET_KEY_PATTERN = /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIAL)/i;

/**
 * @param {Object} extra - explicit env overrides from the task payload
 * @returns {Object} process.env with credential-shaped keys removed, plus extra
 */
export function safeSubprocessEnv(extra = {}) {
  const base = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_KEY_PATTERN.test(key)) {
      base[key] = value;
    }
  }
  return { ...base, ...extra };
}
