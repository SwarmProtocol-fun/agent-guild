/**
 * POST /api/v1/mcp — Agent Guild MCP server (Streamable HTTP, stateless JSON).
 *
 *   Authorization: Bearer agt_…   (scope mcp:read, or mcp:write for the write tools)
 *
 * Claude Code:  claude mcp add --transport http agent-guild https://agent-guild.com/api/v1/mcp \
 *                 --header "Authorization: Bearer $AG_TOKEN"
 *
 * GET (a server-to-client SSE stream) isn't offered: every tool answers in
 * its own response. Protocol and tools live in lib/mcp/server.ts.
 */
import { NextRequest } from "next/server";
import { bearerToken, verifyAgentToken } from "@/lib/agent-tokens";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { withSpan } from "@/lib/telemetry";
import { handleRpc, rpcError, RPC, SUPPORTED_PROTOCOL_VERSIONS, type JsonRpcRequest } from "@/lib/mcp/server";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });

/** Browsers send Origin; a page on another site must not drive an agent's tools (DNS rebinding / CSRF). */
function originAllowed(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.nextUrl.host;
  } catch {
    return false;
  }
}

const isRequest = (m: unknown): m is JsonRpcRequest =>
  !!m && typeof m === "object" && (m as JsonRpcRequest).jsonrpc === "2.0" && typeof (m as JsonRpcRequest).method === "string";

export async function POST(req: NextRequest) {
  if (!originAllowed(req)) return json(rpcError(null, RPC.INVALID_REQUEST, "Origin not allowed"), 403);

  const version = req.headers.get("mcp-protocol-version");
  if (version && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return json(rpcError(null, RPC.INVALID_REQUEST, `Unsupported MCP-Protocol-Version ${version}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`), 400);
  }

  const token = bearerToken(req.headers);
  const claims = token ? await verifyAgentToken(token) : null;
  if (!claims) {
    return json(rpcError(null, RPC.INVALID_REQUEST, "Send an Agent Guild token (agt_…) with the mcp:read or mcp:write scope as a Bearer token"), 401, {
      "www-authenticate": 'Bearer realm="agent-guild", error="invalid_token"',
    });
  }
  if (!claims.scopes.includes("mcp:read") && !claims.scopes.includes("mcp:write")) {
    return json(rpcError(null, RPC.INVALID_REQUEST, "This token lacks the mcp:read / mcp:write scope"), 403, {
      "www-authenticate": 'Bearer realm="agent-guild", error="insufficient_scope", scope="mcp:read"',
    });
  }

  const limited = await rateLimit(`mcp:${claims.agentId}`);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(rpcError(null, RPC.PARSE_ERROR, "Body must be JSON"), 400);
  }

  // Batches were dropped from the spec in 2025-06-18; older clients may still send them.
  const messages = Array.isArray(body) ? body : [body];
  if (!messages.length || messages.length > 20) return json(rpcError(null, RPC.INVALID_REQUEST, "Send one JSON-RPC message (or a batch of at most 20)"), 400);

  const responses = (
    await Promise.all(
      messages.map((m) => {
        if (!isRequest(m)) return rpcError(null, RPC.INVALID_REQUEST, "Not a JSON-RPC 2.0 request");
        const tool = m.method === "tools/call" && typeof m.params?.name === "string" ? m.params.name : undefined;
        return withSpan(
          tool ? `tools/call ${tool}` : m.method,
          {
            "mcp.method.name": m.method,
            ...(tool ? { "gen_ai.tool.name": tool } : {}),
            "agent_guild.org_id": claims.orgId,
            "agent_guild.agent_id": claims.agentId,
          },
          () => handleRpc(m, claims),
        );
      }),
    )
  ).filter((r): r is object => r !== null);

  // Only notifications / responses from the client: acknowledge with no body.
  if (!responses.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? responses : responses[0]);
}

export async function GET() {
  return new Response("This MCP server answers each POST directly and offers no SSE stream.", { status: 405, headers: { allow: "POST" } });
}

export async function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
