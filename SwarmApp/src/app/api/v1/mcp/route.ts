/**
 * MCP server surface — Context Vault PRD §43/§44 ("Any Swarm-compatible
 * agent runtime should be able to reach the Vault without a native SDK
 * integration"). Exposes the same capabilities already shipped as REST
 * (compute/memory.ts, agent-context-pack.ts, compute/graph.ts) as MCP
 * tools, via the Streamable HTTP transport — stateless, one server+
 * transport instance per request, matching how every other route here is
 * a stateless serverless function (no in-memory session store to leak
 * across invocations).
 *
 * Auth: `x-agent-id` + `x-agent-api-key` headers, checked against the same
 * `authenticateAgent()` primitive requireAgentAuth's API-key tier already
 * uses (src/lib/auth-guard.ts) — MCP clients configure headers on their
 * transport, not query params, so this is the header-based equivalent of
 * that same tier rather than a new auth mechanism.
 */
import { NextRequest } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { authenticateAgent } from "@/app/api/webhooks/auth";
import { getAgentIdentity } from "@/lib/mod-stubs";
import type { AgentIdentity } from "@/lib/agent-memory-server";
import { mcpRemember, mcpRecall, mcpContextPack, mcpLink, mcpGraph, McpToolInputError } from "@/lib/mcp-tools";

export const runtime = "nodejs";

const SCOPE_TYPES = ["workspace", "computer", "agent", "user"] as const;
const ENTITY_TYPES = ["agent", "task", "project", "memory", "document"] as const;

function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof McpToolInputError || err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function authenticateFromHeaders(req: NextRequest): Promise<AgentIdentity | null> {
  const agentId = req.headers.get("x-agent-id");
  const apiKey = req.headers.get("x-agent-api-key");
  const auth = await authenticateAgent(agentId, apiKey);
  if (!auth) return null;
  return { agentId: auth.agentId, orgId: auth.orgId, agentName: auth.agentName };
}

function buildServer(agent: AgentIdentity): McpServer {
  const server = new McpServer({ name: "swarm-context-vault", version: "1.0.0" });

  server.registerTool(
    "context_remember",
    {
      title: "Remember",
      description: "Store a memory for this agent, or an explicit shared scope (workspace/computer/user).",
      inputSchema: {
        content: z.string().describe("The content to remember, or ciphertext when encrypted=true"),
        scopeType: z.enum(SCOPE_TYPES).optional().describe("Defaults to this agent's own scope"),
        scopeId: z.string().optional(),
        tags: z.array(z.string()).optional(),
        pinned: z.boolean().optional().describe("Pinned memories are always included in context packs"),
        encrypted: z.boolean().optional().describe(
          "True if content is AES-256-GCM ciphertext you encrypted yourself with a key derived from your vault keypair — the server never decrypts it. Requires iv and authTag."
        ),
        iv: z.string().optional().describe("Base64 AES-GCM IV, required when encrypted=true"),
        authTag: z.string().optional().describe("Base64 AES-GCM auth tag, required when encrypted=true"),
        embedding: z.array(z.number()).optional().describe(
          "Your own embedding of the plaintext, computed before encrypting — required for semantic recall of encrypted entries since the server never sees plaintext to embed"
        ),
      },
    },
    async (args) => {
      try {
        return toolResult(await mcpRemember(agent, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "context_recall",
    {
      title: "Recall",
      description: "Hybrid (semantic + substring) search over this agent's, or an explicit scope's, memories.",
      inputSchema: {
        query: z.string(),
        scopeType: z.enum(SCOPE_TYPES).optional(),
        scopeId: z.string().optional(),
        limit: z.number().optional().describe("Max 100, default 10"),
      },
    },
    async (args) => {
      try {
        return toolResult(await mcpRecall(agent, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "context_pack",
    {
      title: "Context Pack",
      description:
        "Token-budgeted, task-aware context for this agent: working/long-term/daily memory, task-ranked memories, and recent messages.",
      inputSchema: {
        task: z.string().optional().describe("When given, ranks memories relevant to this task"),
        tokenBudget: z.number().optional().describe("Default 8000, clamped to [500, 32000]"),
      },
    },
    async (args) => {
      try {
        return toolResult(await mcpContextPack(agent, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "context_link",
    {
      title: "Link",
      description: "Create a knowledge-graph edge from this agent (or an explicit entity) to another entity.",
      inputSchema: {
        toType: z.enum(ENTITY_TYPES),
        toId: z.string(),
        relation: z.string().describe('e.g. "works_on", "related_to", "derived_from"'),
        fromType: z.enum(ENTITY_TYPES).optional().describe("Defaults to this agent"),
        fromId: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return toolResult(await mcpLink(agent, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "context_graph",
    {
      title: "Graph",
      description: "List knowledge-graph edges touching one entity (either endpoint), newest first.",
      inputSchema: {
        type: z.enum(ENTITY_TYPES),
        id: z.string(),
        relation: z.string().optional(),
        limit: z.number().optional(),
      },
    },
    async (args) => {
      try {
        return toolResult(await mcpGraph(agent, args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

async function handle(req: NextRequest): Promise<Response> {
  const agent = await authenticateFromHeaders(req);
  if (!agent) {
    return Response.json(
      { error: "Unauthorized — provide x-agent-id and x-agent-api-key headers" },
      { status: 401 },
    );
  }

  // The Vault gate: an agent must have completed /api/v1/register (which
  // issues an identity credential synchronously — mod-stubs.ts's
  // issueAgentIdentity) before it can touch the Context Vault at all.
  const identity = await getAgentIdentity(agent.agentId);
  if (!identity) {
    return Response.json(
      { error: "No identity credential issued for this agent — complete /api/v1/register first" },
      { status: 403 },
    );
  }

  // New server + transport per request — stateless, matching every other
  // route in this app being a stateless serverless function. No session
  // store to leak state across invocations or across agents.
  const server = buildServer(agent);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function DELETE(req: NextRequest) {
  return handle(req);
}
