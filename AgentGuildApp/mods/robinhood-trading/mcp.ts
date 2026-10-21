/**
 * A minimal MCP client for Robinhood's server over Streamable HTTP: just the
 * three calls this mod needs (initialize, tools/list, tools/call). Replies
 * arrive as plain JSON or as an SSE stream; both are handled. One MCP session
 * per org is kept in memory and re-opened when the server forgets it (404).
 */
import { MCP_URL } from "./oauth";

/** What the live trading server negotiated on 2026-10-21. */
export const PROTOCOL_VERSION = "2025-11-25";

/** The access token was rejected: refresh it and retry once. */
export class McpAuthError extends Error {}
/** The server answered with a JSON-RPC error or couldn't be reached. */
export class McpError extends Error {}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpCallResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface Rpc { jsonrpc: "2.0"; id?: number; result?: unknown; error?: { code: number; message: string } }

/** Picks the reply to `id` out of an SSE body (servers may interleave notifications). */
export function parseSse(body: string, id: number): Rpc | null {
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as Rpc | Rpc[];
      const hit = (Array.isArray(msg) ? msg : [msg]).find((m) => m.id === id);
      if (hit) return hit;
    } catch { /* keep-alive or partial event */ }
  }
  return null;
}

const sessions = new Map<string, string>();
let nextId = 1;

async function post(token: string, sessionId: string | null, message: object): Promise<{ res: Response; text: string }> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(30_000),
  }).catch((err: Error) => { throw new McpError(`Can't reach Robinhood: ${err.message}`); });
  if (res.status === 401 || res.status === 403) throw new McpAuthError("Robinhood rejected the access token");
  return { res, text: await res.text() };
}

async function rpc(token: string, sessionId: string | null, method: string, params: object): Promise<{ result: unknown; sessionId: string | null; status: number }> {
  const id = nextId++;
  const { res, text } = await post(token, sessionId, { jsonrpc: "2.0", id, method, params });
  if (res.status === 404 && sessionId) return { result: null, sessionId, status: 404 };
  if (!res.ok) throw new McpError(`Robinhood MCP ${method} failed (${res.status}): ${text.slice(0, 200)}`);
  const msg = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? parseSse(text, id) : (JSON.parse(text) as Rpc);
  if (!msg) throw new McpError(`Robinhood MCP ${method} returned no reply`);
  if (msg.error) throw new McpError(`Robinhood: ${msg.error.message}`);
  return { result: msg.result, sessionId: res.headers.get("mcp-session-id") ?? sessionId, status: res.status };
}

async function openSession(key: string, token: string): Promise<string | null> {
  const init = await rpc(token, null, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "agent-guild-robinhood-trading", version: "1.2.0" },
  });
  // An empty string means "this server does not use session ids", so the next
  // call does not initialize again. The live server often omits the header.
  sessions.set(key, init.sessionId ?? "");
  await post(token, init.sessionId, { jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
  return init.sessionId;
}

/** One request in the org's session, re-initializing once if the server dropped it. */
export async function request(key: string, token: string, method: string, params: object): Promise<unknown> {
  let sessionId: string | null;
  if (sessions.has(key)) sessionId = sessions.get(key) || null;
  else sessionId = await openSession(key, token);
  let out = await rpc(token, sessionId, method, params);
  if (out.status === 404) {
    sessions.delete(key);
    sessionId = await openSession(key, token);
    out = await rpc(token, sessionId, method, params);
  }
  return out.result;
}

export const forgetSession = (key: string) => sessions.delete(key);

export async function listTools(key: string, token: string): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = (await request(key, token, "tools/list", cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string };
    tools.push(...(res?.tools ?? []));
    if (!res?.nextCursor) break;
    cursor = res.nextCursor;
  }
  return tools;
}

export const callTool = (key: string, token: string, name: string, args: Record<string, unknown>) =>
  request(key, token, "tools/call", { name, arguments: args }) as Promise<McpCallResult>;

/** The useful part of a tool result: structured content, else its text parsed as JSON when it is JSON, else the text. */
export function resultValue(result: McpCallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n");
  try { return JSON.parse(text); } catch { return text; }
}
