/**
 * Agent Guild MCP server — written from the spec, no SDK.
 *
 * Transport: Streamable HTTP, stateless. Every POST carries one JSON-RPC
 * message and gets one JSON response (no SSE stream, no session id), which is
 * all a request/response tool server needs and works on serverless hosts.
 *
 * Auth: an Agent Guild token (agt_…) as the bearer. `mcp:read` lists jobs,
 * reads memory, searches the directory and fetches harness feedback;
 * `mcp:write` also updates memory and claims / delivers jobs. A tool the
 * token's scopes don't cover is not listed and cannot be called.
 *
 * Tools act as the token's agent in the token's org, through the same checks
 * as the signed REST API (lib/job-actions.ts, agent-memory-server.ts).
 */
import type { AgentTokenClaims } from "@/lib/agent-tokens";
import { getAgent, getJobsByOrg } from "@/lib/firestore-admin";
import { claimJob, getIncomingGigOrders, getJob, submitJobDelivery } from "@/lib/jobs-admin";
import { checkClaimable, checkDeliverable, isPolicyRejection, JobActionError } from "@/lib/job-actions";
import { validateDelivery } from "@/lib/job-lifecycle";
import { agentActor } from "@/lib/job-audit";
import {
  ALLOWED_SECTIONS, appendDailyNote, appendMemoryMd, getDailyNoteIfExists, getOrCreateMemoryMd, getOrCreateWorkingMd,
  isAllowedSection, updateWorkingMd,
} from "@/lib/agent-memory-server";
import { searchDirectory } from "@/lib/agent-directory";
import { buildFeedback } from "@/lib/harness";
import { listGenerations, listJobOutcomes, listReplyOutcomes } from "@/lib/harness-store";
import type { Job } from "@/lib/firestore";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const SERVER_INFO = { name: "agent-guild", title: "Agent Guild", version: "1.0.0" };

// ─── JSON-RPC ──────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export const RPC = { PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 };

const ok = (id: JsonRpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0" as const, id: id ?? null, result });
export const rpcError = (id: JsonRpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } });

// ─── tools ─────────────────────────────────────────────────────

type Scope = "mcp:read" | "mcp:write";

/** Thrown inside a tool: reported to the model as a tool error (isError), not a protocol error. */
class ToolError extends Error {}

interface Tool {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  run: (args: Record<string, unknown>, agent: AgentTokenClaims) => Promise<unknown>;
}

const str = (args: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string => {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw new ToolError(`${key} is required`);
    return "";
  }
  if (typeof v !== "string") throw new ToolError(`${key} must be a string`);
  if (opts.max && v.length > opts.max) throw new ToolError(`${key} is longer than ${opts.max} characters`);
  return v;
};

const section = (doc: keyof typeof ALLOWED_SECTIONS, args: Record<string, unknown>) => {
  const s = str(args, "section");
  if (s && !isAllowedSection(doc, s)) throw new ToolError(`section must be one of: ${ALLOWED_SECTIONS[doc].join(", ")}`);
  return s || undefined;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateArg = (args: Record<string, unknown>) => {
  const d = str(args, "date") || new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(d)) throw new ToolError("date must be YYYY-MM-DD");
  return d;
};

const summarizeJob = (j: Job, full = false) => ({
  id: j.id,
  title: j.title,
  description: full ? j.description : (j.description || "").slice(0, 400),
  status: j.status,
  priority: j.priority,
  reward: j.reward ?? null,
  hiringMode: j.hiringMode ?? "instant",
  takenByAgentId: j.takenByAgentId ?? null,
  ...(full ? { reviewStatus: j.reviewStatus ?? null, reviewNotes: j.reviewNotes ?? null, reviewDueAt: j.reviewDueAt ?? null, rating: j.rating ?? null, requirements: { minCompletedJobs: j.minCompletedJobs ?? null, minTrustScore: j.minTrustScore ?? null } } : {}),
});

const identity = (a: AgentTokenClaims) => ({ agentId: a.agentId, orgId: a.orgId, agentName: a.agentName });

const MEMORY_SECTIONS_NOTE = (doc: keyof typeof ALLOWED_SECTIONS) => `Optional section: ${ALLOWED_SECTIONS[doc].join(", ")}.`;

export const TOOLS: Tool[] = [
  {
    name: "whoami",
    title: "Who am I",
    description: "Your Agent Guild identity: agent id, name, organization, trust score and completed-job count.",
    scope: "mcp:read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (_args, a) => {
      const agent = await getAgent(a.agentId);
      return { ...identity(a), type: agent?.type ?? null, trustScore: agent?.trustScore ?? null, tasksCompleted: agent?.tasksCompleted ?? 0 };
    },
  },
  {
    name: "list_jobs",
    title: "List jobs",
    description: "Jobs on your organization's board. filter=open: jobs you can claim. filter=mine: jobs you hold (including gig orders). Descriptions are truncated; use get_job for the full text.",
    scope: "mcp:read",
    inputSchema: {
      type: "object",
      properties: { filter: { type: "string", enum: ["open", "mine"], default: "open" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args, a) => {
      const filter = str(args, "filter") || "open";
      if (filter !== "open" && filter !== "mine") throw new ToolError("filter must be open or mine");
      if (filter === "open") {
        const jobs = (await getJobsByOrg(a.orgId)).filter((j) => j.status === "open");
        return { jobs: jobs.slice(0, 50).map((j) => summarizeJob(j)) };
      }
      const [own, gigs] = await Promise.all([getJobsByOrg(a.orgId), getIncomingGigOrders(a.orgId)]);
      const byId = new Map([...own, ...gigs].filter((j) => j.takenByAgentId === a.agentId).map((j) => [j.id, j]));
      return { jobs: [...byId.values()].slice(0, 50).map((j) => summarizeJob(j)) };
    },
  },
  {
    name: "get_job",
    title: "Get job",
    description: "One job's full description, status, requirements and the buyer's latest review notes.",
    scope: "mcp:read",
    inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (args, a) => {
      const job = await getJob(str(args, "jobId", { required: true, max: 200 }));
      const visible = job && (job.orgId === a.orgId || (job.gigId && job.sellerOrgId === a.orgId && job.takenByAgentId === a.agentId));
      if (!visible) throw new ToolError("Job not found in your organization");
      return summarizeJob(job, true);
    },
  },
  {
    name: "claim_job",
    title: "Claim job",
    description: "Take an open, instant-hiring job. It moves to in_progress and is assigned to you. Jobs that need an application can't be claimed here.",
    scope: "mcp:write",
    inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: async (args, a) => {
      const jobId = str(args, "jobId", { required: true, max: 200 });
      const job = await checkClaimable(a, jobId);
      try {
        const taskId = await claimJob(jobId, a.agentId, a.orgId, job.projectId || "", a.agentName);
        return { jobId, status: "in_progress", taskId };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isPolicyRejection(message)) throw new ToolError(message);
        throw err;
      }
    },
  },
  {
    name: "deliver_job",
    title: "Deliver job",
    description: "Submit your finished work on a job you hold. A person in the buyer's organization then approves it or sends it back with notes.",
    scope: "mcp:write",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        deliveryNotes: { type: "string", description: "What you did, and the result itself if it's text." },
        deliveryFiles: { type: "array", items: { type: "string" }, description: "URLs of delivered files." },
      },
      required: ["jobId", "deliveryNotes"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: async (args, a) => {
      const jobId = str(args, "jobId", { required: true, max: 200 });
      const files = args.deliveryFiles;
      if (files !== undefined && !(Array.isArray(files) && files.every((f) => typeof f === "string"))) throw new ToolError("deliveryFiles must be an array of URLs");
      const delivery = validateDelivery({ deliveryNotes: args.deliveryNotes, deliveryFiles: files });
      if (!delivery.ok) throw new ToolError(delivery.error);
      await checkDeliverable(a, jobId);
      await submitJobDelivery(jobId, { ...delivery.value, completedByAgentName: a.agentName }, agentActor(a));
      return { jobId, status: "completed", reviewStatus: "pending" };
    },
  },
  {
    name: "read_memory",
    title: "Read memory",
    description: "Your persistent memory. doc=working: current focus and tasks (WORKING.md). doc=long_term: durable facts and learnings (MEMORY.md). doc=daily: one day's journal (date defaults to today, UTC).",
    scope: "mcp:read",
    inputSchema: {
      type: "object",
      properties: { doc: { type: "string", enum: ["working", "long_term", "daily"] }, date: { type: "string", description: "YYYY-MM-DD, for doc=daily" } },
      required: ["doc"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args, a) => {
      const doc = str(args, "doc", { required: true });
      if (doc === "working") return { doc, content: (await getOrCreateWorkingMd(a)).content };
      if (doc === "long_term") return { doc, content: (await getOrCreateMemoryMd(a)).content };
      if (doc === "daily") {
        const date = dateArg(args);
        return { doc, date, content: (await getDailyNoteIfExists(a, date))?.content ?? null };
      }
      throw new ToolError("doc must be working, long_term or daily");
    },
  },
  {
    name: "update_working_memory",
    title: "Update working memory",
    description: `Replace your working memory (WORKING.md), or one section of it. ${MEMORY_SECTIONS_NOTE("working_md")}`,
    scope: "mcp:write",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" }, section: { type: "string", enum: ALLOWED_SECTIONS.working_md } },
      required: ["content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: async (args, a) => {
      const doc = await updateWorkingMd(a, str(args, "content", { required: true, max: 50_000 }), section("working_md", args));
      return { updatedAt: doc.updatedAt };
    },
  },
  {
    name: "remember",
    title: "Remember",
    description: `Append an entry to your long-term memory (MEMORY.md). ${MEMORY_SECTIONS_NOTE("memory_md")}`,
    scope: "mcp:write",
    inputSchema: {
      type: "object",
      properties: { entry: { type: "string" }, section: { type: "string", enum: ALLOWED_SECTIONS.memory_md } },
      required: ["entry"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: async (args, a) => {
      const doc = await appendMemoryMd(a, str(args, "entry", { required: true, max: 10_000 }), section("memory_md", args));
      return { updatedAt: doc.updatedAt };
    },
  },
  {
    name: "append_daily_note",
    title: "Append to daily note",
    description: `Append an entry to a day's journal (today, UTC, unless date is given). ${MEMORY_SECTIONS_NOTE("daily_note")}`,
    scope: "mcp:write",
    inputSchema: {
      type: "object",
      properties: { entry: { type: "string" }, section: { type: "string", enum: ALLOWED_SECTIONS.daily_note }, date: { type: "string" } },
      required: ["entry"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: async (args, a) => {
      const date = dateArg(args);
      const doc = await appendDailyNote(a, date, str(args, "entry", { required: true, max: 10_000 }), section("daily_note", args));
      return { date, updatedAt: doc.updatedAt };
    },
  },
  {
    name: "search_directory",
    title: "Search agent directory",
    description: "Find public agents by name, skill or capability — with their reputation and the MCP / A2A endpoints they publish, so you can hire or call them.",
    scope: "mcp:read",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        capabilities: { type: "array", items: { type: "string" }, description: "Capability keys the agent must all have." },
        minReputation: { type: "number" },
        limit: { type: "number", default: 10, maximum: 50 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args) => {
      const caps = Array.isArray(args.capabilities) ? args.capabilities.filter((c): c is string => typeof c === "string") : [];
      const minReputation = typeof args.minReputation === "number" ? args.minReputation : null;
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
      const results = await searchDirectory({ q: str(args, "query", { max: 200 }), capabilities: caps, minReputation });
      return {
        total: results.length,
        agents: results.slice(0, limit).map((p) => ({
          agentId: p.agentId, name: p.name, type: p.type, bio: p.bio ?? null, status: p.status,
          skills: p.reportedSkills.map((s) => s.name), capabilities: p.capabilities.map((c) => c.key),
          creditScore: p.reputation?.creditScore ?? null, endpoints: p.endpoints,
        })),
      };
    },
  },
  {
    name: "get_feedback",
    title: "Get harness feedback",
    description: "How your playbook generations have scored on buyer verdicts and reply results, recent failures under the live one, and regression / plateau flags. The input for proposing a better playbook.",
    scope: "mcp:read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (_args, a) => {
      const [generations, jobs, replies] = await Promise.all([listGenerations(a.agentId), listJobOutcomes(a.agentId), listReplyOutcomes(a.agentId)]);
      return buildFeedback(generations, jobs, replies);
    },
  },
];

const allowed = (tool: Tool, scopes: readonly string[]) => scopes.includes(tool.scope) || (tool.scope === "mcp:read" && scopes.includes("mcp:write"));

export function toolsFor(scopes: readonly string[]) {
  return TOOLS.filter((t) => allowed(t, scopes)).map(({ name, title, description, inputSchema, annotations }) => ({
    name, title, description, inputSchema, ...(annotations ? { annotations } : {}),
  }));
}

// ─── dispatch ──────────────────────────────────────────────────

/** Handle one JSON-RPC message. Returns null for notifications (no response body). */
export async function handleRpc(msg: JsonRpcRequest, agent: AgentTokenClaims): Promise<object | null> {
  const isNotification = msg.id === undefined;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};

  switch (msg.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return ok(msg.id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          `You are ${agent.agentName} (agent ${agent.agentId}) in Agent Guild, a marketplace where agents take and deliver jobs for organizations. ` +
          "Use list_jobs / get_job to find work, claim_job to take it, deliver_job to hand it in. Keep notes in your memory (read_memory, " +
          "update_working_memory, remember, append_daily_note) so the next session picks up where this one stopped.",
      });
    }
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { tools: toolsFor(agent.scopes) });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(msg.id, RPC.INVALID_PARAMS, `Unknown tool: ${name || "(none)"}`);
      if (!allowed(tool, agent.scopes)) return rpcError(msg.id, RPC.INVALID_PARAMS, `Tool ${name} needs the ${tool.scope} scope`);
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      try {
        const result = await tool.run(args, agent);
        const structured = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : { result };
        return ok(msg.id, { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }], structuredContent: structured });
      } catch (err) {
        if (err instanceof ToolError || err instanceof JobActionError) {
          return ok(msg.id, { content: [{ type: "text", text: err.message }], isError: true });
        }
        console.error(`[mcp] ${name} failed:`, err);
        return ok(msg.id, { content: [{ type: "text", text: `${name} failed on the server. Try again later.` }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
      return rpcError(msg.id, RPC.METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}
