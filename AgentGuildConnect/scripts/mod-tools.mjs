// Generic mod tools: any installed mod that serves GET /agent/tools
// (polymarket-trading, hyperliquid-trading, solana-settlement, …) can be
// driven from the CLI and MCP without a per-mod command. Pure helpers only;
// the signed fetch lives in agent-guild.mjs (modRequest).

const MOD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A mod id safe to put in /api/mods/<mod>/… — throws otherwise. */
export function checkModId(mod) {
  if (typeof mod !== "string" || !MOD_ID_RE.test(mod)) {
    throw new Error(`Invalid mod id "${mod}" (lowercase letters, digits and dashes, e.g. polymarket-trading)`);
  }
  return mod;
}

/**
 * Turn one manifest tool + its input into a request. `{name}` path segments
 * come from the input ({agentId} from this agent); what's left goes in the
 * query string for GET and the JSON body for POST.
 */
export function buildToolRequest(tool, input = {}, agentId) {
  if (!tool || typeof tool.path !== "string") throw new Error("Tool has no path");
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be a JSON object");
  const method = String(tool.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") throw new Error(`${tool.name}: unsupported method ${method}`);
  const rest = { ...input };
  const path = tool.path.replace(/^\/+/, "").replace(/\{(\w+)\}/g, (_, key) => {
    const value = key === "agentId" ? agentId : rest[key];
    delete rest[key];
    if (value == null || value === "") throw new Error(`${tool.name} needs ${key}`);
    return encodeURIComponent(String(value));
  });
  if (method === "GET") {
    const query = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v == null) continue;
      query[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
    }
    return { method, path, query, body: undefined };
  }
  return { method, path, query: {}, body: rest };
}

/** Human-readable tool list: name, method/path, required args, description. */
export function formatToolList(mod, tools) {
  if (!tools.length) return `${mod}: no agent tools`;
  const lines = [`${mod} — ${tools.length} tool(s). Run one with: mod call ${mod} <tool> '<json>'`, ""];
  for (const t of tools) {
    const props = Object.keys(t.input_schema?.properties || {});
    const required = new Set(t.input_schema?.required || []);
    const args = props.map((p) => (required.has(p) ? p : `${p}?`)).join(", ");
    lines.push(`${t.name}(${args})  ${t.method} ${t.path}`);
    if (t.description) lines.push(`  ${t.description}`);
  }
  return lines.join("\n");
}
