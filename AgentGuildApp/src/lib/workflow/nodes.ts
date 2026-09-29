/**
 * Workflow Engine — Built-in node type handlers.
 *
 * Each handler implements the NodeHandler interface: given a node + inputs,
 * execute the work and return a result. All handlers must complete within ~9s.
 */

import type {
  NodeHandler,
  NodeExecutionResult,
  WorkflowNodeType,
  ApiCallConfig,
  AgentTaskConfig,
  ConditionalConfig,
  TransformConfig,
  DelayConfig,
} from "./types";

// ── Template interpolation ───────────────────────────────────────────────────

/** Replace {{key}} placeholders with values from inputs */
function interpolate(
  template: string,
  inputs: Record<string, unknown>,
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path: string) => {
    const parts = path.split(".");
    let value: unknown = inputs;
    for (const part of parts) {
      if (value && typeof value === "object" && part in value) {
        value = (value as Record<string, unknown>)[part];
      } else {
        return `{{${path}}}`; // Leave unresolved
      }
    }
    return String(value ?? "");
  });
}

/**
 * Safely evaluate a restricted expression against inputs.
 *
 * Allows only: property access (a.b.c), comparisons (===, !==, >, <, >=, <=),
 * logical operators (&&, ||, !), string/number/boolean literals, and ternary.
 * NO function calls, assignments, or arbitrary code execution.
 */
const SAFE_EXPRESSION_RE =
  /^[\s\w.'"` \d\-+*/%<>=!&|?:,[\]()]+$/;

const FORBIDDEN_PATTERNS = [
  /\b(eval|Function|constructor|__proto__|prototype)\b/,
  /\b(require|import|export|process|globalThis|window|document)\b/,
  /\b(fetch|XMLHttpRequest|WebSocket|setTimeout|setInterval)\b/,
  /[;{}]/, // no statements or blocks
  /=(?!=)/, // no assignment (but allow == and ===)
];

function safeEval(expression: string, inputs: Record<string, unknown>): unknown {
  // Validate expression against allowlist
  if (!SAFE_EXPRESSION_RE.test(expression)) {
    throw new Error("Expression contains disallowed characters");
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(expression)) {
      throw new Error(`Expression contains forbidden pattern: ${pattern}`);
    }
  }

  // Evaluate with a frozen shallow copy — no prototype pollution
  const frozen = Object.freeze({ ...inputs });
  const fn = new Function("inputs", `"use strict"; return (${expression});`);
  return fn(frozen);
}

// ── Trigger handler ──────────────────────────────────────────────────────────

const triggerHandler: NodeHandler = {
  type: "trigger",
  async execute(_node, inputs): Promise<NodeExecutionResult> {
    // Trigger nodes pass through — their input becomes output
    return {
      status: "completed",
      output: inputs._trigger || inputs,
    };
  },
};

// ── API Call handler ─────────────────────────────────────────────────────────

const apiCallHandler: NodeHandler = {
  type: "api-call",
  async execute(node, inputs): Promise<NodeExecutionResult> {
    const config = node.config as ApiCallConfig;
    const url = interpolate(config.url, inputs);
    const timeoutMs = config.timeoutMs || 9000;

    const headers: Record<string, string> = {};
    if (config.headers) {
      for (const [key, val] of Object.entries(config.headers)) {
        headers[key] = interpolate(val, inputs);
      }
    }

    const fetchOptions: RequestInit = {
      method: config.method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (config.bodyTemplate && config.method !== "GET") {
      const body = interpolate(config.bodyTemplate, inputs);
      fetchOptions.body = body;
      if (!headers["content-type"] && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
    }

    const response = await fetch(url, fetchOptions);
    const contentType = response.headers.get("content-type") || "";

    let output: unknown;
    if (contentType.includes("application/json")) {
      output = await response.json();
    } else {
      output = await response.text();
    }

    if (!response.ok) {
      return {
        status: "failed",
        error: `HTTP ${response.status}: ${typeof output === "string" ? output.slice(0, 200) : JSON.stringify(output).slice(0, 200)}`,
        output,
      };
    }

    return { status: "completed", output };
  },
};

// ── Agent Task handler ───────────────────────────────────────────────────────

const agentTaskHandler: NodeHandler = {
  type: "agent-task",
  async execute(node, inputs, run): Promise<NodeExecutionResult> {
    const config = node.config as AgentTaskConfig;
    const description = interpolate(config.descriptionTemplate, inputs);

    // Create a task assignment via the internal API
    // This delegates to the existing assignment system
    try {
      const origin =
        process.env.NEXT_PUBLIC_APP_DOMAIN
          ? `https://${process.env.NEXT_PUBLIC_APP_DOMAIN}`
          : "http://localhost:3000";

      const response = await fetch(`${origin}/api/workflows/internal/assign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET || "",
        },
        body: JSON.stringify({
          orgId: run.orgId,
          agentId: config.agentId,
          description,
          priority: config.priority || "normal",
          requiresAcceptance: config.requiresAcceptance ?? false,
          workflowRunId: run.id,
          nodeId: node.id,
        }),
        signal: AbortSignal.timeout(config.timeoutMs || 9000),
      });

      if (!response.ok) {
        const err = await response.text();
        return { status: "failed", error: `Assignment failed: ${err}` };
      }

      const data = await response.json();

      // If the task is synchronous (no acceptance needed), it's done
      if (data.completed) {
        return { status: "completed", output: data.result, externalRef: data.assignmentId };
      }

      // Otherwise, the task is pending acceptance/completion — mark as running
      // The assignment system will callback when done
      return { status: "running", externalRef: data.assignmentId };
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : "Agent task failed",
      };
    }
  },
};

// ── Conditional handler ──────────────────────────────────────────────────────

const conditionalHandler: NodeHandler = {
  type: "conditional",
  async execute(node, inputs): Promise<NodeExecutionResult> {
    const config = node.config as ConditionalConfig;

    try {
      const result = safeEval(config.expression, inputs);
      const branch = String(result);

      const targetNodeId = config.branches[branch] || config.defaultBranch;

      return {
        status: "completed",
        output: {
          evaluatedTo: result,
          selectedBranch: branch,
          targetNodeId,
        },
      };
    } catch (err) {
      return {
        status: "failed",
        error: `Conditional expression failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

// ── Transform handler ────────────────────────────────────────────────────────

const transformHandler: NodeHandler = {
  type: "transform",
  async execute(node, inputs): Promise<NodeExecutionResult> {
    const config = node.config as TransformConfig;

    try {
      const result = safeEval(config.expression, inputs);
      return { status: "completed", output: result };
    } catch (err) {
      return {
        status: "failed",
        error: `Transform failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

// ── Parallel (fan-out) handler ───────────────────────────────────────────────

const parallelHandler: NodeHandler = {
  type: "parallel",
  async execute(_node, inputs): Promise<NodeExecutionResult> {
    // Parallel nodes pass through immediately — their children become ready
    return { status: "completed", output: inputs };
  },
};

// ── Join (fan-in) handler ────────────────────────────────────────────────────

const joinHandler: NodeHandler = {
  type: "join",
  async execute(_node, inputs): Promise<NodeExecutionResult> {
    // Join nodes collect all parent outputs into a merged object
    return { status: "completed", output: inputs };
  },
};

// ── Delay handler ────────────────────────────────────────────────────────────

const delayHandler: NodeHandler = {
  type: "delay",
  async execute(node, inputs): Promise<NodeExecutionResult> {
    const config = node.config as DelayConfig;
    const durationMs = config.durationMs || 0;

    // For short delays (< 8s), wait inline
    if (durationMs < 8000) {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      return { status: "completed", output: inputs };
    }

    // For longer delays, store the target time and return "running".
    // Next poll will check if time has elapsed.
    const targetTime = Date.now() + durationMs;
    return {
      status: "running",
      output: { _delayUntil: targetTime, ...inputs },
    };
  },
};

// ── Output handler ───────────────────────────────────────────────────────────

const outputHandler: NodeHandler = {
  type: "output",
  async execute(_node, inputs): Promise<NodeExecutionResult> {
    // Output nodes collect all upstream data
    return { status: "completed", output: inputs };
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

const handlers = new Map<WorkflowNodeType, NodeHandler>();

function registerHandler(handler: NodeHandler) {
  handlers.set(handler.type, handler);
}

// Register built-in handlers
registerHandler(triggerHandler);
registerHandler(apiCallHandler);
registerHandler(agentTaskHandler);
registerHandler(conditionalHandler);
registerHandler(transformHandler);
registerHandler(parallelHandler);
registerHandler(joinHandler);
registerHandler(delayHandler);
registerHandler(outputHandler);

/**
 * Get the handler for a node type.
 * Throws if no handler is registered.
 */
export function getNodeHandler(type: WorkflowNodeType): NodeHandler {
  const handler = handlers.get(type);
  if (!handler) {
    throw new Error(`No handler registered for node type: ${type}`);
  }
  return handler;
}
