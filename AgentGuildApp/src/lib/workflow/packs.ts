/**
 * Workflow Packs — Declarative workflow templates with QA rules,
 * cost profiles, and routing keywords.
 *
 * A WorkflowPack is a reusable, marketplace-publishable bundle that defines:
 * - A complete DAG template (nodes + edges) with placeholder agent slots
 * - QA rules that validate inputs/outputs at gate nodes
 * - A cost profile estimating per-run resource usage
 * - Routing keywords for agent matching and search discovery
 */

import type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowNodeType,
  AgentTaskConfig,
} from "./types";

/* ═══════════════════════════════════════
   QA Rules
   ═══════════════════════════════════════ */

/** A single QA rule applied at a gate node */
export interface QARule {
  id: string;
  /** Human-readable name */
  name: string;
  /** Which node output field to evaluate */
  field: string;
  /** Comparison operator */
  operator: "exists" | "not_empty" | "matches" | "min_length" | "max_length"
    | "contains" | "not_contains" | "gte" | "lte" | "eq" | "regex";
  /** Expected value for comparison operators */
  value?: string | number | boolean;
  /** What to do on failure */
  onFail: "block" | "warn" | "retry" | "route_to";
  /** Node to route to on failure (only for onFail=route_to) */
  failTargetNodeId?: string;
  /** Max retries before escalating (only for onFail=retry) */
  maxRetries?: number;
}

/** QA profile attached to a workflow pack */
export interface QAProfile {
  /** Gate nodes where QA checks run */
  gates: {
    /** ID of the node after which this gate applies */
    afterNodeId: string;
    rules: QARule[];
    /** All rules must pass ("all") or any one passes ("any") */
    mode: "all" | "any";
  }[];
  /** Global quality thresholds */
  thresholds?: {
    /** Max allowed error rate (0-1) before pausing the workflow */
    maxErrorRate?: number;
    /** Min success rate for the last N runs */
    minSuccessRate?: number;
    /** Window size for rolling metrics */
    rollingWindow?: number;
  };
}

/* ═══════════════════════════════════════
   Cost Profile
   ═══════════════════════════════════════ */

export interface CostProfile {
  /** Estimated cost per run in USD cents */
  estimatedCentsPerRun: number;
  /** Breakdown by node */
  breakdown: {
    nodeId: string;
    label: string;
    centsEstimate: number;
    /** What drives the cost */
    costDriver: "api-call" | "agent-time" | "compute" | "storage" | "external";
  }[];
  /** Monthly budget cap (USD cents). Runs are rejected if exceeded */
  monthlyCap?: number;
  /** Per-run hard limit */
  perRunCap?: number;
}

/* ═══════════════════════════════════════
   Routing Keywords
   ═══════════════════════════════════════ */

export interface RoutingKeywords {
  /** Required agent capabilities for agent-task nodes */
  requiredCapabilities: string[];
  /** Preferred agent types (sorted by priority) */
  preferredAgentTypes: string[];
  /** Tags for marketplace search discovery */
  searchTags: string[];
  /** Natural-language keywords for intent matching */
  intentKeywords: string[];
}

/* ═══════════════════════════════════════
   Workflow Pack
   ═══════════════════════════════════════ */

export type PackCategory =
  | "content"
  | "code"
  | "research"
  | "data"
  | "operations"
  | "security"
  | "creative"
  | "custom";

export interface WorkflowPack {
  id: string;
  name: string;
  description: string;
  category: PackCategory;
  version: string;
  /** Author (org or user ID) */
  author: string;

  /** DAG template — nodes use placeholder agentIds (resolved at install) */
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];

  /** QA validation rules */
  qa: QAProfile;
  /** Cost estimation */
  cost: CostProfile;
  /** Agent matching + discovery */
  routing: RoutingKeywords;

  /** Default trigger configuration */
  defaultTrigger: "manual" | "cron" | "event" | "webhook";
  /** Default cron schedule (if trigger=cron) */
  defaultSchedule?: string;

  /** Required env vars / secrets */
  requiredEnv?: string[];
  /** Marketplace visibility */
  isPublic: boolean;
  /** Install count */
  installs: number;

  createdAt: unknown;
  updatedAt: unknown;
}

/* ═══════════════════════════════════════
   Built-in Pack Templates
   ═══════════════════════════════════════ */

function makeNode(
  id: string,
  type: WorkflowNodeType,
  label: string,
  config: Record<string, unknown>,
  position?: { x: number; y: number },
): WorkflowNode {
  return { id, type, label, config, position };
}

function edge(from: string, to: string, label?: string): WorkflowEdge {
  return { from, to, label };
}

/* ── Code Review Pack ── */

export const CODE_REVIEW_PACK: Omit<WorkflowPack, "id" | "author" | "createdAt" | "updatedAt"> = {
  name: "Code Review Pipeline",
  description: "Automated code review: lint → review → security scan → approval gate",
  category: "code",
  version: "1.0.0",
  defaultTrigger: "webhook",
  isPublic: true,
  installs: 0,

  nodes: [
    makeNode("trigger", "trigger", "PR Webhook", { triggerType: "webhook" }, { x: 0, y: 200 }),
    makeNode("lint", "agent-task", "Lint & Format", {
      agentId: "$slot:linter",
      descriptionTemplate: "Run lint and format checks on PR #{{inputs.pr_number}} in {{inputs.repo}}",
      priority: "normal",
      timeoutMs: 60000,
    } satisfies Partial<AgentTaskConfig> as Record<string, unknown>, { x: 250, y: 200 }),
    makeNode("review", "agent-task", "Code Review", {
      agentId: "$slot:reviewer",
      descriptionTemplate: "Review code changes in PR #{{inputs.pr_number}}. Focus on logic, performance, and maintainability.",
      priority: "normal",
      timeoutMs: 120000,
    } satisfies Partial<AgentTaskConfig> as Record<string, unknown>, { x: 500, y: 100 }),
    makeNode("security", "agent-task", "Security Scan", {
      agentId: "$slot:security",
      descriptionTemplate: "Scan PR #{{inputs.pr_number}} for security vulnerabilities (OWASP top 10, dependency CVEs).",
      priority: "high",
      timeoutMs: 90000,
    } satisfies Partial<AgentTaskConfig> as Record<string, unknown>, { x: 500, y: 300 }),
    makeNode("join", "join", "Gather Results", {}, { x: 750, y: 200 }),
    makeNode("gate", "conditional", "Quality Gate", {
      expression: "inputs.review?.approved && !inputs.security?.critical_issues",
      branches: { true: "approve", false: "request_changes" },
    }, { x: 1000, y: 200 }),
    makeNode("approve", "output", "Approved", { label: "PR Approved", outputType: "action" }, { x: 1250, y: 100 }),
    makeNode("request_changes", "output", "Changes Requested", { label: "Changes Needed", outputType: "report" }, { x: 1250, y: 300 }),
  ],

  edges: [
    edge("trigger", "lint"),
    edge("lint", "review"),
    edge("lint", "security"),
    edge("review", "join"),
    edge("security", "join"),
    edge("join", "gate"),
    edge("gate", "approve", "true"),
    edge("gate", "request_changes", "false"),
  ],

  qa: {
    gates: [
      {
        afterNodeId: "lint",
        mode: "all",
        rules: [
          { id: "lint-output", name: "Lint produced output", field: "result", operator: "exists", onFail: "retry", maxRetries: 2 },
          { id: "lint-no-errors", name: "No lint errors", field: "errors", operator: "eq", value: 0, onFail: "block" },
        ],
      },
      {
        afterNodeId: "review",
        mode: "all",
        rules: [
          { id: "review-body", name: "Review has content", field: "review", operator: "min_length", value: 50, onFail: "retry", maxRetries: 1 },
          { id: "review-verdict", name: "Review has verdict", field: "approved", operator: "exists", onFail: "block" },
        ],
      },
      {
        afterNodeId: "security",
        mode: "all",
        rules: [
          { id: "sec-scan-complete", name: "Scan completed", field: "scanned", operator: "eq", value: true, onFail: "retry", maxRetries: 2 },
        ],
      },
    ],
    thresholds: {
      maxErrorRate: 0.15,
      minSuccessRate: 0.8,
      rollingWindow: 20,
    },
  },

  cost: {
    estimatedCentsPerRun: 85,
    breakdown: [
      { nodeId: "lint", label: "Lint & Format", centsEstimate: 15, costDriver: "agent-time" },
      { nodeId: "review", label: "Code Review", centsEstimate: 40, costDriver: "agent-time" },
      { nodeId: "security", label: "Security Scan", centsEstimate: 30, costDriver: "agent-time" },
    ],
  },

  routing: {
    requiredCapabilities: ["code-review", "linting", "security-scanning"],
    preferredAgentTypes: ["Code", "Security", "Research"],
    searchTags: ["code-review", "pr-review", "security", "linting", "ci-cd"],
    intentKeywords: ["review", "pull request", "code quality", "security scan", "lint"],
  },
};

/* ── Research & Report Pack ── */

export const RESEARCH_REPORT_PACK: Omit<WorkflowPack, "id" | "author" | "createdAt" | "updatedAt"> = {
  name: "Research & Report",
  description: "Multi-source research → synthesis → QA review → formatted report",
  category: "research",
  version: "1.0.0",
  defaultTrigger: "manual",
  isPublic: true,
  installs: 0,

  nodes: [
    makeNode("trigger", "trigger", "Research Request", { triggerType: "manual" }, { x: 0, y: 200 }),
    makeNode("parallel", "parallel", "Fan Out Sources", {}, { x: 200, y: 200 }),
    makeNode("web", "agent-task", "Web Research", {
      agentId: "$slot:researcher",
      descriptionTemplate: "Research topic: {{inputs.topic}}. Find 5+ credible sources and summarize key findings.",
      priority: "normal",
      timeoutMs: 180000,
    } satisfies Partial<AgentTaskConfig> as Record<string, unknown>, { x: 450, y: 100 }),
    makeNode("data", "agent-task", "Data Analysis", {
      agentId: "$slot:analyst",
      descriptionTemplate: "Analyze available data related to: {{inputs.topic}}. Produce charts and statistics.",
      priority: "normal",
      timeoutMs: 180000,
    } satisfies Partial<AgentTaskConfig> as Record<string, unknown>, { x: 450, y: 300 }),
    makeNode("join", "join", "Combine Findings", {}, { x: 700, y: 200 }),
    makeNode("synthesize", "agent-task", "Synthesize Report", {
      agentId: "$slot:writer",
      descriptionTemplate: "Synthesize research findings into a structured report. Include executive summary, analysis, and recommendations.",
      priority: "normal",
      timeoutMs: 240000,
    } satisfies Partial<AgentTaskConfig> as Record<string, unknown>, { x: 950, y: 200 }),
    makeNode("qa_review", "agent-task", "QA Review", {
      agentId: "$slot:qa",
      descriptionTemplate: "Review report for accuracy, completeness, grammar, and citation quality. Flag any unsupported claims.",
      priority: "high",
      timeoutMs: 120000,
    } satisfies Partial<AgentTaskConfig> as Record<string, unknown>, { x: 1200, y: 200 }),
    makeNode("gate", "conditional", "Quality Gate", {
      expression: "inputs.qa_score >= 0.8 && !inputs.factual_errors",
      branches: { true: "output", false: "synthesize" },
    }, { x: 1450, y: 200 }),
    makeNode("output", "output", "Final Report", { label: "Research Report", outputType: "report" }, { x: 1700, y: 200 }),
  ],

  edges: [
    edge("trigger", "parallel"),
    edge("parallel", "web"),
    edge("parallel", "data"),
    edge("web", "join"),
    edge("data", "join"),
    edge("join", "synthesize"),
    edge("synthesize", "qa_review"),
    edge("qa_review", "gate"),
    edge("gate", "output", "true"),
    edge("gate", "synthesize", "false"),
  ],

  qa: {
    gates: [
      {
        afterNodeId: "web",
        mode: "all",
        rules: [
          { id: "web-sources", name: "Has sources", field: "sources", operator: "min_length", value: 3, onFail: "retry", maxRetries: 1 },
        ],
      },
      {
        afterNodeId: "qa_review",
        mode: "all",
        rules: [
          { id: "qa-score", name: "QA score ≥ 0.8", field: "qa_score", operator: "gte", value: 0.8, onFail: "route_to", failTargetNodeId: "synthesize" },
          { id: "qa-no-errors", name: "No factual errors", field: "factual_errors", operator: "eq", value: false, onFail: "route_to", failTargetNodeId: "synthesize" },
          { id: "qa-complete", name: "Review is complete", field: "reviewed", operator: "eq", value: true, onFail: "retry", maxRetries: 1 },
        ],
      },
    ],
    thresholds: {
      maxErrorRate: 0.2,
      minSuccessRate: 0.75,
      rollingWindow: 10,
    },
  },

  cost: {
    estimatedCentsPerRun: 320,
    breakdown: [
      { nodeId: "web", label: "Web Research", centsEstimate: 80, costDriver: "agent-time" },
      { nodeId: "data", label: "Data Analysis", centsEstimate: 60, costDriver: "agent-time" },
      { nodeId: "synthesize", label: "Report Writing", centsEstimate: 120, costDriver: "agent-time" },
      { nodeId: "qa_review", label: "QA Review", centsEstimate: 60, costDriver: "agent-time" },
    ],
  },

  routing: {
    requiredCapabilities: ["research", "writing", "data-analysis", "qa"],
    preferredAgentTypes: ["Research", "Content", "Data"],
    searchTags: ["research", "report", "analysis", "synthesis", "writing"],
    intentKeywords: ["research", "report", "investigate", "analyze", "write report"],
  },
};

/* ── Content Pipeline Pack ── */

export const CONTENT_PIPELINE_PACK: Omit<WorkflowPack, "id" | "author" | "createdAt" | "updatedAt"> = {
  name: "Content Pipeline",
  description: "Draft → edit → SEO optimize → publish-ready content",
  category: "content",
  version: "1.0.0",
  defaultTrigger: "manual",
  isPublic: true,
  installs: 0,

  nodes: [
    makeNode("trigger", "trigger", "Content Brief", { triggerType: "manual" }, { x: 0, y: 200 }),
    makeNode("draft", "agent-task", "Write Draft", {
      agentId: "$slot:writer",
      descriptionTemplate: "Write a {{inputs.content_type}} about: {{inputs.topic}}. Target audience: {{inputs.audience}}. Tone: {{inputs.tone}}.",
      priority: "normal",
      timeoutMs: 300000,
    } satisfies Partial<AgentTaskConfig> as Record<string, unknown>, { x: 300, y: 200 }),
    makeNode("edit", "agent-task", "Edit & Polish", {
      agentId: "$slot:editor",
      descriptionTemplate: "Edit the draft for clarity, grammar, style consistency, and flow. Preserve voice and key points.",
      priority: "normal",
      timeoutMs: 180000,
    } satisfies Partial<AgentTaskConfig> as Record<string, unknown>, { x: 600, y: 200 }),
    makeNode("seo", "agent-task", "SEO Optimize", {
      agentId: "$slot:seo",
      descriptionTemplate: "Optimize content for SEO. Add meta description, headings, internal links, and keyword density for: {{inputs.primary_keyword}}.",
      priority: "normal",
      timeoutMs: 120000,
    } satisfies Partial<AgentTaskConfig> as Record<string, unknown>, { x: 900, y: 200 }),
    makeNode("gate", "conditional", "Quality Gate", {
      expression: "inputs.readability_score >= 70 && inputs.seo_score >= 80",
      branches: { true: "output", false: "edit" },
    }, { x: 1200, y: 200 }),
    makeNode("output", "output", "Publish Ready", { label: "Final Content", outputType: "result" }, { x: 1500, y: 200 }),
  ],

  edges: [
    edge("trigger", "draft"),
    edge("draft", "edit"),
    edge("edit", "seo"),
    edge("seo", "gate"),
    edge("gate", "output", "true"),
    edge("gate", "edit", "false"),
  ],

  qa: {
    gates: [
      {
        afterNodeId: "draft",
        mode: "all",
        rules: [
          { id: "draft-length", name: "Minimum word count", field: "word_count", operator: "gte", value: 300, onFail: "retry", maxRetries: 1 },
          { id: "draft-content", name: "Has content", field: "content", operator: "not_empty", onFail: "block" },
        ],
      },
      {
        afterNodeId: "seo",
        mode: "all",
        rules: [
          { id: "seo-score", name: "SEO score ≥ 80", field: "seo_score", operator: "gte", value: 80, onFail: "route_to", failTargetNodeId: "edit" },
          { id: "readability", name: "Readability ≥ 70", field: "readability_score", operator: "gte", value: 70, onFail: "warn" },
          { id: "meta-desc", name: "Has meta description", field: "meta_description", operator: "not_empty", onFail: "retry", maxRetries: 1 },
        ],
      },
    ],
  },

  cost: {
    estimatedCentsPerRun: 180,
    breakdown: [
      { nodeId: "draft", label: "Write Draft", centsEstimate: 80, costDriver: "agent-time" },
      { nodeId: "edit", label: "Edit & Polish", centsEstimate: 50, costDriver: "agent-time" },
      { nodeId: "seo", label: "SEO Optimize", centsEstimate: 50, costDriver: "agent-time" },
    ],
  },

  routing: {
    requiredCapabilities: ["writing", "editing", "seo"],
    preferredAgentTypes: ["Content", "Research"],
    searchTags: ["content", "writing", "blog", "seo", "copywriting", "editorial"],
    intentKeywords: ["write", "blog post", "article", "content", "publish", "seo"],
  },
};

/* ── Data ETL Pack ── */

export const DATA_ETL_PACK: Omit<WorkflowPack, "id" | "author" | "createdAt" | "updatedAt"> = {
  name: "Data ETL Pipeline",
  description: "Extract → validate → transform → load data with schema checks",
  category: "data",
  version: "1.0.0",
  defaultTrigger: "cron",
  defaultSchedule: "0 */6 * * *",
  isPublic: true,
  installs: 0,

  nodes: [
    makeNode("trigger", "trigger", "Schedule / Manual", { triggerType: "cron", schedule: "0 */6 * * *" }, { x: 0, y: 200 }),
    makeNode("extract", "api-call", "Extract Data", {
      method: "GET",
      url: "{{inputs.source_url}}",
      headers: { Authorization: "Bearer {{inputs.api_key}}" },
      timeoutMs: 9000,
    }, { x: 250, y: 200 }),
    makeNode("validate", "agent-task", "Validate Schema", {
      agentId: "$slot:validator",
      descriptionTemplate: "Validate extracted data against schema: {{inputs.schema_name}}. Report missing fields, type mismatches, and constraint violations.",
      priority: "high",
      timeoutMs: 60000,
    } satisfies Partial<AgentTaskConfig> as Record<string, unknown>, { x: 500, y: 200 }),
    makeNode("gate", "conditional", "Validation Gate", {
      expression: "inputs.valid === true && inputs.error_count === 0",
      branches: { true: "transform", false: "alert" },
    }, { x: 750, y: 200 }),
    makeNode("transform", "agent-task", "Transform Data", {
      agentId: "$slot:transformer",
      descriptionTemplate: "Transform data: {{inputs.transform_rules}}. Normalize formats, deduplicate, and enrich.",
      priority: "normal",
      timeoutMs: 120000,
    } satisfies Partial<AgentTaskConfig> as Record<string, unknown>, { x: 1000, y: 100 }),
    makeNode("load", "api-call", "Load to Target", {
      method: "POST",
      url: "{{inputs.target_url}}",
      headers: { "Content-Type": "application/json", Authorization: "Bearer {{inputs.target_api_key}}" },
      bodyTemplate: "{{inputs.transformed_data}}",
      timeoutMs: 9000,
    }, { x: 1250, y: 100 }),
    makeNode("output", "output", "ETL Complete", { label: "ETL Result", outputType: "result" }, { x: 1500, y: 100 }),
    makeNode("alert", "output", "Validation Failed", { label: "Data Quality Alert", outputType: "report" }, { x: 1000, y: 300 }),
  ],

  edges: [
    edge("trigger", "extract"),
    edge("extract", "validate"),
    edge("validate", "gate"),
    edge("gate", "transform", "true"),
    edge("gate", "alert", "false"),
    edge("transform", "load"),
    edge("load", "output"),
  ],

  qa: {
    gates: [
      {
        afterNodeId: "extract",
        mode: "all",
        rules: [
          { id: "extract-data", name: "Has data", field: "data", operator: "exists", onFail: "retry", maxRetries: 3 },
          { id: "extract-status", name: "HTTP success", field: "status", operator: "gte", value: 200, onFail: "block" },
        ],
      },
      {
        afterNodeId: "validate",
        mode: "all",
        rules: [
          { id: "schema-valid", name: "Schema valid", field: "valid", operator: "eq", value: true, onFail: "block" },
          { id: "no-errors", name: "Zero errors", field: "error_count", operator: "eq", value: 0, onFail: "block" },
        ],
      },
      {
        afterNodeId: "load",
        mode: "all",
        rules: [
          { id: "load-success", name: "Load succeeded", field: "status", operator: "gte", value: 200, onFail: "retry", maxRetries: 2 },
        ],
      },
    ],
    thresholds: {
      maxErrorRate: 0.05,
      minSuccessRate: 0.95,
      rollingWindow: 50,
    },
  },

  cost: {
    estimatedCentsPerRun: 45,
    breakdown: [
      { nodeId: "extract", label: "Extract", centsEstimate: 5, costDriver: "api-call" },
      { nodeId: "validate", label: "Validate", centsEstimate: 15, costDriver: "agent-time" },
      { nodeId: "transform", label: "Transform", centsEstimate: 20, costDriver: "agent-time" },
      { nodeId: "load", label: "Load", centsEstimate: 5, costDriver: "api-call" },
    ],
  },

  routing: {
    requiredCapabilities: ["data-validation", "data-transformation", "api-integration"],
    preferredAgentTypes: ["Data", "Operations"],
    searchTags: ["etl", "data-pipeline", "data-quality", "automation", "integration"],
    intentKeywords: ["extract", "transform", "load", "data pipeline", "etl", "data sync"],
  },
};

/* ═══════════════════════════════════════
   Pack Registry
   ═══════════════════════════════════════ */

/** All built-in packs */
export const BUILTIN_PACKS = [
  CODE_REVIEW_PACK,
  RESEARCH_REPORT_PACK,
  CONTENT_PIPELINE_PACK,
  DATA_ETL_PACK,
] as const;

/** Look up a built-in pack by name */
export function getBuiltinPack(name: string) {
  return BUILTIN_PACKS.find(p => p.name === name) ?? null;
}

/** Get all packs matching a category */
export function getPacksByCategory(category: PackCategory) {
  return BUILTIN_PACKS.filter(p => p.category === category);
}

/** Search packs by keyword (matches name, description, routing tags, intent keywords) */
export function searchPacks(query: string): typeof BUILTIN_PACKS[number][] {
  const q = query.toLowerCase();
  return BUILTIN_PACKS.filter(p =>
    p.name.toLowerCase().includes(q) ||
    p.description.toLowerCase().includes(q) ||
    p.routing.searchTags.some(t => t.includes(q)) ||
    p.routing.intentKeywords.some(k => k.includes(q))
  );
}

/** Validate a QA rule against a node output */
export function evaluateQARule(rule: QARule, output: Record<string, unknown>): boolean {
  const val = output[rule.field];

  switch (rule.operator) {
    case "exists":
      return val !== undefined && val !== null;
    case "not_empty":
      return val !== undefined && val !== null && val !== "" && !(Array.isArray(val) && val.length === 0);
    case "eq":
      return val === rule.value;
    case "gte":
      return typeof val === "number" && typeof rule.value === "number" && val >= rule.value;
    case "lte":
      return typeof val === "number" && typeof rule.value === "number" && val <= rule.value;
    case "min_length":
      return (typeof val === "string" || Array.isArray(val)) && val.length >= (rule.value as number);
    case "max_length":
      return (typeof val === "string" || Array.isArray(val)) && val.length <= (rule.value as number);
    case "contains":
      return typeof val === "string" && typeof rule.value === "string" && val.includes(rule.value);
    case "not_contains":
      return typeof val === "string" && typeof rule.value === "string" && !val.includes(rule.value);
    case "matches":
    case "regex":
      return typeof val === "string" && typeof rule.value === "string" && new RegExp(rule.value).test(val);
    default:
      return false;
  }
}

/** Evaluate all rules in a QA gate against node output */
export function evaluateGate(
  gate: QAProfile["gates"][number],
  output: Record<string, unknown>,
): { passed: boolean; failures: QARule[] } {
  const failures: QARule[] = [];
  for (const rule of gate.rules) {
    if (!evaluateQARule(rule, output)) {
      failures.push(rule);
    }
  }
  const passed = gate.mode === "all" ? failures.length === 0 : failures.length < gate.rules.length;
  return { passed, failures };
}
